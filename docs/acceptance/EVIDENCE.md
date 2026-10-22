# Acceptance evidence — OpsWeave 0.0.1

This report records what was actually executed on the development host. It does **not** claim the production three-host or rootless-Linux gates.

## Environment

| Item | Observed value |
|---|---|
| Date | 2026-10-22 (Asia/Shanghai) |
| Code freeze commit | `ca56462` (`Stage A.1.3.1`) |
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

GitHub Actions run [`39736068436`](https://github.com/baicie/ops-1/actions/runs/39736068436) on commit `ca56462`:

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
opsweave_kernel: 9 passed (cursor, path traversal, capacity fail-closed, placement transfer, STOP/START accounting, IP-key/trusted-proxy, sliding-window limiter)
opsweave_node: 8 passed (path traversal, Docker cleanup failure propagation, lifecycle lock timeout, no unlocked Docker scan, retry convergence/error retention, runtime helpers)
result: all 24 passed, 0 failed
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

### Node lifecycle barrier and cleanup

`run_once()` pulls outside the lifecycle mutex, then holds it across digest verification and `create/start`; adoption is also guarded. `quarantine()` sets the flag, cancels supervisors, and performs only a guarded sweep. A 15s lifecycle-lock timeout is itself a `QUARANTINE_CLEANUP_FAILED` result: it never scans Docker without the lock. A separate detached retry task waits for the in-flight lifecycle operation, then retries guarded cleanup and clears the error only after an empty managed-container enumeration. Deterministic tests cover both the retry-success path (lock released, error cleared) and the permanent-Docker-failure path (error retained), in addition to the no-unlocked-scan test. A post-pull `ensure_node_active()` check prevents a slow pull from creating after the flag was set. Docker `inspect` (including `port_of`), `list_managed`, `is_running`, `version`, normal commands, pull and stop/remove are all timeout-bounded. The initial quarantine attempt has a 15s lifecycle-lock wait and a 45s cleanup deadline; it never calls Docker without the lock. A detached retry task continues after that response deadline, re-enumerates and re-attempts stop/remove, and retains `QUARANTINE_CLEANUP_FAILED` until it can verify an empty managed set. A timeout is never treated as success.

The deterministic slow-pull-versus-lease race test is not automated; the lifecycle barrier and post-pull checks are the code-level mitigation. Real Docker daemon unavailability and permanent CLI hang remain `NOT_RUN`.

### Live node quarantine — containers actually stop

Command: `tests/acceptance/node_quarantine.sh`

```
node-a has 3 managed container(s); revoking e976c6d5-53fe-4012-93a6-07236778a52d
node quarantine test passed: 3 container(s) were removed after revocation
```

### Kernel partition beyond node lease

Command: `tests/acceptance/node_lease.sh`

```
stopping Kernel pid=81407; node-b has 2 container(s)
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

`auth.rs` unit tests additionally prove that two connections from the same IP but different ephemeral ports map to the same IP rate-limit key, that `X-Forwarded-For` is ignored unless the immediate peer is an explicit trusted proxy, and that a multi-hop chain is parsed from the trusted side toward the client. `state.rs` tests verify the five-minute sliding window drops only expired timestamps instead of deleting or retaining a whole bucket incorrectly.

### Publisher revocation gate

Command: `tests/acceptance/publisher_revocation.sh`

```
publisher revocation gate passed: deploy rejected with PUBLISHER_REVOKED
```

### Scheduler capacity reservation

The scheduler now re-evaluates CPU/memory reservations for every slot, uses fail-closed capacity when a snapshot is missing, and enforces per-deployment max instances plus the global `OPSWEAVE_MAX_INSTANCES_PER_NODE` cap. Migration explicitly transfers the global instance count and both CPU/memory reservations from the source Node to the target Node. STOP→START restoration charges only the target Node and never subtracts an uncounted source. `deployments.rs` unit tests cover fail-closed snapshot, memory pressure, CPU pressure, START migration, STOP migration and STOP→START restoration. A dedicated end-to-end multi-deployment low-capacity stress test is `NOT_RUN`.

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
| C10 migration gate / destructive schema rollback prevention | 0.0.2 adds checksum-gated EXPAND/MIGRATE/CONTRACT storage migrations; automatic destructive rollback remains intentionally unsupported. |
| SSE backpressure/flood | Per-poll revocation and idle backoff implemented; deliberate flood/backpressure test not run. |
| Production performance, HA, multi-tenancy, disaster recovery | Explicitly out of scope for 0.0.1. |

## Evidence files

- `/tmp/a131-e2e2.out`, `/tmp/a131-quarantine.out`, `/tmp/a131-lease.out`, `/tmp/a13-auth2.out`, `/tmp/a13-endpoint2.out`, `/tmp/a13-security2.out`, `/tmp/a13-conformance2.out`
- `/tmp/a12-failover.out`, `/tmp/a12-restart.out` (the quarantine follow-up did not alter failover/restart semantics)
- Final UI evidence is regenerated by `pnpm --filter @opsweave/ui-tests test` in `artifacts/ui/`.
- Final UI evidence is regenerated after the final clean reset; `artifacts/ui/`.
- `artifacts/ui/*.png`
- Kernel and Node logs: `/tmp/opsweave-kernel.log`, `/tmp/opsweave-node-a.log`, `/tmp/opsweave-node-b.log`

## 0.0.2 Data Foundation development evidence

This section records only what was actually executed during the 0.0.2 implementation branch. It is not a production acceptance report.

| Check | Result | Notes |
|---|---|---|
| Contract validation | PASS | `python3 tests/contract/validate_contracts.py`: 10 schemas and all generated bundles validate; data bundles include capability/storage schema/examples. |
| Rust workspace | PASS (local) | 28 tests: 4 bundle + 3 contracts + 13 kernel + 8 node; Clippy `-D warnings` and `cargo fmt --check` pass. |
| Catalog host-process PostgreSQL | PASS (local) | Dataset creation, schema revision 2 draft/publish, compatible diff and incompatible type/removal rejection (`SCHEMA_INCOMPATIBLE`). |
| Catalog idempotency | PASS (local) | Same `sourceBatchKey` + same request returned the original receipt; changed content is rejected by the receipt digest check. |
| Integration HTTP/JSON connector | PASS (local) | Connection test `OK`, four discovered fields, preview `readOnly=true`; preview left Catalog record count unchanged. |
| SSRF negative | PASS (local) | Loopback source without opt-in returned HTTP 422 `SOURCE_SSRF_BLOCKED`. |
| Kernel capability grant/resolve | PASS (local) | `data.catalog.v1` provider resolved; grant created; disable returned 409 `DEPENDENCY_BLOCKED` while Integration grant was active. |
| Kernel capability invoke | PASS (local harness) | Signed workload token accepted; invocation routed through a local Node-proxy harness to the real Catalog service and returned an `ACCEPTED` receipt. |
| Integration → real Kernel → Catalog | PASS (local harness) | Run `E2E` resolved through `/api/v1/capabilities/data.catalog.v1/1/...`, returned `SUCCEEDED`, `accepted=2`; replaying the same idempotency key returned the same run. |
| Data OCI image build/deploy | PASS (CI) | GitHub Actions run `39825950028`: both data backend images built, pushed to a host-local registry, and deployed as OCI containers. Local Docker Desktop remained unavailable; this is a CI Linux result. |
| Real two-plugin OCI cross-node Gateway path | PASS (CI) | Run `39825950028`: two real Node runtimes enrolled; Catalog placed on `zone=node-a`, Integration on `zone=node-b`; Golden Path passed through the real Kernel Capability Gateway. |
| Data Foundation CI workflow | PASS | `.github/workflows/data-foundation.yml`, run `39767019066` (job `golden-path`). |
| Catalog/Integration browser smoke | PASS (CI) | Run `39825950028` loaded both signed remote extensions in Chromium against active OCI plugins (`2 passed`); screenshots are uploaded as the `data-foundation-screenshots` artifact. |
| 0.0.1 E2E regression | PASS (CI) | Same run, `legacy-regression` job: existing hello TS/Go/Java lifecycle, rollback and re-enable path `PASS=21 FAIL=0`. |
| Schema/quality assertions | PASS (CI) | Same run: schema revision 2 draft/publish, compatible diff, incompatible change rejection (`409`), and quality total/unknown assertions. |
| Kernel migration gate | PASS (local) | Checksum-matched EXPAND migration applied under a least-privilege plugin database role; replay returned the original record; a second list encoded the APPLIED record. CONTRACT-during-live-instances and changed-checksum rejection are implemented but not all tested. |

The local capability harness is not a substitute for the required real OCI Golden Path. No production claim is made.

### 0.0.2 branch CI

- PR `#1` (`feat/0.0.2-data-foundation`) Rust/Web/Contracts checks: **PASS** on the latest branch commit.
- `.github/workflows/data-foundation.yml` run [`39825950028`](https://github.com/baicie/ops-1/actions/runs/39825950028): **PASS** on Linux with Docker, real PostgreSQL, two Node runtimes, real OCI data plugin containers, Chromium smoke tests for both signed extensions, and the 0.0.1 E2E regression (`PASS=21 FAIL=0`).
- Local Docker Desktop remained unavailable; local-only OCI deployment is `NOT_RUN`. The CI result is not a production deployment.

## 0.0.2 Review Remediation

### P0 authorization

- Both data plugin servers now derive user scopes only from the authenticated role:
  `viewer` gets read-only scopes, `operator`/`admin` get write scopes, and unknown
  roles get an empty scope. `hasScope()` no longer treats `kind === 'user'` as a
  wildcard.
- Real Kernel Gateway CI run `39825950028` (`golden-path` success) exercised:
  - Viewer dataset create `403`;
  - Viewer schema publish `403`;
  - Viewer source create `403`;
  - Viewer ingestion run `403`;
  - Viewer dataset read `200`;
  - Operator dataset/source/spec/run legal path `SUCCEEDED`.
- Evidence is emitted by `tests/acceptance/data_authz.sh`.

### P0 SSRF

- Integration now parses IPv6 bytes and classifies IPv4-mapped addresses in both
  dotted and hexadecimal forms, plus IPv4 special ranges, IPv6 ULA, link-local,
  loopback, multicast, documentation, Teredo, 6to4 and other non-global ranges.
- Real Gateway/Connector CI run `39825950028` blocked all nine tested targets with
  `422 SOURCE_SSRF_BLOCKED`:
  `127.0.0.1`, `::ffff:7f00:1`, `::ffff:a9fe:a9fe`, `::1`, `fc00::1`,
  `fe80::1`, `169.254.169.254`, `10.0.0.1`, `198.51.100.1`.
- Evidence is emitted by `tests/acceptance/data_ssrf.sh`.

### P1 migration ledger atomicity

- `apply_migration()` now takes a per-plugin PostgreSQL advisory transaction lock,
  writes `PENDING` and `APPLIED` in the same transaction as the migration SQL, and
  resets the plugin role before writing the ledger. Failure rolls back DDL and the
  pending row, then records `FAILED`.
- Local test on `opsweave_data_test` against Kernel `127.0.0.1:18183`:
  - SQL that created a table then failed returned `409 MIGRATION_FAILED`;
  - the table was absent and ledger row was `FAILED`;
  - a successful migration returned `APPLIED`;
  - replay returned `APPLIED` with `replay=true`.
- The test used a development PostgreSQL database and was not run in the OCI CI
  workflow. Signed package migration-plan validation remains `NOT_RUN`; the current
  gate validates the SQL checksum supplied with the request.

### P1 provider binding

- Grant provider binding is enforced during invocation with
  `CAPABILITY_PROVIDER_MISMATCH`; predicate unit test passes.
- A real multi-provider selection/switch test remains `NOT_RUN`.

### P1 workload identity

- Workload claims now include `instanceId`, `nodeId` and `nodeGeneration`; invocation
  requires a live READY instance on a non-revoked, non-stale READY node with matching
  generation and `plugin:<capability>` audience.
- Unit test covers inactive instance, revoked node, generation mismatch and stale
  node. Real CI Golden Path proves newly issued tokens still work.
- `refresh_workload_token()` accepts an expired token only inside a bounded grace
  window, re-checks live instance/node/generation, active grant and scope, and issues
  a fresh token. Integration refreshes before the 60-second threshold.
- CI run `39825950028` used a **5 second token TTL and 1 second grace**, waited
  beyond `TTL + grace` without any Catalog call, then executed an ingestion run;
  it passed (`expired workload token refreshed; run status=SUCCEEDED`).
- Node runtime now maintains a **mounted capability-token file** and refreshes it
  through the Node-authenticated `instance_environment` endpoint even when the
  plugin is idle. The plugin reads that file before using its startup env token.
  A short Kernel outage was injected with SIGSTOP/SIGCONT and the subsequent run
  still succeeded (`PASS Kernel outage injected and resumed`).
- The same run extracted the current token from the mounted file, refreshed it,
  revoked the Integration Node through the real Kernel API, then verified both
  refresh and a capability invocation returned `403 WORKLOAD_IDENTITY_REVOKED`.
  This is a real Gateway/Node revocation test, not only a predicate unit test.

### Migration APPLIED race protection

- `record_failed_migration()` now uses `ON CONFLICT ... DO UPDATE ... WHERE
  kernel.plugin_migrations.status <> 'APPLIED'`, so a late failure cannot overwrite
  a committed successful ledger row.
- Local SQL check on `opsweave_data_test`: inserted an `APPLIED` row, applied the
  same late `FAILED` upsert, and observed the row remain `APPLIED` with empty details.
  Reproducer: `tests/acceptance/storage_migration_ledger.sh`; result `PASS`.
- Reproducer: `tests/acceptance/storage_migration_ledger.sh`; result `PASS`.
- A true two-request interleaving test that controls A-fails/B-succeeds timing is
  `NOT_RUN`; the ordering predicate is covered, not the full scheduling race.


## 2026-10-23 Overnight Finalization

- Final branch HEAD before this report: `33c5058`.
- Standard CI [`39825950061`](https://github.com/baicie/ops-1/actions/runs/39825950061): success.
- Data Foundation OCI CI [`39825950028`](https://github.com/baicie/ops-1/actions/runs/39825950028): `golden-path` and `legacy-regression` success.
- Multi-provider real API test: PASS. Grant bound to A reached A; natural selection of B while bound to A returned `403 CAPABILITY_PROVIDER_MISMATCH` and wrote audit; unbounded grant reached B; revoke/restore were immediate; no-provider resolve failed closed.
- Migration concurrency real HTTP test: PASS. A failed, B applied once, late failure did not overwrite APPLIED; replay, checksum mismatch and CONTRACT live-instance checks passed.
- Token file security: PASS. Mode 644, no cross-instance token, no Node control credential in plugin env, no token in an unauthenticated response.
- Full UI business flow: PASS (4 Playwright tests). Catalog create/Draft/Diff/Publish/Records/refresh persistence and Integration create/Test/Discover/Preview/Mapping/Run/Quality/Lineage passed.
- Screenshot matrix: PASS. 1440x900, 1024x768 and 390x844, light/dark, both extensions; artifact `data-foundation-screenshots` from run `39825950028`.
- D06 bounded reliability: PARTIAL. Retention policy visibility, catalog batch idempotency, changed-content rejection, schema revision rejection and record count passed. UNKNOWN/catalog timeout, retention enforcement, Kernel restart recovery and full fault injection remain `NOT_RUN`.
- 0.0.1 E2E regression: PASS, `PASS=21 FAIL=0`.
