# Phase 10A TASK-39: required checks, audited — and the gate that is not one

Read-only. No ruleset was written. Every statement below is from a query whose
command is shown, run on 2026-11-28 against the live repository.

## The finding

**`main` has no required status checks.** The only ruleset is `26958761`
("main-protection", `enforcement: active`), and its `rules` array is:

```
deletion, non_fast_forward, required_linear_history, pull_request
```

There is no `required_status_checks` rule. `gh api repos/baicie/ops-1/rulesets/26958761`
and `gh api repos/baicie/ops-1/branches/main/protection` (404, "Branch not protected" —
the legacy endpoint is empty because protection lives in the ruleset).

So `ci-gate` is a **job**, not a gate. It computes a real verdict — it waits for
delegated suites, attributes checks to their producing workflow, and fails on
absent or cancelled — and then **nothing consumes that verdict**. A red `ci-gate`
does not stop a merge; a missing `ci-gate` does not stop a merge.

The consequence is not hypothetical. It is the current operating mode of this
repository, and the merges in the Phase 9 table were made under it.

## What is *not* the problem

Worth stating so nobody fixes the wrong thing:

- **`ci-gate`'s logic is sound and counterfactually tested.** `--selftest`,
  `impact.test.mjs`, `check-run-ledger.test.mjs`, `await-delegated.test.mjs`,
  `ci-gate.api-failure.test.mjs`, `check-test-substance.mjs` all run in
  `verify-main`.
- **The suite tables are consistent.** `check-impact-consistency.mjs` is itself a
  required-in-spirit check that fails when the analyzer and the filter tables
  disagree.
- **The ten contexts the candidate names are all produced on every PR.** Measured:
  `linux-runtime` and `quality-faults` appear on the head of PRs #240–#247 (8/8),
  even though their workflows are path-filtered *on push* — the `pull_request`
  trigger has no `paths:`, which is the half that matters for a required check.
  `check-required-contexts.mjs` reports all ten produced; no `NOT_EVALUATED`.

## What the audit changes about the migration plan

`docs/ci/ruleset-audit.md` proposes two options. Both are now answerable, and one
was based on a stale premise.

| | original (`original-strict`) | intermediate (`with-required-checks`) | candidate (`candidate-ten`) |
|---|---|---|---|
| contexts | 9 | 9 | **10** (adds `ci-gate`) |
| `strict_required_status_checks_policy` | `true` | **`false`** | `true` |
| includes `ci-gate` | no | no | **yes** |

`docs/ci/ruleset-audit.md` §4 recommends **方案 A — restore the nine, `strict: true`**,
on the argument that its cost has been measured. **That premise no longer holds in
the way it reads.** The 9-context payload has no `ci-gate`, which means under 方案 A
the aggregate gate — the one component that knows about delegated suites — is *not*
required. Nine green checks from nine independent workflows is a weaker statement
than the one `ci-gate` makes, and 方案 A would make `ci-gate` advisory forever.

`candidate-ten` is the payload that matches the design the repository actually
built. It is `strict: true` and it names `ci-gate`.

## The real cost of `strict: true`, stated honestly

`strict` means *the branch must be up to date with `main` before it can merge*. The
audit records the cost as "p95 34 minutes for `data-foundation`, plus a rebase
whenever the branch falls behind". That number came from the nine-context era.

**This audit did not measure the ten-context cost and does not estimate it.** The
reason is principled rather than lazy: `strict`'s cost depends on how often `main`
moves while a PR is open and how long the required set takes to re-run after a
rebase, and neither is a property of the payload. Anyone quoting a number here
would be quoting the old sample.

What can be said without measuring: adding `ci-gate` to the required set does not
change `strict`'s failure mode (branch behind → re-run), only how long the re-run
takes, because `ci-gate` waits for delegated suites whose own wall time dominates.

## The conflict the preflight reports, and which side is right

`node tests/ci/check-ruleset-preflight.mjs` (20 ok, 1 FAIL):

```
FAIL the payloads DISAGREE on strict: ten-context=true, nine-context=false.
     docs/ci/ruleset-audit.md records the migration as "strict: false";
     decide which is intended before either is sent
```

This is a **real disagreement between committed artifacts**, not a checker bug:

- `ruleset-26958761-original-strict.json` — nine contexts, `strict: true`
- `ruleset-26958761-with-required-checks.json` — nine contexts, `strict: false`
- `ruleset-candidate-ten.json` — ten contexts, `strict: true`

The audit document describes the *intermediate* payload (`strict: false`) and calls
it the migration. The candidate file is `strict: true`. Both cannot be the intent.

**Recommendation, and its reason:** `strict: true`. Reason: with `strict: false` a
PR merges on a green run against a base that has since moved — which is exactly the
"PR's SUCCESS does not prove main's SUCCESS" case `verify-main` exists to surface.
Choosing `false` would mean opting into that case *while also* having no required
checks, which is the current state twice over.

