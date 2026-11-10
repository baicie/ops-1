# P001-B.1 — Real Container Acceptance

Status: **PARTIAL**. The platform image builds, installs, serves, restarts, backs up
and restores on a real Docker daemon, and every one of those was executed. It is not
`ACCEPTED`: three required conditions could not be met in this environment, and they
are named in §7 rather than worked around.

Audit date: 2026-11-10. Base SHA `bc23d60`, tested HEAD `423a19d` on branch
`fix/p001-b1-container-acceptance`.

---

## 0. Environment (measured, not assumed)

| Item | Value |
|---|---|
| Docker Engine | **29.7.2** (API 1.55) |
| Docker Compose | **5.5.0** |
| Host | Darwin 24.6.0 **arm64** (macOS, Docker Desktop) |
| PostgreSQL | `postgres:17` (container) |
| Registry | `registry:2` (container) |
| Image under test | `opsweave-platform:p001-b1-final` |
| Image ID | `sha256:1db33230ffbce6a84485e373691cb4579813ff093ba9e25dd55a0ec714f44dbc` |

The daemon was **not running** when this phase began. It was started, and every
result below comes from that live daemon — none is inferred from a Dockerfile.

**macOS is a limitation, and it is load-bearing.** Two of this phase's findings
(§3.5, §3.6) are Docker Desktop behaviours that a Linux host does not have. They
are reported as host limitations, not as product defects, and the checks that
stayed unproven because of them are listed in §7.

---

## 1. Baseline (measured before any change)

`origin/main` was `5ab4a9c` (the task named `bc23d60`; `bc23d60` is an ancestor,
and the intervening commits are #75/#76/#77 — none touches `deployments/platform`
or `scripts/platform_up.sh`).

