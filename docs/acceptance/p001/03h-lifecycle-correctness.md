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

### Counterfactuals

| Assertion | Broken implementation | Fixed |
|---|---|---|
| a full clone cannot claim the original (`state_dir_clone.rs`) | **FAIL** — `a full clone resolved silently` | PASS |
| a restore needs an explicit accept | **FAIL** | PASS |
| 8 concurrent mints agree on one identity | **FAIL** against the fixed-`.tmp` code (`ENOENT`) | PASS |
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
C1.2 → **PASS on its own scope**: an installation cannot delete, stop or
overwrite a container another installation owns, verified against a real daemon
with a planted colliding container. The pre-upgrade migration is manual and is
stated above, not automated.

The three phases together do not close the container-ownership question for
*containers created before C1.2*: those are unlabelled and will be reported
rather than swept forever, until an operator removes them.