But this is a product decision about merge throughput, and the recommendation is
not the decision. **The blocking fact is that it is unresolved**, and the preflight
refuses both payloads until it is.

## `verify-main` detects the failure and then reports success

This is the sharper finding, and it was only visible by reading the step log rather
than the check-run conclusion.

On `63ef2451` the `verify-main` check run concluded **`success`**. Its fourth step's
log says:

```
verify-main: FAILED (rc=1)
##[error]main ran a workflow that FAILED for 63ef24515be29a0051b795f0cd026cdca3f94235
         — see the summary. This does not un-merge the commit; it is the fact a human needs.
```

`gh api repos/baicie/ops-1/actions/jobs/<id>` reports that step as
`"conclusion": "success"`, and the job as `success`.

**The mechanism** is in `ci.yml:1999`, the step's own shell flags:

```yaml
set -uo pipefail          # no `-e`
```

`node verify-main.mjs` exits `1` on `FAILED`, the `|| rc=$?` captures it, and the
final `echo "verify-main: $STATE (rc=$rc)"` succeeds — so the last command's status,
which is the step's status, is `0`. `::error::` writes an **annotation**; it does
not fail a step.

**It is deliberate**, and the workflow comment says so: "This does not un-merge the
commit; it is the fact a human needs." Judged alone, reporting rather than failing
is a defensible choice for a post-merge observer.

Judged together with the finding above, it is not defensible: **there are no
required checks, and the one job whose purpose is to say whether `main` is verified
cannot go red.** The two properties multiply:

| | effect |
|---|---|
| no `required_status_checks` on `main` | a red `ci-gate` does not block a merge |
| `verify-main` exits 0 on `FAILED` | a red `main` does not produce a red check either |

A commit can therefore land with red suites, fail verification, and leave **every
check run on it green**. That is the exact shape `ci-gate`'s own design notes call
out as the worst failure — "a red required check reported green" — reached by a
different route, and not by any of the paths those notes enumerate.

### The earlier `success` on `63ef2451` was not a precedence bug

Checked while auditing rather than assumed: `verify-main.mjs:163-169` orders
`FAILED` before `INCOMPLETE`, and a direct run against the same commit returns
`FAILED` with `ci.yml` and `plugin-lifecycle.yml` still `in_progress`. So the tool's
state machine is right; only the step's exit status is wrong. The distinction
matters because fixing the first would have been a no-op.

## What would move this

1. **Decide `strict`** — true or false — so the preflight stops refusing both
   payloads. This is the only decision TASK-39 is blocked on.
2. **Make `verify-main` red on `FAILED`.** The step already computes `rc`; it needs
   only to turn it into the step's status:

   ```bash
   if [ "$STATE" = "FAILED" ]; then
     echo "::error::main ran a workflow that FAILED for $GITHUB_SHA — see the summary."
     exit 1
   fi
   ```

   Measured — four states through the real shell flags (`set -uo pipefail`):

   | `STATE` | exit |
   |---|---|
   | `FAILED` | **1** |
   | `VERIFIED` | 0 |
   | `INCOMPLETE` | 0 |
   | `CANCELLED` | 0 |

   **The obvious one-liner is wrong, and this document recommends it only after
   measuring that it breaks the passing case:**

   ```bash
   [ "$STATE" = "FAILED" ] && exit 1     # FAILED → 1, VERIFIED → 1
   ```

   When the test is false, the AND-list's status is the *test's* status (`1`), and it
   is the last command in the step — so a verified `main` goes red. Measured on the
   same four states: `FAILED → 1`, `VERIFIED → 1`. This is the same shape as the
   defect it is meant to fix, inverted, and it would have been introduced by the fix.

   Keeping `INCOMPLETE` and `CANCELLED` at `0` is deliberate: neither is a failure of
   this job, and the reasons are in the workflow's own comments. It is a separate
   decision from (1) and weaker in consequence — a red `verify-main` is still not
   required — but without it, `verify-main` is a report CI cannot act on at all.
   **Not applied here**: it changes a post-merge job's contract, and this document is
   the input to that decision rather than the decision.
3. **Authorise the write.** `gh api -X PUT repos/baicie/ops-1/rulesets/26958761
   --input docs/ci/ruleset-candidate-ten.json` after the preflight is 21/21.
   `PUT` replaces the whole `rules` array; `check-ruleset-payload.mjs` exists
   because a checks-only payload silently drops the four protections.
4. **Rollback material.** `ruleset-rollback-pre-migration.json` restores the live
   state (four rules, no checks) and the preflight confirms it matches live rule for
   rule. The audit's §6 says the current state has no snapshot — that gap is closed.
5. **One real merge under the new ruleset.** The first ten-required run is an
   observation, not a formality: it is the first time GitHub itself enforces a
   verdict that has only ever been advisory.

Until (1) and (3), **the CI gate remains advisory**, and every "CI is green"
statement about this repository describes a check that a human chose to respect —
and, for `main` specifically, one that stays green even when the job whose job it
is to disagree has already printed its disagreement.
