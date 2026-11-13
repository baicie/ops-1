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

## 4c. C1.1 review fixes — seven defects found by reading the tests, not the code

A review of this phase found seven places where a test could pass without
proving what it claimed. All seven are fixed, and each has a counterfactual.

| # | Defect | Evidence it was real |
|---|---|---|
| B1 | `isolation_guard` read `run.json` **after** `--purge` deleted it, so "own containers removed" printed 0 unconditionally | the `if not os.path.exists(path): print(0)` branch was the only one reachable |
| B2 | teardown killed any PID in a stale pidfile — `kill -0` proves a process exists, not that it is ours | PIDs are recycled; a leftover file after a reboot names an unrelated process |
| B3 | CASE 2 planted a container with a *different* node-id and called it a collision | it asserted nothing the old code could fail |
| B4 | `RUN_ID` came from env/argv unvalidated, and scratch files used fixed `/tmp/p001c11-*` names | two concurrent runs overwrote each other's output |
| B5 | concurrency asserted "at least one exited 0" | that passes when the second request corrupts state |
| B6 | the idempotent short-circuit ran **before** the `expectedRevision` check | a stale CAS was answered `200 idempotent` |
| B7 | conformance self-check inspected the AST | an assertion that exists only in the AST is not one that fires |

### B2 — process identity

Each pidfile now carries a start fingerprint (`/proc/<pid>/stat` field 22 on
Linux, `ps -o lstart=,comm=` on macOS) captured at launch. Teardown refuses to
signal a PID whose fingerprint no longer matches, and says so.

### B3 — the collision is real, and it needed a code change

Node ids are **not ownership**. They survive a database restore or a copied
state directory, so two unrelated installs can share one. The cleanup was scoped
to `label=opsweave.node-id=<id>` alone, which would delete the other install's
containers.

Fixed by giving the node a caller-supplied label: `OPSWEAVE_CONTAINER_LABELS`,
stamped on every container it creates. Cleanup now matches **node id AND**
`opsweave.test-run=<RUN_ID>`.

Measured, with a container planted that carries the run's node id but not its
run label:

```
PASS  the collision is real: 1 container(s) answer to node-id <id> alone
PASS  the dual filter excludes it (0 matched)
PASS  the colliding container survived the attempted cleanup
```

### B6 — ordering, and what it broke

`rollback` to the version that is **already active**, with an **outdated**
`expectedRevision`, returned `200 {idempotent: true}`. The caller's
compare-and-swap was silently ignored and the answer confirmed a belief about the
current revision that was false.

The revision check moved above the short-circuit. Verified by section C of the
state-machine test, which now refuses in **0 s** instead of after a redeploy.

### B5 — concurrency, and the assertion that was wrong twice

Two identical rollbacks now classify as `success` + `conflict`. The initial
version of this phase asserted that both must succeed; that was wrong, because
whichever commits second legitimately finds a consumed `expectedRevision`. The
correction is recorded in the test itself.

A second correction: the classifier now accepts `409 CONFLICT` as well as
`REVISION_CONFLICT`. Both are correct CAS refusals - one from the pre-flight
check, one from the unique-index mapping added in this phase - and the property
under test is that neither is a 500.

### B7 — behaviour, not syntax

`probe()` now has `probeable_instances()` extracted so the test can drive the
real function with synthetic deployments: no instances, all `UNHEALTHY`, `READY`
without a host port, a mixed set, and a `STOPPED` instance. Each must produce a
recorded failure; a probeable instance must not.

Counterfactual: restoring the original skip-everything loop makes it print
`self-check broken: a probeable instance still tripped the zero-instance failure`
and exit 1.

### What the review did not change

- No required check was weakened, no ruleset touched, no workflow trimmed.
- The isolation guard still fails when the global `opsweave.managed=true` sweep
  is reintroduced: verified again after these changes.

## 4d. C1.2 — container ownership, and why the node id was never enough

C1.1 scoped the **test harness** to its own run. That was correct and it was not
enough: the **product** had the same defect underneath it, and the harness label
that fixed the harness did not exist in production.

### The root cause

`DockerAdapter::remove_if_exists()` ran a bare `docker rm -f <name>` before every
create, and `container_name()` is `opsweave-<node-id>-<instance-id>`. Both ids
come from the database. A restored database — or a copied state directory —
therefore reproduces them **exactly**, and a second installation then computes
the same container name, deletes the first installation's running container, and
creates its own in its place. The first installation keeps serving traffic that
is now going to a container it does not own.

`list_managed()` had the same shape: `label=opsweave.node-id=<id>` alone. It
drives `cleanup_orphans`, `cleanup_locked` (quarantine) and the retry loop, so
the product's own recovery path removed another installation's containers. The
harness defect C1.1 fixed was the *same* bug, noticed in the harness.

### The fix

| Where | Change |
|---|---|
| `docker::INSTALLATION_LABEL` | `opsweave.installation-id`, stamped on every container the node creates |
| `DockerAdapter::installation_id` | carried by the adapter; `None` never means "owns everything" |
| `ownership_of()` | decides `Ours` / `Foreign` / `Absent` by reading the label back from Docker |
| `remove_owned_if_present()` | replaces `remove_if_exists`; a `Foreign` container is an error, not a delete |
| `stop_and_remove_owned()` | used by `cleanup`, `cleanup_orphans`, quarantine, retry loop |
| `list_managed()` | requires **both** node id and installation label; errors with `CONTAINER_OWNERSHIP_UNPROVEN` without an identity |
| `create_and_start()` | refuses with `CONTAINER_OWNERSHIP_CONFLICT` on a foreign name; refuses to create unlabelled |
| `runtime::load_or_create_installation_id()` | mints `<state_dir>/installation-id` once; validated as a UUID on read |
| `scripts/demo_down.sh`, `demo_up.sh` | the global `opsweave.managed=true` sweep is gone; both scope to this checkout's identity |

Deliberately **not** stored in the database. A restored database is one of the
two ways two installations come to share a node id, so a token kept there would
be restored alongside the collision and prove nothing. It lives with the Node's
state directory, which is the thing that is actually distinct per install.

### Compatibility

A container created before this change carries no installation label. It reads
as `Foreign` and is **never swept**. That is the correct default — an unlabelled
container may belong to another installation or to an older version, and neither
is safe to delete on a guess — but it means an upgrade leaves the old containers
running until an operator deals with them:

```
docker ps -a --filter label=opsweave.managed=true --filter label=opsweave.node-id=<node>
# those with no opsweave.installation-id are pre-upgrade
docker rm -f <name>   # deliberate, one at a time
```

