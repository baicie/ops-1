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

An independent adversarial review of the branch (not told what the fixes were meant to prove)
found three P1s and four P2s. Each was reproduced before it was changed; each fix was then broken
again to show the new assertion fails. All are fixed in `e2a045e`.

| # | Sev | Finding | Status |
|---|---|---|---|
| 1 | P1 | `deployment_environment` was hard-wired to `PASSED`: it filtered `checks` for names (`identity`, `health`) the workflow never produces, so the list was empty and the expression fell through. Executing the block reproduced `PASSED` on a failed deploy. | **Fixed** — reads the deploy job's result, the served SHA from `host-status.json` and the deploy script's health verdict; 8 scenarios executed, each answering for itself. The same check exposed that `code_acceptance` required every group (including tier-skipped ones) and so was always `FAILED`; it now counts executed groups only. |
| 2 | P1 | The spec-coverage checker counted any mention as an execution: a `paths:` entry, an echo string or a dict key was enough. With every real invocation deleted and only the path filter left, it still printed COVERED. | **Fixed** — parses `run:` blocks only, folds continuations, requires a runner invocation on the same line, follows harnesses to depth 4, lists recursively. The reported counterfactual now fails and exits 1. |
| 3 | P1 | The new script's cleanup never ran: `DELETE` on a verdict-bearing incident hits `ON DELETE RESTRICT`, and `\|\| true` swallowed it — two fixtures leaked per run while the suite reported success. | **Fixed** — deletes runs, verdict and incident in order, asserts each step, re-reads to prove the rows are gone (`Z1`, `Z2`). |
| 4 | P2 | The create gate's "second witness" refused only on the failure path; a successful workspace read disagreeing with `scope.workspaceCount === 0` returned `allowed`. | **Fixed** — the scope refuses on every path, as its comment always claimed; unit case added. |
| 5 | P2 | `incident_verdicts` was rewritable and deletable by any SQL while 0019 called it write-once, and 0024's closure guard leans on that. Measured `UPDATE 1` / `DELETE 1`. | **Fixed** — migration 0025; two transaction-local flags are the declared exits (test cleanup, migration backfill), set by nothing in the kernel or any route. |
| 6 | P2 | `code { overflow-wrap: anywhere }` was global, changing break behaviour for every exact token at every width, where the phone rule already covered narrow viewports. | **Fixed** — scoped to `code[data-long-token]`, set on the two digest sites; 20/20 sweep still clean. |
| 7 | P2 | The contract did not say what `FAILED` + `FINAL_ANSWER` means, and the panel renders the two labels side by side, which reads as a contradiction. | **Fixed** — the status field's description states it; `validate_contracts` passes. |

Re-measured after the fixes:

```
cargo test (real DB, REQUIRE=1)      190 passed / 0 failed / 0 ignored
g12_closure_invariants.sh            31 passed / 0 failed   (was 23)
g12_lifecycle.sh                     90 passed / 0 failed   (was 88)
browser, 7 specs                     29 passed, 2 skipped (no pipeline on this host), 4.2 min
vitest                               30 files / 416 passed
typecheck / build / i18n / tokens / PNG / spec-coverage / fmt / clippy   clean
```

The review also listed what it could **not** verify, and this record does not claim more than it
did: the browser-level numbers and the staging runner path were not reproduced by the reviewer,
and the multi-workspace dialog race was inspected, not driven live.

## 7.1 What the review changed about this document's own claims

Three statements in earlier revisions of this file were weaker than they read, and are corrected
above rather than silently left standing:

- "`deployment_environment` … is computed from the served commit and the health probes" was false
  in the code even though it was true in intent (finding 1).
- The two coverage counterfactuals in §3 passed partly because the checker was weak (finding 2);
  the counterfactual that actually matters — deleting the real invocation — is the one now
  recorded.
- §2 D2's "it leaves no fixtures" was not true (finding 3).

## 8. Open items / not done

1. ~~`contracts/openapi/investigation-v1.yaml` does not state what SUCCEEDED implies~~ — done in
   `e2a045e` (§7 finding 7): the status field now states SUCCEEDED / PARTIAL / FAILED with
   FINAL_ANSWER, and the no-evidence case.
2. The runner-side stage-1 measurement needs a timing probe inside the job (§4).
3. `/api/v1/diagnostics` outlives `load` on `/access`; measured, not explained (§4).
4. Surfaces and seeded-data tiers were skipped by the tier rule.
5. Real-model E2E remains blocked by absent credentials (§2 D3).
6. The create dialog's membership-revoked-while-open transition has no browser case (§1).
7. Migration 0025 is what makes the verdict write-once. It runs after 0024 in order, so a
   deployment that stops at 0024 has the closure invariant without the signature guarantee; there
   is no supported partial upgrade, and the migration list is the record of that.
