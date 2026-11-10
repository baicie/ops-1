# P001 Phase 2 — Platform-only Packaging and Installer

Status: **implemented; container-level acceptance NOT_RUN.** The compose file parses
and the installer's refusal and generation paths were executed and verified. No
Docker daemon was available in this session, so **nothing was installed into
containers**. §5 states exactly what is and is not proven.

Depends on: Phase 1 (`docs/acceptance/p001/01-platform-boundary.md`) for a binary
that has no business surface to install.

---

## 1. What was wrong

Measured in the baseline audit (`00-baseline-audit.md` §4):

| # | Finding |
|---|---|
| G-08 | `scripts/opsweave.sh up` defaults `WITH_DATA=1` and installs Data Catalog + Data Integration |
| G-09 | the same script refuses to start unless four Hello plugin bundles exist on disk |
| G-10 | it builds from source: Rust, pnpm, Go and Maven are required to run it |
| G-11 | the staging image carries both web bundles and the pipeline worker |
| G-14 | it prints a fixed demo credential (`opsweave.sh:82`) |
| — | there was no install path that produces a platform with zero business plugins |

There was also no formal profile distinction: "developer machine" and "deployment"
were the same script with different environment variables.

---

## 2. What was added

### 2.1 Three profiles, now explicit

| Profile | Entry point | Business plugins | Toolchain on host |
|---|---|---|---|
| **Development** | `scripts/demo_up.sh`, `scripts/opsweave.sh` | Hello reference plugins; `up` installs Data | Rust, pnpm, Go, Maven, Docker |
| **Platform-only Preview** | `deployments/platform/` + `scripts/platform_up.sh` | **none, ever** | Docker + Compose only |
| **Distributed** | `deployments/staging/` (single host today) | none by default | Docker + Compose only |

The developer scripts are **unchanged**. They remain the right tool for development,
and the brief explicitly allows `demo_up.sh` to stay as long as it is not a
production install path — which `deployments/platform/README.md` §7 now states.

### 2.2 A platform-only image target

`deployments/staging/Dockerfile` gains a `platform` stage (built with
`--target platform`). It differs from the full image in ways an operator can verify
with `docker image inspect`:

* the Kernel is the `--no-default-features` binary, copied from a separate path so
  the two builds cannot be mixed up;
* **no** `/app/ops-web`;
* **no** `opsweave-pipeline-worker`;
* **no** `OPSWEAVE_OPS_WEB_DIST` in the environment.

The full-product `runtime` stage is untouched, so the staging deployment is unchanged.

### 2.3 A compose profile with safer defaults than staging

`deployments/platform/compose.yaml`:

| Setting | This profile | Staging |
|---|---|---|
| Volumes | **named** (`pgdata`, `kernel`, `registry`) | host bind paths |
| `restart` | `unless-stopped` on every service — a host reboot is recovery | same |
| Pipeline worker | `OPSWEAVE_NODE_WORKER_ENABLED=0`, and the binary is absent | enabled, with a host marker file |
| Ops bundle | absent | mounted |
| Trusted publishers | none | dev publisher seeded from env |
| Plugin registry | empty | empty |

Named volumes are the substantive change: an upgrade that rewrites the compose file
cannot orphan the database, and `compose down` does not remove it.

### 2.4 An installer that refuses to invent credentials

`scripts/platform_up.sh` — commands `install`, `status`, `doctor`, `start`, `stop`,
`upgrade`, `rollback`, `backup`, `restore`, `login-check`.

The credential rules, because they are the part most often got wrong:

* **No default password.** `OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD` must be supplied.
  A generated password nobody recorded is a locked-out deployment; a fixed one is
  the defect this release is removing from its own installer.
* **No echo.** The password is never printed, never written to a log, and never
  placed on a command line where `ps` would show it.
* Refused with exit 2 before touching anything: missing image, missing email,
  missing password, password shorter than 12 characters, and the well-known demo
  value.

The database password **is** generated (nobody needs to type it), and re-used on a
second run so a re-install does not lock the Kernel out of its own database.

### 2.5 The install verifies its own boundary

A successful `compose up` is not evidence that the right product is running. After
starting, `install` asserts:

1. `GET /app` is **404** — a `200` means the image is the full-product one, and the
   install aborts with that message;
2. `POST /api/v1/telemetry/events` is **404**;
3. the bootstrap administrator can sign in;
4. a node enrolment token is minted, the node joins, and the token is then cleared
   from `node.env` (a consumed token left in a file is a stale credential).

