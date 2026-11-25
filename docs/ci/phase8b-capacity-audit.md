# Phase 8B TASK-30: the staging capacity audit

**Real staging was not accessed.** Everything below is read from artifacts that the
*failed runs themselves* uploaded, plus the Kernel source. No query was run against
the staging database, and nothing was deleted or rewritten. That limit is stated
first because TASK-30's own brief forbids claiming otherwise.

## The failure, from its own evidence

Run **45570951551**, job **139057760059**, step 13 (`Publish the data plugin
bundles`), commit `b217284a`:

```
data-catalog: 0.0.65450 already built on this host
data-catalog: pushed 127.0.0.1:15001/opsweave/data-catalog:0.0.65450
opsweave.data-catalog@0.0.65450 already installed; re-checking its deployment
  PENDING 0/0 ready (No eligible healthy node matches the placement selector
  [INSTANCE_CAPACITY_EXCEEDED] node staging-node: 4 instances already scheduled
  on this node against a per-node limit of 4; occupied by
  dev.opsweave.hello@0.0.1, opsweave.data-catalog@0.0.2,
  opsweave.data-catalog@0.0.3590, opsweave.data-integration@0.0.2)
Error: timed out waiting for deployment readiness
```

The four instances named in the brief are exactly the four in the error. The
observation was accurate.

## What each of the seven questions actually answers

| # | question | answer | evidence |
|---|---|---|---|
| 1 | ACTIVE / READY / STOPPING / FAILED / orphan? | **Not knowable from any artifact.** The host status JSON has `services` (postgres, registry, kernel, node) and no plugin-deployment section. | `host-status.json` in the run's artifact |
| 2 | which carry Gateway traffic | **At most one per plugin** — `route_candidates` requires an `ACTIVE` activation revision, and `publish-data-plugins.sh` never calls `activate` (B-18). So *none* of these four is being routed to by the publish. | `grep -c activate scripts/publish-data-plugins.sh` → 0 |
| 3 | which belong to an unfinished release | The two `data-catalog` rows, and the `data-integration` row. | see below |
| 4 | which old versions keep artifacts but need no instance | the version history is retained in `plugin_packages`; **runtime** retention is the separate question this task decides | ADR-025 |
| 5 | does lifecycle release conform to the ADRs | **No.** ADR-027 claimed activation releases the old version, and that is true — but it never fires for these rows. | see "the root cause" |
| 6 | why did the preflight not stop it | **The preflight was never consulted.** `capacity_preflight` is a read-only endpoint; `create_deployment_inner` never calls `placement_preflight::gather`. | `deployments.rs:296-490` |
| 7 | is there a cleanup failure or wrong desired state | **Both, and they are the same defect.** | see "the root cause" |

## The root cause, which is not the one ADR-027 was written about

