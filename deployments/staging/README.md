# OpsWeave staging (single image, two roles)

One image serves both roles: the Kernel (which also hosts the React Web Shell) and the
Node Runtime. The Node role is selected at run time by overriding the container command
with `command: ["/usr/local/bin/opsweave-node"]`.
Background and accepted trade-offs: `docs/adr/ADR-014-staging-preview-deployment.md`.

The target host has **no** rust/node/psql toolchain, so images are built in CI only.
Image: `ghcr.io/baicie/opsweave:<40-char-sha>` - never `latest`. Rollback = the previous SHA.

## 1. Build (CI, x86_64 runner)

```bash
docker build -f deployments/staging/Dockerfile -t ghcr.io/baicie/opsweave:$GITHUB_SHA .
docker run --rm --entrypoint /usr/local/bin/opsweave-kernel ghcr.io/baicie/opsweave:$GITHUB_SHA --version
docker run --rm --entrypoint /usr/local/bin/opsweave-node   ghcr.io/baicie/opsweave:$GITHUB_SHA --version
docker push ghcr.io/baicie/opsweave:$GITHUB_SHA
```

Local syntax check on any host (native platform, e.g. arm64 on macOS):

```bash
docker build -f deployments/staging/Dockerfile -t opsweave-staging:localdev .
docker run --rm --entrypoint /usr/local/bin/opsweave-node opsweave-staging:localdev --version
```

Image contents: `/usr/local/bin/{opsweave-kernel,opsweave-node,opsctl,opsweave-pipeline-worker}`,
Web assets in `/app/web`, plus the `docker` CLI (the Node drives plugin containers), `curl`, `tini`.

## 2. First-time host setup (Ubuntu 24.04)

```bash
sudo mkdir -p /var/lib/opsweave-staging/{pg,registry,kernel,node}
sudo chown -R 999:999     /var/lib/opsweave-staging/pg     # postgres:17 runs as uid 999
sudo chown -R 10001:10001 /var/lib/opsweave-staging/kernel /var/lib/opsweave-staging/node
sudo mkdir -p /srv/opsweave-staging
sudo cp deployments/staging/staging.env.example /srv/opsweave-staging/staging.env
sudo chmod 600 /srv/opsweave-staging/staging.env   # then edit every __PLACEHOLDER__

# Values the compose file must agree with:
docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'   # -> DOCKER_BRIDGE_IP
stat -c '%g' /var/run/docker.sock                                             # -> DOCKER_GID
```

`docker compose` interpolation reads the **shell** environment, not `env_file`. The deploy
script must export the image, build identity and bridge gateway first:

```bash
set -a; . /srv/opsweave-staging/staging.env; set +a
export OPSWEAVE_IMAGE=ghcr.io/baicie/opsweave:$SHA
export OPSWEAVE_BUILD_SHA=$SHA OPSWEAVE_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
```

## 3. Deploy

```bash
cd <repo> && set -a; . /srv/opsweave-staging/staging.env; set +a
export OPSWEAVE_IMAGE=ghcr.io/baicie/opsweave:$SHA
docker compose -f deployments/staging/compose.yaml pull
docker compose -f deployments/staging/compose.yaml up -d
docker compose -f deployments/staging/compose.yaml ps
```

**First deploy only** - the node needs a one-time enrolment token or it cannot join:

```bash
opsctl --url http://127.0.0.1:18080 login --email <admin email> --password <admin password>
opsctl --url http://127.0.0.1:18080 node-token --label staging-node
# put the printed token into OPSWEAVE_ENROLLMENT_TOKEN and re-run: up -d
```

The token is consumed on redemption. Once `/var/lib/opsweave-staging/node/node-identity.json`
exists the node re-uses that identity, so **leave `OPSWEAVE_ENROLLMENT_TOKEN` empty afterwards**.
Never delete that directory: losing it re-enrols the node and breaks its generation history.

Verify: `curl -fsS http://127.0.0.1:18080/livez`, `curl -fsS http://127.0.0.1:18080/readyz`,
`curl -fsS http://127.0.0.1:9101/healthz`; browsers use `http://<host>:18080/`.

## 4. Ports and paths (frozen)

| Service | Address | Notes |
|---|---|---|
| kernel | `0.0.0.0:18080` | `network_mode: host`, no port mapping; API + Web Shell |
| node | `127.0.0.1:9101` | data plane, loopback only (Kernel whitelist) |
| postgres | `127.0.0.1:55432` + `172.17.0.1:55432` | gateway binding is what plugin containers use |
| registry | `127.0.0.1:15001` + `172.17.0.1:15001` | `registry:2`, 15001 -> 5000 |

| Path | Owner | Content |
|---|---|---|
| `/var/lib/opsweave-staging/pg` | 999:999 | PostgreSQL data (`PGDATA=/var/lib/postgresql/data/pgdata`) |
| `/var/lib/opsweave-staging/registry` | root | OCI blobs |
| `/var/lib/opsweave-staging/kernel` | 10001:10001 | packages, backups |
| `/var/lib/opsweave-staging/node` | 10001:10001 | `node-identity.json` (must persist) |
| `/srv/opsweave-staging/staging.env` | root, 0600 | all runtime configuration |

Plugin containers are created by the Node on the default bridge and report back to
`172.17.0.1:18080` / `172.17.0.1:55432`; that is why both services bind the docker gateway.
With a wrong `DOCKER_BRIDGE_IP` plugins start but cannot reach the Kernel or their database.

## 5. Operating notes and rollback

- **Kernel must stay a single instance.** It applies sqlx migrations at startup
  (`apps/kernel/src/main.rs:50`), so staging needs no separate migration step; but two
  Kernels booting at once would race the same schema. Never scale `kernel` horizontally.
- **Rollback:** set `OPSWEAVE_IMAGE` back to the previous 40-char SHA and re-run `up -d`.
  Data lives outside the image, so a code rollback needs no restore. Migrations are
  forward-only: rolling back across a migration requires restoring the database.
- Logs: `docker compose -f deployments/staging/compose.yaml logs -f kernel node`
  (json-file, 10 MB x 3 per service).
- Stop without data loss: `docker compose -f deployments/staging/compose.yaml down`.
- Known risk (staging only): the `node` service mounts `/var/run/docker.sock`, i.e. full
  host Docker control. Accepted for staging in ADR-014; do not reuse this file in production.
