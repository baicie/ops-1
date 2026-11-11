# P001-C1.1 — Lifecycle Correctness & Test Isolation

Status: **PARTIAL, materially better.** The test harness can no longer touch
anything outside its own run, and `rollback` now has one outcome shape across
every branch, verified against a live platform. Two defects were found by the
new tests that the previous phase did not catch.

| Fact | Value |
|---|---|
| Base | `main` `7853c3c` |
| Branch | `test/p001-c11-isolated-harness` |
| Host | macOS 15.7 / arm64, Docker Desktop 29.7.2 |
| Regression | `cargo test -p opsweave-kernel` → **281 passed, 0 failed** |

---

## 1. A — test resource isolation

### 1.1 The defect

`tests/ci/p001c_up.sh` ended its reset with:

```bash
docker ps -aq --filter label=opsweave.managed=true | xargs -r docker rm -f
```

Every OpsWeave container on the daemon. It was harmless only because the four it
removed were abandoned leftovers — had another installation or a concurrent run
been live, it would have destroyed them.

### 1.2 What replaced it

Everything derives from one `RUN_ID`:

| Resource | Before | Now |
|---|---|---|
| database | `p001c` | `p001c_<runid>` |
| state dir | `/tmp/p001c` | `/tmp/p001c-<runid>` |
| kernel / node ports | 18281 / 9201 / 9202 | derived from `RUN_INDEX`, two runs coexist |
| HOME | the user's real `$HOME` | `/tmp/p001c-<runid>/home` (0700) |
| containers | `opsweave.managed=true` | `opsweave.node-id=<this run's node ids>` |

`opsweave.node-id` is the label the node already stamps and is a fresh UUID per
database, so it cannot match another run or another installation.
`opsweave.managed=true` is never used as a filter again.

`tests/ci/p001c_teardown.sh <run-id>` stops one run and removes only its own
containers, refusing with `BLOCKED` when it cannot verify the target.

### 1.3 Credentials

`opsctl` wrote to `~/.opsweave/session.json` regardless of the test, overwriting
the user's session on every run. The run now has its own `HOME`; measured after
a 22:54 run, the real session still carried its 20:14 timestamp unchanged.
`session.json`, `token` and `run.json` are all `0600` under `umask 077`.

### 1.4 The counterfactual, and the bug it found in this very change

`tests/ci/p001c_isolation_guard.sh` plants a container that looks exactly like
something safe to delete — `opsweave.managed=true`, a foreign `opsweave.node-id`,
a real running process — and requires it to survive a full start/restart/teardown
cycle.

**It found a dead branch.** The cleanup was written as
`if [ "$RESTART" = "0" ] && [ -f "$STATE/run.json" ]`, which is unreachable: a
freshly generated run id always has an empty state dir, so `run.json` never
exists on the branch that runs it. The guard passed while the global sweep was
deliberately reintroduced, because the sweep sat in code that never executed.

Corrected to `RESTART=1`, after which:

```
correct implementation  -> 7 PASS, exit 0
global sweep reinstated -> 2 FAIL, exit 1   (foreign container removed / restarted)
restored                -> 7 PASS, exit 0
```

That sequence is the evidence. A guard that cannot fail is not a guard, and the
first version of this one could not.

### 1.5 What ran

```
PASS  the run created 2 container(s) of its own
PASS  restarting the same run exercised the cleanup branch
PASS  the foreign container still exists, same id
PASS  the foreign container was not restarted
PASS  the run's own containers were all removed
PASS  a second foreign container also survived
PASS  teardown refuses an unknown run and says BLOCKED
```

---

## 2. B — rollback state consistency

### 2.1 Every branch now reports the same thing

| Target state | Behaviour | `rollbackCompleted` |
|---|---|---|
| already active | idempotent success, no work | `true` |
| `READY` | activate, then re-read | `true` |
| `PENDING` / `PREPARING` | 202, says what to wait for | `false` |
| `DISABLED` / `DRAINING` / `FAILED` / `DEGRADED` | redeploy, then the CLI activates | `true` after the CLI finishes |
| no deployment | create it, then activate | `true` after the CLI finishes |

`rollbackCompleted` is **not asserted by the branch** — it is computed by reading
the `ACTIVE` activation back from the database, so a branch cannot claim
completion by returning a success-shaped body.

Envelope, on every branch:

```json
{ "targetVersion": "0.0.1", "effectiveVersion": "0.0.2",
  "effectiveRevision": 2, "rollbackCompleted": false,
  "pendingActivation": true,
  "nextStep": "the target deployment was DRAINING; it must be redeployed …" }
```

### 2.2 Two defects found by driving it

**D-A — concurrent rollbacks returned 500.** Two operators activating at once
compute the same next generation; the loser hit
`activation_revisions_plugin_id_generation_key`, and the blanket
`From<sqlx::Error>` turned a unique violation into `Internal Server Error`. Now a
`409 CONFLICT`. Measured: before, one of two concurrent calls returned 500;
after, neither does and exactly one `ACTIVE` revision remains.

**D-B — a stale `expectedRevision` was detected only after a full redeploy.**
`activate_inner` checks it, but the redeploy branch ran first, so a caller
holding an outdated revision waited out a redeploy to be told the request was
never valid. The check moved before any work: **0 s instead of minutes.**

### 2.3 A false positive in the test itself

The concurrency assertion searched for `"500"` anywhere in the CLI output and
went red on a container id that happened to contain those digits. It now matches
the CLI's own `API 5xx` prefix. Recorded because it is the same class of mistake
the phase is about — a test that reports the wrong thing — pointing the other way.

