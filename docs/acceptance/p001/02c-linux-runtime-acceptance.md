# P001-B.2 — Code review, before the Linux acceptance runs

Status: **NOT_RUN as acceptance.** The Linux workflow exists and is committed; it
has never executed on a Linux host. This document reviews what the branch
contains, what it can and cannot prove, and the two behaviours the review asked
for.

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
