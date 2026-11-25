# Phase 8 TASK-20: gate verdicts across reruns — an audit, not a new suite

The brief is explicit about what to do first:

> 先盘点 #203、#205 的现有测试。只补真正缺少的反例。
> 不能因为自测数量多就自动宣称已覆盖全部身份边界。

So this is an audit. **No new test was written, because every one of the seven
required counterexamples already has one.** What follows is the mapping and the
evidence, so the claim is checkable rather than asserted.

## The seven, and the test that covers each

Existing coverage: **73** `ci-gate --selftest` assertions, **20** check-run-ledger
unit tests.

| # | Condition | Test | File |
|---|---|---|---|
| 1 | old attempt SUCCESS | `latest completed attempt decides, so a green re-run clears a red one` | `check-run-ledger.test.mjs` |
| 2 | new attempt FAILURE | `a later red attempt is not masked by an earlier green one` | same |
| 3 | new attempt PENDING | `an unbalanced attempt is not the answer while an unfinished one exists` | same |
| 4 | new attempt CANCELLED | `a cancelled check that was never re-answered explains itself as unanswered`; `...replaced by a later answer is named superseded, and still fails while it is the latest`; `a cancelled manual run is named manual`; `cancelled STAYS in RED_CONCLUSIONS` | same |
| 5 | same name, different producer | `impostor: the name exists, but from a workflow that does not own the suite`; `impostor: a red check from the wrong workflow is not a failure of the suite`; `ambiguous: two producers and no declared owner` | same |
| 6 | producer missing | `a check with no matching workflow run is reported unattributed, not guessed`; `required suite not wired: want FAIL because notWired` | both |
| 7 | required suite absent | `absent: the name is not on this commit at all`; and the gate's own `notWired` path | both |

Run them:

```
node tests/ci/ci-gate.mjs --selftest         # 73 ok
node --test tests/ci/check-run-ledger.test.mjs   # # pass 20
```

## The one thing worth checking rather than trusting

The ordering rule reads `startedAt` / `runId`, **not** `run_attempt`:

```js
const attemptOrder = (r) => Date.parse(r.startedAt ?? '') || Number(r.runId) || 0;
```

That looked like a gap — the comment talks about `run_attempt 2` while the code
never reads it. It is not a gap, and the reason is recorded in the code and
confirmed against GitHub below: **a re-run does not reuse a check run.** It creates
a new one and leaves the previous attempt `completed` forever, so there are two
rows with the same name and two different ids. Ordering by `run_attempt` would be
ordering a field that both rows carry the same value of.

Verified against the live API for the commit the comment cites:

```
$ gh api repos/baicie/ops-1/commits/cc7be5c/check-runs \
    --jq '.check_runs[] | select(.name=="golden-path") ...'
135572060029  completed/success  started=2026-11-19T12:50:07Z
```

One row survives, with the later start time — which is exactly what the ordering
rule needs and exactly what `run_attempt` cannot distinguish. The comment's two
ids (`135561535255` attempt 1, `135572060029` attempt 2) were real; the earlier one
has since been pruned by GitHub's retention.

## What this audit does not claim

- It does not claim the *sutie count* proves correctness. Each row above names the
  behaviour, not a number.
- It does not cover the case where GitHub prunes the earlier attempt **while** the
  gate is reading. A single API call is a snapshot; a prune landing mid-walk is
  outside what a per-commit query can see. Not tested, and not claimed.
- It says nothing about the classifier's own attribution of a failure to a
  category — that is TASK-21's subject, and it is separate.
