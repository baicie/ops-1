# Phase 9C — TASK-14: activate and reclaim, concurrently

Baseline after `51439d66`. Claims are tests in `apps/kernel/src/deployments.rs`
(module `activate_reclaim_race`) run against real PostgreSQL, three of them through a
genuine concurrent transaction with a barrier.

## The outcome the brief forbids

> 「回收先判定符合条件；激活随后成功；回收继续停止已经 ACTIVE 的实例。」

Activation writes two things inside one transaction: an `ACTIVE`
`activation_revisions` row, and the deployment's `status='ACTIVE'`. The reclaim sweep
writes one thing, in its own statement: `status='DRAINING'`. **Neither is inside the
other's transaction**, so the question is whether the predicates alone are enough.

They are. This document says which predicate does what, and how each was measured.

## Ordering A — the reclaim decides first, activation commits second

`activate_inner` moves the row to `ACTIVE` and inserts the revision. The reclaim's
write is:

```sql
WHERE id=$1 AND status=$2 AND generation=$3
```

`$2` is the status the reclaim *read*. Activation changed it to `ACTIVE`, so the
predicate no longer matches and `rows_affected` is 0. **The reclaim does nothing**,
and the candidate keeps serving instead of being drained underneath a route that
just started pointing at it.

Measured: `a_reclaim_that_lost_the_race_does_not_drain_an_activated_candidate`.
Counterfactual: removing `AND status=$2` makes it fail with *"the reclaim's
`status=$3` fence must refuse a row that activation moved to ACTIVE; without it a
live route is drained"*.

## Ordering B — the reclaim commits first, activation tries

`activate_inner` refuses anything that is not `READY` (`DEPLOYMENT_NOT_READY`,
`deployments.rs:648`). A drained candidate is `DRAINING`, so activation cannot
proceed. The two outcomes are mutually exclusive **by the state machine**, not by
their order.

Measured: `activation_refuses_a_candidate_the_reclaim_already_drained`.

## The real race — two connections, one barrier

The two tests above order the operations deliberately, which proves the predicates
are right but not that they hold under concurrency. The brief is explicit:

> 「测试必须使用真实 PostgreSQL 并发事务和 Barrier，不能仅顺序执行两个 mock。」

`concurrent_activate_and_reclaim_never_produce_both_outcomes` spawns two tasks on
pooled connections, each with its own transaction, meeting at a
`tokio::sync::Barrier`. One activates, one reclaims, both reads happen before the
barrier and both writes after it. The assertion is on the *pair* of outcomes:

| activated | reclaimed | required final state |
|---|---|---|
| yes | no | `ACTIVE`, one ACTIVE revision |
| no | yes | `DRAINING`, no ACTIVE revision |
| no | no | `READY`, untouched |

`(true, true)` is the forbidden combination and the test fails on it explicitly.
Both-back-out is legal — the two fences are compare-and-set, so a writer that lost
does nothing rather than retrying — and the row must then carry no trace of either.

## Why there is no lock

The brief says "prefer the existing transaction, row locks, generation
compare-and-set, atomic state conditions, existing receipts; do not introduce
unnecessary global locks". This is compare-and-set on two independent predicates:

- **status** — the reclaim's `$2` refuses a row activation moved;
- **generation** — TASK-13's fence, which refuses a row a redeploy moved.

No lock is held across either read, so neither operation can block the other; they
collide only at the write, where exactly one wins. A global lock would serialise
every activation behind every sweep for no additional guarantee.

## What this does not cover

- **No staging observation.** staging has no concurrent activate-and-reclaim: the
  four occupants are three `ACTIVE` and one `DEGRADED` (`capacity.json`, run
  45799322906), and nothing is being activated.
- **Not TASK-15.** This proves the two control-plane writers cannot both win. It does
  not prove that a stopped instance's physical resources are released — that needs the
  Node, and it is the next task.
- **Not TASK-16.** The repeated release cycle is separate.

## One thing worth carrying

The first version of these tests was two sequential mock calls — which is exactly
what the brief rules out, and for a reason this task demonstrates: sequential
execution cannot distinguish "the predicate is right" from "the order happened to be
favourable". The barrier test is the one that would catch a predicate that reads
correctly and races badly.
