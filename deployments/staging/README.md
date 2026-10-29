# OpsWeave staging (single image, two roles)

One image serves both roles: the Kernel (which also hosts the React Web Shell) and the
Node Runtime. The Node role is selected at run time by overriding the container command
with `command: ["/usr/local/bin/opsweave-node"]`.
Background and accepted trade-offs: `docs/adr/ADR-014-staging-preview-deployment.md`.
Known exposure and the staging-only rule that forbids this shape in production: ADR-014 §8.
Convergence plan for the shared-bridge exposure: ADR-014 §9.

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

# The three per-service env files (ADR-014 §8) are derived from staging.env by the deploy script on
# its first run, with a deny-by-default allow list:
#   postgres.env  POSTGRES_* only                     -> postgres container
#   kernel.env    DATABASE_URL + bootstrap admin      -> kernel container
#   node.env      node identity + enrolment token     -> node container, no credentials
# To write them by hand instead, copy postgres.env.example / kernel.env.example / node.env.example.
# staging.env itself is compose interpolation input only and is never mounted into a container.

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
| `/srv/opsweave-staging/staging.env` | root, 0600 | compose interpolation only (image, gateway, socket GID, port); never mounted |
| `/srv/opsweave-staging/postgres.env` | root, 0600 | `POSTGRES_*` only; mounted into `postgres` |
| `/srv/opsweave-staging/kernel.env` | root, 0600 | `DATABASE_URL`, bootstrap admin, limits; mounted into `kernel` |
| `/srv/opsweave-staging/node.env` | root, 0600 | node identity + enrolment token; mounted into `node`; no credentials allowed |

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
- Known risk (staging only): postgres/registry are published on `172.17.0.1`, which every container
  of every project on this host can reach. The host itself has no packet filter (`ufw inactive`), so
  the cloud firewall is the only boundary. Registered as E2/E3 in ADR-014 §8; ADR-014 §9 is the
  convergence plan (dedicated bridge + fixed gateway + `--network` on plugin containers).
- `node.env` is checked before every compose call: a `POSTGRES_*`, `DATABASE_URL`,
  `OPSWEAVE_BOOTSTRAP_ADMIN_*`, `OPSWEAVE_GHCR_TOKEN` or `*SECRET*` key there aborts the run.

## 6. Pipeline execution: the three gates a job must pass

A submitted job is claimed by a **node-managed pipeline worker**: a child process of the
`node` service, not a plugin container. It only exists if all three conditions hold. Miss
any one and the job sits in `QUEUED` forever with `attempts=0`, `currentLeaseId=null` and a
single `JOB_SUBMITTED` event — no attempt, no lease, no error.

| # | Gate | Where it is set |
|---|------|-----------------|
| 1 | `OPSWEAVE_NODE_WORKER_ENABLED=1` | `compose.yaml` node `environment:` |
| 2 | `OPSWEAVE_PIPELINE_WORKER_BIN=/usr/local/bin/opsweave-pipeline-worker` | `compose.yaml` node `environment:` (binary is baked in by `Dockerfile:74`) |
| 3 | marker **file** `/var/lib/opsweave-staging/node/worker-enabled` | created by the operator on the host, see below |

Gates 1 and 2 live in compose, not `node.env`, on purpose: compose `environment:` wins over
`env_file`, so the same keys in `node.env` would be dead configuration. Gate 3 is not an
environment variable at all (`apps/node/src/worker_supervisor.rs:45,52`) and **no deploy step
creates it** — it is the deliberate, explicit switch that tests use to start and stop workers.

```bash
# gate 3: once per state directory. Re-create it after anything that wipes the directory.
sudo install -m 644 -o root -g root /dev/null /var/lib/opsweave-staging/node/worker-enabled
sudo docker logs opsweave-staging-node-1 2>&1 | grep -E 'worker disabled|starting node-managed'
#   "node-managed pipeline worker disabled"  -> gate 1/3 missing
#   "starting node-managed pipeline worker"  -> running; instance_id is the Ready instance
```

Two further conditions are satisfied by an ordinary deployment: at least one plugin instance
must be `READY` (the supervisor binds the worker to it, `worker_supervisor.rs:59-72`), and the
worker only fetches a source whose host or IP is in `OPSWEAVE_WORKER_SOURCE_ALLOWLIST` — a
non-public address is otherwise refused (`apps/pipeline-worker/src/main.rs:1165-1173`). The
allow-list is a compose interpolation input: override `OPSWEAVE_WORKER_SOURCE_ALLOWLIST` in
`staging.env`; its default is `172.17.0.1` (the bridge gateway).

**Verifying a release actually executes jobs** (a green `/livez` proves nothing here):

```bash
# submit, then poll: QUEUED -> CLAIMED -> RUNNING -> SUCCEEDED
curl -sS -b jar -H 'x-csrf-token: <csrf>' -H "Idempotency-Key: $(uuidgen)" \
  -H 'content-type: application/json' \
  -d '{"pipelineId":"host-metrics-pipeline","pipelineRevision":2,"maxAttempts":3,"timeoutSeconds":300}' \
  http://127.0.0.1:3000/api/v1/jobs
```

A job that outlives its deadline while still queued is terminalized as
`JOB_DEADLINE_EXCEEDED` with `attempts=0` — that is the symptom, not a separate fault.

### DEMO source (staging host only, not a production endpoint)

The seeded pipeline `host-metrics-pipeline` revision 2 pins
`http://172.17.0.1:18090/data-hosts.json` as its source. The fixture is version-controlled
at `deployments/staging/demo/data-hosts.json` and is copied to
`/srv/opsweave-staging/demo-source/data-hosts.json` on the host, where a plain
`python3 -m http.server`
bound to the docker bridge gateway only (`172.17.0.1:18090`, never a public interface), marked
`README-DEMO.txt` in that directory. Records match catalog dataset
`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` schema revision 1: `id` (string, required), `name`
(string, nullable).

```bash
# restart
sudo nohup python3 -m http.server 18090 --bind 172.17.0.1 \
     --directory /srv/opsweave-staging/demo-source \
     >>/srv/opsweave-staging/demo-source/http-18090.log 2>&1 &
# clean up (the fixture is not a service; nothing else depends on it)
sudo kill "$(sudo cat /srv/opsweave-staging/demo-source/http-18090.pid)"
sudo rm -f /srv/opsweave-staging/demo-source/data-hosts.json \
           /srv/opsweave-staging/demo-source/http-18090.pid
```

Replace that URL with a real source (and add its host to `OPSWEAVE_WORKER_SOURCE_ALLOWLIST`)
before any pipeline acceptance run that claims to prove staging is production-like.
