# OpsWeave Platform — a single-host install with no business application

Status: **P001-B, implemented; container-level acceptance NOT_RUN on this workstation
(no Docker daemon).** Read §6 before treating anything here as installed and proven.

This directory ships the platform-only deployment profile: the release you install
when you want OpsWeave itself — identity, nodes, plugins, the console — and none of
the Ops business product.

## 1. What you get

| Component | Present | Notes |
|---|---|---|
| Platform Console | yes | `/app` is **404** by design; there is no ops bundle in the image |
| Kernel | yes, built `--no-default-features` | no incident/investigation/automation handlers exist in the binary |
| IAM / RBAC / sessions / CSRF | yes | |
| Plugin Registry / Publisher Trust | yes | starts with **zero** trusted publishers and **zero** plugins |
| Plugin Lifecycle + Capability Gateway | yes | install one with `opsctl` or the console |
| Node Registry + Node Runtime | yes, one node | enrolled automatically on first install |
| Ops application | **no** | not compiled, not served, no worker |
| Data / Pipeline / Investigation | **no** | |

## 2. Requirements

* Linux amd64 host, Docker Engine ≥ 24 with the Compose v2 plugin.
* **No Rust, Node, Go, Maven, psql or git.** The image is prebuilt and pulled.
* ~2 GB RAM, 5 GB disk.
* One TCP port for the console (`OPSWEAVE_PORT`, default 18080) and the Docker socket.

## 3. Install

```bash
# 1. Get the image. Use a DIGEST for anything you intend to keep.
export OPSWEAVE_IMAGE=ghcr.io/<owner>/opsweave-platform@sha256:<digest>

# 2. Choose the first administrator. There is NO default password and none is
#    generated for you: an unrecorded generated password is a locked-out
#    deployment, and a fixed one is the defect this release removes.
export OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL=you@example.com
export OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD='<at least 12 characters>'

# 3. Install.
sudo -E ./scripts/platform_up.sh install
```

The script refuses (exit 2, before touching anything) when the image or the
administrator credential is missing, shorter than 12 characters, or a well-known
demo value.

It generates `/srv/opsweave-platform/{postgres,kernel,node}.env` with mode `0600`,
a random database password, starts the four services, then **verifies the
boundary** before reporting success:

* `GET /app` must be `404`; if it is `200` the image is the full-product one and
  the install aborts;
* `POST /api/v1/telemetry/events` must be `404`;
* the bootstrap administrator must be able to sign in;
* a node enrolment token is minted, the node joins, and the token is then cleared.

## 4. Operating

```bash
./scripts/platform_up.sh status          # image, build identity, health, /app must be 404
./scripts/platform_up.sh doctor          # preflight + live report
./scripts/platform_up.sh stop            # keeps every volume
./scripts/platform_up.sh start
./scripts/platform_up.sh upgrade  <image>   # tag or @sha256 digest
./scripts/platform_up.sh rollback <image>
./scripts/platform_up.sh backup  [file]     # pg_dump + kernel data, one tarball
sudo OPSWEAVE_RESTORE_FORCE=1 ./scripts/platform_up.sh restore <file>
```

### Upgrade and rollback

`upgrade` and `rollback` are the same operation: pull, recreate the kernel, wait for
health, recreate the node, wait for health, then re-assert that `/app` is still
`404`. **Migrations are forward-only.** Going back across a migration requires
`restore`, and the script says so rather than implying a code rollback is enough.

### Backup and restore

Two halves, and a backup missing either one cannot be restored into a working
platform:

* the database: identity, grants, the plugin registry ledger, the cursor secret;
* the kernel volume: the plugin package store and its backups directory.

`backup` writes both into one tarball with a manifest naming the image and the
served build identity. `restore` recreates the database from the dump, restarts the
kernel, copies the volume data back, and refuses to run without
`OPSWEAVE_RESTORE_FORCE=1` — it is destructive to the current database.

### Volumes

`pgdata`, `kernel` and `registry` are **named volumes**. `compose down` does not
remove them; only `compose down -v` or an explicit `docker volume rm` does. Nothing
in this profile deletes data on its own.

## 5. Security posture of this profile

| Control | State |
|---|---|
| Bootstrap admin | must be supplied; no default, no generation, no echo to a log |
| `node.env` credential boundary | enforced; the installer refuses a node env holding `POSTGRES_*`, `DATABASE_URL`, `OPSWEAVE_BOOTSTRAP_ADMIN_*` or any `*SECRET*` |
| Publisher trust | empty on install; no plugin can be installed until an administrator adds a publisher |
| Session / CSRF / RBAC | unchanged from the product |
| Container limits | CPU and memory limits per service |
| Graceful shutdown | `tini` as PID 1, 30 s kernel / 45 s node stop grace |
| TLS | **not included.** Put a TLS-terminating reverse proxy in front and set `OPSWEAVE_PUBLIC_URL=https://…`; until you do, the session cookie is not marked `Secure` and this is a **preview**, not a production deployment |
| Docker socket | the node mounts it (it must, to create plugin containers). That is host-root-equivalent; the profile is single-host and trusted-operator only |

**This profile is a Preview posture, not a production-ready distributed release.**
The conditions that would make it one — mTLS kernel↔node, rootless Docker, image
signature verification, SBOM and vulnerability gates — are `NOT_RUN` (see
`docs/acceptance/p001/00-baseline-audit.md` §6, G-25/G-26/G-13).

## 6. What is verified, and what is not

**Verified on the authoring workstation (macOS, Docker CLI present, daemon absent):**

| Check | Result |
|---|---|
| `bash -n scripts/platform_up.sh` | clean |
| `--help` | prints the command list |
| refusal: missing image / missing password / short password / demo password / missing email | all **exit 2** with the specific reason |
| env generation | three files, mode `0600`, random DB password, **no credential in `node.env`** |
| `node.env` boundary check | refuses a file containing `POSTGRES_PASSWORD` |
| `docker compose config` (real CLI) | **parses**, resolves `OPSWEAVE_WEB_DIST=/app/web`, `NODE_WORKER_ENABLED=0`, `restart: unless-stopped` everywhere, and **no** `OPSWEAVE_OPS_WEB_DIST` |

**NOT_RUN — and these are the ones that matter:**

| Check | Why |
|---|---|
| `install` against real containers | **no Docker daemon was available in this session** (`Cannot connect to the Docker daemon`) |
| `docker build --target platform` | needs a Docker daemon; the Dockerfile syntax was reviewed, not built |
| Install → Bootstrap → Login → Node Health → Registry → Diagnostics → Restart → Restore on a clean Linux host | the acceptance flow the brief requires; **not executed** |
| Image digest, tag and published artifact | no registry push was performed |

The distinction is stated because "compose parses" and "the install works" are
different claims, and only the first one has evidence here.

## 7. Relationship to the other install paths

| Path | Purpose | Installs business plugins? |
|---|---|---|
| `deployments/platform/` (this) | platform-only single host | **no** |
| `deployments/staging/` | full-product single host, the staging preview | carries both bundles; no plugins by default |
| `scripts/demo_up.sh` | developer demo | yes — Hello reference plugins |
| `scripts/opsweave.sh up` | developer bootstrap | **yes by default** (`WITH_DATA=1`) |

Only this profile and `deployments/staging/` are deployment-shaped. The other two
build from source and are documented as developer tools; neither is an installation
path for an operator.
