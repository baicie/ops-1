# Operations Runbook — 0.0.1

## 1. Start and stop

```bash
# dependencies (PostgreSQL + local registry)
docker compose -f deployments/local/compose.yaml up -d
# build binaries and web
make build && make web
# build signed plugin images/bundles (first time)
scripts/build-plugins.sh
# start Kernel + two nodes + deploy reference plugins
scripts/demo_up.sh
# stop everything (leaves PostgreSQL data and package store)
scripts/demo_down.sh
```

The Kernel listens on `127.0.0.1:18181` in the local demo. Production must terminate TLS at a trusted ingress; the Node data proxy must be reachable only on a private network.

## 2. Enroll a node

1. Sign in as admin and open **Nodes → Join node**.
2. Create a one-time token (5–1440 minutes). Treat it as a secret.
3. On the Linux host install the Node binary and start with `OPSWEAVE_ENROLLMENT_TOKEN` and a Rootless Docker socket.
4. Verify `/nodes` shows `READY` and a fresh heartbeat. A stale heartbeat is `UNREACHABLE`, not `STOPPED`.

## 3. Install a plugin

1. **Plugins → Install package**, upload a signed bundle.
2. Review publisher signature, manifest compatibility, requested permissions and digests.
3. Deploy to nodes (replicas + selector). The deployment remains `PENDING/PREPARING` until every replica reports READY.
4. Activate a revision explicitly. Activation is a separate transaction and is blocked if dependencies/readiness fail.
5. Verify the Gateway and the plugin remote page. The tenant never sees a node IP or container port.

## 4. Upgrade and rollback

- Upload the new version; deploy it while the old revision remains effective.
- Wait for every new replica to be READY, review permission/API changes, then activate.
- Old revision enters a bounded DRAINING window; the Gateway switches only to the new ACTIVE revision.
- Rollback = activate an older deployed version. It is not a database schema reversal. A migration that is not backward compatible must block the upgrade and require a maintenance procedure.

## 5. Failure recovery

```bash
opsctl status
opsctl doctor
opsctl nodes
opsctl plugins
opsctl disable <plugin-id> --reason "operator recovery"
opsctl enable <plugin-id>
opsctl activate <plugin-id> <version>
```

Kernel-owned recovery:
- `GET /livez`, `/readyz`
- `GET /api/v1/diagnostics` (admin)
- `GET /bootstrap` (operator/admin, server-rendered; no plugin JS)

If Node A is down, Gateway routes exclude it after the stale window and continue using Node B. Do not interpret a missing heartbeat as a stopped container.

## 6. Logs and cursors

- **Instance logs** page or `opsctl logs <instance-id>`.
- Cursor is opaque and signed; a forged cursor returns 400.
- Disconnect leaves the last cursor in the UI. Reconnect resumes from it; if the Node ring buffer rotated, a `gap` event is explicit. History search is not part of 0.0.1.

## 7. Backup and restore

```bash
scripts/backup.sh                 # PG custom dump + package store tar + hashes
scripts/restore.sh data/backups/kernel-....dump data/backups/packages-....tar.gz opsweave_restore
```

Restore verifies a **new** database by default. Never point the Kernel at a partially restored DB and call it healthy. Record RPO/RTO targets separately; this is an internal experiment, not a production SLA.

## 8. Credential and trust operations

- Disable a user: **Access → Workspace users → Disable**; sessions are deleted.
- Revoke a node: **Nodes → Node detail → Revoke**.
- Revoke a publisher: **Access → Trusted publishers → Revoke**; new installs fail, audit history remains.
- Publisher keys are offline Ed25519 keys. Never put private keys in the Kernel or a manifest.

## 9. Known operational limits

- Kernel is a single instance; PostgreSQL is not HA.
- mTLS is not implemented in code; private network + TLS ingress is mandatory until it is.
- The Docker CLI adapter requires a protected local Engine socket on each Node.
- Java/Go/TS images in this workspace were built for linux/arm64 due to the development host. Republish `linux/amd64` images before claiming the C01–C04 hardware gate.
- Do not run multiple Kernel instances against the same PostgreSQL database: leader election is not implemented.