`demo_down.sh` prints that instruction when it finds them. There is no automatic
migration: a migration that guessed would be the same bug again.

### Counterfactuals

Each was run against the real daemon, not reasoned about.

| Assertion | Broken implementation | Fixed |
|---|---|---|
| `apps/node/tests/container_ownership.rs` — B cannot take over A's container | **FAIL** (`B was allowed to create over A's container`) | **PASS** |
| same file — an unlabelled container is never swept | **FAIL** | **PASS** |
| same file — a same-name, same-image container is not adopted | **FAIL** (`B adopted A's container`) | **PASS** |
| `docker.rs` unit tests (4 ownership tests) | **FAIL** (4/4) | **PASS** |
| `p001c_isolation_guard.sh` CASE 2 | **FAIL** (`teardown removed another install's container`, `was stopped or restarted`, `labels changed`) | **PASS** |
| `p001c_isolation_guard.sh` CASE 2 with the node not stamping the label | **FAIL** (`CASE 2 run created no containers`) | **PASS** |

The CASE 2 rewrite matters on its own. The previous version ran teardown a
*second* time after `--purge` had already deleted the run record, so teardown
refused before it ever reached the container-ownership decision — the case
proved nothing about containers. It now starts its own run, plants a container
with **the same node id and a different installation id**, and drives a real
restart and a real teardown against a **valid run record**.

### What is verified, and where

| Scope | Evidence |
|---|---|
| Ownership decision, all three outcomes | unit tests in `apps/node/src/docker.rs`, fake daemon |
| Real daemon, compiled adapter, two installs | `apps/node/tests/container_ownership.rs`, **ran locally** (Docker 29.7.2, macOS 15.7) |
| Harness restart + teardown does not over-reach | `p001c_isolation_guard.sh`, **ran locally**, all checks PASS |
| Crash-recovery loop still converges | existing `runtime::tests::retry_loop_*`, PASS |
| CI, native Linux | `linux-runtime` job on `3f58524`: **success**, 18 steps. Includes `One installation cannot take over another's container` (`OPSWEAVE_REQUIRE_TEST_DOCKER=1`, real daemon) plus build → install → unprivileged socket → upgrade/rollback → DEGRADED |

### Three things this does not fix

**The harness and the product use different predicates.** The harness still
passes `OPSWEAVE_CONTAINER_LABELS=opsweave.test-run=<run id>`; teardown now
matches on the product's `opsweave.installation-id`. The test-run label is now
redundant and is kept only so an old run record still cleans up. `p001c_up.sh`
keeps the identity across restarts and records it in `run.json`; before that,
every restart would have minted a new one and orphaned the previous containers —
which is the bug this phase is about, one level down.

**The harness had the same bug one level down, and it was found by writing this
section.** The first version of the `p001c_up.sh` change minted one installation
id *per node* but recorded only node-a's in `run.json`, so teardown would have
cleaned node-a's containers and silently left node-b's behind forever. Both
nodes now share one id, minted once and preserved across restarts. It is the
same failure the phase is about - a cleanup predicate that does not cover
everything it claims - and it survived two green guard runs before being read.

**One sweep was left as it was, deliberately.** `tests/ci/data_foundation_ci.sh`
still ends with `docker ps -aq --filter label=opsweave.managed=true | xargs -r
docker rm -f`. It is a CI script that runs only on a dedicated ephemeral runner,
so its blast radius is the runner, not a developer or production host - and
changing it mid-CI would have invalidated four in-flight jobs for no safety
gain. It is the same defect class and should be scoped the same way the demo
scripts now are; recorded here rather than silently fixed in the wrong phase.

**One pre-upgrade container is still on the daemon** from an earlier run, with
`opsweave.managed=true`, a node id, and no installation label. It is left alone
on purpose, as the compatibility section describes.

---

## 4e. C1.2.1 — a clone is not the original, and a stop is not a guess

C1.2 gave each installation an `opsweave.installation-id` and stamped it on every
container. That fixed two installations that were created **independently**. It
does not fix two installations where one state directory is a byte-for-byte copy
of the other's, which is the ordinary result of `cp -a`, `rsync -a` or untarring
a backup.

### The reproduction, before any fix

`apps/node/tests/state_dir_clone.rs` seeds a state directory, starts nothing,
resolves A's identity, then `cp -a`s it to B. Both carry the same
`node-identity.json` and the same `installation-id`, so B's adapter asks
`ownership_of` about A's running container and gets:

```
left: Ours
right: Foreign
REGRESSION (C1.2.1 Task A): a full state-dir clone answered Ours for a container
it did not create.
```

That is the whole defect: on the daemon the original and the clone are the same
installation, so the clone can delete, stop and take over the original's
containers. `list_managed` lists them for the same reason.

### What can and cannot be distinguished

| Event | On disk | Identity must persist? |
|---|---|---|
| restart | same directory, same inode | **yes** |
| in-place `mv`, one filesystem | same inode, new path | **yes** |
| restore into a new place | new inode, original may still run | **yes, if the original is gone** |
| full clone (`cp -a`) | new inode, original still runs | **no** |

Restore and clone are the **same bytes**, so no amount of reading the state
directory separates them. Only the operator knows which it is. ADR-023 records
the decision: bind the identity to the device+inode it was minted in, and fail
closed when the directory no longer matches, with a one-time explicit choice.

### The fix

`<state_dir>/installation-binding.json` records the installation id and the
device/inode of the directory it was minted in. `cp -a` allocates a new inode;
a restart and an in-place `mv` do not. A mismatch is `INSTALLATION_IDENTITY_CONFLICT`,
and `OPSWEAVE_INSTALLATION_ID_ACTION` resolves it once:

| Value | Meaning |
|---|---|
| unset | refuse to start; nothing changed |
| `accept` | same installation, moved or restored; keep the id |
| `reinitialize` | this directory is a clone; mint a new id, leave the original's containers to the original |

Pre-C1.2.1 directories have an identity but no binding. They adopt their current
directory and log it. **That is the one silent path, and it has a stated
boundary:** a clone made *before* the upgrade is undetectable, because both
copies adopt their own directories and keep the shared id. It is a residual
risk, not a fixed case.

### Three defects found inside `load_or_create_installation_id`

The brief asked for these specifically; all three were real.

| # | Defect | Consequence |
|---|---|---|
| 1 | `if let Ok(existing) = read_to_string(...)` treated **every** read error as "absent" | an `EACCES` on the state directory silently minted a second identity and orphaned everything the first owned |
| 2 | fixed `installation-id.tmp` | two concurrent starts shared the temporary file; one rename moved it out from under the other |
| 3 | no `create_new` | the loser returned an id it had failed to persist, and the daemon was labelled with it |

