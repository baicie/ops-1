# Phase 8 — closeout

Written 2026-11-25. Baseline `a039cf6c` (#212). Head at time of writing
`530c81b8` (#225).

**Conclusion: `COMPLETE_WITH_DOCUMENTED_NON_BLOCKING_LIMITATIONS`.**

Not `COMPLETE`. Three things are load-bearing and are not done: the live branch
ruleset enforces **no required status check at all**, no real staging acceptance
passed, and **the capacity defect that fails every staging deploy is a different
defect from the one this phase fixed** — measured, not inferred (§6.1). The first
is `BLOCKED_AUTH`; the other two were attempted and measured, and the measurements
are negative.

A negative measurement is not a reason to withhold the whole phase — the phase's
defects were real, their fixes are verified against PostgreSQL and committed, and
every claim below is one of `fixture` / `component` / `real`. It is a reason not to
write `COMPLETE`.

Two of those defects were found **by the instruments this phase built**, against
the claims this phase had written: the `READY` premise that gave #222 its shape was
false, and `opsctl capacity`'s own verdict is wrong on a full node. Both are in §6.
That is the phase working as intended, and it is also why its conclusion cannot be
`COMPLETE`.

---

## 1. Baseline

| | |
|---|---|
| main at start | `a039cf6c79856985985f8a22fc28eaf6704af64c` (#212) |
| main at close | `530c81b87d61b8fdfebd74c7df5eec12522a3a9a` (#225) |
| PRs merged this phase | 13 — #213, #214, #215, #216, #217, #218, #219, #220, #221, #222, #223, #224, #225 |
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
| **39** | **ATTEMPTED, RESULT NEGATIVE** — a real staging deploy was authorised and run; the fix is on the host and did not release the four rows. See §6 |
| **40** | **PARTIAL** — main CI was read for each merge; see §4. Now also a tool (`verify-main.mjs`), not only a habit |
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
| `079f8fce` (#222) | success | success | success | failure (capacity) |
| `a1f468ff` (#223) | **success** (`ci-gate` included) | **success** | **success** | **failure (capacity, with the fix deployed and installed)** |
| `ab541299` (#224) | success | success | success | failure (capacity) |
| `530c81b8` (#225) | success | success | success | **failure (capacity, and the artifact explains why for the first time)** |

At `530c81b8` the `staging-preview` failure finally carried its own explanation:
the four occupants are three `ACTIVE` and one `DEGRADED`, so the reclamation rule
never had a candidate (§6.1). `plugin-lifecycle` also succeeded on that commit,
which is the workflow that verifies the plugin path the publish exercises.

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
capacity defect #220 fixes. `aedc7680` (run 45593146217, 10:15Z) reads
`INSTANCE_CAPACITY_EXCEEDED` and `4 instances already scheduled`.

The last row is the one that matters, and it changes what the rest of this table
means: at `a1f468ff` the fix **is on the host** — `served_commit` and the image
digest say so — and the publish still fails on the same four occupants. **A merged
fix and a deployed fix are different facts, and neither is a fix that works.** The
measurement is in §6.

`a1f468ff`'s own `ci` run completed **success** with `ci-gate` success and zero
failed or cancelled jobs; it was still `in_progress` when this table was first
drafted, and that draft said `success` anyway. See §12.2.

Running `verify-main` against the head gives the answer this phase is built on:

```
$ node tests/ci/verify-main.mjs --sha a1f468ff
FAILED  a1f468ff
  1 workflow(s) failed on this commit: staging-preview.yml: failure
  verified: ci.yml
```

Exit 1. The commit is on `main`, it is green where it is green, and **it is not a
verified commit** — one workflow that must run on every push failed. That is the
distinction TASK-40 exists to preserve, applied to this phase's own head.

## 5. Fixture vs. real execution — kept apart

Every claim in this phase is one of three kinds, and they are not mixed:

| kind | what was run | where |
|---|---|---|
| **fixture** | committed JSON, no network | classifier's 10 counterexamples; index's 16 assertions; sanitizer's 17; verify-main's 19 |
| **component** | real PostgreSQL, real kernel process, real Docker | the kernel suite; the Phase 7 suites; capacity preflight |
| **real staging** | **two deploys, 2026-11-25** — one that measured a negative, and one whose artifact reversed the diagnosis | §6 — runs 45608152539 and 45634540776 |

The staging capacity audit (#220) reads a **failed run's own uploaded artifacts**
plus the kernel source. No query was executed against staging, no row was deleted,
and no capacity limit was raised.

The real staging actions taken this phase are the two deploys in §6, authorised
explicitly for this task. Their evidence is each run's own artifacts and log. The
first established that the fix was running and had no effect; the second produced
`capacity.json` and established **why** — the four occupants were never eligible.
No SSH session, no direct database query, and no mutation beyond what a deploy
performs.

## 6. Staging: what is actually true

The four occupants, the capacity failure, and the audit that found the defect
(`READY` deployments that were never activated held their node slots forever) are
recorded in `phase8b-capacity-audit.md`. What changed on 2026-11-25 is that the
fix was **deployed and measured**, and the measurement was negative.

### The deploy

`staging-preview` run **45608152539**, `push` on `a1f468ff`, 11:50Z–12:00Z. A
dispatch for `079f8fce` (45607268815) was cancelled by this run through the shared
concurrency group — **my ordering error**, not a workflow fault: the deploy was
triggered before the merge instead of after. `a1f468ff` contains the same fix, so
the push run is an equally valid deploy of it.

| step | result |
|---|---|
| build image | success |
| deploy to staging host, steps 1–10 (checkout, SSH, install, pull, deploy, health) | **success** |
| step 13, `Publish the data plugin bundles` | **failure** |
| collect host status / upload evidence | success |

The host's own status file puts the fix on staging:

```json
"current": {"sha": "a1f468ff57a12cdbdf396373f7f9b6ff74826f4e",
            "digest": "sha256:36f3feb046921332c384ceae77e708d0e19da8d604383adc2d52e6080344057d",
            "deployed_at": "2026-11-25T11:54:29Z", "healthy": true}
"health": {"livez": "pass", "readyz": "pass", "root": "pass"}
```

### The measurement

The publish step ran 11:54:35 → 11:59:53 — five minutes on a kernel six seconds
old — and for the whole window the same line repeated:

```
PENDING 0/0 ready ([INSTANCE_CAPACITY_EXCEEDED] node staging-node: 4 instances
already scheduled against a per-node limit of 4; occupied by
dev.opsweave.hello@0.0.1, opsweave.data-catalog@0.0.2,
opsweave.data-catalog@0.0.3590, opsweave.data-integration@0.0.2)
Error: timed out waiting for deployment readiness
```

**The same four occupants as before the deploy. None released.**

| claim | status |
|---|---|
| the fix is running on staging | **verified** — `served_commit` is `a1f468ff`, digest measured |
| it releases the two `data-catalog` rows | **DISPROVEN — and the premise was wrong, not just the prediction (see below)** |
| the four are "superseded and never activated" | **FALSE, measured in §6.1** |
| staging's plugin path works | **no** |

### 6.1 The instrument answered it, and the audit was wrong

The next run (`530c81b8`, run 45634540776) produced the first `capacity.json`. It
shows the four occupants as **three `ACTIVE` and one `DEGRADED` — not one `READY`**:

| occupant | status | created | activated |
|---|---|---|---|
| `dev.opsweave.hello@0.0.1` | **ACTIVE** | 2026-10-29 | 2026-10-30 |
| `opsweave.data-catalog@0.0.2` | **ACTIVE** | 2026-10-28 | 2026-10-28 |
| `opsweave.data-integration@0.0.2` | **ACTIVE** | 2026-10-28 | 2026-10-28 |
| `opsweave.data-catalog@0.0.3590` | **DEGRADED** | 2026-11-16 | never |

The reclamation rule matches `d.status = 'READY'`, so **it never had a candidate**.
Its refusal was correct, and its `ACTIVE` exclusion clause did exactly the job it
was written for: `data-catalog@0.0.2` is the **serving** version of its plugin, and
the audit that called it "superseded, therefore reclaimable" would have taken a
live route down had the rule agreed.

So the honest correction is stronger than "the fix did not work": **the fix
addressed a condition the host did not have.** Three of the four rows were never
eligible, and the fourth is `DEGRADED`, which the rule also does not match.

What the node *does* have is **nine `PENDING` deployments** across the two data
plugins (`0.0.65450`, `0.0.48829`, `0.0.19142`, `0.0.24497`, `0.0.15749`,
`0.0.17455`, `0.0.3`, and two on data-integration) — thirteen rows in total, each
a historical attempt that never placed. They hold no slots (`instancesReady: 3`),
and nothing removes them: `reconcile_once` plans `PENDING` forever, the version
cannot be re-created because `create_deployment_inner` returns an existing
`PENDING` unchanged, and the 4/4 the scheduler counts comes from the four
non-`PENDING` rows. That is a different defect from the one #220/#222 addressed,
and **#227 fixes it**: a deployment with zero replicas placed becomes `FAILED`
after `OPSWEAVE_PENDING_TIMEOUT_SECONDS` (default 600), its reason names what
happened, and one re-deploy starts a fresh attempt on a new clock
(`attempt_started_at`, migration 0037 — not `created_at`, which survives a
redeploy and would make the retry born expired). It was observed working on the
real host; see §6.1a.

### 6.1a #227 on the real host: the nine rows became FAILED

The first staging deploy running #227 (`be7e9254`, run 45676555140, 2026-11-25)
produced a new `capacity.json`:

| status | count |
|---|---|
| `ACTIVE` | 3 |
| `FAILED` | **9** |
| `DEGRADED` | 1 |

All nine `PENDING` rows became `FAILED`, and the reason is the one the code
writes, with the original rejection preserved:

```
never placed after 388203s: 0/1 replicas, and the last placement attempt was
refused; re-deploy to try again; No eligible healthy node matches the placement
selector [INSTANCE_CAPACITY_EXCEEDED] ...
```

The three `ACTIVE` deployments kept their `activatedAt` values unchanged
(2026-10-28T15:03:14Z, 2026-10-28T15:20:17Z, 2026-10-30T09:39:10Z) — the change
touches only rows that never placed, which is what the brief requires of anything
that runs against staging.

`verdict` is still `CAPACITY_AVAILABLE` with `freeSlotsTotal: 1`, and the publish
still fails: this change stops the platform re-planning hopeless rows, it does
**not** make room. That is a separate defect and it is still open.

### 6.2 A wrong answer from the tool built to give the right one

In the same artifact, `verdict` is `CAPACITY_AVAILABLE` and `freeSlotsTotal` is
`1`, while the publish four seconds earlier was refused for
`INSTANCE_CAPACITY_EXCEEDED` at 4/4.

`freeSlots` is `instancesTotal - instancesReady` computed in
`apps/opsctl/src/main.rs`, and `instancesTotal` counts `desired_action='START'`
instances — **not** the per-node limit. So the verdict compares READY replicas
against the requested replica count, which is not the capacity question.

**This is a wrong answer from the instrument this phase built**, found by putting
its first real output next to the publish log from the same run — not by reading
its code. It is not fixed here: the fix needs the per-node limit, which the node
view does not carry (its own comment says so). Recorded as the next change.

### 6.3 What is now unknown versus known

- **Known**: which row is in which state, and since when. That was the whole gap.
- **Known**: the reclamation rule had no eligible candidate, so its silence is
  correct behaviour rather than a bug.
- **Unknown**: whether the nine `PENDING` rows are what eventually fills the node,
  or are merely noise beside the four `START` rows. They hold no slots today, and
  the number that matters — the per-node limit the scheduler enforces — is still
  absent from every artifact.

### 6.4 Why the earlier prediction failed

The rule matches on `d.status = 'READY'`. **That premise was inferred, never
verified** — nothing in any artifact carried a deployment's status. Two facts from
the source narrow it without closing it:

1. `capacity_occupants` lists only instances with `desired_action='START'`
   (`deployments.rs:2685`), and a deployment that cannot place a slot has its rows
   written to `STOP` (`:2092`). So all four occupants did place an instance at some
   point.
2. A version that already exists in `PENDING`/`PREPARING`/`READY` is answered with
   202 and returned untouched (`deployments.rs:352`) — no new row, no state
   advance. `data-catalog@0.0.65450` therefore stays `PENDING` for as long as it
   is asked for.

Which clause of the rule failed needs the four rows' `status` and `created_at`.
This session has no path to them: `opsctl capacity --json` prints exactly that,
read-only, but it needs a session on the host, and the host is not reachable from
here.

> Recorded because it was nearly written down wrongly: `http://<staging>:3000/livez`
> answers **502** from this machine, which reads as "staging is down". It is the
> local proxy — `connect=0.0003s` with `Proxy-Connection: keep-alive`, and
> `--noproxy '*'` gives `000`. **The 502 is my machine.** Staging's only real
> evidence is its own status endpoint, which said healthy.

### What this does not license

- **Not "the fix is wrong."** As of §6.1 the clause is no longer unknown, and the
  answer is that the rule had no eligible candidate — its silence was correct.
- **Not "raise the limit."** The brief forbids it
  (「禁止仅通过提高 Staging 实例容量来掩盖插件生命周期问题」), and 4/4 with four
  named occupants is a condition, not a cause.
- **No row was deleted, no limit changed.** The run's only writes were a deploy's.

### The instrument, now built — and it ran

No artifact carried deployment state, so the question this task turned on — which
row is `READY`, and since when — was answerable only by inference. That is now
collected: `scripts/ci/collect-capacity.sh` runs `opsctl capacity --json` inside the
kernel container and writes `capacity.json` into `staging-deploy`, and `opsctl
capacity` now reports each occupant's `createdAt` and `activatedAt`.

**Its first real output reversed the conclusion** (§6.1): the four occupants are
three `ACTIVE` and one `DEGRADED`, so the reclamation rule never had a candidate.
The instrument did not confirm the audit — it refuted it, which is the only reason
it was worth building.

It also reported a wrong verdict of its own (§6.2), found by comparing it against
the publish log from the same run. Both outcomes are the argument for instruments
over reasoning, and both are recorded rather than smoothed over.

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
| The staging capacity fix | **deployed 2026-11-25, and it addressed a condition the host did not have** — three occupants are `ACTIVE`, one `DEGRADED`, none `READY`; the rule had no candidate (§6.1) |
| Real staging acceptance (TASK-39) | **attempted, negative** — the deploy succeeded and the plugin path still fails |
| The real capacity defect | **nine `PENDING` deployments** that never place and are never removed (§6.1) — **fixed in #227 and observed on staging**: all nine became `FAILED` with a named reason on the first deploy running it, and the three `ACTIVE` rows kept their `activatedAt` (§6.1a) |
| Making room on staging | **still open** — `freeSlotsTotal` is 1 while the publish needs a slot the scheduler counts as taken; #227 stops futile re-planning, it does not free capacity |
| `opsctl capacity`'s own verdict | **wrong on a full node** — reports `CAPACITY_AVAILABLE` at 4/4 because it compares READY replicas, not the per-node limit (§6.2) |
| Deployment state in an artifact | **built and exercised** — `capacity.json` appeared in `staging-deploy` on the first run after the change, and it reversed the diagnosis (§6.1) |
| `RECLAIM_REQUIRED` reaching a caller | kernel returns it; `opsctl` still times out unchanged |
| TASK-33/34 release identity | not started |
| TASK-35 CI cost | not measured |
| TASK-38 failure-injection matrix | not built |

## 12. The pattern worth carrying forward

**Five** times this phase, the deliverable was **correct and connected to nothing**:

1. a Phase 7 suite with a CI step and zero assertions (#215);
2. a classifier and a collector no workflow invoked (#219 → measured in #221);
3. a capacity preflight the deploy path never called (#220);
4. `ci.yml` uploading nothing at all (#221);
5. **the deploy job never ran `opsctl capacity`** — the one read-only command that
   prints per-deployment status, in a phase whose central question was "which row
   is READY". Found while trying to answer that question and discovering no
   artifact could (§6). Fixed in #224's follow-up; this one is the only entry in
   the list that was closed rather than merely named.

Each was found by asking **"who calls this"**, never by reading the code. The
cheapest gate this repository could add is one that asks that question about every
tool it builds.

The fifth also shows the shape of the fix: it was not a new tool. `opsctl capacity`
already existed and already answered correctly; nothing called it, and it was not
printing the two fields that made its answer usable. **The cheapest repair in this
list was one call site and two JSON keys.**

### 12.1 The second pattern, and this phase produced its strongest instance

**A conclusion that was reasoning all the way down, and never touched.** §6 was one
inference stacked on another: the four rows are `READY` → therefore superseded →
therefore released. Every step is defensible and none was measured.

The deploy made the last step false. Then the instrument made the **first** step
false too, and that mattered more: none of the four was `READY` at all. Three were
`ACTIVE` — serving — and one was `DEGRADED`. The rule had no candidate, so its
silence was correct, and the two `data-catalog` rows the audit called "reclaimable"
included the plugin's **live** version. Had the rule agreed with the audit, it would
have taken a working route down.

That is worse than a prediction failing. A wrong prediction wastes a deploy; a wrong
premise, acted on, breaks production. The audit was one step away from recommending
it: 「两个可以回收」 was written as a fact about safety.

The tell is in what the earlier version of this document said: *"reasoned from the
rule + the occupant list, not observed"* — and then, four lines later, a table row
reading *"the fix resolves staging: not verified and not claimed"*. The distinction
was already written down correctly. It just was not load-bearing, because nothing
downstream depended on it. **A caveat that changes no decision is decoration.**

What fixed it was two cheap things: one authorised deploy, and one read-only command
whose output nobody had ever collected. The second cost one call site and two JSON
keys. **Instruments refute. Reasoning, however careful, only elaborates.**

### 12.2 A number must come from the sample it describes

Nearly written down twice, in two shapes:

- `http://<staging>:3000/livez` → **502**, which reads as "staging is down". It was
  the local HTTP proxy: `connect=0.0003s`, `Proxy-Connection: keep-alive`, and
  `--noproxy '*'` → `000`. **The sample was my machine.**
- the closeout table row for `a1f468ff` was set to `success` before `ci.yml` had
  finished. It was `in_progress` at that moment, and it was only caught because the
  row was being cross-checked against the API rather than against the memory of a
  green PR.

Both are the same mistake as 「PR 通过不等于 main 通过」, which this phase spent a
whole task building a tool for. The tool is now right and the habit is not yet.

### 12.3 A suite that passes because no fixture reaches the hard case

The version-ordering defect in #222 passed all five tests in its module. The
counterfactual only failed once a fixture straddled a digit boundary — `0.0.9`
before `0.0.10` with an older `created_at`. A rule can be wrong in exactly the case
nobody built.

Then the same shape appeared in a test rather than in a rule, and this time the fix
was found by running the counterfactual rather than by reading the code. The test
that was supposed to catch "this suite dirties the working tree" asserted only
`git status | grep '^ M'` — so when the fixtures were files that had just been
**deleted** from the index, the pollution appeared as `??` and the assertion passed.
Measured: the counterfactual reported `ok and rewrote no tracked fixture` while
seven files had been written into the repository. Fixed to `grep -v '^D '`, which
catches both shapes.

The lesson is the same one as above: **an assertion is only worth its
counterfactual.** Reading it told me it was correct; running it told me it was
not.
