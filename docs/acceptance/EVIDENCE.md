# Acceptance evidence — OpsWeave 0.0.1

This report records what was actually executed on the development host. It does **not** claim the production three-host or rootless-Linux gates.

## Environment

| Item | Observed value |
|---|---|
| Date | 2026-10-22 (Asia/Shanghai) |
| Commit | `git log -1` (implementation checkout) |
| Host OS / arch | macOS 15.7.7 / arm64 (Apple M1) |
| Rust / Cargo | 1.96.0 |
| Node / pnpm | 22.12.0 / 10.34.3 |
| PostgreSQL | 17.10 (Homebrew) |
| Docker | Docker Desktop 29.7.2, linux/aarch64 containers |
| Registry | `registry:2`, `127.0.0.1:5001` |
| Kernel | `0.0.1`, bind `127.0.0.1:18181` |
| Nodes | node-a + node-b, data ports 9101/9102 (two processes, one Docker daemon) |
| Plugins | TS/Node 22, Go 1.25, Java 21.0.12.1 / Spring Boot 3.3.5 |

## Signed bundles / OCI digests

`scripts/build-plugins.sh` produced these real, pushed image digests (recorded in `dist/plugins/index.json`):

| Plugin | Image |
|---|---|
| `dev.opsweave.hello@0.0.1` | `localhost:5001/opsweave/hello-ts@sha256:6da03a9732278ba36f87456a637a04e79357a9775262289612222b1a0352d226` |
| `dev.opsweave.hello@0.0.2` | `localhost:5001/opsweave/hello-ts@sha256:3061f3715be35a41c4bdbe5ae4673354bac4bec2d36d73cbbb258dff9e690804` |
| `dev.opsweave.hello-go@0.0.1` | `localhost:5001/opsweave/hello-go@sha256:7c12d2e85bb306256a54e58b3d1f1335c87cdd6e149edb8b6ccb506b29d3fd2c` |
| `dev.opsweave.hello-java@0.0.1` | `localhost:5001/opsweave/hello-java@sha256:27f33d59da172c368e8fba5c97d39a1c9d4a055ee85c986c288aa545c7840f12` |

The signature covers both the canonical payload index digest and the canonical manifest digest, so changing `backend.imageRef` invalidates the publisher signature (asserted by a Rust unit test).

## Executed checks

### Remote CI