Now: only `NotFound` means absent, the identity file is created with `O_CREAT|O_EXCL`
and a loser re-reads the winner's value, and the binding uses a unique temporary
name. `concurrent_mints_agree_on_one_identity` runs eight simultaneous starts and
requires one identity and agreement with the file — it **failed** against the
fixed-`.tmp` implementation that this section documents.

### Task D — the check and the delete were two different objects

`remove_owned_if_present` decided by **name** and then ran `docker rm -f <name>`.
Between the two the name can be reassigned: another installation removes the
container we judged ours and creates its own under the same name, and the delete
then destroys theirs.

`probe_ownership` now returns the label **and** the immutable container id from a
single `docker inspect`, and every destructive call (`rm`, `stop`) targets the id.
Docker never reuses an id, so it cannot be redirected. "Already gone" is success;
a surviving id is `CONTAINER_OWNERSHIP_BLOCKED`.

### Task B — the demo scripts

Two defects, both confirmed by reading before changing:

1. **`demo_up.sh` read ownership after destroying it.** `RESET=1` ran `rm -rf data`
   and only then looked for `data/node-*/installation-id`. The wipe had already
   deleted those files, so the cleanup loop never ran and every reset left the
   previous run's containers on the daemon while reporting a clean reset.
2. **Both scripts killed whatever held the demo ports.** `lsof -t | xargs kill`
   assumes the listener is ours. It is not when a second checkout, a colleague, or
   a stale process holds 18181.

`scripts/demo_common.sh` now owns both operations:

- `demo_kill_port` kills a listener only when its command line proves this
  checkout started it, waits for the port to free, and returns BLOCKED otherwise.
- `demo_stop_containers` removes only containers carrying this installation's
  label, and reports (never removes) containers it cannot attribute.
- `demo_up.sh` stops containers **before** `rm -rf`, and aborts the reset if the
  stop could not be proven.

### Task C — the Data Foundation harness

`tests/ci/data_foundation_ci.sh` ended with the global
`label=opsweave.managed=true` sweep. It now removes only the installation ids
this run created under `data-ci/`, reports anything it cannot attribute, and
refuses to start on a daemon that already carries OpsWeave containers unless
`OPSWEAVE_CI_ALLOW_SHARED_DAEMON=1` says the runner is dedicated.

The cleanup trap now ends with `exit "$code"`. The old code ended with `|| true`
on the last command; that happened to preserve the exit status because nothing
ran afterwards, but it was one edit away from turning a failed acceptance run
green.

### Two defects CI caught that local runs did not

Both were found by the first CI run of this phase, and both are recorded because
they are the point of running CI at all.

**1. `create_new` reserves the name, not the content.** `write_private` created
the identity file with `O_CREAT|O_EXCL` and *then* wrote it. The loser of the
mint re-read the name in between and got an empty file:

```
called `Result::unwrap()` on an `Err` value:
  .../installation-id was created concurrently and is not a valid installation id ("")
```

It reproduced locally about once in twenty runs and deterministically in CI. The
file is now written to a unique temporary path, synced, and published with
`hard_link`, which fails with `AlreadyExists` when the target is present. A
reader only ever observes a complete file.

Counterfactual: restoring the `create_new` version made
`concurrent_mints_agree_on_one_identity` fail 1/20 locally and on CI; the
`hard_link` version passed 25/25.

**2. The first run is not a lost identity.** `demo_stop_containers` refused
whenever no installation identity existed, which also refused the ordinary first
run - `legacy-regression` failed with `BLOCKED: no installation identity under
/data`. A fresh checkout has no containers by definition, so the correct
behaviour is a no-op. The two states are now distinguished by the daemon: no
OpsWeave containers at all means first run; containers without an attributable
identity means refusal.

This is the failure mode the brief warned about - a safety check tightened past
the point where it blocks legitimate work. It was caught by CI, not by review.

### Counterfactuals

| Assertion | Broken implementation | Fixed |
|---|---|---|
| a full clone cannot claim the original (`state_dir_clone.rs`) | **FAIL** — `a full clone resolved silently` | PASS |
| a restore needs an explicit accept | **FAIL** | PASS |
| 8 concurrent mints agree on one identity | **FAIL** against the fixed-`.tmp` code (`ENOENT`) and 1/20 against `create_new` (`""`) | PASS, 25/25 |
| a first run is a no-op, not a refusal | **FAIL** — `legacy-regression`: `BLOCKED: no installation identity` | PASS |
| an unreadable identity is an error, not a new identity | **FAIL** | PASS |
| the clone's sweep excludes the original's container | **FAIL** | PASS |
| a foreign listener survives `demo_down.sh` | **FAIL** — `the unrelated process was killed` | PASS |
| `demo_up.sh` stops before it wipes | **FAIL** — `wipes state before stopping containers` | PASS |
| a failed container removal is reported | **FAIL** — `a failed removal was reported as success` | PASS |
| a foreign installation's container survives the CI trap | **FAIL** | PASS |
| a shared daemon is refused with BLOCKED | **FAIL** | PASS |
| the acceptance exit code survives the trap | **FAIL** — rewritten to 0 | PASS |

### Compatibility and migration

- **Restoring a backup into a new path needs one explicit start** with
  `OPSWEAVE_INSTALLATION_ID_ACTION=accept`. Before this phase it needed nothing and
  silently inherited the original's ownership.
- **Cloning a state directory now needs `reinitialize`**, which mints a new
  identity. The original keeps its containers.
- **Clones made before this version remain undetectable.** Stated above; not
  claimed as closed.
- **Pre-C1.2 containers are still unlabelled** and still never swept.

### Residual risk

| Risk | Status |
|---|---|
| A state-dir clone **made before** C1.2.1 is undetectable | **open**, boundary stated in ADR-023 §2.3 |
| Non-Unix platforms cannot check the device/inode | binding is written with 0/0 and logs a warning; **a clone is not detected there** |
| `data_foundation_ci.sh` still kills whatever holds 18181/9101/9102 | **unchanged** — this phase scoped its *container* sweep only |
| Concurrent processes that both hold a valid binding for one directory | out of scope; they are the same installation by definition |

---

## 4f. C1.2.2 — a clone is not the original *node* either

C1.2.1 separated the Docker ownership identity. It left the **Kernel** identity
alone, and that is the other half of the same clone: `node-identity.json` holds
the node id, the control credential, the data token and the generation.

