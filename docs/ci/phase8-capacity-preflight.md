# Phase 8 TASK-25: capacity preflight, verified in isolation

**Real staging was not accessed.** No configuration file here claims otherwise.
Everything below was measured on one host with a real Kernel, real PostgreSQL and
two real node processes, with the capacity knobs set by the test.

## The two defects this found

Both were in the product, both were found by the first honest run of the suite,
and both are fixed with counterfactually verified tests.

### 1. An unreachable node vanished from the answer

`placement_preflight::gather` selected

```sql
WHERE revoked_at IS NULL AND status='READY' AND last_seen_at > ...
```

So a node that was `UNREACHABLE` or `DEGRADED` did not appear in the per-node
answers **at all**. The caller saw an empty `nodes` list and a `CAPACITY_BLOCKED`
verdict with nothing to blame — and "there are no nodes" is a very different
message from "the node exists and is not ready", which is what `NODE_NOT_READY`
exists to say.

Measured before the fix: mark node-a `UNREACHABLE`, ask for a plan, and the
per-node codes contained no `NODE_NOT_READY`. After: the node is present with its
own code, and the surviving node still reports `FITS` — the refusal is per node,
not a blanket.

`evaluate_node` already rejected non-READY nodes with `NodeNotReady`. The filter
was hiding the answer, not producing it.

### 2. "No eligible node" for a cluster that is merely too small

Five replicas on two healthy nodes reported `reason=NO_ELIGIBLE_NODE` with no
detail. The nodes are eligible; there are too few of them.

`furthest` is `None` when every node individually FIT, and the fallback turned
that into `NO_ELIGIBLE_NODE`. It is now `NOT_ENOUGH_NODES`, and the refusal
carries its numbers at the top level:

```
5 replica(s) requested, 2 placeable: the nodes are eligible,
there are not enough free slots across them
```

A third change came with it: `Preflight` gained a top-level `detail`. A refusal
whose only text is a code is a boolean in disguise, and a caller should not have
to reconstruct the arithmetic from `nodes[]` to know whether to add a node or
shrink the request.

## What the suite asserts

Six rejection codes, each constructed deliberately and asserted **by code and by
the numbers behind it**:

| condition | code | the detail it must name |
|---|---|---|
| more replicas than slots | `NOT_ENOUGH_NODES` | requested vs placeable |
| a selector no node satisfies | `SELECTOR_MISMATCH` | the label key |
| more millicores than the node has | `CPU_INSUFFICIENT` | requested vs budgetable |
| more MiB than the node has | `MEMORY_INSUFFICIENT` | requested vs available |
| the only candidate is not READY | `NODE_NOT_READY` | per node, not blanket |
| an old version holding a slot | counted in `instances_on_node` | occupancy |

And the assertion a capacity preflight most needs:

**`FITS` is not a promise.** The suite checks that the preflight is read-only
(instance count unchanged across calls) *separately* from any deploy outcome, and
records the product's own caveat:

> read-only estimate at the moment this ran; the scheduler still re-evaluates
> every slot, and another deployment may place in between

## Measured

```
16 passed, 0 failed, 1 skipped
```

The skip is coexistence: a fresh platform has no deployment, so there is no old
version to coexist with. It reports that rather than passing silently.

## What this does not prove

- **Not staging.** One host, capacity knobs set by the script. The brief forbids
  claiming a staging acceptance from this, and none is claimed.
- **Not that `FITS` means the deploy succeeds.** That is the point of the caveat
  and of case 6.
- **Not the multi-node scheduling path.** Two nodes exist and are asked about
  individually; a real two-machine placement is TASK-12/15's ground.

## Running it

```bash
tests/ci/phase8_capacity_preflight.sh          # needs docker + PostgreSQL
```

Registered in `plugin-lifecycle.yml` after the image build, with its log in the
evidence artifact; the zero-assertion meta-test checks both.
