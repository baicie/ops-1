# Phase 8 — closeout

Written 2026-11-25. Baseline `a039cf6c` (#212). Head at time of writing `aedc7680`
plus #222 in flight.

**Conclusion: `COMPLETE_WITH_DOCUMENTED_NON_BLOCKING_LIMITATIONS`.**

Not `COMPLETE`. Two things are load-bearing and are not done: the live branch
ruleset enforces **no required status check at all**, and no real staging
acceptance was performed. Both are `BLOCKED_AUTH` / `BLOCKED_ENV` and neither is
paperable over.

---

## 1. Baseline

| | |
|---|---|
| main at start | `a039cf6c79856985985f8a22fc28eaf6704af64c` (#212) |
| main at close | `aedc7680` (#221), with #222 in flight |
| PRs merged this phase | 9 — #213, #214, #215, #216, #217, #218, #219, #220, #221 (and #222) |
| open PRs at start | 0 |

## 2. Task status

The brief listed 41 tasks. What was actually executed:

| tasks | status |
|---|---|
| 01, 02, 03, 09 | **done** — #215. Two Phase 7 suites ran zero assertions in CI; fixed with a BLOCKED exit and a meta-test that counterfactually fails when the registration is removed |
| 11, 13, 15 | **done** — #216. The heartbeat protocol's bounds, asserted as convergence rather than a stopwatch sample |
| 19, 23, 25 | **done** — #217. Ruleset preflight (read-only), sampled golden-path baseline, capacity refusals |
| 20, 21, 22 | **done** — #218. TASK-20 was an audit (`ALREADY_COVERED`); 21/22 are new tools |
| 26, 27, 28, 29 | **done** — #219. One sanitization boundary; classifier V2; collector V2; byte-accurate budget |
| 30, 31, 32 | **done** — #220 + #222. Capacity audit; `RECLAIM_REQUIRED`; superseded-candidate reclamation |
| 37 | **done** — #221. Evidence index, and the measurement that made it necessary |
| **35** | **NOT DONE** — CI cost was not measured. No claim is made about it |
| **36** | **PARTIAL** — the central rule is verified and asserted (the gate cannot read a classification); the full contract re-verification was not run |
| **38** | **NOT DONE** — no failure-injection matrix. The one injection that mattered is a kernel test in #220 |
| **39** | **BLOCKED_ENV** — real staging acceptance. No staging access |
| **40** | **PARTIAL** — main CI was read for each merge; see §4 |
| **41** | this document |

## 3. Defects confirmed this phase

Ordered by how long they had been shipping silently.

1. **`isFailureLine` was a character class**, not an alternation —
   `/[\[FATAL\]|\[ERROR\]|…]/` matches every string. The "prefer a failure line as
   evidence" rule had never done anything since the file was written. Found in
   #219.
2. **A redaction bypass with a P0 shape.** The collector redacted `log.excerpt` and
   copied `classification.evidence[].line` verbatim from a classifier that had read
   the raw log. One line, twice in one artifact — redacted in one field, live in the
   other. Found in #219.
3. **A byte cap applied in UTF-16 code units.** 1000 CJK characters = 1000 units =
   3000 bytes, so a "512 KB" artifact was 1.5 MB, and a slice could end on a lone
   surrogate. Found in #219.
4. **Two Phase 7 suites ran zero assertions in CI** — five SUCCESS runs contained
   `0 passed, 0 failed, 1 skipped`. Found in #215.
5. **A `READY` deployment that was never activated held its node slot forever.**
   This is what filled staging to 4/4. Found in #220.
6. **The capacity preflight was never consulted by the deploy path**, so staging
   learned it had no slots by timing out after a full image build. Found in #220.
7. **`ci.yml` uploaded no artifact at all**, and both Phase 8A diagnostic tools were
   invoked by no workflow. Found in #221.
8. **The reclamation ordered supersession by `version`**, which is a content hash
   with no ordering (ADR-025). `"0.0.9" > "0.0.10"` is true as a string. Found in
   #222 — a defect introduced by #220, found before it could ship.

## 4. Main CI, per merge (TASK-40)

A green PR says nothing about `main`: they are separate executions of separate
commits. Measured:

| merge | ci | data-foundation | platform-linux | staging-preview |
|---|---|---|---|---|
| `a039cf6c` (baseline) | success | success | — | failure |
| `b217284a` (#218) | success | — | — | failure |
| `a1634d62` (#219) | success | success | success | failure |
| `a7d6cd65` (#220) | **cancelled** | **cancelled** | success | failure |
| `aedc7680` (#221) | **success** (`ci-gate` included) | **success** | **success** | failure (capacity) |

Verified at `aedc7680` on 2026-11-25: `ci` (run 45593146700) completed **success**
with `ci-gate` success among its jobs, `data-foundation` (45593146075) success, and
`platform-linux-acceptance` (45593146573) success. This is the check the brief
requires and the one a green PR cannot substitute for — it was read from the push
runs on `main`, not from the pull request.

**The two `cancelled` rows are correct behaviour, not a defect.** `ci.yml` sets
`cancel-in-progress: true` for pushes on a shared ref, so merging #221 while #220's
`main` run was still going cancelled it. That is the documented policy
(`ci.yml:44-47`, `tests/ci/check-concurrency-supersede.mjs`), and the superseding
run is the one that counts.

**`staging-preview` fails on every commit, including the baseline.** That is the
capacity defect #220 fixes. Confirmed on the current head, `aedc7680`
(run 45593146217, 10:15Z): the log still reads `INSTANCE_CAPACITY_EXCEEDED` and
`4 instances already scheduled`. **The fix is merged and not deployed** — the four
rows are still there. Releasing them requires a staging deploy, which is TASK-39
and needs authorization this session does not have.

## 5. Fixture vs. real execution — kept apart

Every claim in this phase is one of three kinds, and they are not mixed:

| kind | what was run | where |
|---|---|---|
| **fixture** | committed JSON, no network | classifier's 10 counterexamples; index's 16 assertions; sanitizer's 17 |
| **component** | real PostgreSQL, real kernel process, real Docker | 346 kernel tests; the Phase 7 suites; capacity preflight |
| **real staging** | — | **nothing** |

The staging capacity audit (#220) reads a **failed run's own uploaded artifacts**
plus the kernel source. No query was executed against staging, no row was deleted,
and no capacity limit was raised.

## 6. Staging: what is actually true

- The node was at 4/4 and every publish failed after a full build.
- The rule in #222 releases **two of the four** rows: `data-catalog@0.0.2` and
  `data-catalog@0.0.3590`, both superseded by `0.0.65450`.
- The other two — `dev.opsweave.hello@0.0.1` and `data-integration@0.0.2` — are each
  their plugin's only version and are **not touched**. Whether they are genuinely
  `ACTIVE` needs the staging database.
- **The fix is not deployed.** The four rows are still there right now.

## 7. Required Check status

**This is the most important limitation and it is not a documentation gap.**

```
$ gh api repos/baicie/ops-1/rulesets/26958761 --jq '[.rules[].type]'
["deletion", "non_fast_forward", "required_linear_history", "pull_request"]

$ gh api repos/baicie/ops-1/branches/main/protection --jq .required_status_checks
null
```

The live ruleset has **no `required_status_checks`**, and the legacy branch
protection API returns `null` too. So **GitHub enforces no status check on
`main`.** `ci-gate` runs, computes a real verdict, and that verdict is
**advisory** — a red PR is technically mergeable.

This was not introduced this phase; it is recorded in
`docs/ci/ruleset-migration-ten-contexts.md` and the migration payload plus rollback
file exist. Writing it is `BLOCKED_AUTH`, and it was not done.

What *is* true: `ci-gate`'s own rule set is verified — see #219 and #221 — and it
cannot be talked out of a failure. What is *not* true: anything about enforcement.

## 8. CI cost (TASK-35) — not measured

No before/after exists, so no optimisation is claimed. What the audit did establish
without measuring timing:

- 15 `upload-artifact` steps across 8 workflows; `ci.yml` had **zero** before #221.
- No workflow uses a matrix, so a fixed artifact name cannot collide within one
  attempt.
- A **retried** run holds two artifacts of the same name (measured: run
  45542879392), and the artifact object carries no `run_attempt` — the index now
  reports that collision rather than resolving it.

## 9. Release identity (TASK-33/34) — not done

The brief's TASK-33 (full release identity chain) and TASK-34 (per-release journal,
content digest instead of `% 100000`) were **not implemented**. #222 removed one
place where the version-as-counter assumption was load-bearing; the underlying
identity problem ADR-025 describes remains `NEEDS_DECISION`.

## 10. Security and compatibility

- No capability was added to the kernel. #220 adds one SQL statement to an existing
  sweep and reuses `DRAINING` → `DISABLED` → the existing `STOP` write.
- No API contract changed. `Preflight` gained fields; the classifier kept
  `verdict`/`confidence`/`reason`/`evidence` at the top level.
- `RECLAIM_REQUIRED` **cannot** turn a refusal into a `FITS`, and the index
  **cannot** change a gate verdict — both are asserted structurally, not just
  intended.
- One regression was introduced and caught inside the phase: the reclamation drained
  a rollback target. Fixed with a "only when something is PENDING" clause, with the
  counterexample kept.

## 11. Unresolved

| item | status |
|---|---|
| Ruleset migration (required checks) | `BLOCKED_AUTH` — payload and rollback ready, write not authorised |
| Real staging acceptance (TASK-39) | `BLOCKED_ENV` — no access |
| The four staging rows | still present; two are releasable by #222 once deployed |
| `RECLAIM_REQUIRED` reaching a caller | kernel returns it; `opsctl` still times out unchanged |
| TASK-33/34 release identity | not started |
| TASK-35 CI cost | not measured |
| TASK-38 failure-injection matrix | not built |

## 12. The pattern worth carrying forward

Four times this phase, the deliverable was **correct and connected to nothing**:

1. a Phase 7 suite with a CI step and zero assertions (#215);
2. a classifier and a collector no workflow invoked (#219 → measured in #221);
3. a capacity preflight the deploy path never called (#220);
4. `ci.yml` uploading nothing at all (#221).

Each was found by asking **"who calls this"**, never by reading the code. The
cheapest gate this repository could add is one that asks that question about every
tool it builds.

The second pattern: **a test suite that passes because no fixture reaches the hard
case.** The version-ordering defect in #222 passed all five tests in its module;
the counterfactual only failed once a fixture straddled a digit boundary. A rule can
be wrong in exactly the case nobody built.