### The reproduction, before the fix

`tests/ci/p001c122_clone_node_identity.sh` clones node-a's live state directory
on a running platform and reinitializes it. Against C1.2.1:

```
A node=8c820e19-5447-439f-a2e0-08bab78250ee  endpoint=http://127.0.0.1:9251
PASS  the clone minted a different Docker installation id
FAIL  the clone loaded A's Kernel identity instead of enrolling afresh
FAIL  A's data endpoint moved http://127.0.0.1:9251 -> http://127.0.0.1:21637
```

The clone did not merely *share* A's node row — its heartbeat **overwrote A's
`data_endpoint`**. Two processes with one node id alternate `generation`,
`last_seen_at` and `data_endpoint` on every heartbeat, both receive the same
`DesiredWorkload` list, and both may create instances for it. Separating the
container identity alone therefore fixed the container half of the collision and
none of the node half.

### The fix

`IdentityAction::Reinitialize` now means **a new installation in both senses**.
`load_or_create_installation_id` returns whether the Kernel identity must be
discarded, and `main` acts on it:

| Question | Answer |
|---|---|
| What is discarded? | `installation-id`, `installation-binding.json`, `node-identity.json` |
| What is required? | a **new** enrolment token — the inherited one was spent by the original |
| Credential / data token / generation | all new, from `POST /api/v1/node-enrollment/redeem` |
| When is state destroyed? | **after** the new enrolment succeeds, never before |
| If enrolment fails? | **corrected in §4g**: only `node-identity.json` was restored, so the directory is NOT what it was. C1.2.3 replaced this with a durable migration marker |

The inherited identity is read, set aside, and only replaced once the
replacement exists. A failed enrolment puts it back, so the directory is exactly
what it was and the operation is retryable. It never falls back to the shared
credential.

`accept` is unchanged and means the opposite: this directory **is** the same
installation, moved or restored, and keeps its Kernel identity.

### The operational trap the fix exposes

`kernel.nodes.name` is `UNIQUE`, and the inherited name belongs to the original.
A clone enrolled without `OPSWEAVE_NODE_NAME` is rejected with the Kernel's
generic

```
node enrollment failed (409 Conflict): {"code":"CONFLICT", ...}
```

which does not explain itself. This is **not fixed**: the Kernel cannot know
that two enrolments are one clone, and deriving a `CONFLICT` explanation from a
bare unique violation would be a guess. ADR-023 records the documented step —
set `OPSWEAVE_NODE_NAME` when reinitializing a clone. It is a residual risk, not
a closed item.

### Three defects in the assertion itself

The credential and desired-workload checks had to be written twice. All three
mistakes were mine, and all three would have produced a green that meant nothing:

1. The first version treated HTTP **422** as a credential rejection. 422 is a
   payload error returned *after* authentication succeeds. The control that
   proved it: A's **own** credential got 422 for A.
2. The body said `"status":"ready"`; the contract's `NodeStatus` is uppercase
   (`READY`). Another 422.
3. The body said `"generation":1` while A's live supervisor had advanced the
   row, so the control got **409 STALE_NODE_GENERATION** — a rejection of the
   number, not the credential.

Fixed by reading the node's current generation from the Kernel and by adding a
control assertion that A's own credential returns **200** before the clone's is
required to return 401. Without that control, a wrong payload shape would have
made every credential assertion pass by accident.

### Task B — the demo cleaned one installation and reported success

`demo_installation_id()` returned the **first** identity it found. `demo_up.sh`
gives node-a and node-b separate state directories, so they normally hold
different ids — and `demo_stop_containers` removed node-a's containers and left
node-b's running, behind a message that said the stop had succeeded.

`demo_installation_ids()` now returns the whole set, deduplicated (two nodes can
legitimately share an id after a copied directory, and removing one installation
twice is pointless). `demo_stop_containers` iterates it. One installation
failing to remove aborts the others and returns non-zero; it never widens the
sweep and never reports success.

### Counterfactuals

| Assertion | Broken implementation | Fixed |
|---|---|---|
| after reinitialize the clone has its own Kernel node id | **FAIL** — `still holds A's Kernel node id` | PASS |
| the clone holds a **different control credential** | **FAIL** — `the clone inherited A's control credential` | PASS |
| the clone's credential is rejected for A's node id | **FAIL** — accepted, because they are the same credential | PASS, HTTP 401 |
| the Kernel answers A's heartbeat for A's node id | n/a (control) | PASS |
| A's data endpoint is not overwritten | **FAIL** — `9251 -> 21637` | PASS |
| a re-enrolment without a fresh token is refused | n/a (new) | PASS |
| the inherited `node-identity.json` is restored byte for byte | n/a (new) | PASS — but only that file, which is the defect §4g fixes |
| it does not fall back to the shared credential | n/a (new) | PASS |
| A1 (node-a) and B1 (node-b) are both removed | **FAIL** — `B1 survived: only the first installation was cleaned` | PASS |
| C1 (another installation) survives | PASS (both) | PASS |
| both installations are named in the report | **FAIL** — only `aaaa…` listed | PASS |
| a duplicated identity is reported once | n/a (new) | PASS |

### Verified where

| Scope | Evidence |
|---|---|
| Kernel identity split | `p001c122_clone_node_identity.sh` against a **real** Kernel + PostgreSQL: **15 checks PASS**, twice |
| Distinct credentials (behavioural) | same script: A's own credential 200, the clone's 401 for A's node id |
| Docker identity | `state_dir_clone.rs` 7 tests PASS |
| No-token refusal and restore | same script, 3 checks PASS |
| Demo multi-installation cleanup | `p001c121_demo_safety.sh` CASE 3b/3c, 8 checks PASS |
| Workspace | `cargo test --locked --workspace` |

### Residual risk

| Risk | Status |
|---|---|
| A clone made **before** C1.2.1 is undetectable | **open** — ADR-023 §2.3, unchanged |
| Non-Unix platforms cannot check device/inode | **open** — unchanged |
| A clone re-enrolled without `OPSWEAVE_NODE_NAME` fails on the UNIQUE name | **open**, documented in ADR-023 §2.2a |
| Two processes sharing one state directory with a valid binding | out of scope, unchanged |

---

## 4g. C1.2.3 — a failed reinitialize is a state, not an accident

C1.2.2 made `reinitialize` discard the Kernel identity as well as the Docker
one, and relied on an in-memory restore when enrolment failed. That restore was
incomplete and conditional on the process still being alive.

### The defect, measured

The reproduction does exactly what the brief forbids substituting around: clone,
fail once, then start again **without** deleting the directory, **without**
re-copying it, **without** repairing a file and **without** a token.

