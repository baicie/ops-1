# Phase 9 final closeout

Baseline: `main` at `63ef2451`, plus the branch that carries TASK-26–30.

**Verdict: the code phase is COMPLETE. The product release verdict is BLOCKED**,
because real staging has not passed a deployment acceptance. That distinction is
the point of this document and is not softened anywhere below.

## Task map

| task | what it was | outcome |
|---|---|---|
| 01–05 (9A) | lifecycle audit, reproduce the staging 4/4 shape | done — #231, `docs/ci/phase9a-lifecycle-audit.md` |
| ADR-030 | what may be reclaimed | done — #232 |
| 08–09 (9B) | one reclaim decision, reuse DRAINING | done — #233 |
| 10 | correctness matrix: one counterexample per protection | done — `docs/ci/phase9b-reclaim-matrix.md` |
| 11 | PREPARING convergence, no deadline | done — #235 |
| 12 | redeploy must not claim slots first | done — #236; **two CI-caught regressions** on the way |
| 13 | generation fencing on status write-back | done — #238 |
| 14 | activate/reclaim under a real barrier | done — #239 |
| 15 | a stopped instance stops naming a container | done — #240 |
| 16 | twenty publish cycles, both release paths | done — #241 |
| 17 | staging change plan | done, **`BLOCKED_AUTH`** — plan only, no action |
| 18–21 (9D) | real staging recovery | **not executed** — no authorisation |
| 22 | failure-injection inventory | done — 12 gaps closed, `docs/ci/phase9e-failure-injection-inventory.md` |
| 23 | diagnostics | partially — TASK-27 scoping landed; the rest is P2 |
| 24 | CI efficiency | superseded by Phase 10A (TASK-31–35) |
| 25 | closeout | this document |
| 26 | #246 finish, correct the Maven section | done |
| 27 | scope the placement diagnosis | **done, and it was a real defect** |
| 28 | drive the supervisor loop | **done, and it found a real defect** |
| 29 | risk matrix instead of an unbounded list | done — in the inventory document |
| 30 | this closeout | — |

## The defects this phase actually fixed

Not test gaps — behaviour that was wrong.

| # | defect | how it was found | evidence a counterfactual would have caught it sooner |
|---|---|---|---|
| 1 | a redeploy claimed its old rows' slots before anything evaluated whether they fit, then the "fix" (setting STOP) broke redeploy entirely | measured on staging, then twice on CI while a local run passed | the first fix passed every capacity assertion and broke every deploy — **one test that counts a redeploy as "does it come back" would have caught it in seconds** |
| 2 | `container_id` was never cleared when an instance stopped, so ADR-030 D4's "a container may still be running" guard never lifted | separating the slot from the container (TASK-15) | the guard was fail-closed, so nothing failed — it silently became a permanent block |
| 3 | `supervise`'s `Err` branch never recorded `restart_count`; a container that failed five times ended `Failed` with count 0 | driving the loop instead of its decisions (TASK-28) | the pure-function tests all passed; only asserting the count in the real loop exposed it |
| 4 | `diagnose_placement` scanned every node, so a deployment whose label matched nothing could be told its obstacle was CPU on an unrelated host | three failed attempts to test it — **the failure was the finding** | the test could not be made stable against the defect |
| 5 | the preflight's four occupancy inputs were never populated, so it answered "empty node" for every question | reading the test helper instead of the function (TASK-22) | the endpoint told operators FITS for deploys the planner refuses |

