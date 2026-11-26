# Phase 9C — TASK-13: generation fencing across the lifecycle

Baseline after `e0f774ae`. Claims are tests in `apps/kernel/src/deployments.rs`
(module `generation_fencing`) and `apps/kernel/src/nodes.rs` (module
`observation_order`), run against real PostgreSQL.

## The five interleavings the brief lists, and where each stands

| brief's invariant | status |
|---|---|
| an older generation must not overwrite a newer one (status) | **was broken, fixed here** |
| an old STOP must not stop new instances | **already fenced** — `desired_action` is written per instance id, and `reconcile_deployment` only stops rows whose `slot >= desired_replicas` |
| an old READY must not revive a failed deployment | **already fenced** — `INSTANCE_OBSERVATION_SQL` (`nodes.rs:412`, the `WHERE` at `:417`) guards on `deployment_generation = $11` **and** `observed_at < $4` |
| a delayed observation must not overwrite a newer one | **already fenced and tested** — module `observation_order`, which says in its own comment why the guard exists: a report saying "STARTING at T1" can land after "READY at T2" |
| an old runtime report must not change a new release intent | covered by the above two |

Three of the five were already handled. This document is about the one that was
not, and about not re-asserting the ones that were.

## The defect, reproduced

`reconcile_deployment` computes a status from facts it read at the start of the
pass: instance states, the `ready`/`starting`/`failed` counts, and `is_effective`.
It then writes with:

```sql
WHERE id=$1 AND status<>'DRAINING'
```

**No generation predicate.** Between the read and the write,
`create_deployment_inner` can reset the row to `PENDING` with `generation+1` — a new
attempt whose intent is the opposite of a status computed from the old one's
instances. The write still matches, and the newer intent is overwritten by a
computation about an attempt that no longer exists.

Reproduced in `a_status_from_an_older_generation_does_not_overwrite_a_redeploy`:
read generation 1, bump the row to generation 2 the way a redeploy does, then run
**the production statement** bound to the generation the stale computation was made
from. Before the fix, `rows_affected` was 1 and the row read `READY` at generation 2.

## The fix

```sql
WHERE id=$1 AND status<>'DRAINING' AND generation=$4
```

The write simply does not match a row that has moved on. The next pass reads the
new generation's facts and writes a status derived from those — the only writer whose
answer is about the current attempt.

**The statement is a constant now** (`STATUS_WRITE_BACK_SQL`). The test runs it
rather than a copy, because a copy lets a counterfactual that removes the fence from
the real statement leave the test green — the exact defect `nodes.rs` already
documents for the observation query:

> The first version of this helper repeated the SQL. A counterfactual that removed
> the `observed_at` guard from `heartbeat` left the test GREEN, because the test was
> running its own query.

## Counterfactual

Removing `AND generation=$4` fails
`a_status_from_an_older_generation_does_not_overwrite_a_redeploy` with:

```
a status computed from generation 1 must not land on a row that is now at
generation 2: the redeploy's intent is newer than the facts this write was derived from
```

## Why this is not a lock

The brief asks for "row locks / generation compare-and-set / atomic state conditions"
and warns against "unnecessary global locks". This is the compare-and-set option: the
predicate is the current generation, so a writer that lost the race matches zero rows
and does nothing. No lock is held across the read, no transaction is widened, and a
concurrent writer is never blocked — it wins or loses by the version it names.

`create_deployment_inner`'s own redeploy write is also unscoped on generation, but it
is a read-modify-write inside one request under the row it just fetched; making it
conditional would change what it does when it loses (it would silently do nothing
instead of redeploying). That is a separate decision and is not taken here.

## What this does not cover

- **No staging observation.** No staging deployment is being redeployed concurrently
  with a reconcile at the moment of writing; the four occupants are three `ACTIVE`
  and one `DEGRADED` (`capacity.json`, run 45799322906).
- **Not TASK-14.** The activate/reclaim race needs a genuine concurrency test with a
  barrier, and this fence is an input to it, not a substitute.
- **Not TASK-15/16.** Physical release measurement and the repeated cycle are separate.