GitHub Actions run [`39723679225`](https://github.com/baicie/ops-1/actions/runs/39723679225) on commit `35181c3`:

```
web       success  (pnpm typechecks + Shell/hello builds)
contracts success  (schema and example validation)
rust      success  (workspace tests, fmt, clippy -D warnings)
```

### Rust tests

Command: `cargo test --workspace`

```
opsweave_bundle: 4 passed
  builds_and_verifies_bundle ... ok
  rejects_tampered_payload ... ok
  rejects_path_traversal ... ok
  manifest_image_reference_is_covered_by_signature ... ok
opsweave_contracts: 3 passed
opsweave_kernel: 5 passed (cursor, path traversal, capacity fail-closed, IP-key extraction + trusted proxy)
opsweave_node: 2 passed (path traversal, Docker cleanup failure propagation)
result: all 14 passed, 0 failed
```

### Contract validation

Command: `python3 tests/contract/validate_contracts.py`

```
contract validation passed
  schemas: 6
  examples validated: 6
  ok bundle hello-ops-0.0.1.plugin.zip
  ok bundle hello-ops-0.0.2.plugin.zip
  ok bundle hello-go-0.0.1.plugin.zip
  ok bundle hello-java-0.0.1.plugin.zip
```

### Runtime v1 conformance (black-box, real containers)

Command: `tests/contract/run_conformance.sh`

Tested each READY instance directly on loopback, plus the Kernel Gateway:

- Runtime Info identity/version/protocol matched the active signed manifest for TypeScript, Go and Java.
- `capabilityDigest` matched SHA-256 of the canonical `provides` array.
- liveness 200, readiness 200, unknown path 404.
- Gateway forged `X-OpsWeave-User-Role: forged-superadmin` was overwritten with the authenticated admin role.

Result: `Runtime conformance: 0 failure(s)`.

### Full lifecycle E2E

Command: `tests/acceptance/e2e_platform.sh`

Result: `PASS=21 FAIL=0`, including:
- authenticated overview, `/livez`, `/readyz`;
- signed v1/v2 staging;
- tampered `imageRef` rejected `400 SIGNATURE_OR_BUNDLE_INVALID`;
- two READY replicas and Gateway call;
- SSE status + real log event, forged cursor `400`;
- viewer denied log stream `403` and diagnostics `403`;
- Go and Java Runtime v1 servers;
- v1→v2 upgrade and rollback to v1;
- disable returns `503 CAPABILITY_UNAVAILABLE`, re-enable and activate serves again.

### Two-node failover

Command: `tests/acceptance/two_node_failover.sh`

```
active instance on node-a: f40940f9-fc7c-4cf1-a5ff-13815401215f
before (forced node-a): f40940f9-fc7c-4cf1-a5ff-13815401215f
immediate failover: b5145338-5d38-443c-bc36-b5997d661abe
node statuses after stale window: node-a=UNREACHABLE node-b=READY
after stale failover: b5145338-5d38-443c-bc36-b5997d661abe
recovered: f40940f9-fc7c-4cf1-a5ff-13815401215f
dev.opsweave.hello ... replicas=2/2
two-node failover test passed
```

This proves traffic selected a Node A instance, Node B served after A was killed, Node A became `UNREACHABLE` (not STOPPED), and the deployment returned to 2/2 after A rejoined. It is a local two-process simulation, not two physical hosts.

### Kernel restart reconciliation

Command: `tests/acceptance/kernel_restart.sh`

```
active version before restart: 0.0.1
active version after restart: 0.0.1
packages=4 installedPlugins=3 deployments=3 readyInstances=4
kernel restart reconciliation test passed
```

### Node credential revocation and unsafe endpoint rejection

Command: `tests/acceptance/node_revocation.sh`

```
node credential revocation test passed (unsafe endpoint 400; heartbeat 200 before revoke, 403 after)
```

### Live node quarantine — containers actually stop

Command: `tests/acceptance/node_quarantine.sh`

```
node-a has 3 managed container(s); revoking 6768450f-64b6-4a14-9731-b618ab687e0b
node quarantine test passed: 3 container(s) were removed after revocation
```

### Kernel partition beyond node lease

Command: `tests/acceptance/node_lease.sh`

```
stopping Kernel pid=59733; node-b has 1 container(s)
node lease test passed: workloads stopped after Kernel partition exceeded lease
```

Node log shows `node entering quarantine ... reason="node lease deadline expired"`, confirming the independent watchdog path, not just a failed heartbeat request. This is a local process/network partition simulation, not a physical network partition.

### SSE endpoint policy

Command: `tests/acceptance/endpoint_policy.sh`

The test temporarily corrupts a Node's `data_endpoint` in PostgreSQL to the cloud metadata address and calls the live SSE route. The Kernel rejects it before opening the stream:

```
endpoint policy test passed: SSE rejects a tampered dataEndpoint
```

### Public auth limits

Command: `tests/acceptance/auth_limits.sh`

```
login throttle codes: [401, 401, ..., 429, 429]
auth limit test passed: oversized body 413; repeated failures end in 429
```

`auth.rs` unit tests additionally prove that two connections from the same IP but different ephemeral ports map to the same IP rate-limit key, and that `X-Forwarded-For` is ignored unless the immediate peer is an explicit trusted proxy.

### Publisher revocation gate

Command: `tests/acceptance/publisher_revocation.sh`

```
publisher revocation gate passed: deploy rejected with PUBLISHER_REVOKED
```

### Scheduler capacity reservation

The scheduler now re-evaluates CPU/memory reservations for every slot, uses fail-closed capacity when a snapshot is missing, and enforces per-deployment max instances plus the global `OPSWEAVE_MAX_INSTANCES_PER_NODE` cap. `deployments.rs` unit tests cover fail-closed snapshot, memory pressure and CPU pressure. A dedicated multi-deployment low-capacity stress test is `NOT_RUN`.

### Container security baseline

Command: `tests/acceptance/container_security.sh`

Inspected every running managed container: `privileged=false`, `cap-drop ALL`, `no-new-privileges`, forced `User=65532:65532`, actual `id -u` non-zero, read-only rootfs, memory/CPU/PID limits, no host binds, no host network, loopback-only published ports.

Result: `container security baseline: 0 failure(s) across 4 containers`.

### UI / visual

Command: `pnpm --filter @opsweave/ui-tests test`

```
5 passed
responsive overview matrix 1440/1024/390 light/dark
core operator pages render and do not overflow at 1440
plugin detail and install wizard are usable
dynamic remote extension loads and calls the Gateway
instance log viewer connects and shows a log line
```

Screenshots: `artifacts/ui/` (six overview matrix images plus route/feature captures). Review notes: `docs/ui/visual-review.md`.

### Backup / restore

`scripts/backup.sh` produced a PostgreSQL custom dump and package-store tar with SHA-256 manifest. `scripts/restore.sh` restored into a new database `opsweave_restore`; verification query returned 4 packages and 3 nodes. This validates the procedure, not a production RPO/RTO.

## NOT_RUN / not demonstrated

| Gate | Reason |
|---|---|
| Real Linux amd64 + Rootless Docker | Development host is macOS arm64 with Docker Desktop; images built for linux/arm64. |
| Three physical machines / independent network boundaries | Two Node processes share one Docker daemon; `node_lease.sh` covers local Kernel partition, physical network partition remains `NOT_RUN`. |
| mTLS control and data channels | Not implemented; bearer credentials over private TLS ingress only. Remote plaintext HTTP is rejected by endpoint policy; the reference Node listener must remain loopback behind an authenticated TLS/mTLS tunnel. |
| OCI image signature/attestation, SBOM, vulnerability gate | Not implemented; content digest pull is enforced. |
| C09 old-tab compatibility window | Not implemented. |
| C10 migration gate / destructive schema rollback prevention | No migration engine in 0.0.1. |
| SSE backpressure/flood | Per-poll revocation and idle backoff implemented; deliberate flood/backpressure test not run. |
| Production performance, HA, multi-tenancy, disaster recovery | Explicitly out of scope for 0.0.1. |

## Evidence files

- `/tmp/a1-final-e2e.out`, `/tmp/a1-failover.out`, `/tmp/a1-restart3.out`, `/tmp/a1-auth.out`, `/tmp/a1-endpoint.out`, `/tmp/a1-quarantine.out`, `/tmp/a1-lease.out`, `/tmp/a1-final-security.out`, `/tmp/a1-final-conformance.out`, `/tmp/a1-final-contract.out`
- Final UI evidence is regenerated after the final clean reset; `artifacts/ui/`.
- `artifacts/ui/*.png`
- Kernel and Node logs: `/tmp/opsweave-kernel.log`, `/tmp/opsweave-node-a.log`, `/tmp/opsweave-node-b.log`