After the first (failed) start the directory held:

```
installation-id            1c9e7d81…   NEW  (A's is fd4f3842…)
installation-binding.json  81d45240…   NEW
node-identity.json         93e348d4…   IDENTICAL TO A'S
```

The next start compared the new binding against its own directory, matched,
concluded the directory was settled, and returned `discard_node_identity:
false`:

```
INFO  loaded node identity  node_id=20f478dd-…  generation=2
```

That is A's node id. The clone then heartbeated as A and rewrote its endpoint:

```
A endpoint before: http://127.0.0.1:9321
A endpoint after : http://127.0.0.1:21902
RESULT: A OVERWRITTEN BY THE CLONE
```

### The fix

A durable marker, `<state_dir>/reinitialize-in-progress.json`, written **before**
any identity file is touched and cleared only after the new Kernel identity is
enrolled and persisted. Every start reads it first; it overrides the binding
comparison, so "the binding matches" can no longer be read as "the migration
finished".

| Crash point | Next start |
|---|---|
| marker written, nothing else | continues the migration |
| new identity minted, marker present | continues; does not settle |
| identity file missing | mints, then continues |
| enrolled but not committed | continues; re-establishes instead of inheriting |
| committed (marker cleared) | normal start |

`accept` against a pending migration is refused — it means "same installation",
the opposite of what the directory was being migrated to.

There is deliberately **no** in-memory restore of the installation identity.
Restoring the inherited id is what recreated the collision. The directory stays
mid-migration and the error now describes what is actually on disk instead of
claiming a clean revert.

### Acceptance scenarios

| Scenario | Result |
|---|---|
| **A.** failed reinitialize, then a plain start | does not load A's identity; A's endpoint unchanged |
| **B.** retry with a fresh token, same directory, no repair | enrols; nodeId / credential / dataToken / installation-id **all four independent** |
| **C.** crash at each of three points | never adopts the inherited identity; continues or refuses |
| **D.** restart / accept / first enrol / container ownership | unchanged, all PASS |

B, measured:

```
nodeId           A=20f478dd-…   B=7a429c74-…   independent
credential       A=ow_node_rR…  B=ow_node_B3…  independent
dataToken        A=ow_data_H2…  B=ow_data_Qb…  independent
installation-id  A=249b93d5-…   B=5e58418c-…   independent
marker cleared: migration committed
```

### Counterfactuals

| Assertion | Broken implementation | Fixed |
|---|---|---|
| a failed reinitialize is not settled on the next start | **FAIL** | PASS |
| every crash point refuses or continues | **FAIL** ×2 | PASS |
| accept and reinitialize do not mix | **FAIL** | PASS |
| end-to-end: the second start does not adopt A | **FAIL** — `A OVERWRITTEN BY THE CLONE` | PASS, `A untouched` |

The end-to-end counterfactual was run with a binary built from `origin/main` in a
separate worktree, so it measures the released code rather than a reverted
working tree. Removing the marker check failed three of the ten tests in
`state_dir_clone.rs`; restoring it passed ten.

### What changed in the documentation

ADR-023 said a failure left the directory "exactly what it was". That was false
and is corrected in place, with the measurement that disproved it. The claim is
withdrawn, not softened.

### Residual risk

| Risk | Status |
|---|---|
| A crash between two file operations still leaves a partial state | handled: every partial state is one the next start continues or refuses |
| A clone made **before** C1.2.1 is undetectable | **open**, unchanged (ADR-023 §2.3) |
| Non-Unix platforms cannot check device/inode | **open**, unchanged |
| Kernel consumed the token but the local write failed | the node exits naming the state; a fresh token is required. It is **not** a lossless automatic retry, and the message says so |

---

## 4h. C1.2.4 — an interrupted migration cannot keep the original's Docker identity

### The defect

`finish_or_continue_migration()` returned whatever `installation-id` held while
the migration marker was present. When the process died between `begin_migration()`
and the first `remove_file`, that value was the **inherited** id:

```rust
// before
Ok(InstallationIdentity {
    installation_id: current.to_string(),   // == inheritedInstallationId
    discard_node_identity: true,
})
```

The clone then completed its reinitialize with a fresh Kernel identity and the
original's Docker ownership token. The Kernel row was new, so the node *looked*
isolated; every cleanup scoped to that token still reached A's containers.

### Reproduced on `7581ee6`

The state was planted exactly as a crash leaves it - marker written, identity not
yet removed - and the node started with a fresh enrolment token.

```
== A node=fd189952… install=c19db612-015e-4fbd-8648-0aab05109e60
   planted the migration marker; installation-id is still A's
FAIL  the clone finished the migration holding A's installation id (c19db612-…)
PASS  the clone's Kernel identity is its own (649c98f0-…)
```

Both halves measured in one run: **new Kernel node, old Docker token**. That is
the failure mode C1.2.2 warned about, in the direction C1.2.3 left open.

Whether this is exploitable through the demo depends on the state directory
layout. `demo_up.sh` gives node-a and node-b separate directories, so the
`data/node-*/installation-id` scan does not see a clone inside the demo. The
exposure is to any cleanup that is handed an installation id directly - a
restored or copied deployment directory, a script that reads one id, an operator
who copies a directory in place - and the safety property above does not depend
on knowing which of those is in use.

### The fix

Three changes, all inside the migration state machine:

| Change | Effect |
|---|---|
| `finish_or_continue_migration` never returns `inheritedInstallationId` | the interrupted step is completed: remove, then mint |
| the marker records `inheritedNodeId` | commit can tell whether the Kernel half happened |
| `commit_migration` checks both halves | the marker cannot be cleared over a stale identity, on either side |

An identity that no binding attests to this directory is **replaced, not
adopted** (scenario C2 below). The argument is in ADR-023 §2.2a: while the marker
is present the node never reaches supervision, so an id minted during an
uncommitted migration owns no container and replacing it orphans nothing.

### Persistence

`write_atomic` and `commit_migration` did not sync the parent directory, and
`save_identity` was a bare rename. The recovery argument assumes the marker is
there when the process is not, so the write path now syncs file **and** parent
for the marker, the enrolled identity, and the marker's removal. What each level
actually guarantees - and what a process-kill test does *not* prove - is in
ADR-023 §2.5. **No power-loss test was run and none is claimed**; the third
level is a design property of the write path.

### Regression matrix

Each scenario asserts the final installation id differs from
`inheritedInstallationId`, not just the `discard_node_identity` flag.

