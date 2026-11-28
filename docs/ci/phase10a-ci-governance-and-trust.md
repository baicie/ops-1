# Phase 10A: CI governance and release trust — what changed, and what did not

Baseline: `main` at `63ef2451`. This covers the eight commits through `389990c2`.

**Verdict, unchanged in shape: `CODE PHASE = COMPLETE`, `PRODUCT RELEASE = BLOCKED`.**
But two of the three things the brief said blocked it are now *measured* rather than
assumed, and one of them turned out to be worse than the Phase 9 closeout said.

## The finding that reorganised this phase

`main` had **no required status checks**. The only ruleset (`26958761`) carried
`deletion`, `non_fast_forward`, `required_linear_history` and `pull_request` — and
nothing else. `ci-gate` computed a real verdict on every PR and **nothing consumed
it**. Every merge in the Phase 9 table landed that way.

Worse, and found only by reading a step log rather than a check run: `verify-main`
**detected** a red `main` and **exited 0**.

```
verify-main: FAILED (rc=1)
##[error]main ran a workflow that FAILED for 63ef2451…
```

…while its check run concluded `success`. The step used `set -uo pipefail` without
`-e`, captured the tool's status in `rc`, and ended on an `echo`. `::error::` writes
an annotation; it does not fail a step.

Together: a commit could land with red suites, fail verification, and leave **every
check run on it green**.

## The second finding: the observer could not see what it was pointed at

`verify-main` ran as a job in `ci.yml` with no `needs:`, so it started four seconds
after the push. On `4375c988`:

| | time |
|---|---|
| observer read the check state | 06:26:12 |
| observer finished | 06:26:23 |
| first judged workflow settled | 06:30:20 |
| last judged workflow settled | 07:16:30 |

It printed `INCOMPLETE` with **zero of five** settled. On `63ef2451` it reported
`FAILED` only because runner queueing delayed its start ten minutes, until after a
fast-failing `staging-preview` landed. **Same tool, same code, different verdicts,
decided by how busy the runners were.**

## What was built

| PR | change |
|---|---|
| #248 | the audit above; no ruleset written |
| #249 | observer moved to `main-verification.yml`; classifier rewritten; `ci-governance` job added |
| #250 | `strict` decided; migration prepared (not executed) |
| #251 | the wait read a field the production reader does not produce |
| #252 | TASK-35 cost report |
| #253 | the three verdict levels use the receipt's vocabulary |
| #254 | TASK-36A registry state machine |

### The classifier defect, which was live and silent

`classifyMainRuns` fed only `unfiltered` workflows through its state machine. For
`filtered` it checked `if (!by[wf])` and recorded not-triggered — nothing else.
Reproduced against the real function before the change:

```
ci.yml success + staging-preview.yml success + plugin-lifecycle.yml FAILURE
  -> state: VERIFIED, failed: [], notTriggered: [..., plugin-lifecycle.yml]
```

A workflow that **ran and failed** was reported as *not applicable*. A paths filter
says when a result is owed; it says nothing about whether a result that exists counts.

### The first real verdict

`main verification` on `da320d8e`, after #251:

```
wait: all delegated suites settled after 27 read(s), 1501s
"state": "SUPERSEDED"
"reason": "2 workflow(s) were superseded by a newer push (ci.yml, staging-preview.yml);
           this commit's suites never completed, so nothing about it was verified"
verify: exit 3
```

**1501 s, 27 reads.** Before the fix, run 46126691989: created 08:37:29, finished
08:37:41 — **12 s**, one read, and wrong (it reported `INCOMPLETE_TIMEOUT` while
four workflows were running).

And the classification is right on its own terms: `data-foundation` and
`platform-linux-acceptance` completed (no `cancel-in-progress`); only the two with
`cancel-in-progress: true` were superseded by `c96185f3`. Nothing failed — so
`SUPERSEDED`, exit 3, not `FAILED` and not `VERIFIED`.

## The defects this phase committed against itself

Recorded because they are the same class as the ones it exists to remove, and
because a phase that claims to fix a defect class should be judged on whether it
managed that.

