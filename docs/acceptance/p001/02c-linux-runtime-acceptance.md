# P001-B.2 — Code review, before the Linux acceptance runs

Status: **RUN and PASSING on a native Linux host** — workflow
`platform-linux-acceptance` run **42945036358**, every step green (§7). This
document reviews what the branch contains, what it proves, and — in §8 — what it
still does not.

It is **CI evidence on an Ubuntu 24.04 runner**, not a three-host or production
acceptance, and §8 keeps that distinction rather than blurring it.

Branch `test/p001-b2-linux-runtime-acceptance` @ `9e3e8e9`, based on `main` `6cd9bcd`.

---

## 1. What the branch contains

| Commit | Change |
|---|---|
| `4636d6b` | `platform-linux-acceptance.yml` — install → login → node READY → socket reachability → OCI create → identity stability → v1→v2→v1. Plus the `upgrade` fixes it needed. |
| `9e3e8e9` | mutable-tag pull rule, DEGRADED outcome, `tests/ci/p001_upgrade_behaviour.sh`, live DEGRADED step |

Two front-end files, no application code.

---

## 2. The two behaviours the review required

### 2.1 A mutable tag must never be satisfied by a local copy

**The defect.** The previous commit skipped `compose pull` whenever
`docker image inspect` succeeded. That is correct for a digest and wrong for a
tag: `:latest`, `:stable`, or a reused version can be repointed, so the upgrade
would restart the containers on the old image, pass every health check, and report
success while changing nothing.

**Now** (`scripts/platform_up.sh`, `cmd_switch_image`):

| Reference | Behaviour |
|---|---|
| `repo@sha256:…` | reused locally when present — a digest names exactly one image and cannot be stale |
| a tag, default | **always pulls**, and the result is verified to exist (`is not present after a successful pull`) |
| a tag + `OPSWEAVE_ALLOW_LOCAL_TAG=1` | uses the local copy, and prints that it is a local artifact, **not** a registry upgrade, and **not** digest-pinned |

The review's second half — "production upgrades should prefer an immutable
Digest" — is a deployment-documentation claim, not a code path: the installer
cannot choose the digest for the operator. It is stated in
`deployments/platform/README.md` §4 (upgrade/rollback) and enforced in the
acceptance runs by using digests where a registry is involved. **No registry push
exists yet**, so the digest path is exercised only locally; that is recorded as a
gap in §4.

### 2.2 An unhealthy node must yield DEGRADED, not complete

**The defect.** The kernel switched, the node stayed unhealthy, and the function
still ended with `ok "… complete"` and exit 0.

**Now** three distinct, machine-readable outcomes:

```
kernel switch failed        -> die,  exit 1
kernel ok, node unhealthy   -> DEGRADED, exit 3
both ok                     -> success, exit 0
```

Exit 3 rather than 0 or 1: a runbook checking `$?` sees "not 0", and one that must
tell a broken upgrade from a partial one can do so without parsing prose. A
DEGRADED run still asserts the kernel answers, so it is a qualified success rather
than a disguised failure.

---

## 3. What was verified, and how

### 3.1 `tests/ci/p001_upgrade_behaviour.sh` — 10 checks, executed

Source-shaped, because neither behaviour can be observed without a daemon and two
images; the live assertions exist in the workflow (§3.3). All 10 pass.

**Counterfactuals executed**, because a guard that cannot fail is not a guard:

| Mutation | Result |
|---|---|
| `OPSWEAVE_ALLOW_LOCAL_TAG` renamed away | `FAIL a local tag can be reused without an explicit opt-in` |
| `return 3` → `return 0` | `FAIL DEGRADED has no distinct exit code` |

Both restored afterwards and re-run green.

### 3.2 Regression, executed

```
cargo test -p opsweave-kernel            281 passed, 0 failed
tests/ci/p001_credential_argv.sh         PASS   (A1/A2 guard from #78)
tests/ci/p001_upgrade_behaviour.sh       PASS   (this commit)
```

### 3.3 Live assertions that exist but have not run

`platform-linux-acceptance.yml` contains, and has never executed:

| Step | Asserts |
|---|---|
| `Record the environment` | kernel, distro, docker, compose, cgroup driver, socket owner, runner groups |
| `Install the platform` | a clean-host install with no Rust/Node/Go/Maven |
| `Assert the installed platform` | `/livez`, `/readyz`, `/app`=404, console=200, ingest not-built, login, registry lists the console only |
| `Node reaches the docker socket as an unprivileged user` | socket uid:gid **inside** the container, node uid, node groups, and `docker version` as a non-root uid |
| `The node enrolled, reports health, and can create a container` | node `READY`, identity file present, a real `docker run` from the node, no leftover containers, identity hash unchanged across restart |
| `Upgrade and roll back between two real image versions` | two **different** images (v1 = 0.0.1, v2 built from a modified `Cargo.toml` = 0.0.2), v1→v2 reports 0.0.2, login still works, rollback reports 0.0.1, login still works |
| `An unhealthy node makes the upgrade DEGRADED, not complete` | node made unable to start → upgrade exits **3**, prints DEGRADED and "NOT a complete upgrade", kernel still serving |

