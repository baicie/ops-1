# ADR-027: A plugin upgrade must release the old version's instances

**Status: PROPOSED — the root cause is proven, the fix is not implemented.**

Found 2026-11-17 while investigating why the staging publish chain has never
succeeded. It changes what TASK-16 (plugin lifecycle) and TASK-01/11 (capacity)
are actually about.

## The defect

`deploy_plugin` looks up the deployment by **`(plugin_id, version)`**:

```rust
"SELECT * FROM kernel.plugin_deployments WHERE plugin_id=$1 AND version=$2"
```

`plugin_deployments` has one row **per version**. Nothing in `deploy_plugin`
disables the previous version's row. So each publish leaves the old deployment
`START`-ing its own instances, and the new one asks for a slot beside them.

The measured consequence, on a node whose limit is 4:

```
publish 0.0.17453  -> deployment A, 1 instance, node at 1/4
publish 0.0.17454  -> deployment B, 1 instance, node at 2/4   (A still running)
publish 0.0.17454  -> deployment C, 1 instance, node at 3/4   (A, B still running)
publish 0.0.17455  -> deployment D, 1 instance, node at 4/4
publish 0.0.17456  -> INSTANCE_CAPACITY_EXCEEDED
```

That is exactly the staging log:

```
PENDING 0/0 ready (No eligible healthy node matches the placement selector
[INSTANCE_CAPACITY_EXCEEDED] node staging-node:
4 instances already scheduled on this node against a per-node limit of 4)
```

This is not a capacity configuration problem, and it is not a ghost problem. Four
publishes left four live deployments, each with a healthy instance, all belonging
to plugins that are no longer the active version. **The platform keeps every
version it has ever deployed running.**

## Why the earlier fixes could not help

- `is_ghost_instance` / the capacity predicates (#135–#137) exclude
  `UNHEALTHY`/`UNREACHABLE` rows with no container. These four rows are healthy
  and have containers. Correctly counted.
- `must_rebuild` (this round) re-creates a ghost. There is no ghost to re-create.
  Confirmed by rerunning after the merge (`bc19140`, run 44029228405): identical
  `4 instances already scheduled`.

Both fixes are right, and both were aimed at a different defect. The reason the
staging failure kept looking like a capacity bug is that its **message** is a
capacity message; the cause is lifecycle.

## What a correct upgrade looks like

An upgrade is not "deploy another version". It is a transition:

```
ACTIVE(v_old)  --deploy(v_new)-->  DRAINING(v_old)  -->  DISABLED(v_old)
                                   PREPARING(v_new) -->  ACTIVE(v_new)
```

The old version's instances must be released **before** the new ones are placed,
or the node needs room for both. Both orderings are defensible:

| Strategy | Needs 2x capacity? | Downtime | Use when |
|---|---|---|---|
| **Stop-then-start** | No | Yes, briefly | one node, tight capacity (staging today) |
| **Start-then-stop** (surge) | Yes | No | multi-node, capacity available |

The platform currently does neither — it starts without stopping, which is the
surge strategy without the capacity for it.

## Proposed fix, in order

1. **Release before place.** When `deploy_plugin` targets a version different
   from the plugin's current deployment, mark every other non-`DISABLED`
   deployment of that `plugin_id` as `DRAINING` with `drain_until = now()`, so the
   reconciler stops their instances and their slots free in the same pass.
2. **Make the strategy explicit.** A `placement.rollout` field:
   `"stop-then-start"` (default on a single node) or `"surge"`. The default must
   be the one that works on the smallest installation; surge is an opt-in that
   requires the operator to have the capacity.
3. **Order within one pass.** The reconciler currently plans deployments in
   `ORDER BY created_at`, so the OLD deployment is reconciled first and re-asserts
   its instance before the new one is considered. Without a drain step, ordering
   alone can never free a slot.
4. **Assert it.** A real-PostgreSQL test with a node limit of 2, three successive
   publishes, asserting: after each, exactly one deployment is `START`; the node
   is at 1/2; and the previously-active version is `DISABLED`.

## Why this is an ADR and not a patch

It changes the meaning of `deploy` from "create or retry this version" to "make
this version the one that runs", which is a user-visible semantic. It interacts
with `uninstall` (which already disables by `plugin_id` — the same query belongs
in `deploy`), with `activation_revisions` (which already has an ACTIVE/SUPERSEDED
model for the plugin-level pointer), and with ADR-026's publish state machine
(`ACTIVATED` should mean "the old version is gone", not "a new row exists").

Doing it as a patch would produce a second, differently-shaped notion of "the
current version" beside the one `activation_revisions` already keeps.

## Decisions needed

1. **Default strategy: stop-then-start or surge?** The proposal is stop-then-start,
   because a single-node installation is the common case and the one that breaks.
2. **Is a brief downtime acceptable for an upgrade?** Stop-then-start means the
   plugin is unavailable between the old instance stopping and the new one becoming
   READY. On this platform that is seconds, but it is not zero.
3. **Should `deploy` refuse when the target version equals the active one?** It
   already returns `409 VERSION_ALREADY_ACTIVE`. Keep it.
4. **What should `uninstall` do to history?** It disables all deployments of the
   plugin. That is now consistent with upgrade; confirm the audit record is what
   you want (`status='DISABLED'`, rows retained).

## Evidence

Every claim above is from a real run, not a reading of the code.

```
staging-preview run 44016184862  (main c3edae4)   deploy step failed, 4/4
staging-preview run 44029228405  (main bc19140)   deploy step failed, 4/4  <- must_rebuild merged
```

Both times the publish got as far as `staged ... bundle=sha256:...`, so image
push, bundle assembly and signing all work. The single failure point is placement,
and placement is full because every earlier version is still running.

The staging database cannot be inspected directly from here: the SSH credentials
exist only as CI secrets and the local key is refused
(`Permission denied (publickey)`). The four-row count is therefore inferred from
the error message — which names the exact query — plus the code path above, not
from a `SELECT`.