Two of these five (#3, #4) were found by this phase's own work rather than by
staging.

## Counterfactual results

Every claim in Phase 9E is a test with a mutation that makes it fail. The ones
whose mutation makes the system **report success** are listed separately, because
they are the ones no ordinary test suite would ever surface:

| mutation | what the system does instead of failing |
|---|---|
| skip the instance count on activation | returns **200** and creates an ACTIVE revision for a deployment whose second replica is STARTING |
| remove `DEPENDENCY_BLOCKED` | `disable` returns **200** and stops a provider an active consumer requires |
| ignore `reserved` in the preflight | verdict **FITS** for a node whose CPU is already spent |

**A red test is loud; a successful lie is not.**

## Invariants, and where each is enforced

| invariant | enforced by | proven at |
|---|---|---|
| a node reports only about instances it hosts | `INSTANCE_OBSERVATION_SQL`'s `node_id` | L2, counterfactual removes it |
| an observation from a superseded generation does not land | the same statement's `deployment_generation` | L2, counterfactual removes it |
| a status computed from an older generation does not land | `STATUS_WRITE_BACK_SQL`'s `generation=$4` | L2, counterfactual removes it |
| activation requires every replica READY | `activate_inner`'s re-count | L2, counterfactual makes it return 200 |
| a redeploy reclaims nothing before the planner looks | the ghost write in `create_deployment_inner` | L2 |
| a released slot is visible to the next placement | the planner's own aggregate | L2 |
| the diagnosis names a node in the deployment's range | `diagnose_placement`'s selector filter | L2, counterfactual removes it |
| uninstall removes the route before anything else | `uninstall_inner` | L2 |
| a node older than the Kernel's generation is refused | `check_node_generation` | L1 |

## Component evidence versus real staging

This is where the phase is honest about what it does not have.

| claim | component evidence | staging evidence |
|---|---|---|
| the four release paths do not leak across 20 cycles | **yes** — TASK-16, two phases, two counterfactuals | **no** |
| a redeploy places again with no room to move | **yes** — `a_redeploy_on_a_pinned_node_still_places_again` | **no** |
| a stopped instance releases its physical container | **partly** — the Node clears the id; the Kernel never observes the exit independently | **no** |
| capacity is reclaimed safely | **yes at L2** | **no** — the change plan is `BLOCKED_AUTH` |
| the product golden path works end to end | **no** — that is TASK-44 | **no** |

**No fixture, no isolated environment, and no component test is presented here as
a staging acceptance.**

## Current known limitations

1. **Staging has not passed a deployment acceptance.** The node is 4/4 with three
   `ACTIVE` and one `DEGRADED` occupant (measured); at most one is a release
   candidate and its eligibility depends on four booleans nobody has read.
   Recovery is a plan, not an execution.
2. **Three P1 risks remain open**: redeploy while the old version is DRAINING,
   repeated enable/disable cycles, and quarantine during a pull. Each has a named
   successor in the inventory's risk matrix.
3. **Maven Central 429** costs a 40–60 minute rerun. The retry wrapper exists and
   fired once on run 45931039517; the observed window outlived its 30 s backoff.
   Phase 10A is where this is addressed, by warming the dependency set rather than
   by waiting longer.
4. **The supervisor loop** is driven for two scenarios (cancel-before-work,
   budget exhaustion). The other eight TASK-28 listed are not, and the loop's
   cleanup path alone costs ~75 s per test, which is why.
5. **The Gateway's routing** is proven by `route_candidates` unit tests and by the
   existing live acceptance; Phase 9 added no new gateway evidence.

## Index

| item | reference |
|---|---|
| Phase 9A audit | `docs/ci/phase9a-lifecycle-audit.md` |
| ADR-030 | `docs/adr/ADR-030-failed-candidate-reclaim.md` |
| reclaim matrix | `docs/ci/phase9b-reclaim-matrix.md` |
| TASK-12 … TASK-16 | `docs/ci/phase9c-*.md` |
| staging change plan | `docs/ci/phase9d-staging-change-plan.md` |
| failure-injection inventory + risk matrix | `docs/ci/phase9e-failure-injection-inventory.md` |
| this closeout | `docs/ci/phase9-final-closeout.md` |

Merged on main: #231, #232, #233, #234, #235, #236, #238, #239, #240, #241, #242,
#243, #244, #245.

## What would move the verdict

1. **Authorisation for the four read-only queries** in the staging change plan.
   They can come back saying there is nothing to reclaim, which is a legitimate
   finish — but until they run, every capacity statement about staging is an
   inference from one artifact.
2. **A real staging deploy → activate → verify** with the release identity chain
   of TASK-38. Until then, "the platform can deploy a plugin" is proven only at
   L2/L3.
3. **Phase 10A's warmed dependency set**, so the expensive acceptance jobs stop
   depending on Central's availability at the moment they run.

Until (1) and (2), `PRODUCT_RELEASE = BLOCKED`.
