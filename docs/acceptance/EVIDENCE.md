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
| `dev.opsweave.hello@0.0.1` | `localhost:5001/opsweave/hello-ts@sha256:7fff8456d2c1d8a8b430207bfea3e4dd34ea30f3c28e93483cad252eea624b6b` |
| `dev.opsweave.hello@0.0.2` | `localhost:5001/opsweave/hello-ts@sha256:693424870872a813324e0bfba52469f9e33a5f1903b6a6a441dfbaea59ce40e6` |
| `dev.opsweave.hello-go@0.0.1` | `localhost:5001/opsweave/hello-go@sha256:b2b0a8ee141638dd8787ac871dc918d86f62826ccbe968c50511b216b3b39bda` |
| `dev.opsweave.hello-java@0.0.1` | `localhost:5001/opsweave/hello-java@sha256:a7a45af9222bf022b334c78b1e95eb361e162005881bdf60e2320668e96df996` |

The signature covers both the canonical payload index digest and the canonical manifest digest, so changing `backend.imageRef` invalidates the publisher signature (asserted by a Rust unit test).

## Executed checks

### Rust tests

Command: `cargo test --workspace`

```
opsweave_bundle: 4 passed
  builds_and_verifies_bundle ... ok
  rejects_tampered_payload ... ok
  rejects_path_traversal ... ok
  manifest_image_reference_is_covered_by_signature ... ok
opsweave_contracts: 3 passed
opsweave_kernel: 1 passed
result: all 8 passed, 0 failed
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
active instance on node-a: df301173-f71a-408b-88e9-14caae7723d4
before (forced node-a): df301173-f71a-408b-88e9-14caae7723d4
immediate failover: 89defb3e-37d8-49ec-adfe-1595ef01ffd5
node statuses after stale window: node-a=UNREACHABLE node-b=READY
after stale failover: 89defb3e-37d8-49ec-adfe-1595ef01ffd5
recovered: df301173-f71a-408b-88e9-14caae7723d4
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

### Node credential revocation

Command: `tests/acceptance/node_revocation.sh`

```
node credential revocation test passed (200 before revoke, 403 after)
```

### Container security baseline

Command: `tests/acceptance/container_security.sh`

Inspected every running managed container: `privileged=false`, `cap-drop ALL`, `no-new-privileges`, read-only rootfs, memory/CPU/PID limits, no host binds, no host network, loopback-only published ports, non-root image user.

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
| Three physical machines / independent network boundaries | Two Node processes share one Docker daemon; no packet loss/partition test. |
| mTLS control and data channels | Not implemented; bearer credentials over private TLS ingress only. |
| OCI image signature/attestation, SBOM, vulnerability gate | Not implemented; content digest pull is enforced. |
| C09 old-tab compatibility window | Not implemented. |
| C10 migration gate / destructive schema rollback prevention | No migration engine in 0.0.1. |
| SSE backpressure/flood and revoke-mid-stream | UI/stream path implemented; stress tests not run. |
| Production performance, HA, multi-tenancy, disaster recovery | Explicitly out of scope for 0.0.1. |

## Evidence files

- `/tmp/final2-e2e.out`, `/tmp/final2-failover.out`, `/tmp/final2-restart.out`, `/tmp/final-revoke.out`, `/tmp/final-security2.out`, `/tmp/final-conformance.out`, `/tmp/final-contract.out`, `/tmp/final-ui2.out`
- `artifacts/ui/*.png`
- Kernel and Node logs: `/tmp/opsweave-kernel.log`, `/tmp/opsweave-node-a.log`, `/tmp/opsweave-node-b.log`