The v1/v2 pair is built from two different source trees, not one image under two
tags — the workflow asserts `[ "$v1" != "$v2" ]` on image ids precisely because
"same image, two tags" is the failure mode the task names.

---

## 4. What this branch does NOT prove

| Claim | Status | Why |
|---|---|---|
| Linux install works | **NOT_RUN** | the workflow is committed, never executed |
| The node reaches the socket unprivileged | **NOT_RUN** | same |
| OCI container creation from the node | **NOT_RUN** | same |
| v1→v2→v1 | **NOT_RUN** | same |
| DEGRADED behaviour, live | **NOT_RUN** | same; only the source shape is verified |
| Digest-pinned upgrade from a registry | **NOT_RUN** | nothing has been pushed to a registry; no digest upgrade has been performed |
| Three-host / production acceptance | **NOT_RUN, and cannot be claimed** | an Ubuntu runner is CI evidence; the task says so explicitly and this document does not blur it |
| Migration-incompatible upgrade | **NOT_RUN** | v1→v2 changes no schema. A real migration boundary needs a version whose migrations conflict, which does not exist yet |
| Rollback after a migration | **NOT_RUN** | migrations are forward-only; `restore` is the only path and it was drilled in 02b, not here |

The last two matter: the task asks for "迁移不兼容" and "需要数据库恢复时明确拒绝伪回滚".
Neither is covered by v1↔v2 with no migration. The installer *states* the
limitation on every rollback ("migrations are forward-only: rolling back across one
requires `restore <file>`"), but a statement is not a test.

---

## 5. Known weaknesses in the workflow itself, before it runs

Written down because a gate nobody has run should not read as a gate that works.

1. ~~**`OPSWEAVE_DOCKER_HOST_OVERRIDE` is not a variable the installer reads.**~~
   **Fixed before this review was published.** The compose file now reads
   `OPSWEAVE_DOCKER_HOST: ${OPSWEAVE_DOCKER_HOST:-unix:///var/run/docker.sock}`, so
   the DEGRADED step can point the node at a path that does not exist. Both paths
   were verified with `docker compose config`: unset resolves to the standard
   socket, set resolves to the override.
2. ~~**`sed -n ... /dev/null` in the upgrade step** is leftover scaffolding.~~
   **Fixed** — deleted.
3. **The v2 build edits `Cargo.toml` in place.** If the build is interrupted the
   worktree keeps `version = "0.0.2"`. The `|| { mv Cargo.toml.bak Cargo.toml; }`
   handles a build failure but not a runner kill.
4. **`platform-linux-acceptance` triggers on `pull_request` with a `paths` filter**
   that includes `scripts/platform_up.sh` — good — but it will also run on `main`
   pushes only if a `push:` trigger is added, which it currently has not. As
   written it can never be a required check for `main`.

These are listed as work for the authorised continuation, not as things this
review quietly accepted.

---

## 6. Position

The branch contains a Linux acceptance workflow that covers the three defect
classes a macOS host cannot reach, and two installer behaviours that were
genuinely wrong (a tag that could silently not upgrade, and a node failure
reported as complete success). Both behaviours are asserted at the source, with
counterfactuals, and the live assertions are written.

**None of the Linux acceptance has run.** Phase 2 stays `PARTIAL` until it does.
The two §5 items that would have failed on first execution were fixed before this
review was published rather than left for the run to discover; the two that
remain (an interrupted v2 build leaving `Cargo.toml` edited, and the missing
`push:` trigger) are real and are listed as work, not as accepted.


---

## 7. The run: 42945036358 (2026-11-11, all steps green)

### 7.1 Environment, measured by the run itself

| Item | Value |
|---|---|
| Kernel / arch | `Linux 7.0.0-1017-azure x86_64` |
| Runner | `ubuntu-24.04` (GitHub-hosted) |
| Docker | reported by the step; socket owner `root:docker` gid **118** |
| Install duration | **28 s** |

### 7.2 Results, step by step

| Step | Result |
|---|---|
| Record the environment | success |
| Build the platform-only image | success |
| Node state directory writable by container uid | success |
| **Install the platform** | success — 28 s, no host Rust/Node/Go/Maven |
| The install left no node restart loop | success |
| Assert the installed platform | success — `/livez` 200, `/readyz` 200, `/app` **404**, console 200, ingest `BUSINESS_ROUTE_NOT_BUILT`, login OK, registry lists only `opsweave.console` |
| **Node reaches the docker socket as an unprivileged user** | success |
| **The node enrolled, reports health, and can create a container** | success |
| **Upgrade and roll back between two real image versions** | success |
| **An unhealthy node makes the upgrade DEGRADED** | success |

### 7.3 The socket result, in numbers

| Measurement | Value |
|---|---|
| Detected gid (host socket) | **118** |
| Node runtime uid | **10001** |
| Node runtime groups | `10001 118` |
| Socket inside the container | `0:118 660` |
| Assertion | `the node reaches the daemon as uid 10001 (not root)` |

This is the class of defect the macOS phase could not reach: on Docker Desktop
the socket appears inside containers as `root:root`, so `--group-add` cannot help
and the node had to be declared DEGRADED. On Linux the group mapping works and the
node runs unprivileged.

### 7.4 Two genuinely different images

| | Image ID |
|---|---|
| v1 | `sha256:eb1f71fdb9fa0a9c8618e48fad87f84adebc964f5f73b8ca261f05b29d00902a` |
| v2 | `sha256:58fc45981a5490ba2e5c289f0a6cdd758bd421906b6ec201a6c2cc648791cf66` |

Built from the same tree with `--build-arg OPSWEAVE_VERSION_OVERRIDE=0.0.2`, which
rewrites the workspace version in `Cargo.toml` and all seven `Cargo.lock` entries
**inside the build stage**, where cargo exists. Verified locally that this is a
real change and not a relabel:

```
image                         "0.0.1" literals  "0.0.2" literals  binary sha256
opsweave-platform:ci                  6                 1          c16deb6522d3…
opsweave-platform:v2test              4                 3          ac423625ba71…
```

The counts invert and the binaries differ; a tag rename cannot produce that. The
workflow additionally asserts `[ "$v1" != "$v2" ]` on image ids.

### 7.5 Upgrade, rollback, identity, DEGRADED

| Assertion | Result |
|---|---|
| before upgrade the kernel reports `0.0.1` | pass |
| after upgrade it reports `0.0.2` | pass |
| the upgraded image is still platform-only (`/app` = 404) | pass |
| the pre-upgrade account still authenticates after the upgrade | pass |
| after rollback it reports `0.0.1` | pass |
| the account still authenticates after the rollback | pass |
| node identity hash unchanged across a restart | pass |
| a node that cannot become healthy yields **exit 3 + `DEGRADED`** | pass |
| the kernel still serves after a DEGRADED upgrade | pass |

---

## 8. What this run still does NOT prove

| Claim | Status | Why |
|---|---|---|
| Three-host distributed deployment | **NOT_RUN, and cannot be claimed** | one GitHub runner is not a distributed deployment; the task says so and this document agrees |
| Rootless Docker | **NOT_RUN** | the runner's daemon is rootful; the socket is `root:docker` |
| mTLS kernel↔node | **NOT_RUN** | not implemented in this phase |
| Node certificate rotation / revocation | **NOT_RUN** | same |
| Image signature / SBOM / vulnerability gate | **NOT_RUN** | nothing is signed and nothing is pushed to a registry |
| Digest-pinned upgrade from a registry | **NOT_RUN** | both images are local builds; the digest path is exercised only in the unit-level guard |
| Migration-incompatible upgrade | **NOT_RUN** | v1→v2 changes no schema |
| Rollback across a migration | **NOT_RUN** | migrations are forward-only; `restore` is the only path, drilled in 02b |
| Plugin install from the registry (OCI pull) | **NOT_RUN** | the node creates a container from a locally present image; it does not pull a signed plugin bundle |
| Quarantine / fencing under partition | **NOT_RUN** | belongs to the distributed phase |

### 8.1 Defects this run found — all real, all fixed

| # | Defect | How it surfaced |
|---|---|---|
| 1 | Node state directory not owned by uid 10001 | install succeeded, node died with `Permission denied (os error 13)` |
| 2 | A consumed enrolment token made the node permanently unrecoverable | restart loop of `Enrollment token has already been used`, 10+ attempts |
| 3 | `upgrade` did not recreate the node on an `env_file` change | the retry loop survived a correct re-run |
| 4 | `--locked` build fails when only `Cargo.toml` is bumped | v2 build died in 1.6 s |
| 5 | `cargo update --offline` needs a registry index | second v2 attempt, exit 101 inside the build |
| 6 | The "break the node" mechanisms were undone by the recreate under test | DEGRADED assertion saw a healthy node and `got 0` |
| 7 | `upload-artifact` fails when a green run produces no files | every assertion passed, job red |
| 8 | `upload-artifact` cannot read `node-identity.json` (uid 10001) | job red after a fully passing run |

Defects 1–3 are product defects a macOS host could not reach. 4–8 are defects in
the acceptance harness itself, found by running it.

---

## 9. Position

Phase 2's Linux-runtime condition is now met **with CI evidence**: a clean-host
install, a node that enrols unbprivileged and creates a container, a real two-
version upgrade and rollback, and a DEGRADED outcome when the node cannot run.

It is **not** a production or distributed acceptance, and §8 says so item by item.
Phase 2 therefore moves from `PARTIAL` to **`PARTIAL (Linux runtime verified;
distributed conditions outstanding)`** — the remaining gaps are the ones that need
infrastructure this project does not have.