1. **The wait read a field the production reader does not produce.** `awaitPush`
   read `snapshot.expected`; `makeReader` returns `snapshot.workflows.expected`.
   Against the real reader the obligation list was empty, so it reported "settled
   after 1 read(s)" in one second — on main's first run. Every test fed the flat
   shape, so the suite was green while the production path was broken.
2. **Two counterfactuals stayed green** until the tests were rewritten: `B2`
   (`UNKNOWN` with no run) and `N2` (a green self-run). Neither test existed until
   the mutation ran.
3. **A registry-auth check could not fail.** `grep -v … | grep -q …` under
   `set -o pipefail`: `grep -q` exits at the first match, upstream takes SIGPIPE
   (141), the pipeline status is 141, and `&&` never fired — so the check reported
   OK **with the defect present**. Found only by running the counterfactual.

## Counterfactuals that make the suite red

Every one was run against the real code.

| mutation | caught by |
|---|---|
| remove the any-run-is-judged rule | DEFECT 1, 1b |
| resolve `UNKNOWN` downward | B2 |
| order attempts by array position | E, F, F2 |
| treat `NOT_CREATED` as settled | wait timeout cases |
| report a timeout as success | wait timeout case |
| remove the self-exclusion | N2 |
| `ci-governance` removed from `ci-gate.needs` | gate contract |
| `ci-governance` job deleted | gate contract |
| `main-verification.yml` registered as a **merge** gate | gate contract, **after** adding the check |
| shorten the verdict ladder | vocabulary test |
| reintroduce the `|| true` auth swallow | registry-auth test, **after fixing the check itself** |

## TASK-35, measured

116 completed runs, four workflows:

| workflow | first-attempt ok | p50 |
|---|---|---|
| `plugin-lifecycle.yml` | 15/30 | **51.3 min** |
| `data-foundation.yml` | 22/28 | 23.7 min |
| `runtime-conformance.yml` | 25/30 | 3.9 min |
| `ci.yml` | 17/28 | 25.2 min |

The retry has **zero margin**: run `45931039517` hit 429 on attempt 1, 429 again on
attempt 2, and succeeded on attempt 3. Backoff is `attempt * 15`, so the whole
window is 45 s and it was exactly enough.

**`cache: maven`'s effect is unmeasured.** It landed 2026-11-28; both observed Maven
failures are from 2026-11-26; the sample contains no post-cache 429 either way.

## The migration decision

Target: `candidate-ten.json`, ten contexts, `strict: true`. Reason: the nine-context
payload predates `ci-gate` entirely, so adopting it leaves the aggregate gate
advisory for ever; and `strict: false` merges on a green run against a base that has
since moved — the exact case `main-verification.yml` exists to surface.

Measured cost, honestly bounded: 7 of 12 recent PRs never fell behind `main`; mean
0.6 intervening merges. **That is a count of interruptions, not their cost.**

## What is still BLOCKED, and on what

| item | blocker | state |
|---|---|---|
| the ruleset `PUT` | explicit authorisation | **BLOCKED_AUTH** |
| enforcement observations 1–7 | needs the write, then a deliberate-failure PR | not started |
| staging capacity (TASK-37) | registry credential + SSH + runtime mutation | **BLOCKED_AUTH** |
| release identity (TASK-38) | needs registry access and a real deployment | blocked on 37 |
| TASK-33/34 offline proof | the warm path's effect is unmeasured | gated on TASK-32 |
| TASK-40–45 | product acceptance | not started |

## What would move the verdict

Unchanged from `phase9-final-closeout.md`, and now with sharper evidence for why:

1. **Authorisation for the ruleset write.** Without it, `ci-gate` is a verdict
   nothing enforces. The structural evidence is the ruleset itself: it carries no
   `required_status_checks` rule, so GitHub has nothing to check against. (An
   earlier draft of this document cited PR #168's `mergeStateStatus: UNSTABLE` as
   the behavioural proof; that status is `UNKNOWN` after a merge and cannot be
   re-read, so the claim was replaced with the structural fact, which can.)
2. **A real staging deploy → activate → verify.** The registry state machine now
   names *why* an identity check failed instead of retrying a credential; it does
   not make one succeed.
3. **TASK-32's cache measurement**, so the expensive jobs stop depending on
   Central's availability at the moment they run.