| Workflow on `5ab4a9c` | Result |
|---|---|
| `ci` | **success** |
| `reliability` | **success** |
| `staging-preview` | **success** (fixed in #76) |
| `g12-acceptance` | success on the previous SHA |

Baseline platform image build (before any change in this phase):

```
docker build -f deployments/staging/Dockerfile --target platform -t opsweave-platform:p001-b1-baseline .
exit=0  elapsed=362s
```

Contents were already correct: `opsweave-kernel`, `opsweave-node`, `opsctl`,
`docker`, `/app/web`; **no** pipeline worker, **no** `/app/ops-web`, **no**
`OPSWEAVE_OPS_WEB_DIST`. The kernel binary in the image carried
`BUSINESS_ROUTE_NOT_BUILT` and did **not** carry `opsweave.ops/incidents`
(contrast: the full-product kernel carries the latter and not the former).

So the boundary was right and the **build dependency was wrong** — which is the
defect §2 addresses.

---

## 2. The platform target depended on the business build (fixed)

`webbuild` compiled ops-web; `rustbuild` built the full kernel plus the pipeline
worker before producing the platform-only kernel. A broken business frontend or
business binary therefore failed an image that contains neither.

Stages are now split along the real dependency line:

| Stage | Produces | Reaches the platform target? |
|---|---|---|
| `webbuild-console` | console bundle | **yes** |
| `webbuild` | console + ops bundle | no |
| `rustbuild-platform` | platform kernel, node, opsctl | **yes** |
| `rustbuild` | full kernel + pipeline worker | no |

**Verification is the sabotage, not the build.** With
`apps/ops-web/src/main.tsx` and `apps/pipeline-worker/src/main.rs` both
deliberately broken:

```
--target platform   exit 0   elapsed 231s
--target runtime    exit 1   failed at: pnpm --filter @opsweave/ops-web build
```

Both halves are required evidence: the first shows the dependency is gone, the
second shows the sabotage was real. Without the second, "it still built" could
mean the breakage did nothing.

Build-log stage confirmation for `--target platform`: the only stages executed are
`dockercli`, `webbuild-console`, `rustbuild-platform`, `platform`. `webbuild` and
`rustbuild` never run.

---

## 3. Real install, end to end

Isolated target: host directory `/tmp/p001b1/accept`, compose project
`opsweave-p001b1`, ports 19080 / 55440 / 15010. **No staging database, volume or
project was touched.**

```
./scripts/platform_up.sh install
exit=0  elapsed=323s
```

### 3.1 What the install asserted and observed

```
== checking the plugin gateway
warn no bindable docker bridge gateway on this host (reported: 172.17.0.1)
== pulling images
== starting PostgreSQL and the registry
== resolving the database address
 ok the kernel will reach PostgreSQL at host.docker.internal:55440
== starting the Kernel
== verifying the platform-only boundary
    livez=200 readyz=200 app=404 console=200
 ok the Ops application is absent from the served build
== bootstrap administrator
 ok signed in as accept@example.invalid
== checking docker socket access for the node
warn the docker socket is NOT reachable from the node container as an unprivileged user
== enrolling the node
warn the node did not become healthy; the platform is usable but has no node
```

### 3.2 Post-install acceptance checks (all executed)

| Check | Expected | Measured |
|---|---|---|
| `GET /livez` | 200 | **200** |
| `GET /readyz` | 200 | **200** |
| `GET /app` | 404 | **404** |
| `GET /admin/overview` | 200 | **200** |
| `POST /api/v1/telemetry/events` | 404 `BUSINESS_ROUTE_NOT_BUILT` | **404, code correct** |
| `POST /api/v1/auth/login` | 200 + session + CSRF | **200** |
| `GET /api/v1/auth/me` | platform access + console grant | `allowedSurfaces: [workspace, admin]`, console granted |
| `GET /api/v1/applications` | `opsweave.console` only | **exactly that, `denied: []`** |
| `GET /api/v1/plugins` | no business plugin | **1 system plugin** (`dev.opsweave.ops-center`, `isSystem: true`) |
| `GET /api/v1/nodes` | empty | **`[]`** |
| `GET /api/v1/diagnostics` | `availableWithoutPlugins: true` | **true**, `installedPlugins: 0` |
| `GET /api/v1/incidents` | not activated | **404** |
| `GET /api/v1/business-workspaces` | not activated | **404** |
| `GET /api/v1/telemetry/sources` | not activated | **404** |
| Toolchain needed on host | none | none — only Docker + Compose |

### 3.3 No fixed demo credential

The installer refuses to run without `OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD`, rejects
it under 12 characters, and rejects the well-known demo value. Verified in the
previous phase and unchanged here; this run used a per-run password that appears
in **no** install log (`grep` over every captured log: 0 matches) and only in
`kernel.env` (mode `0600`).

### 3.4 Artifact permissions

```
-rw-------  gateway.env  kernel.env  node.env  postgres.env
```

`node.env` holds no credential (boundary check enforced); a fixed-path
`/tmp/opsweave-platform-login.json` no longer exists — the login body now goes to
a per-call `mktemp -d` that is removed on every path.

### 3.5 The published port is unreachable from the macOS host (host limitation)

`docker exec` into the Kernel answers correctly (`livez=200 app=404`), but
`curl http://127.0.0.1:19080/...` from macOS answers **502**. Docker Desktop does
not publish a host-networked container's ports to the macOS host.

The installer detects this (`reachable_from_host`), switches its own probes to run
**inside** the Kernel container, and says so. Two consequences, both recorded
rather than hidden:

* the boundary assertions still ran — from the only place that can answer them;
* `install` exits 0 because the platform is genuinely installed and serving; the
  operator is told this host cannot observe it from outside.

On a Linux host (the deployment target) this does not occur.

### 3.6 The node cannot reach the docker socket (host limitation)

The node restarts with:

```
docker engine is unavailable: permission denied while trying to connect to the
docker API at unix:///var/run/docker.sock
```

Root cause, established by testing rather than assuming: inside a container on
Docker Desktop the socket is presented as **`root:root` 0660**, whatever its host
ownership. `--group-add $(stat -f %g ...)` cannot fix a file owned by `0:0`, and
`--user root` does work (verified: `docker version` → 29.7.2) but is a security
regression this phase will not enable by default.

The installer therefore probes socket access, reports it, and finishes the install
with `node: unhealthy` — because identity, console, registry and diagnostics do
not need a node. It offers `OPSWEAVE_NODE_RUN_AS_ROOT=1` as an explicit,
documented trade rather than a silent fallback.

---

## 4. Backup and restore (destructive drill, real data)

### 4.1 What was fixed first

The previous implementation could produce a normally-named, incomplete backup and
restore in the wrong order. Both were rewritten; the fixes and their reasons are in
the commit `fix(installer): …` and summarised here:

| Defect | Now |
|---|---|
| kernel-volume copy failure did `\|\| mkdir -p` and continued | **fatal**; no file written |
| kernel container not running → `warn`, backup continues | **`ensure_running` refuses before the first byte** |
| `tar` written directly to the destination | written beside it, **renamed only when complete**, then read back |
| no checksum | dump checksummed; manifest records it; restore verifies |
| no consistency statement | manifest records `pg_dump-then-volume-copy; not-a-single-point-in-time` and `registry_included=no` |
| restore started the Kernel **before** restoring its volume | **quiesce → validate → restore → validate → start** |
| volume copy failure only `warn`ed | **fatal**, and file count is checked against the manifest |
| archive extracted without inspection | unsafe paths and links rejected; checksums verified **before** anything is stopped |

### 4.2 The drill

```
1. create evidence     POST /api/v1/users -> 200, adds restore-proof@example.invalid
2. backup              ./scripts/platform_up.sh backup …/backup-with-user.tar.gz
                       exit=0, 26 240 bytes dump, 0 package files
3. DESTROY             docker compose -p opsweave-p001b1 down -v
                       volumes removed: pgdata, registry (kernel volume gone too)
4. restore             OPSWEAVE_RESTORE_FORCE=1 ./scripts/platform_up.sh restore …
                       exit=0, elapsed 98s
5. verify              login 200; GET /api/v1/users contains restore-proof@example.invalid
```

**The evidence survives a full volume wipe.** Step 5 is the whole point: the user
created in step 1 exists after the platform's volumes were deleted and rebuilt
from the archive.

Manifest of the restored backup:

```
format=1
created_at=20261110T131908Z
image=opsweave-platform:p001-b1-final
database_bytes=26240
kernel_files=0
database_sha256=813deeeecee3d26580d664aa190f805e4baccd02f6a6f41d90eff6e344eb806a
consistency=pg_dump-then-volume-copy; not-a-single-point-in-time
registry_included=no; re-push plugin images from their bundles after restore
```

`kernel_files=0` is correct here: no plugin package had been installed, so the
store was empty. The count check still ran and still matched.

### 4.3 Failure paths (executed, not reasoned about)

| Scenario | Result |
|---|---|
| backup with postgres stopped | `error postgres is not running; refusing to write an incomplete backup`; **no file created** |
| restore without `OPSWEAVE_RESTORE_FORCE=1` | `refused …` |
| restore of an archive with one byte flipped | `error database dump checksum mismatch (manifest 813dee…, file e803cb…)` |

### 4.4 Restart and persistence

```
stop    exit=0   running containers after stop: 0
start   exit=0   kernel: 200 /livez, 200 /readyz
```

After the restart: login `200`, and `restore-proof@example.invalid` still present.
Users, sessions, grants and the registry ledger live in PostgreSQL, which is a
named volume; nothing is regenerated. Node identity was not exercised — the node
never enrolled here (§3.6).

---

## 5. CI gate: `platform-image-build`

Added to `.github/workflows/ci.yml`, four steps:

1. `docker build --target platform`;
2. contents: the four binaries and the console bundle present;
   `opsweave-pipeline-worker`, `/app/ops-web`, `OPSWEAVE_OPS_WEB_DIST` **absent**;
   the **kernel binary** checked with `strings` for the platform-only marker;
3. it boots against real PostgreSQL: `/livez`, `/readyz`, `/app` 404, ingest
   `BUSINESS_ROUTE_NOT_BUILT`, `/admin/overview` 200;
4. sabotage: with the business application deliberately broken, the platform
   target must still build.

**All four steps were executed locally before pushing**, because this phase's
whole point is that a gate nobody ran is not a gate:

```
step 1  build                     exit 0
step 2  boundary                  STEP2 PASS
step 3  boot                      livez=200 app=404 console=200 ingest=NOT_BUILT — STEP3 PASS
step 4  sabotage counterfactual   exit 0
```

Step 3 uses a published port on a user network rather than host networking: on
Docker Desktop host networking is unreachable from the host, and this job is about
the image booting, not about the deployment's topology.

---

## 6. What changed, file by file

| File | Change |
|---|---|
| `deployments/staging/Dockerfile` | stage split (console/ops web, platform/full Rust); `runtime` contents unchanged |
| `deployments/platform/compose.yaml` | loopback-only publishing; `OPSWEAVE_ENVIRONMENT` no longer defaults to `PRODUCTION`; node user is configurable |
| `deployments/platform/compose.bridge-gateway.yaml` | **new**: the conditional bridge binding |
| `scripts/platform_up.sh` | gateway probe, DB-address resolution, docker-gid wiring, socket probe, node degradation, backup/restore rewrite, stdin passwords, `ensure_api_context` |
| `.github/workflows/ci.yml` | `platform-image-build` |

---

## 7. Not proven here, and why — this is why the phase is PARTIAL

| Condition (task §9) | Status | Reason |
|---|---|---|
| **Node enrollment / node health** | **NOT_RUN** | the node cannot reach the docker socket on this host (§3.6). Enrollment token minting **did** run (a token was issued and consumed into `node.env`), but the node never joined, so "node identity persists across restart" is unproven. |
| **Upgrade / rollback (task §4)** | **NOT_RUN** | needs two compatible image versions and a migration boundary; this phase produced one image. `upgrade`/`rollback` code paths exist and were not exercised. |
| **Install on a clean Linux host** | **NOT_RUN** | no Linux host available. The Docker Desktop findings above mean a macOS run is *not* a substitute. |
| **Published image with a registry digest** | **NOT_RUN** | nothing was pushed; the digest in §0 is a local image ID, not a registry reference. |
| **Plugin install (registry non-empty)** | **NOT_RUN** | out of scope (P001-C). The empty-registry state is verified; the populated state is not. |
| **Host networking verified from the host** | **NOT_RUN** | impossible on Docker Desktop (§3.5) |

Three of these are environment limits. **One is not**: upgrade/rollback is a real
gap in this phase's coverage, and the completion criteria in the task name it
explicitly.

---

## 8. Defects found and fixed (summary)

Five real defects, each found by running the thing rather than reading it:

1. the platform target depended on the business build (§2);
2. the bridge gateway was bound unconditionally — install died before starting (§3.1);
3. the Kernel's DSN assumed the same gateway — healthy database looked dead;
4. `DOCKER_GID` was computed and never passed — node could never talk to docker;
5. backup could silently produce an incomplete archive; restore started the Kernel
   before restoring its volume (§4.1).

Plus two exposures: the admin password travelled in `argv`, and the login body was
written to a fixed `/tmp` path.

---

## 9. Honest position

The platform-only image is now **real, buildable, installable, restartable and
restorable**, and each of those statements is backed by a command and its output in
this file. The parts that are not proven are the parts a single macOS workstation
cannot prove — and one, upgrade/rollback, that this phase simply did not cover.

`ACCEPTED` requires all nine conditions in the task's §9. Six hold. Three do not.
**Phase 2 therefore remains `PARTIAL`**, with the gap list above as the work.

---

## 10. Review follow-up (PR #78, before merge)

The review found two credential-handling defects that this phase's own checks
missed. Both are fixed, and the fix is now guarded by a test that fails without it.

### 10.1 The admin password travelled in `python3` argv

`login_probe` and `issue_node_token` built the login body with

```
python3 -c '...' "$email" "$password"
```

so the administrator password was readable by any process of the same user for
the lifetime of that `python3` — on a script that runs as root on a deployment
host. The enrolment token took the same path back out (`sys.argv[1]`).

Now: values enter `python3` on **STDIN**, NUL-separated, and leave it the same
way. JSON is produced by `json.dumps`, so quotes, backslashes, newlines and
non-ASCII round-trip rather than being forbidden — **no character of the password
is restricted**.

### 10.2 Container-mode scratch files were fixed paths

`/tmp/login.json`, `/tmp/login-resp.json`, `/tmp/jar` and `/tmp/lp.json` were
predictable in a shared `/tmp`, shared between concurrent installs, and cleaned
only by `rm -f ... || true`. They now live in a per-call `mktemp -d /tmp/owp.XXXXXX`
directory **inside the container**, validated against that shape before it is
interpolated into `rm -rf`, and removed from a RETURN trap as well as on the
success path.

That trap exposed a second bug, which the real install caught: a bash `RETURN`
trap is **not scoped to the function that armed it** — it fires on the return of
every later function, where `$cid` no longer exists. The install ended with
`line 312: cid: unbound variable`. Every RETURN trap in the installer is now
disarmed in the function that armed it, and the guard asserts the counts balance.

### 10.3 The guard, and why it is not vacuous

`tests/ci/p001_credential_argv.sh` (wired into the `platform-only` CI job):

| Check | Passed because |
|---|---|
| no credential as an argv to `python3` | static scan, **comments stripped** (the installer documents the old shape) |
| no `sys.argv` credential read | static scan |
| stdin helpers exist | `json_login_payload`, `csrf_from_stdin`, `token_from_stdin` |
| no fixed auth temp paths | five known paths, none present |
| RETURN traps balanced | armed 4, disarmed 4 |
| JSON round-trip ×9 | quotes, backslash, newline/tab, CJK+emoji, trailing space, JSON-lookalike, `$()`/backtick |
| live process argv | a canary password never appears in a spawned process's `ps` output |
| process-table scan | self-checked both ways: zero for an absent marker, **non-zero for a deliberate leak** |
| the scan rejects the forbidden shape | negative control |
| the scan accepts the stdin form | positive control |

Three of its own bugs were found by these controls while writing it: a regex that
missed the real leak shape, a scanner that matched the explanatory comment, and a
process scan that counted `grep`'s own argv. Each was fixed and is now asserted.

**Executed after the change**, to show the fix did not break the installer:
`install exit=0` (350 s, login OK, boundary OK), `backup exit=0`,
`restore exit=0`.

### 10.4 Restore manifest integrity

The manifest is now validated for the fields a restore depends on rather than for
existence: `format` (must be `1`), `created_at`, `image`, `database_bytes`,
`kernel_files`, `database_sha256`, `consistency`, `registry_included`. The
declared package-file count and dump size must match the archive. Executed:

| Archive | Result |
|---|---|
| missing `consistency` | `error backup manifest is missing 'consistency'; refusing to restore` |
| `kernel_files=5` but 0 archived | `error manifest declares 5 package files but the archive lists 0` |
| intact | `ok archive validates (format 1, 0 package files, registry: no)` |

### 10.5 The four recovery layers, kept distinct

`kernel_files=0` in every drill above is **not** evidence that plugin recovery
works, and the document does not claim it:

| Layer | Backed up | Verified |
|---|---|---|
| Database | yes (`pg_dump --clean --if-exists`) | **yes** — a user created before a full volume wipe survives the restore |
| Kernel artifact store | yes (volume archive + checksums) | **structural only** — the count and checksum check ran, against 0 files |
| OCI registry blobs | **no** — declared in the manifest and printed on restore | **no**, and cannot be claimed |
| Plugin instances | n/a (none installed) | **NOT_RUN** — belongs to P001-C |

A deployment restored from this archive has its plugins *registered* but their
images absent; they must be re-pushed from their signed bundles. That is stated
by `restore` itself, not left for an operator to discover.