| # | State on disk | Expected | Result |
|---|---|---|---|
| A | marker + inherited id | mints its own; never returns the inherited | PASS |
| B | marker, identity removed | mints; binding names it | PASS |
| C | marker, unattested id, no binding | replaced, re-bound; stable on the next start | PASS |
| C2 | marker, id bound to **another** directory | replaced, re-bound to this one | PASS |
| D | both files new, Kernel identity old | commit **refused**, marker kept, id unchanged | PASS |
| D' | Kernel new, inherited Docker id | commit **refused**, naming the id | PASS |
| E | both new, commit not reached | commit succeeds, marker gone | PASS |
| F | after commit, restart | ordinary start, no marker, same id | PASS |
| G | `accept` against a pending reinitialize | **refused**; identity unchanged | PASS |
| H | first install / restart | unchanged | PASS |
| Docker | clone finishes migration, A's container live | `Foreign`, not swept, not removed; A's id/StartedAt/Running/labels unchanged | PASS |

### Counterfactuals

Run against `origin/main` (`7581ee6`) in a separate worktree, so they measure the
released code:

| Assertion | On `7581ee6` | Fixed |
|---|---|---|
| A: the interrupted migration returns the inherited id | **FAIL** | PASS |
| C: an unattested identity is not adopted | **FAIL** | PASS |
| C2: an identity bound elsewhere is not adopted | **FAIL** (on the guarded build) | PASS |
| D: commit refuses a stale Kernel identity | **FAIL** | PASS |
| D': commit refuses the inherited Docker id | **FAIL** | PASS |
| Docker: the clone cannot reach A's container | **FAIL** (`the clone continued the migration with the original's Docker identity`) | PASS |
| e2e: the clone's installation id differs from A's | **FAIL** (binary built from `7581ee6`) | PASS |

The C2 row records a hole in the first version of this round's own tests: with
the inherited-id guard disabled, only one test failed, and with the binding
attestation disabled **none** did - the existing scenario C removed the binding
file, so the attestation branch was never reached. C2 was added to reach it, and
it fails when the check is removed. Two guards, two tests; neither is assumed
because the other passes.

### Verified where

| Run | Environment | Result |
|---|---|---|
| `migration_identity.rs` | real Docker daemon | 10 passed |
| `migration_durability.rs` | filesystem | 4 passed |
| `state_dir_clone.rs` | filesystem + Docker | 10 passed |
| `container_ownership.rs` | real Docker daemon | 3 passed |
| `p001c124_migration_identity.sh` | real Kernel + PostgreSQL | 7 checks PASS |
| `p001c123_reinit_recovery.sh` (C1.2.3 regression) | real Kernel + PostgreSQL | 6 checks PASS |
| `p001c121_demo_safety.sh` | shell | all PASS |
| `p001c121_data_foundation_scope.sh` | shell + Docker | all PASS |
| `p001c_rollback_activates.sh` (C1.1 regression) | shell | PASS |

### Residual risk

| Risk | Status |
|---|---|
| Power loss is not tested; the fsync ordering is a design property | **open**, stated in ADR-023 §2.5. No process-kill test is offered as evidence for it |
| A filesystem without directory `fsync` | `sync_dir_of` errors rather than proceeding; the assurance is absent there and the node refuses |
| A clone made **before** C1.2.1 is undetectable | **open**, unchanged (ADR-023 §2.3) |
| Non-Unix platforms cannot check device/inode | **open**, unchanged |
| A clone enrolled without `OPSWEAVE_NODE_NAME` fails on the UNIQUE name | **open**, unchanged (ADR-023 §2.2a) |
---

## 4i. C1.3 — one lifecycle run that can fail

### The defect this phase was about

`tests/acceptance/e2e_platform.sh` ran deploy, activate, rollback and the
multi-language deploy under `|| true`:

```bash
"$OPSCTL" --url "$KERNEL_URL" deploy dev.opsweave.hello 0.0.1 ... || true
"$OPSCTL" --url "$KERNEL_URL" activate dev.opsweave.hello 0.0.1 >/dev/null 2>&1 || true
```

Six such lines. Two consequences, both measured in this phase:

1. **A failed deploy is reported as a failed gateway.** The script's only
   verdict was `[ "$FAIL" = "0" ]` on assertions downstream of the deploy, so a
   deploy that never happened surfaced as "the gateway does not serve v1" (503)
   - a message that names the wrong component.
2. **`2>&1 >/dev/null` discarded the reason.** The redirection order is wrong:
   stderr went to the *terminal's* stdout and stdout to `/dev/null`, so even the
   `|| true` had nothing left to print.

It was not theoretical. When this phase's driver first ran the script on a fresh
isolated platform, Go and Java were never staged, so both deploys returned
`404 package not found`. Under the old script that produced two green lines
followed by a confusing gateway failure; the new script named the step:

```
FAIL  dev.opsweave.hello-go deploys (exit 1)
      Error: API 404 Not Found returned NOT_FOUND: package dev.opsweave.hello-go@0.0.1 not found
