# Phase 8C — the tools existed; nothing called them

Baseline `main a1634d62` (#219 merged). This wave is an audit plus one built tool,
and the audit is the part worth reading.

## The measurement that shaped everything else

```
$ gh api repos/baicie/ops-1/actions/runs/45576929658/artifacts --jq .total_count
0
```

That is the `ci.yml` run for the **8A merge commit** — 22 checks, all green, the
merge that carried the classifier and the evidence collector. It uploaded **nothing**.

And the two tools:

```
$ grep -rn "classify-failure\|collect-failure-evidence" .github/ | grep -v '\.test\.sh'
(no output)
```

**Both Phase 8A tools are invoked by no workflow outside their own self-tests.**
Every assertion in `classify-failure.test.sh` and `collect-failure-evidence.test.sh`
passes, and neither tool has ever run against a real failing build in CI. This is
the `shipped-but-not-connected` shape this repository has recorded before, and it is
the third time in Phase 8 that a right answer was wired to nothing.

The same check on a workflow that *does* upload:

```
$ gh api repos/baicie/ops-1/actions/runs/45558832645/artifacts --jq '.artifacts[].name'
plugin-lifecycle-evidence        (87 KB, sha256:7f09bbcf…)
```

So the capability exists; it is simply not on the workflow that gates merges.

## TASK-37: the index, built on what the gate already knows

`ci-gate.mjs` already reads every check run on the exact commit, by name and by
producing workflow, and already prints the whole picture as JSON (`ci-gate.mjs:1808`).
The index is a thin layer over that, not a second collector.

### The three states it must not conflate

| state | meaning |
|---|---|
| `PASSED_WITH_EVIDENCE` | the check passed and an artifact **from its own producer** is indexed |
| `PASSED_EVIDENCE_UNATTRIBUTED` | an artifact exists on this commit, but nothing links it to this check |
| `PASSED_NO_EVIDENCE` | the check passed and produced nothing. **This is not "verified".** |

Plus `FAILED`, `PENDING` (only with positive `in_progress`/`queued` status) and
`UNKNOWN` (no conclusion, no status — never seen to start).

### The defect the index had, caught by testing it against real data

The first version said `artifacts.length > 0` → every passing check is
`PASSED_WITH_EVIDENCE`. Tested against the #217 commit — 32 checks, **one** artifact
from `plugin-lifecycle`:

```
passedWithEvidence: 27      <- wrong: 26 of them come from workflows that upload nothing
```

That is the same false assurance as calling them all verified, one step removed. The
link is now per-producer, supplied by `--workflow-of`, and without that map the
honest answer is `PASSED_EVIDENCE_UNATTRIBUTED`:

```
with the map:    passedWithEvidence 1, passedNoEvidence 26
without a map:   passedWithEvidence 0, passedEvidenceUnattributed 27
```

Measured on the real 8A commit with its real check runs:

```
$ node tests/ci/evidence-index.mjs --gate-json …/gate.json --artifacts …/artifacts.json
summary: { total: 22, failed: 0, pending: 0,
           passedWithEvidence: 0, passedNoEvidence: 22, artifacts: 0 }
```

**22 green checks. Zero evidence artefacts. That is the commit that merged 8A.**

### Wiring

The index is now a step in `ci-gate`, `if: always()` so it runs on a red gate, and it
`exit 0`s regardless — an index that could redden a green gate or green a red one
would be a second gate, and there must be exactly one. Two structural assertions
guard the wiring: that `ci.yml` invokes it, and that the step neutralises its own
exit.

## What this wave did **not** do

TASK-35 (CI cost), TASK-36 (gate contract) and TASK-38 (failure injection matrix)
are audits this session did not complete, and they are not claimed. What is known:

- `TASK-36`'s central rule **holds today and is asserted**: `ci-gate.mjs` never
  imports the classifier, and execs only `gh` (`ci-gate.mjs:1694`). The classifier
  cannot make a failing check green.
- `TASK-35`'s premise — that CI is slow because of duplication — was not measured,
  so no claim about it is made. The brief forbids claiming an optimisation without a
  before/after, and there is no before/after here.
- `TASK-38`'s fault-injection matrix is not built. The one injection that mattered
  most in this phase — a rollback target being drained — was written as a test in
  TASK-32, in the kernel suite, not in a shared matrix.

## The pattern, stated once more

Three times in Phase 8 the deliverable was correct and unconnected:

1. `phase7_suites_cannot_silently_pass` — a test with no CI call site (TASK-01).
2. The classifier and collector — tools no workflow invokes (8A).
3. `ci.yml` uploading no artifact at all (8C).

Each was found by asking "who calls this", not by reading the code. That question is
cheap, and `check-spec-coverage.mjs` already answers it for *files* — what it cannot
see is a file that is referenced by a `bash …test.sh` line and whose *product* is
never used. That gap is the one to close next.
