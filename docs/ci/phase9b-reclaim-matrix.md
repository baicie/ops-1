# Phase 9B — the reclamation correctness matrix (TASK-10)

Baseline `cb88d698`. Every result below was produced by mutating the source and
running the full kernel suite against real PostgreSQL, then restoring the file.
The mutation was an exact string replacement asserted to match; a mutation that
did not apply would have been reported rather than counted.

**What this measures.** A test suite that passes is not evidence that each
protection does something. A protection whose removal changes no test result is
not a protection — it is a comment with a `return` in front of it. So each of
ADR-030's conditions was removed, one at a time, and the tests that noticed were
recorded.

## The matrix

| # | protection removed | tests that fail |
|---|---|---|
| E2 | the ACTIVE-revision check | `an_active_revision_protects_even_a_ready_deployment`, `a_degraded_deployment_that_is_effective_is_protected`, `both_halves_together_are_protected` |
| E1 | the "a newer same-plugin deployment exists" check | `a_deployment_with_no_successor_is_protected` |
| E5 | the "something is waiting" check | `nothing_waiting_means_no_reclaim` |
| E8 | the "a failed candidate may still have a container" check | `a_failed_candidate_that_may_still_have_a_container_is_not_reclaimed` |

All four are caught. **Every one is caught by a unit test and by nothing else.**

## The gap that matters, stated plainly

The integration tests in `staging_capacity_shape` — the ones that build the real
4/4 topology and run the real sweep — **did not fail for any of these mutations.**

That is not a small thing, and it is the single most useful result in this
document. The integration layer proves the rule is *wired in*, and the unit layer
proves the rule *decides correctly*; neither proves the other. A future change that
keeps the wiring and breaks a decision would pass every integration test.

Why each integration test misses:

| mutation | why `staging_capacity_shape` did not notice |
|---|---|
| E2 removal | the serving rows in that fixture are `status='ACTIVE'`, and the status gate (E4) excludes them before the revision check is ever consulted. Phase 9A recorded this same gap when it first tried to write the test. |
| E1 removal | the fixture's candidate always has a successor, so the removed check never fired. |
| E5 removal | the fixture's sibling is always `PENDING`/`PREPARING`, so the removed check never fired. |
| E8 removal | the released candidate in the fixture is given `container_id = NULL` — the safe shape — so the refusal never fired. |

Each is the same defect in the fixture: **it carries only the cases that pass.**
The protections are exercised by the unit tests, which is real coverage, but the
integration suite never sees a row that a protection is holding back.

## What would close it

One fixture per protection, each shaped so that the protection is the ONLY thing
between the row and release:

- a `DEGRADED` row with an ACTIVE revision (E2) — needs the reconciler to re-plan
  it, which `reconcile_once_scoped(Some(other))` does not do; the honest way is to
  let a real full sweep run
- a plugin's only version (E1)
- a candidate with no waiting sibling (E5)
- a failed candidate whose instance still references a container (E8)

**This is not done in this PR.** It is the remaining half of TASK-10, and it is
recorded rather than simulated with a test that would assert the unit layer twice
and call it integration.

## What the matrix does establish

1. Each of the four conditions is load-bearing: removing it changes a test
   outcome. None of them is decorative.
2. The rule is a single decision (`reclaim_eligibility`) that both the sweep and
   the preflight call, so a mutation applied once affects both. There is no second
   copy to fall out of step.
3. The failure messages name the protection, not a symptom — which is what makes
   the next person able to tell which one they broke.

## Method note

`scripts/ci/reclaim-matrix.sh` automates this. It is **not** a CI test: it mutates
the working tree, runs the suite, and restores. Its first run was abandoned after
ten minutes because the output was captured by command substitution and could not
be watched; the four results above were produced by applying the same mutations by
hand, one at a time. The script is kept because the matrix should be re-runnable
when ADR-030 is revised — and because a script that has never been observed to
finish is not evidence of anything.
