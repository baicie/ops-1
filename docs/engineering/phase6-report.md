# Phase 6 — final engineering report

Written 2026-11-23 against main `800c21e2`. Every row states what proves it. A row
with no evidence says so.

States: `FIXED` `ALREADY_DONE` `VERIFIED_NOT_A_DEFECT` `PREVENTIVE_ONLY`
`BLOCKED_AUTH` `BLOCKED_ENV` `NOT_RUN` `NEEDS_REVIEW`

## Start and end

| | |
|---|---|
| start main | `6ef12bce` (#204 merged) |
| end main | `800c21e2` (#207 merged) |
| PRs this phase | #205, #206, #207 |
| open PRs at end | 0 |
| branches left | 0 |

## Wave A — Release receipt correctness

| TASK | State | PR | Test | Evidence |
|---|---|---|---|---|
| 01 required suite non-success certified | **FIXED** | #205 | `scripts/release-receipt.test.mjs` | measured: receipt `rust=failure` + run `rust=failure` returned CERTIFIED before, REFUSED after |
| 02 old success masks new failure | **FIXED** | #205 | same, 3 cases | `[{rust,success},{rust,failure}]` returned `{rust:"success"}`; now delegates to `checkState` |
| 03 `unique_by(.name)` in the cert workflow | **FIXED** | #205 | `scripts/ci/release-check-ledger.test.mjs` (9) | four measured inputs; two were wrong, and a red suite reported green |
| 04 receipt identity from outside | **FIXED** | #205 | `release-receipt.test.mjs` | `verify` now REFUSES without `--expect-sha`/`--expect-repository` |
| 05 check provenance | **FIXED** | #205 | same, 6 cases | `REQUIRED_SUITE_PRODUCER` for all ten; impostor/ambiguous refused |
| 06 pagination / incomplete data | **PREVENTIVE_ONLY** | #205 | `incomplete` case | one page read; no run observed crossing 100. Refuses, but never triggered |
| 07 code vs deployment certification | **FIXED** | #205 | 7 cases | four states; `STATES_THIS_FILE_PROVES=['CODE_CERTIFIED']` |
| 08 certification isolation acceptance | **PARTIAL** | #205 | `resolve-certification-target.test.mjs` (11) | the TARGET decision is tested; the workflow has never been dispatched |

TASK-08's limit, stated: writing its cases found two real defects (`OUT="$(cmd)"`
does not trip `set -e`; an uppercase SHA would resolve a target whose own receipt
fails validation). Neither was found by running the workflow.

## Wave B — Ruleset

| TASK | State | PR | Evidence |
|---|---|---|---|
| 09 nine-context hard-coding | **FIXED** | #205 | `historical-nine` / `candidate-ten` profiles; 10 selftest cases |
| 10 lossless migration payload | **FIXED, NOT APPLIED** | #205 | generated from the live ruleset; `--against-live` reports "adds only required_status_checks" |
| 11 required-context producers alive | **FIXED** | #206 | static 9 problems' worth of checks + `--live` against `/actions/workflows`; all ten active |
| 12 required-check red/green counterfactual | **NOT_RUN** | — | needs a test PR against a live ruleset; requires authorisation |
| 13 ruleset rollback design | **FIXED** | #206 | `--verify-readback`; rollback payload verified against the pre-migration snapshot |

**The gate is still advisory.** Required status checks: **0**. Nothing in this phase
changed that, and `docs/ci/ruleset-migration-ten-contexts.md` has the payload and the
procedure waiting for a decision.

## Wave C — Staging

| TASK | State | Evidence |
|---|---|---|
| 14 capacity preflight | **FIXED** | `GET /api/v1/capacity/preflight` calls the scheduler's own `evaluate_node`; 8 cases + a cross-check that it counts what the planner counts |
| 15 four occupants lifecycle | **BLOCKED_ENV** | `opsctl capacity` is the read-only tool; no staging access, so NO audit was performed |
| 16 precise deployment retire | **FIXED, NOT RUN** | `POST /deployments/{id}/retire` with generation CAS + active-revision refusal; 6 pure-function cases; never executed against a real kernel |
| 17 single-node upgrade capacity | **BLOCKED_ENV** | needs the real node's resource snapshot. `compose.yaml` is not that |
| 18 publish phase state machine | **FIXED** | `scripts/ci/publish-phases.mjs`, 12 cases; `scriptDrift` ties it to the script |
| 19 publish failure recovery | **PARTIAL** | 5 of 11 conditions ALREADY_COVERED, 1 PARTIALLY, **5 NOT_COVERED** — see `docs/engineering/publish-failure-coverage.md` |
| 20 registry digest wiring | **FIXED** | `publish-data-plugins.sh` calls it; verified end to end against a real `registry:2` |
| 21 version identity collision | **NOT_RUN** | ADR-025 has the analysis; no implementation |
| 22 publisher key isolation | **NOT_RUN** | the key still enters the kernel container |
| 23 staging result contract | **NOT_RUN** | — |

## Wave D — Platform kernel

| TASK | State | Evidence |
|---|---|---|
| 24 concurrent reservation counterfactual | **FIXED** | `reconcile_once_scoped` takes a planner advisory lock. Measured, 12 runs each: **1–4 failures without, 0 with** |
| 25 CPU and memory independent refusal | **FIXED** | 4 cases on the real reconcile path; counterfactual (memory refusal labelled CPU) fails the test |
| 26 ghost slot semantics | **ALREADY_DONE** | `must_rebuild`'s three-way rule has a unit test plus two integration tests |
| 27 reconciler convergence | **NOT_RUN** | — |
| 28 two-node acceptance | **BLOCKED_ENV** | one node exists |
| 29 worker fencing | **ALREADY_DONE** | 6 of 7 conditions have named tests; the seventh is in `jobs.rs` |

**A defect this phase introduced and fixed**, recorded because it is the kind of
thing a report like this usually omits: the planner lock made **5 existing tests
fail**, because they run in parallel against one database and a `try_lock` loser
returned `Ok(())` having planned nothing. The lock was right; its effect on the
harness was not. `only_deployment.is_some()` now waits.

## Wave E — CI measurement

| TASK | State | Evidence |
|---|---|---|
| 30 sample identity | **ALREADY_DONE** | #204 |
| 31 skipped vs runner-assigned | **VERIFIED_NOT_A_DEFECT** | `started_at` is absent for a job that never got a runner; #204's split covers it |
| 32 job-level wait bounds | **NOT_RUN** | — |
| 33 golden path timing | **NOT_RUN** | needs measurement runs |
| 34 plugin lifecycle cost | **NOT_RUN** | — |
| 35 CI efficiency acceptance | **NOT_RUN** | no optimization was attempted, so there is nothing to accept |

## Wave F — Product

| TASK | State |
|---|---|
| 36 real Zabbix | **BLOCKED_ENV** |
| 37 real LLM investigation | **BLOCKED_ENV** |
| 38 investigation/report UI | **NOT_RUN** |
| 39 golden incident case | **NOT_RUN** |

## Wave G — Repository

| TASK | State | Evidence |
|---|---|---|
| 40 script and entry audit | **NOT_RUN** | — |
| 41 historical asset cleanup | **PARTIAL** | the ambiguous rows are now `UNKNOWN` (11) instead of silently `A`; **nothing was deleted** |
| 42 single source of truth | **NOT_RUN** | — |

## Quality

- **New false PASSes introduced:** none known. Three were REMOVED (#203 gate, #205
  receipt, #205 certification `unique_by`).
- **Gate still advisory:** yes. 0 required status checks.
- **Receipt forgeable?** It was, three ways. `verify` now refuses without an
  externally supplied SHA and repository, and every required suite must be `success`
  on both sides. `ARTIFACT_VERIFIED` and `STAGING_ACCEPTED` are refused because this
  file has no evidence for them.
- **Ruleset payload ready?** Yes, `docs/ci/ruleset-candidate-ten.json`, verified
  against the live snapshot. **Not applied.**

## Performance

No performance claim is made. Nothing was optimized this phase:

| | Before | After |
|---|---|---|
| Golden Path | ~23–24 min (unchanged) | not measured again |
| Plugin Lifecycle | unchanged | — |
| Runner minutes | unchanged | — |
| Time to first failure | unchanged | — |
| Queue sample coverage | successes only | **all outcomes** (#204) — a measurement fix, not a speedup |

## Release

- **Staging blocker:** `INSTANCE_CAPACITY_EXCEEDED`. Four occupants hold the
  per-node limit of four. Three are ACTIVE revisions of plugins whose current
  version is also deployed, so this is **not** garbage collection.
- **Observed, not reproduced.** The failure appears in production logs and has never
  been reproduced in isolation.
- **Registry digest:** verified against a real registry for the first time. The
  digest the host recorded on staging does not exist in the registry (404).
- **Release certification:** never executed. The workflow exists; no run.

## Product

- Real Zabbix: **not verified**
- Real LLM: **not verified**
- Incident → Verdict → Close: **not verified**
- Browser E2E: unchanged from before this phase
- Still unverified: everything in Wave F, staging acceptance, two-node.

## What this phase is actually worth

Seven of the thirteen FIXED items were **code that existed and was not connected** or
**a check that was connected to the wrong question**:

- `verify-registry-digest.mjs` — no caller for weeks
- `OWNERSHIP_COMPLETENESS` — referenced in three comments, never defined (#203)
- the receipt CLI — forwarded 3 of 8 facts to the verifier
- `unique_by(.name)` — a second implementation of a rule that already had tests
- `placement_preflight` — 8 passing tests and no caller, caught by clippy (#205)
- the publish script — embedded a digest nobody asked the registry about
- the PNG classifier — flagged ambiguity and then counted it as "do not delete"

**The recurring defect in this repository is not a wrong answer. It is a right
answer wired to the wrong question, or to nothing at all.** That is why the tests in
this phase are mostly counterfactuals against the old behaviour rather than cases
for the new one.

## Authorisation needed

1. **Write ruleset 26958761** from `docs/ci/ruleset-candidate-ten.json` — makes the
   gate blocking. Procedure and rollback are in `docs/ci/ruleset-migration-ten-contexts.md`.
2. **Run a publish against staging** — the digest check and the phase model are
   untested there.
3. **`opsctl capacity` against staging** — the four occupants have never been audited
   from a live read.
4. **Two-node environment** — blocks TASK-28 and the two-node half of the charter.
