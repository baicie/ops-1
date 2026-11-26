# Phase 9C — TASK-16: the repeated release cycle

Baseline after `0259a544`. One test in `apps/kernel/src/deployments.rs` (module
`repeated_release_cycle`) against real PostgreSQL, plus two counterfactuals run by
hand and recorded below.

## Why a single cycle is not enough

Phase 9A–9C fixed four paths that each leaked or mis-accounted for a scheduling
slot, one at a time:

- a READY candidate that was never activated and was overtaken (9B),
- a superseded version's 15-second drain (ADR-027),
- a `DISABLED` deployment whose instances kept `desired_action='START'`,
- a redeploy's old rows (TASK-12: ghosts, not claims and not stops).

Each was proven **in isolation**. None was proven to hold across many cycles, which
is what staging actually does: every push publishes a new version, and a node with
a fixed number of slots serves a handful before it is full.

ADR-027 records what that looks like when one path leaks:

```
publish 0.0.17453 -> deployment A, 1 instance, node 1/4
publish 0.0.17454 -> deployment B, 1 instance, node 2/4  (A still up)
publish 0.0.17455 -> deployment C, 1 instance, node 3/4  (A, B still up)
publish 0.0.17456 -> deployment D, 1 instance, node 4/4
publish next      -> INSTANCE_CAPACITY_EXCEEDED
```

## The invariant that can fail, and the one that cannot

The obvious assertion, `occupancy <= limit`, is **true by construction**:
`evaluate_node` refuses any placement that would exceed the limit, so the count can
never pass it. A test built on it passes against every possible leak.

The failure that actually happened is the other direction — the node fills up,
nothing releases, and the next publish is refused after a full image build. So the
assertion is on **release**: twenty consecutive publishes of distinct versions must
each leave exactly one version holding a slot, and no version may linger in
`DRAINING`.

The node is filled to `limit - 2` by a foreign plugin that no reclaim rule may
touch (READY, no successor, no ACTIVE revision), so the plugin under test has
exactly two slots. Two is the real requirement, not one: deploy-then-activate needs
the serving version and the one being placed to coexist for the length of a cycle.
**A node with no room for the transition cannot transition** — that is the ADR-027
failure stated as a precondition rather than as a symptom.

## The two release paths, separated in time

The first version of this test activated two rounds out of three, and that made it
useless against the supersession rule: a counterfactual that disabled supersession
entirely still passed, because the drain from the previous round had already
released the slot. **A test whose protection can be removed without changing its
result is not testing that protection.**

So the cycle runs in two phases:

| rounds | what is in play | counterfactual |
|---|---|---|
| 0–10 | never activated; only supersession can release | disable supersession → round 1 fails |
| 10–20 | activated every round; only the drain sweep can release | disable the drain sweep → round 1 fails |

Both counterfactuals were applied to the source and run, then reverted.

## Three things that went wrong, all mine

Every one produced a failure that looked like the product and was not.

1. **The test node went stale.** `reconcile_deployment` selects only nodes seen
   within `node_stale_seconds` (25 by default). A test node created once and never
   refreshed stops being a candidate after 25 seconds, every instance is stopped for
   lack of a node, and the symptom is `PENDING` forever. A real node heartbeats; the
   test now does too.

2. **The sweep ran before the publish that made it applicable.** Supersession's
   `a_sibling_is_waiting` requires a `PENDING`/`PREPARING` sibling, so it can only
   fire once the new version exists. Running it before `create_deployment_inner`
   found no waiting sibling and released nothing; the cycle stopped at round 2 with
   `INSTANCE_CAPACITY_EXCEEDED` while two predecessors still held their slots. The
   correct order is also the real one: the reconciler ticks independently of
   publishes, so a publish always lands before the pass that releases what it
   superseded.

3. **`reconcile_once` places every deployment in the database.** This suite shares
   one PostgreSQL with ~390 other tests, and some of them place deployments with an
   empty selector — which matches every node, including the one this test created.
   Measured twice, with the limit at 4 and again at 12: a foreign deployment took
   the reserved slots and the publish under test was refused for a slot it never
   took. Raising the limit did not help, because the foreign placement took the new
   headroom too. The test now drives the three release paths itself, restricted to
   its own plugin, and calls `reconcile_deployment` per deployment rather than the
   full sweep.

## The assertion that had to be added

With the ceiling alone, a `DRAINING` row still holds `desired_action='START'` and
was counted as one of the two — so a drain sweep that never completed left a
predecessor holding its slot **indefinitely** while the test stayed green. Measured
with the sweep disabled: `cycle-18` sat in `DRAINING` at the end of a 20-round run
and nothing failed. The assertion that catches it is that no row is past its drain
window.

**The lesson is the same one TASK-10 recorded**: a count that is merely not growing
says nothing about whether the thing behind it still works.

## What this does not prove

- **Not staging.** staging has four occupants, three `ACTIVE` and one `DEGRADED`
  (`capacity.json`, run 45799322906), and nothing is publishing to it. This cycle is
  run against a disposable database.
- **Not fault injection.** Failures, cancellations and node restarts interleaved
  with the cycle are Phase 9E's subject (TASK-22–25). This test interleaves the two
  release paths, not process faults.
- **Not the CPU/memory reservation.** The assertion is on slot count. Resource
  accounting after a release is not measured here for the same reason TASK-15 did
  not measure it: the Kernel does not track per-instance CPU after an instance
  stops.