### 2.4 What ran

`tests/ci/p001c_rollback_states.sh <run-id>`, 17 checks against a live platform:

```
A. idempotent rollback          -> completed, route unchanged
B. v2 -> v1 across a redeploy   -> completed, gateway serves 0.0.1, active 0.0.1
C. stale expectedRevision       -> refused in 0s, route and revision unchanged
D. two concurrent rollbacks     -> one succeeds, neither 5xx, one ACTIVE revision
E. rollback to an unknown version -> refused, route unchanged
```

---

## 3. C0 errata

`03g-c0-errata.md`. Two of C0's three findings were graded too strongly and one
was framed wrongly. Short version:

| | C0 said | Corrected |
|---|---|---|
| F1 | HIGH, blocks C2 | a policy question; C2 cases 5/6 are not blocked |
| F2 | defect | non-ACTIVE assets **must** be served for open tabs; the gap is the absent retention window |
| F3 | defect | `disable` is correct for emergency stop; the planned variant does not exist |

The F1 grade in `03-plugin-baseline.md` was annotated in place rather than
silently edited, so the correction is visible next to what it corrects.

---

## 4. Conformance cannot pass by testing nothing

`tests/contract/run_conformance.py` skipped every instance that was not `READY`
and every instance without a host port, then printed the total instance count as
though it had probed them. **A deployment whose instances were all `UNHEALTHY`
executed zero assertions and the script exited 0.**

It now counts what it probes, fails when that count is zero, and reports
`probed N of M`.

The self-check guarding this was wrong twice, and both attempts are recorded in
the file: a substring search for the assertion matched its own comment, and a
check for a `Name` node called `probed` matched the loop's own increment. It now
requires a `Compare` whose operand is `probed`. Verified by deleting the
assertion — `self-check broken: probe() no longer compares the probed count`,
exit 1 — and restoring it.

**Not verified live here**: the conformance suite needs three running plugins.
It is a logic fix plus a self-check, and the live three-language run stays
`NOT_RUN` until C3.

---

## 4b. A CI outage that looked like a code failure

The first full CI run on this branch reported nine red jobs at once —
`rust`, `acceptance`, `g13a-roundtrip`, `g13a1-gateway`, `g13b14-claim`,
`g13b16-effect`, `g13b17-principal`, `golden-path`, `runtime-golden-path`.

That pattern is what a broken change looks like, and it was not one:

- the failing logs each carried **20** `Temporary failure resolving
  'security.ubuntu.com'` lines — the runner could not resolve DNS, so `rustup`
  and `apt` never installed;
- `platform-only`, the job that runs this phase's own guards, **failed and then
  passed on rerun with no code change**;
- twelve jobs passed in the same run, including `linux-runtime` and
  `platform-image-build`;
- locally, `cargo build` succeeded and `cargo test -p opsweave-kernel` gave
  **281 passed, 0 failed**.

On the rerun the same thing happened to the same seven jobs, and the pattern is
now unambiguous — **every failure failed at the identical step**:

```
Run sudo apt-get update && sudo apt-get install -y postgresql-client
  -> 20 "Temporary failure resolving 'security.ubuntu.com'" per job
```

`rust`, `acceptance`, `golden-path`, `runtime-golden-path`, `g13a-roundtrip`,
`g13a1-gateway`, `g13b14-claim` — all seven stopped in that line. **No Rust code
was compiled and no test ran in any of them.**

Recorded so that a future reader does not treat this run as evidence about the
code in either direction. The green jobs are evidence; the outage is not.

**What this does block:** `rust` is a required check, so the PR cannot merge
while it is red, whatever the cause. That is the rule working as designed. The
resolution is a rerun once the runner's DNS recovers, not a change to the code.

---

## 5. What is still NOT done

| Item | Status |
|---|---|
| Full lifecycle end-to-end in one isolated run (Phase 3) | **NOT_RUN as a single recorded run** — the pieces ran across the state-machine and isolation suites, but no single transcript covers build → push → … → uninstall |
| `|| true` removal from `e2e_platform.sh` | **NOT DONE** — 8 remain; 6 of them sit on deploy/activate lines, so a failed deploy still surfaces as a downstream gateway failure rather than at its cause |
| Dedicated plugin-lifecycle CI workflow | **NOT DONE** — no workflow runs these suites yet |
| Java / Go in the isolated harness | **NOT_RUN** — the Java restart failure reproduced locally, passed in CI, unexplained |
| F2 retention policy | design only |
| F3 planned disable | design only |
| Long-lived async rollback operation | not built; the CLI finishes the work inline, which is enough for one operator and is documented as such |

**The concurrency contention is real and unfixed**: two rollbacks to the same
version can starve each other on a loaded host — both sat at `PREPARING 0/2`
while the node log showed instances cycling `READY → readiness timeout → READY`.
The status codes are now correct; the scheduling problem is separate.

---

## 6. Position

C1.1 asked for two things: a harness that cannot reach outside itself, and a
rollback whose every branch tells the truth. Both are done and both are guarded
by tests that were shown to fail without them.

It is **not** the full lifecycle acceptance (Phase 3), and the workflow wiring
(Phase 6 in the brief) is deliberately left for the next step so that this stays
reviewable.

C1 → **PARTIAL** (D4 assets-after-uninstall open, browser/capability/Java/Go
coverage still owed to C2/C3/C4).
C1.1 → **PASS on its own scope**: isolation and rollback consistency.