ADR-027 was **withdrawn** because its premise ("nothing disables the previous
version") was false. It is worth reading its own correction:

> `activate` has released the previous deployment since #50 … A 15-second grace
> period, so the old version keeps serving while the route moves.

That is true. And it does not apply here.

**The publish never reaches `activate`.** `deploy --wait` times out on capacity
first, so `activate_inner` never runs, so the `DRAINING` write inside it never
runs. The four rows are therefore not "old versions that were superseded"; they are
**deployments that were created and never activated**, each holding a slot.

The sweep cannot reclaim them either. `reconcile_once` plans exactly:

```sql
SELECT * FROM kernel.plugin_deployments
WHERE status IN ('PENDING','PREPARING','READY','ACTIVE','DEGRADED')
```

`READY` is in that set. A `READY` deployment is planned on every tick, so its
instances keep their `desired_action = 'START'` and keep counting against
`max_instances_per_node`. The only writes that reach `DISABLED` are:

- `drain_until` elapsed (requires a `DRAINING` row — which requires `activate`)
- `uninstall`
- an operator setting `desired_replicas = 0`

None of those happens for a deployment that was deployed and never activated.

```
deploy v1  -> READY          (1 slot)
deploy v2  -> READY          (2 slots, v1 never activated, never drained)
deploy v3  -> READY          (3 slots)
deploy v4  -> READY          (4 slots)
deploy v5  -> INSTANCE_CAPACITY_EXCEEDED
```

That is exactly the shape in the error message, and it is the same shape the
`create_deployment_inner` comment describes — but that comment attributes it to
"the platform kept every version it had ever deployed running" via *activation*,
which is only half the mechanism.

## The two defects

### D-1: a `READY` deployment that is not active holds its slot forever

**This is a lifecycle defect, not a capacity-tuning problem.** Nothing in the
platform releases a deployment that reached `READY` and was then superseded
without ever being activated. The brief's rule applies directly:

> 禁止仅通过提高 Staging 实例容量来掩盖插件生命周期问题。

Raising `OPSWEAVE_MAX_INSTANCES_PER_NODE` from 4 would hide this for four more
publishes and make the eventual failure harder to read. It is not a fix.

The fix belongs with the existing mechanism, not beside it. `activate` already
drains the previous version with a 15-second grace period. What is missing is the
same release for a version that **lost the race to another version of the same
plugin** without being activated — the superseded candidate. That must reuse
`DRAINING` → `reconcile_once` → `DISABLED`, because that path already:

- keeps the row observable during the grace window,
- lets the reconciler be the single owner of the status transition,
- stops the instances at `DISABLED` (the `desired_action='STOP'` write in the
  sweep), and
- has a test asserting **both halves** — still serving inside the window, released
  after it (`a_drained_version_frees_its_node_slots_after_the_grace_period`).

A new delete path would duplicate all four and violate the brief's
「如果现有能力已经提供 stop、disable、drain、reconcile，应复用，不得新增旁路删除逻辑」.

### D-2: the preflight exists and the deploy path ignores it

`placement_preflight::gather` runs the same `evaluate_node` the scheduler runs, is
read-only, has six rejection codes with numbers behind them, and is reachable at
`GET /api/v1/capacity/preflight`. `create_deployment_inner` does not call it.

So staging learns it has no slots by **timing out after a full image build**, which
is the exact cost the endpoint was built to remove.

TASK-31 asks for a Release Capacity Planner. The planner already exists; what does
not exist is (a) the deploy path consulting it, and (b) the vocabulary the brief
asks for (`RECLAIM_REQUIRED` in particular), which is a *plan* question the current
endpoint cannot express because it only answers "fits / does not fit".

## Why the four rows cannot be distinguished from a healthy deploy

This is the part that makes the audit hard, and it is worth stating because it
constrains the fix:

`dev.opsweave.hello@0.0.1` is a legitimate sibling plugin. `opsweave.data-catalog@0.0.2`
may be a **genuinely active** version of data-catalog. Only
`opsweave.data-catalog@0.0.3590` and `opsweave.data-integration@0.0.2` are
certainly unfinished.

So the reclamation rule **cannot** be "disable everything that is `READY` and not
the newest". It must be scoped to *superseded candidates of the same plugin*, and
it must never touch:

- the `ACTIVE` version (brief: 「ACTIVE 版本绝不能被自动回收」),
- a version currently serving traffic,
- a different plugin's deployment.

The audit cannot tell which of the four is active without the staging database, and
that is precisely the `BLOCKED_ENV` this task records rather than guesses.

## What this task delivers

1. **This audit.** The failure's cause is identified from the run's own artifacts
   and the Kernel source, and it is *not* the cause ADR-027 proposed to fix.
2. **D-1 and D-2 recorded as defects**, each with the existing mechanism it must
   reuse.
3. **No change to staging, no capacity limit raised, no row deleted.**

## What it does not deliver, and will not claim

- **The status of each of the four instances.** Requires the staging database.
  Blocked, recorded.
- **That the four are all unfinished releases.** Two are certain; two cannot be
  classified from outside.
- **A fix.** TASK-31 (planner integration) and TASK-32 (candidate reclamation) are
  where the changes go, and each gets its own counterexample first.

## The correction worth keeping

ADR-027's lesson was: *two true facts that add up to a false conclusion.* This audit
found the same shape one level down. The withdrawal says activation releases the old
version — true. This comment in `create_deployment_inner` says the platform "kept
every version it had ever deployed running" and that activation is the fix — also
true, and still not what happened here, because the publish never activates.

The check that settles it takes one command, and it is the same class of check
ADR-027 prescribed for itself:

```bash
grep -rn "SET status='DISABLED'" apps/kernel/src/deployments.rs
```

Every one of those writes requires either a `DRAINING` row, an uninstall, or an
operator action. None is reachable from "deployed and never activated".

---

# TASK-31 and TASK-32: what was built, and the regression it caused first

TASK-31's brief says not to build a second calculator: 「将已有 placement preflight
接入真实发布路径，而不是另建一套重复的容量计算器」. So nothing new computes
capacity. Two things were added around the existing one.

## TASK-31: the plan says WHY it is blocked

`Preflight` could say `FITS` or `CAPACITY_BLOCKED`, which conflates two opposite
situations: a cluster that is too small, and a cluster that is full of rows we own
and abandoned. The remedies are opposite, so the verdict now distinguishes them:

| verdict | meaning |
|---|---|
| `FITS` | placeable now |
| `RECLAIM_REQUIRED` | blocked, **and** releasing the candidates listed in `reclaim` would make it fit |
| `CAPACITY_BLOCKED` | blocked, and no reclaim helps |

`RECLAIM_REQUIRED` is computed as `replicas_placeable + slots_freed >= replicas`
using the numbers `evaluate_node` already produced. **It cannot turn a refusal into
a FITS** - `reason` keeps the same rejection code, so a caller that ignores the new
verdict is exactly where it was.

The `reclaim` field is always present (zero when nothing is reclaimable) so a
consumer never has to distinguish "none" from "not computed".

And the deploy path now carries the plan in its 202 body under `capacityPlan`. It is
**an advisory, not a gate**: `gather` failing is logged with `tracing::warn!` and
swallowed with `.ok()`, and there is a test asserting the code shape - a `?` at that
site is what would turn the advisory into a gate. Refusing the create outright would
change the contract of an endpoint whose callers already handle "accepted and
PENDING", and would make a transient capacity state look like a permanent rejection.

## TASK-32: reclaim, reusing the existing mechanism

The sweep gained one statement. It does not delete a row, does not touch an ACTIVE
deployment, does not cross plugin boundaries, and does not pick "newest" by
timestamp - it asks whether a **newer version of the same plugin** exists.

It reuses `DRAINING` → `reconcile_once` → `DISABLED` → the existing `STOP` write,
rather than a second disable path, because that path already keeps the row
observable, keeps the reconciler the single owner of the transition, and has a test
asserting both halves of the grace window.

## The regression it caused, and the counterexample that caught it

The first version of the reclamation **broke rollback**, and I found it by writing
the fault-injection case rather than by reasoning about it.

`rollback` to a version with no deployment creates one and returns:

> the deployment did not exist; wait for it to reach READY, then activate it

Between READY and that activate call the row is *exactly* what the reclamation looks
for: READY, never activated, and - because a rollback goes backwards - superseded by
a newer version. The unguarded statement drained `0.0.1` while an operator was in
the middle of rolling back to it.

```
assertion failed: the rollback target must still be READY and waiting for activation
  left: "DISABLED"
 right: "READY"
```

The fix is one clause: release a candidate **only when the same plugin has a
deployment in `PENDING` or `PREPARING`** - i.e. something is actively blocked on a
slot right now. A rollback target has nothing pending, so it is left alone.
Staging's `data-catalog@0.0.65450` *was* `PENDING`, which is what the same clause
releases for.

The preflight's copy of the predicate carries the clause too, and
`preflight_reclaims_what_the_sweep_releases` fails if the two drift apart - a
preflight that promised a reclaim the sweep would not perform would tell an operator
to wait for something that never happens.

## Two more test defects, both mine

1. **`reconcile_once` vs `reconcile_once_scoped`.** The module's tests share one
   database. `reconcile_once` takes the planner lock with `pg_try_advisory_lock` and
   **returns early** when another planner holds it, so under `cargo test`'s parallel
   execution the test silently reconciled nothing. It passed alone and failed in the
   module run. `reconcile_once_scoped(state, Some(id))` waits; `None` still uses
   `try`. The `Some(id)` is what makes the test deterministic, and the reclamation
   is a global statement so it runs either way.
2. **An absolute count against a shared database.** A parallel test's global sweep
   released my fixture between the insert and the assertion - `left: []` in 2 of 4
   runs. The absolute assertion was replaced with the invariant that survives a
   concurrent sweep: whatever the preflight lists is a subset of what exists, and a
   READY row must be named while a released one must not.

## Counterfactuals run

| change removed | tests that fail |
|---|---|
| the whole reclamation | `a_superseded_candidate_that_was_never_activated_stops_holding_its_slot`, `preflight_reclaims_what_the_sweep_releases` |
| only the waiting guard | `a_rollback_target_is_not_reclaimed_while_it_is_being_activated` |

Three consecutive full runs of the kernel suite: **345 passed, 0 failed**. `cargo
clippy --all-targets`: 0 warnings.

## What this still does not prove

- **Not staging.** No staging access was used or claimed. The fix is verified
  against PostgreSQL with the fixture shaped after the real failure's error message.
- **The four staging rows are still there.** Releasing them requires a deploy that
  runs this code, which is TASK-39's ground and needs authorization this session
  does not have.
- **`RECLAIM_REQUIRED` reaches the caller only once `opsctl` reads it.** The kernel
  now returns it; the CLI that currently times out has not been changed. That is a
  real gap and is named rather than implied.

---

# Correction after merge: a version is not a counter

The reclamation shipped in #220 (`a7d6cd65`) decided supersession with
`newer.version > d.version`. **That assumption does not hold in this repository**,
and it was found by asking whether the rule would actually work on staging's four
rows rather than by reading the code again.

Versions are produced by `scripts/publish-data-plugins.sh:175`:

```bash
version="0.0.$(( 0x$src_hash % 100000 ))"
```

and ADR-025 says of that number, in as many words:

> the number is a **content fingerprint, not a counter: there is no ordering**

So `0.0.9` is not older than `0.0.10` — they are two unrelated hash values. Worse,
compared as strings, `"0.0.9" > "0.0.10"` is `true`, so the rule could have
preferred the older row across a digit boundary rather than merely failing to
reclaim.

The kernel already keeps the right signal: a redeploy always inserts a **new** row,
and every place that asks for "the latest" sorts by `created_at`
(`deployments.rs:228`, `:956`). Both copies of the predicate — the sweep and the
preflight — now use `created_at`. Fixed in #222.

## What this changes about the staging answer

Against the four rows from run 45570951551:

| row | released by the rule? | why |
|---|---|---|
| `opsweave.data-catalog@0.0.2` | **yes** | superseded by a newer row of the same plugin |
| `opsweave.data-catalog@0.0.3590` | **yes** | same |
| `dev.opsweave.hello@0.0.1` | no | its plugin's only version |
| `opsweave.data-integration@0.0.2` | no | its plugin's only version |

**Two of four.** The other two need a decision that requires the staging database,
which this session does not have. That is a smaller effect than "the capacity
problem is fixed", and the smaller number is the true one.

## The counterexample, and why the first version passed its own tests

The fixture is built so the two rules **disagree**: `0.0.9` inserted first with an
older `created_at`, `0.0.10` second. Restoring `version >` fails that one test and
nothing else — the other four in the module pass either way:

```
counterfactual (version >):  a_version_straddling_a_digit_boundary_is_still_superseded  FAILED
                             4 others                                                   ok
```

That is exactly why it would have shipped: every test passed, because no fixture
straddled a digit boundary. A rule can be wrong in the one case nobody built.
