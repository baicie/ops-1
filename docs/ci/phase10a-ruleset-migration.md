# Phase 10A TASK-39F: the required-checks migration

**Status: PREPARED, NOT EXECUTED. The remote write is `BLOCKED_AUTH`.**

This document is the candidate payload, the diff, the migration plan and the
rollback plan. It does not authorise the write, and nothing here was sent to
GitHub. `check-ruleset-preflight.mjs` "has no write path" and that is verified by
its own test.

## The decision this closes

Two shipped payloads set opposite values and the preflight refused to send
either. Resolved: **the target is `docs/ci/ruleset-candidate-ten.json`, ten
contexts, `strict: true`.**

The argument, and its limits:

- The nine-context payload **predates `ci-gate` entirely.** Adopting it now would
  leave the aggregate gate — the only component that waits for delegated suites
  and attributes checks to their producing workflow — advisory for ever.
- `strict: true` is chosen because `strict: false` merges on a green run against a
  base that has since moved, which is exactly the "a PR's SUCCESS does not prove
  main's SUCCESS" case that `main-verification.yml` exists to surface. Opting into
  that while also having no required checks is the current state twice over.

**What was measured, and what was not.** The cost of `strict` is a rebase when a
PR falls behind main. Measured on the 12 most recent merged PRs:

| PRs that never fell behind main | 7 of 12 |
| mean other merges landing between a PR's creation and its merge | 0.6 |
| commits to main in the last 7 days | 30 |

So `strict` will bite on roughly two in five PRs at this repository's current
merge rate. **That is a count of interruptions, not a measurement of their cost** —
nobody has timed a rebase-and-rerun here, and a number for it would be invented.
What can be said without inventing it: at 0.6 intervening merges on average, a PR
that does fall behind usually falls behind once, not repeatedly.

## The candidate

`docs/ci/ruleset-candidate-ten.json`. Compared against the live ruleset
(`26958761`, read on 2026-11-28, `updated_at 2026-11-20T11:03:08+08:00`):

| field | live | candidate | change |
|---|---|---|---|
| `target` | `branch` | `branch` | — |
| `enforcement` | `active` | `active` | — |
| `conditions.ref_name` | `~DEFAULT_BRANCH` | `~DEFAULT_BRANCH` | — |
| `bypass_actors` | `[]` | `[]` | — |
| `rules[deletion]` | present | present | — |
| `rules[non_fast_forward]` | present | present | — |
| `rules[required_linear_history]` | present | present | — |
| `rules[pull_request]` | present | present, params identical | — |
| `rules[required_status_checks]` | **absent** | **present** | **+1 rule** |

The diff is one rule. Everything else is copied verbatim from the live state, and
`check-ruleset-payload.mjs` refuses any payload missing one of the four
protections — `PUT` replaces the whole `rules` array, so a checks-only payload
would silently delete four protections from `main`.

### The ten contexts

`contracts`, `linux-runtime`, `platform-image-build`, `platform-only`,
`quality-faults`, `rust`, `spec-coverage`, `web`, `web-unit`, `ci-gate`.

All nine historical contexts are still required: `candidate-ten` is checked as a
**superset**, so the migration cannot trade one required check for another.

`check-required-contexts.mjs` reports all ten have a producer on every pull
request. Measured independently: `linux-runtime` and `quality-faults` appear on
the head of PRs #240–#247 (8/8), even though their workflows are path-filtered
*on push* — the `pull_request` side has no `paths:`, which is the half that
matters for a required context.

### `integration_id`

The brief asks whether the ruleset supports binding to the GitHub Actions App
identity. The `required_status_checks` entries here are `{context: string}` only.
The API accepts an `app_id` on this shape, but **this repository does not use it,
and the reason is not laziness**: the same App produces checks from every
workflow, so an App binding narrows the source to "some workflow in this
repository" — which `ci-gate`'s workflow-level attribution already does more
precisely. Adding `app_id` would look stricter and mean less. Recorded rather
than implemented; changing it is a separate decision.

