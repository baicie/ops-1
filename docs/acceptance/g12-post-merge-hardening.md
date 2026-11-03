# G12 post-merge hardening — acceptance record

- Date: 2026-11-03
- Branch: `fix/g12-post-merge-hardening`
- Base: `main` at `bdcc394` (PR #24, merged 2026-11-03T01:28:38Z)
- Verdict: **PARTIAL** — every item below states what ran and what did not. Nothing marked PASS
  on the strength of a fixture, a mock, or a different host's run.

## 0. Commits in this branch

| Commit | Scope |
|---|---|
| `1eb0220` | Phase A — the create affordance follows role + membership on both entries |
| `eced7d3` | D1 zero-hypothesis outcome; D2 closure invariant (migration 0024); D3 model-protocol tests |
| `534b775` | D4 digest clipping; the two viewer specs brought onto ADR §4.5 |
| `7019fdc` | Phase B — spec-to-workflow coverage gate |
| `ccee3e8` | Phase C — three-stage staging measurement; two separate verdicts |

## 1. Phase A — the create affordance

**Defect.** `PageHeader.primary` was unconditional. Measured against the real kernel, the three
refusals a create can meet are: `FORBIDDEN` (viewer), `INCIDENT_WORKSPACE_FORBIDDEN` (no
membership), `INCIDENT_WORKSPACE_REQUIRED` (several memberships, none named). The page offered
the form to all three.

**Fix.** One derived value, `incidentCreateGate({role, workspaces, workspaceReadFailed, scope})`,
read by the header primary, the empty-state action, and the dialog:
`allowed` | `role` | `workspace` | `unknown`. Several memberships make the dialog ask, and the
body names `workspaceId` only then.

**Measured.**

| Gate | Result |
|---|---|
| typecheck / build | clean / built |
| vitest | 30 files / **415** tests (+9 gate cases) |
| `check-i18n` | 1900 keys / 17 unused (was 21) |
| status-vocabulary / ui-tokens / PNG | clean / PASS / in budget |
| `g12-create-gate.spec.ts` (real kernel) | **8 passed** (19.8 s) |

Counterfactuals: unconditional header primary → "an operator in no workspace gets no entry" fails
(expected false / received true); `!workspaces` treated as allowed → the unit case fails.

**Not covered:** the dialog's own submit for an account whose membership is revoked *while the
form is open*. The server refuses it (403), the form shows the code, but no browser case drives
that transition; it is a gap, not a claim.

## 2. Phase D — known P1s

### D1 zero-hypothesis SUCCEEDED — fixed

`final_answer_outcome(written_hypotheses, any_failed)` now answers SUCCEEDED / PARTIAL / FAILED.
A FINAL with no hypothesis is FAILED with `stopReason: FINAL_ANSWER` (the model did answer; it
stated nothing). A run with no evidence is unchanged: it writes one UNCERTAIN hypothesis with
`NO_EVIDENCE_ROWS` and remains a real conclusion.

Tests: `a_final_answer_is_judged_by_what_it_stated_and_what_it_read` (4 cases),
`no_evidence_still_counts_as_a_stated_hypothesis`. Counterfactual: disabling the zero branch
fails the test with `got SUCCEEDED, expected FAILED`.

**Not done:** `contracts/openapi/investigation-v1.yaml` still does not state the implication. The
semantics live in the code and in this record; the contract edit was attempted and stopped, and
is left for a change with its own review.

### D2 CLOSED invariant — fixed by migration 0024

Measured before the fix, on a real database: `INSERT … status='CLOSED'` with no verdict →
`INSERT 0 1`; after a legitimate close, rewriting `closure_note` / `closed_at` / `closed_by` /
`closure_key` → `UPDATE 1` each.

0024 replaces 0019's `BEFORE UPDATE OF status` trigger with `BEFORE INSERT OR UPDATE` and
extends the function: no row is born CLOSED, and once CLOSED every closure column is write-once
(a no-op stays legal). 0019 is not edited; no history is retro-fitted; the rollback is spelled in
the migration header and is not free.

`tests/acceptance/g12_closure_invariants.sh` → **23 passed / 0 failed**, including that the
legitimate close over HTTP still returns 200 and that a CONCLUDED row with no verdict is still
refused by both the API and the schema. Counterfactual: with 0019's trigger restored, the suite
reports **12 passed / 11 failed**, naming `INSERT 0 1` and every rewrite.

### D3 model protocol — tested, real model BLOCKED

Eight pure tests for `parse_model_decision`: closed stance/confidence vocabulary (refused, never
coerced), invalid shapes → `MODEL_RESPONSE_INVALID`, over-cap truncation, citation UUID parsing
that drops junk, empty FINAL parses, tool names outside the catalogue parse on purpose (the
executor owns that refusal).

**REAL_MODEL_E2E_BLOCKED.** No credential, endpoint or model is configured in this environment;
none was called. Everything above is the fixture and the schema.

### D4 responsive layout — the recorded 8px is gone; a different clipping was found and fixed

Re-measured 5 widths × 2 locales × 2 themes on a record with a verdict: document overflow was
`-15` (scrollbar width) in all 20 combinations, so §7.4's 8px no longer reproduces on this HEAD.
The sweep did find a real one: the verdict's 64-character sha256 sat in an inline `<code>` with no
break opportunity and reached 1609 px inside a 1024 px column, clipped by an ancestor's overflow —
invisible to a document-level `scrollWidth` check and unreachable for a reader. Fixed at the
source (`code { overflow-wrap: anywhere }`), not with `overflow: hidden`, and nothing is shortened.
The responsive spec now asserts every `main code` ends inside the viewport at each width.

Counterfactual: revert the wrap → the digest is back at 1609 px and both the sweep and the new
assertion report it. After the fix: 20/20 combinations clean, 0 elements past the viewport.

## 3. Phase B — spec-to-workflow coverage

`tests/ci/check-spec-coverage.mjs`, wired as the `spec-coverage` job in `ci.yml`. It reads the
command lines that actually run (comments excluded), follows one level of harness indirection,
and reports COVERED / EXPLICIT_SKIP / NOT_REFERENCED. It also checks, **per event**, that every
input a job reads is inside that workflow's `paths:` — "wired in" and "editing it reruns the job"
are different claims.

Found and fixed on this tree: `g12-create-gate.spec.ts` was itself unreferenced;
`typed-pipeline-runtime.yml` runs four `tests/ui` specs on pull_request with none of them in its
paths; `g12-acceptance.yml`'s push paths omitted `tests/ui/g12d-seed.mjs`.

24 specs remain EXPLICIT_SKIP with a reason each (the V3–V10 visual-audit rounds are evidence
instruments with seeds CI does not build). Final state: **27 covered, 24 explicit-skip, 0
unreferenced**. Counterfactuals: removing a spec line from the harness, and removing one path
filter, each turn the check red and restoring it turns it green.

## 4. Phase C — staging, three stages

Full measurement: `docs/acceptance/g12-staging-runner-measurement.md`.

- Host healthy and serving `bdcc394`; `/livez`, `/readyz`, `/api/v1/version` answer in 50–111 ms.
- The failing case's own 21 navigations: 641–1032 ms total, median 51–71 ms per leg; `/access`
  `load` fired in 227 ms.
- The same suite at the same commit and image from a non-runner host: **19 passed (1.8 min)**.
  On the runner: 17 passed (6.1 min) with a 180 s `goto` stall and a 20 s `waitForResponse` stall.
- **Stage 1 (the runner machine) is UNMEASURED** — nothing outside the job can read it. The other
  specs on that runner were normal, so "the runner is unhealthy" is not supported either.

Conclusion: *consistent with* a runner↔host path problem, **not proven**. `health.json` now
carries `deployment_environment` and `code_acceptance` separately, and `code_acceptance` reports
**UNVERIFIED** — never PASSED — when a timeout/reset/DNS failure shows the suite never reached the
product. No global timeout was raised and no retry loop was added.

## 5. Phase E — what ran

All against a scratch database and a local kernel serving a bundle built from this branch.

| Suite | Result |
|---|---|
| `g12_trusted_evidence.sh` | 51 passed / 0 failed |
| `g12_evidence_content.sh` | 84 passed / 0 failed |
| `g12_lifecycle.sh` | 88 passed / 0 failed |
| `g12_closure_invariants.sh` (new) | 23 passed / 0 failed |
| `g12_ai_investigator.sh`, related source OFF | 195 passed / 0 failed, S8 skipped |
| `g12_ai_investigator.sh`, kernel restarted with `OPSWEAVE_INVESTIGATION_RELATED_SOURCES=incident_index` | **199 passed / 0 failed, 0 skipped — S8 executed for the first time** |
| browser: 7 specs (`g11-incident-slice`, `g12-create-gate`, `g11-page-header-growth`, `g12-incident-route-identity`, `g12-evidence-content`, `g12-lifecycle`, `g12d-workspace`) | **29 passed, 2 skipped (5.7 min)** |
| `cargo test -p opsweave-kernel` (real DB, `OPSWEAVE_REQUIRE_TEST_DATABASE=1`) | 190 passed / 0 failed / 0 ignored |
| `cargo fmt --check`, `cargo clippy -D warnings` | clean |

**The 2 skipped browser cases, named:** `g11-page-header-growth.spec.ts` counterfactual and studio
checks, both skipped because `GET /api/v1/pipelines` returns no pipeline on this host
(`no pipeline on this host`). They are recorded as skipped, not as passed.

**S10** ran in both investigator passes (the S10 family appears in the 195 and the 199): it drives
the cross-scope probe and asserts, in the schema, that C's marker bytes appear in no invocation
row and in no word of the hypothesis.

## 6. Phase F — independent review

See §7: findings raised by a fresh review pass over this branch's diff, each with reproduction.

## 7. Findings and their disposition

*(Filled by the review step; P0/P1 items are reproduced, asserted, fixed and re-verified.)*

## 8. Open items / not done

1. `contracts/openapi/investigation-v1.yaml` does not state what SUCCEEDED implies (§2 D1).
2. The runner-side stage-1 measurement needs a timing probe inside the job (§4).
3. `/api/v1/diagnostics` outlives `load` on `/access`; measured, not explained (§4).
4. Surfaces and seeded-data tiers were skipped by the tier rule.
5. Real-model E2E remains blocked by absent credentials (§2 D3).
6. The create dialog's membership-revoked-while-open transition has no browser case (§1).