```

### The three categories, made explicit

Every command is now one of these, and the kind is visible in the code:

| Kind | Used for | Failure behaviour |
|---|---|---|
| `must` | deploy, activate, rollback, disable, enable, uninstall, install | fails **at that step**, with the captured stderr, and the run continues so every step reports |
| `expect_fail <status> <code>` | a step that must be refused (tampered manifest, forged cursor, rollback to an undeployed version) | asserts the **exact status** and a **stable error code**; a success is itself a failure |
| `cleanup` | teardown only | reported, never changes the verdict, cannot mask the original error |

`expect_fail` deliberately does not accept "non-zero". A typo in the plugin id, a
drained token and a real validation refusal all exit non-zero; only one of them
is the behaviour under test.

### What the run now proves

50 assertions, one isolated platform, in this order (each one read back from the
Kernel or the Gateway, never inferred from a command's exit code):

| # | Step | Asserted by |
|---|---|---|
| 1 | admin signs in, kernel live/ready, ≥2 READY nodes | status endpoints |
| 2 | v1 and v2 bundles staged from a real signature | `opsctl install` + `must` |
| 3 | a tampered manifest is refused | HTTP 400 `SIGNATURE_OR_BUNDLE_INVALID` |
| 4 | v1 deploys to 2 replicas, both READY, on 2 different nodes | plugin detail `instances[]` |
| 5 | **before activation the Gateway does not serve v1** | HTTP 503 |
| 6 | v1 activates; the Gateway serves v1 from a real instance | response `version` + `instanceId` |
| 7 | the Kernel reports v1 active | `activeVersion` |
| 8 | **v2 deploys and is READY but is not activated** | plugin detail |
| 9 | **all 10 requests still route to v1** | 10 Gateway calls, not one sample |
| 10 | v2 activates; all 10 route to v2 | 10 Gateway calls |
| 11 | rollback to v1; all 10 route to v1; control plane agrees | 10 calls + `activeVersion` |
| 12 | disable → 503 `CAPABILITY_UNAVAILABLE`; instances **not** destroyed | status + 503 code + plugin detail |
| 13 | enable → deployment READY again, activates, 10/10 succeed | deploy + activate + 10 calls |
| 14 | uninstall → route stops, Kernel records `UNINSTALLED`, no instance still READY/STARTING | status + 60 s bounded poll |
| 15 | live logs: status event, log event, forged cursor refused 400 `INVALID_REQUEST` | SSE stream + status |
| 16 | viewer: denied logs (403) and diagnostics (403) | status codes |
| 17 | Go and Java: staged, deployed, activated, serve a Runtime v1 identity | Gateway response `runtime.language` |
| 18 | container ownership: only this run's containers remain | `docker ps` filtered by installation id |

Item 9 is the assertion C1 never made. Item 12's second half is the one a
`503`-only check would miss: a disable that destroyed the deployment would also
return 503.

### Proven able to fail

`tests/ci/p001c13_negatives.sh` injects six conditions and asserts the product
refuses each. Run against the isolated platform, **10/10 assertions pass**, and
the six are real conditions rather than edited assertions:

| Injection | What was built | Detected by |
|---|---|---|
| 1 | a bundle re-zipped with a different `imageRef`, not re-signed | `install` → `SIGNATURE_OR_BUNDLE_INVALID`; **control**: the genuine bundle is accepted |
| 2 | a real pushed image that answers liveness and exits | deploy stays `DEGRADED 0/1 (1 failed)` and times out; activation is refused |
| 3 | a real pushed image that answers liveness and never readiness | deployment stays `PREPARING` for 60 s; Gateway 503 |
| 4 | only v1 activated | an assertion that the route is v2 would be false |
| 5 | rollback to a version never deployed | `NOT_FOUND` |
| 6 | another installation's container under our name | a sweep scoped to our id does not list it |

Two defects in this suite were found by running it, and both were the exact
class it exists to catch:

- **Injection 2 passed for the wrong reason.** The manifest was written before
  `$CRASH_IMAGE` existed, so the bundle was never created, the deploy failed with
  `plugin not found`, and the assertion "a crash-looping deployment does not
  report success" went green. The manifest is now written *after* the image is
  pushed, from its real digest.
- **Injection 3's READY check grepped the response for the word `READY`** and
  matched an instance/node state rather than the deployment's, declaring it ready
  while the next line printed `PREPARING`. It now parses the `status` field.

A third, in the driver: the foreign-container check read its list through
`docker ps | while …`, a pipeline subshell, so `FOREIGN_SAFE=0` was set in a
process that had already exited and **the check could never fail**. The list is
now materialised first. Proved with a stub daemon: the old form prints "every
foreign container survived" for a container that was removed, the new form
detects it.

### Isolation

- Its own database (`p001c_<runid>`), dropped with `--force` — see the teardown
  defect below.
- Its own HOME, ports derived from the run id, its own node state directories and
  installation identity, its own registry on a dedicated port.
- **It refuses a daemon that already holds OpsWeave containers** unless
  `OPSWEAVE_CI_ALLOW_SHARED_DAEMON=1`. This is not politeness: the driver removes
  containers, and on a shared daemon it cannot prove which are its own.
- The teardown removes containers **by this run's installation id**, drops this
  run's database, and reports — never removes — what it cannot attribute.

### A teardown defect this phase found

`tests/ci/p001c_teardown.sh` ran `dropdb --if-exists` without `--force`, so
every purge failed with *"database is being accessed by other users"*: killing
the node processes does not close their sqlx pools at once. The error was
reported as `BLOCKED` and the run's database leaked. Fixed with `--force`, which
`demo_up.sh` already used for the same reason.

### CI

`.github/workflows/plugin-lifecycle.yml` runs the lifecycle and then the
negatives on every pull request that can change them, with PostgreSQL 17 as a
service, a dedicated registry port, and real Docker. It fails closed: a missing
daemon is a red step before anything runs, and the driver `BLOCKED`s rather than
degrading. Evidence (`lifecycle.json` plus one command/exit/stdout/stderr file
per step) is uploaded as an artifact.

**It is not a required check**, and this document does not propose making it one
yet: the rule this repository already follows is that a check becomes required
only after it is stable on `main`. These runs are the evidence for that decision.

### What is still not verified

| Claim | Status |
|---|---|
| Frontend assets in a browser (D4: still served after uninstall) | **NOT_RUN / open** — C4 |
| Capability provides/requires at runtime, grant/revoke | **NOT_RUN** — C2 |
| Incompatible upgrade refused | **NOT_RUN** — C2 case 10 |
| OCI **image** signature | **NOT_RUN and cannot be** — not implemented; the bundle signature is not an image signature (P-09) |
| Go and Java full lifecycles | **NOT_RUN** — C3. This run proves each serves Runtime v1 through the Gateway; it does not run their upgrade/rollback/disable/uninstall |
| Three-host, rootless, mTLS | **NOT_RUN** — P001-E |

### Review revision (C1.3, PR #96)

Four defects were found reviewing this phase's own work. All four were
reproduced before being fixed.

**1. The workflow never ran.** Pushing the branch produced run `43394795219`:
`conclusion=failure`, **`jobCount=0`**. Not a config error and not Docker or
Postgres - the workflow had only `workflow_dispatch` and `pull_request`, so a
push matched no workflow, and GitHub recorded that as a failed run that looked
exactly like a red acceptance in the checks list. A `push: main` trigger was
added, unfiltered on purpose: on `main` it is the record that the lifecycle
passed on the merged commit, and filtering it would let a merge that changed a
shared crate be recorded as having no acceptance at all. The PR path filter was
also missing `scripts/assemble_plugin.py` and `scripts/demo_up.sh`.

**2. The Docker isolation check could not fail.** Its "before" set was built by
filtering for this run's installation ids - empty by construction, because the
run had just started - and its "foreign" set was recomputed from whatever was on
the daemon at the END, so a container the run had deleted was simply absent from
the list to be checked. It printed "every foreign container survived" over an
empty set.

It now snapshots **every** container before the run with its immutable id,
ownership label and state, and afterwards looks up each recorded id: removed,
stopped or renamed is a FAIL naming the id. A failed snapshot is BLOCKED, never
empty. Zero pre-existing containers is reported as **INSUFFICIENT** - a
dedicated CI daemon is always in that state, and saying "isolation verified"
about it is the vacuous green this phase removes.

That change immediately paid for itself: the next run reported
`REMOVED 64a4c9ee opsweave-…` - a container from a **previous run id**. The
comparison was right, and the cause was real: `p001c_up.sh` only cleans up a
previous run with the *same* run id, so every different run leaves containers
behind and the next run's teardown removes them.

**3. The six negatives accepted the wrong outcomes.** `expect_refusal` treated
any non-zero exit as "the product refused", conflating four different things:
the product refusing (the only PASS), the platform being unreachable, the test
command being malformed, and the assertion itself failing. It now classifies all
four, and an unreachable kernel, a drained token or a bad command is
**INCONCLUSIVE**, not a pass.

| Was | Now |
|---|---|
| any non-zero exit | the exact error code: `SIGNATURE_OR_BUNDLE_INVALID`, `DEPLOYMENT_NOT_READY`, `NOT_FOUND` |
| `READY\|DEGRADED\|FAILED\|CONFLICT\|not ready` | `DEPLOYMENT_NOT_READY` only |
| `not found\|NOT_FOUND\|404\|deploy` | `NOT_FOUND` only - kept distinct from the not-ready branch |
| HTTP 000 counted as "not routed to" | INCONCLUSIVE |
| a body that did not parse fell back to `{}` | explicit assertions on status, parse, version and the control plane |
| `docker ps --filter label` asserted the CLI agrees with itself | the compiled `DockerAdapter` test runs, and the planted container keeps its id, start time and running state |

**4. Cleanup ran after the verdict.** The script printed
`PASS … resources were removed` and `exit 0` **before** the trap ran, so a
teardown failure was printed underneath a line that already said PASS. That is
this phase's own defect, reproduced in the script meant to prevent it. Cleanup
now runs first and the verdict is computed from its real status.

Proved with a teardown shim that exits 3:

```
functional: PASS
cleanup:    FAIL (a resource this run created could not be removed)
FAIL  the lifecycle passed but this run's resources were NOT fully removed
DRIVER_EXIT=1
```

And SIGTERM mid-run: exit 130, no registry left, no database left.

**The registry is no longer `docker rm -f`'d before use.** A container with the
name is inspected first: this script's own (labelled) is reused, anyone else's
stops the run with an explanation. Cleanup removes only a registry this script
created.

### Two failures the first real Linux run produced

Once the workflow parsed, it started a job - and the job found two more defects.

**The `VERSION_ALREADY_ACTIVE` fix was applied to one call site.** It went into
the TypeScript deploy and the Go and Java deploys in the same script kept using
`must`, so `legacy-regression` reported `PASS=43 FAIL=2` twice. A condition that
applies to every deploy cannot be fixed per call site; it now lives in one helper,
`deploy_or_already_active`, and all four deploy sites use it.

**The job lacked the Java toolchain.** The first run that started a job BLOCKED at
"the plugin bundles could not be built":

```
maven-compiler-plugin: Fatal error compiling: error: release version 21 not supported
```

`scripts/build-plugins.sh` builds all three reference plugins, so the job needs Go
and Java even though the lifecycle it drives is the TypeScript one. The comment
that said "npm/go/maven are not needed for the TS path" was wrong for the same
reason and was corrected rather than deleted: the **lifecycles** are C3's, the
**toolchains** are needed here.

That BLOCKED is the design working. A missing prerequisite stopped the run with
its reason in the log; it did not degrade to a pass.

### A product finding the revision surfaced

The first push turned `data-foundation`'s `legacy-regression` job red with
`VERSION_ALREADY_ACTIVE` on all three plugins. That is **correct product
behaviour** - re-deploying the already-active version is refused
(`deployments.rs:290`) - and the script was wrong to call it a failure. A deploy
now distinguishes success from `VERSION_ALREADY_ACTIVE` from a real error, and
the "the gateway does not serve v1 before activation" assertion is **skipped and
says so** when the control plane reports v1 already active, instead of failing on
a legitimate state.

### Verified in this revision

| Where | Result |
|---|---|
| macOS, full lifecycle | **50/50 PASS**, `preserved 8 pre-existing container(s)`, cleanup PASS |
| macOS, teardown shim (exit 3) | **exit 1**, functional PASS + cleanup FAIL both reported |
| macOS, SIGTERM mid-run | **exit 130**, no registry, no database left |
| macOS, negatives | **11/11 PASS**, every refusal pinned to its real code |
| GitHub-hosted Linux | see the run link on PR #96 |

### Still open after the revision

| Item | Status |
|---|---|
| `runtime-golden-path` (`job completed before long-running proof`) | **flaky, pre-existing.** The same branch passed this job at 08:38 and failed at 09:08 with no code change between them, and this PR touches no pipeline or data-foundation code |
| Real plugin frontend in a browser (D4) | **NOT_RUN** — C4 |
| capability/grant negatives, incompatible upgrade | **NOT_RUN** — C2 |
| OCI **image** signature | **NOT_RUN and cannot be** — not implemented |
| Go/Java full lifecycles | **NOT_RUN** — C3 |
| three-host, rootless, mTLS | **NOT_RUN** — P001-E |

### Position

C1.3 → **PASS on its own scope**: the TypeScript lifecycle completes in one
isolated run (50/50), six injected failures are each detected, container
ownership is measured on the daemon, and the suite is wired to a PR-checked
workflow.

C1 overall stays **PARTIAL**: D4 (assets after uninstall) is untouched by this
phase, and the brief says not to introduce a retention policy here.

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

C1 → **PARTIAL** (D4 assets-after-uninstall open; the TypeScript lifecycle now
has a gate (§4i) but the three-language MATRIX, capability/grant negatives and
browser coverage are still owed to C2/C3/C4).
C1.1 → **PASS on its own scope**: isolation and rollback consistency.
C1.2 → **PASS on its own scope**: an installation cannot delete, stop or
overwrite a container another installation owns, verified against a real daemon
with a planted colliding container. The pre-upgrade migration is manual and is
stated above, not automated. C1.2.4 closes the last path by which a *reinitialized
clone* could end up holding the original's ownership token: a migration
interrupted before its first delete. Its durability argument is a design
property (§4h, ADR-023 §2.5), not a power-loss measurement.

The three phases together do not close the container-ownership question for
*containers created before C1.2*: those are unlabelled and will be reported
rather than swept forever, until an operator removes them.