### 2.6 A credential boundary the installer enforces

`node.env` is the one file whose container holds the host Docker socket. It must
never carry a database URL or the bootstrap password, or "runs a plugin container"
becomes a path to "database superuser". `assert_service_env_boundary` refuses to
start when the file holds `POSTGRES_*`, `DATABASE_URL`, `OPSWEAVE_BOOTSTRAP_ADMIN_*`,
`OPSWEAVE_GHCR_TOKEN` or any `*SECRET*` key.

### 2.7 Backup and restore

`backup` produces one tarball containing:

* `opsweave.sql.gz` — `pg_dump` of the application database;
* `kernel-data/` — the kernel volume (plugin package store, backups dir);
* `MANIFEST` — timestamp, image, and the served build identity.

`restore` recreates the database, restores the dump, restarts the kernel, copies
the volume data back, and **refuses without `OPSWEAVE_RESTORE_FORCE=1`** because it
is destructive to the current database. Both halves are required: the database alone
loses the package store, the volume alone loses identity and grants.

---

## 3. Verification performed

Every command below was run in this checkout.

### 3.1 Static and preflight

| Check | Result |
|---|---|
| `bash -n scripts/platform_up.sh` | clean |
| `./scripts/platform_up.sh --help` | prints the documented command list |
| `docker compose config` on `deployments/platform/compose.yaml` | **parses** |
| resolved `OPSWEAVE_WEB_DIST` | `/app/web` |
| resolved `OPSWEAVE_OPS_WEB_DIST` | **absent** |
| resolved `OPSWEAVE_NODE_WORKER_ENABLED` | `"0"` |
| resolved `restart` on all four services | `unless-stopped` |
| required-variable guard | fails closed when `OPSWEAVE_IMAGE` is unset |

### 3.2 Refusal paths (executed, exit codes observed)

| Input | Result |
|---|---|
| no `OPSWEAVE_IMAGE` | exit **2**, "set OPSWEAVE_IMAGE…" |
| no `OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD` | exit **2**, "no default is provided" |
| password `short` (< 12 chars) | exit **2**, "must be at least 12 characters" |
| password `OpsWeave!2026` | exit **2**, "well-known demo value" |
| no `OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL` | exit **2** |

### 3.3 Environment generation (executed)

Ran `install` against the real code path with the container calls stubbed, and
inspected the produced files:

| Assertion | Result |
|---|---|
| three env files written | yes |
| mode | `0600` on all three |
| database password | random, 40 chars, re-used when `postgres.env` already exists |
| `kernel.env` DSN | embeds the same password |
| `node.env` credentials | **none** |
| `node.env` boundary check | **refuses** a file containing `POSTGRES_PASSWORD` |

---

## 4. What is explicitly NOT done

| Item | Status | Why |
|---|---|---|
| Published platform-only image with a digest | `NOT_RUN` | no Docker daemon; no registry push |
| `docker build --target platform` | `NOT_RUN` | same |
| The full Install → Bootstrap → Login → Node Health → Registry → Diagnostics → Restart → Restore flow on a clean Linux host | `NOT_RUN` | same |
| A CI job that builds and publishes the `platform` target | `MISSING` | belongs with the release-engineering phase, and needs a registry credential policy |
| TLS termination | `MISSING` | documented as an operator step; the profile is a Preview until then |
| `sample` / `conformance` install entry for reference plugins | `MISSING` | Phase 3 |
| `scripts/opsweave.sh up` default flipped to platform-only | **not changed, deliberately** | it is a developer tool; flipping it would break the documented dev workflow for no operator benefit. The README states which path is for deployments. |

---

## 5. The honest summary

**What a reviewer can rely on:** the profile exists as a real artifact (Dockerfile
target, compose file, installer, documentation); the installer's credential policy
and environment generation were executed and are correct; the compose file parses and
resolves to a platform-only configuration; the image target excludes the ops bundle,
the pipeline worker and the ops environment variable by construction.

**What a reviewer must not assume:** that this has been installed. It has not. The
first real install will be the first time `docker build --target platform`, the
compose health gates, the node enrolment over a real socket and the restore drill run
end to end. Any of them may fail on the first attempt, and until that run happens the
correct status of Phase 2 is **implemented, not accepted**.

That distinction is the deliverable here as much as the code is: a release that
claims an install it never performed is the failure mode this whole programme exists
to prevent.