## Preconditions, each verified

`node tests/ci/check-ruleset-preflight.mjs` → **22 ok, 0 failed, 0 not evaluated**.

| # | precondition | result |
|---|---|---|
| 1 | the four existing protections are still present, rule by rule | ok |
| 2 | live carries no rule the payload does not account for | ok |
| 3 | live requires 0 checks (the state the migration changes) | ok |
| 4 | the candidate keeps every protection's parameters identical to live | ok |
| 5 | the candidate requires exactly the ten contexts | ok |
| 6 | `strict` matches the declared target | ok |
| 7 | the historical nine-context payload still records `strict=false`, unedited | ok |
| 8 | the parameters use only API-documented fields | ok |
| 9 | every context entry is exactly `{context}` | ok |
| 10 | every context has a producer on every PR | ok |
| 11 | the rollback payload restores the live state, rule for rule | ok |
| 12 | a candidate that drifts off the target is refused | ok — counterfactual 6b |

**The snapshot is stale and that is stated, not hidden.** `ruleset-live-snapshot.json`
was captured 2026-11-24; the live `updated_at` is 2026-11-20, so the ruleset has not
changed since before the capture — but the brief's rule stands: **the write must be
preceded by a fresh live read**, not this document's snapshot. Run the preflight
without `--snapshot` on the day.

## Migration

```bash
node tests/ci/check-ruleset-payload.mjs         # the payload is complete
node tests/ci/check-ruleset-preflight.mjs       # live, not --snapshot
gh api -X PUT repos/baicie/ops-1/rulesets/26958761 \
  --input docs/ci/ruleset-candidate-ten.json
```

Then read it back and compare to the payload — **a 200 is not evidence**:

```bash
gh api repos/baicie/ops-1/rulesets/26958761 > /tmp/ruleset-after.json
node tests/ci/check-ruleset-payload.mjs --verify-readback \
  docs/ci/ruleset-candidate-ten.json /tmp/ruleset-after.json
```

`--verify-readback` compares the readback to the payload rule for rule, which is
the observation the API's 200 does not provide.

## Rollback

`docs/ci/ruleset-rollback-pre-migration.json` restores the live state exactly:
the four protections, no `required_status_checks`. The preflight confirms it
matches live rule for rule (precondition 11).

```bash
gh api -X PUT repos/baicie/ops-1/rulesets/26958761 \
  --input docs/ci/ruleset-rollback-pre-migration.json
```

`docs/ci/ruleset-audit.md` §6 said the current state had no snapshot, because it
is "delete a rule" and `PUT` can only submit a complete object. That gap is
closed: `ruleset-rollback-pre-migration.json` is a complete four-rule object.
The nine-context payload is kept as history and must not be rewritten to agree
with the present — the preflight now asserts that.

## What would prove the gate is ENFORCED

A 200 from the API proves a write landed. It does not prove a merge was ever
blocked. The brief lists seven observations, all of which need a **deliberately
failing test PR** — never a real product change:

1. missing `ci-gate` cannot merge
2. red `ci-gate` cannot merge
3. a failed delegated suite makes `ci-gate` red
4. a PR behind `main` is blocked by `strict`
5. after rebasing, mergeable again
6. the four original protections still present
7. ruleset readback matches the payload

Observations 3 and 4 are the two that have never happened. **Not executed, and
not claimed.** They need the write, and the write needs authorisation.

## Blockers

| blocker | state |
|---|---|
| the remote `PUT` | `BLOCKED_AUTH` — needs explicit authorisation |
| a deliberate-failure PR for observations 1–7 | not created; needs the write first |
| `main-verification.yml`'s first real run | needs a push to main after merge |

## Successor

TASK-39A's three-level verdict is partly real: `codeVerdict` exists in
`main-verification.yml`. `stagingVerdict` and `releaseVerdict` are `null` there
by design — they belong to TASK-38's release receipt and TASK-37's staging
recovery, neither of which is closed.
