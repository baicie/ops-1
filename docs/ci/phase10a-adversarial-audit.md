# The adversarial audit: what it found, and what is still open

Run after `2ee8910f`, against code whose suite was **green**. Five reviewers, each
assigned a module and told to find inputs that make the code **report success
while being wrong** — not crashes, not style. Each finding was then handed to an
independent agent instructed to refute it.

**35 findings. Every verifier that ran returned `refuted: false`.**

That result is the point, and it is uncomfortable: the suite this audit was
pointed at had 50 passing tests, and six of the audit's findings were reproduced
against the production functions in a few minutes each.

## Why the audit ran at all

Because the checks written to catch this class of defect had failed to catch it
five separate times during the same phase. The pattern was consistent enough to
stop trusting the suite and attack the code instead:

| check I wrote | how it failed |
|---|---|
| `B2` — UNKNOWN with no run | stayed green until the mutation was run |
| `N2` — a green self-run | stayed green; the assertion tested the wrong object |
| the auth-swallow check | `grep -v \| grep -q` under pipefail → 141 → `&&` never fired |
| "module is shipped" v1 | matched its own explanatory **comment** |
| "module is shipped" v2 | the awk region began at that same comment |

## Fixed, with a counterfactual each

All in `#258`. Every one is the same family: **absence of evidence read as
evidence of success.**

| # | defect | consequence before the fix | counterfactual |
|---|---|---|---|
| 1 | `NOT_APPLICABLE` + a run GitHub is still running | `VERIFIED` mid-flight | `AUDIT-1` |
| 2 | empty obligation set | `VERIFIED`, "all 0 required workflows succeeded" | `AUDIT-2` |
| 3 | a red run whose workflow is not in the expectation set | invisible; commit `VERIFIED` | `AUDIT-3` |
| 4 | the API **truncates** the file list at 300 (it does not omit) | tail paths invisible → `NOT_APPLICABLE` | `AUDIT-4` |
| 5 | `filesError` / `unparsed` were reports, not verdicts | `VERIFIED` beside a blocker saying the list was unavailable | `AUDIT-5` |
| 6 | `codeVerdict` copied before `state` was rewritten | one document saying `UNAVAILABLE` and `reached: true` | `AUDIT-6` |

## Still open

Each is real and each needs its own counterfactual rather than being bundled with
the six above.

### `paths:` glob semantics disagree with GitHub

`globToRegExp` translates `?` as **one character**. GitHub's filter-pattern
reference defines `?` as **zero or one of the preceding character**, and `+` as
one or more. A filter written in GitHub's own documented syntax is therefore
evaluated with different semantics.

Measured against the real function:

```
globToRegExp("ab?c")  matches "abbc"   but NOT "abc"
```

GitHub's `?` would match both. So a filter `ab?c` matches a set of paths this
code disagrees with, in the direction that makes a workflow look **not
applicable** when GitHub would have run it.

Negated patterns (`!apps/vendor/**`) are also discarded: `paths.find` returns
`false` for them instead of applying them as exclusions in document order, so a
push touching only `apps/vendor/x.rs` against `['apps/**', '!apps/vendor/**']`
is reported `REQUIRED` and the observer waits for a run GitHub will never create.

**Why it is not in #258:** it changes the classification of real commits, and the
repository's other two glob matchers (`impact.mjs`, `check-paths-filters.mjs`)
carry the same translation. Fixing one of three without deciding the other two is
how they came to disagree.

### A tag push shares `event: push` — REASONED, NOT MEASURED

`run.event !== 'push'` rejects a `workflow_dispatch`. It does not reject a **tag**
push, which GitHub documents as also having `event: push` and carrying the same
`head_sha` — so a green tag-push run of a workflow could mask a red branch-push run
on the same commit.

**This one is not measured, and the document says so rather than implying
otherwise.** This repository has no tag-triggered runs in the fetched history
(`gh api .../runs?event=push` filtered for `head_branch == null` returns nothing),
so there is no observation to point at. What IS measured: `normaliseRun` carries no
`ref` field at all, so the classifier has nothing it could compare even if the
hazard is real.

**Why it is not in #258:** it needs `ref` added to the normalised run, a rule for
what to do with it, and a fixture. Building that on a hazard nobody has observed
would be inventing a requirement; recording it is the honest step.

### Snapshot-mode exit codes are not total

`SNAPSHOT_EXIT` has no entry for `INCOMPLETE_TIMEOUT` or `SUPERSEDED`; the same
cancelled-run fixture exits **1** in snapshot mode and **3** with `--wait`. The
file's header promises the two modes differ only in whether they wait.

### `await-delegated` settles states that are not answers

`checkState` returns the literal status when there is no recognised conclusion, and
`whatToAwait` settles everything that is not `pending` — so a check whose
conclusion is missing or unrecognised is credited as verified by the gate.

Also: a check that is green **from an earlier attempt** is settled even while its
owning workflow run is queued, because the "workflow is running" branch is only
consulted when the check is `absent`.

### Smaller, recorded not ranked

- `ci-gate`'s `needs:` is hand-maintained with no reverse-direction check: adding a
  job and forgetting `needs` leaves the gate blind, and the contract checker does
  not object.
- Deleting `push:` from `main-verification.yml` passes every check.
- `check-gate-enforcement`'s CI step runs only `--selftest`; the live half answers
  nothing in CI, while a green step suggests it does.
- `check-test-substance` discovers only `*.test.mjs`, so seven `*.test.sh` suites in
  `ci-governance` are unchecked.
- `check-l0-discovery` never calls `unpinnedActions` on the production path — 130
  mutable-tag actions are counted and reported as zero problems.
- `newerRun` breaks an attempt tie by comparing run ids **as strings**
  (`"9" > "10"`), so the older run can win.
- `process.exit` after a large `--json` write truncates at 64 KiB on a pipe.
- `IS_MAIN` compares paths literally, so a symlinked entry point exits 0 silently.
- Two evidence steps in `ci.yml` fabricate an empty artifact list and parse gate
  JSON by `lastIndexOf('\\n}')`, both of which can report success on a failure.

## What this changes about the phase's verdict

Nothing about the code phase's completeness — these are found and prioritised, not
proven absent elsewhere. What it changes is the **confidence** a reader should place
in "the suite is green". For this module, the suite was green through six defects of
the class it was written to catch.

The one durable lesson, now recorded five times in this phase: **a check is only
worth its counterfactual.** Every defect in the table above was found by running
the mutation, and none by reading the code or the test.
