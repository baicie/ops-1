# Implementation status — OpsWeave 0.0.1

Updated: 2026-10-22 (Asia/Shanghai)

This file separates three things that must never be conflated: **implemented code**, **tests actually run**, and **design claims**. Entries not executed on real hardware are `NOT_RUN`, even when local simulations pass.

## Environment used for the evidence below

| Item | Value |
|---|---|
| Host | macOS 15.7.7, Apple M1, arm64 (development host) |
| Kernel | Rust 1.96.0, Axum 0.8, Tokio, SQLx 0.8 |
| Database | PostgreSQL 17.10 (Homebrew, localhost) |
| Container engine | Docker Desktop 29.7.2, linux/aarch64 containers |
| Registry | `registry:2` at `127.0.0.1:5001` |
| Node runtimes | two `opsweave-node` processes, data ports 9101/9102, same Docker daemon |
| Plugins | TypeScript/Node 22, Go 1.25, Java 21.0.13+9 Spring Boot 3.3.5 |

The production reference target is **Linux amd64 + Rootless Docker + three physical hosts**. That target was not available and is **NOT_RUN**.

## Epic status (plan/01-001)

| Epic | Status | What was actually built / tested |
|---|---|---|
| E00 Project Bootstrap | DONE (local) | Cargo + pnpm workspaces, lockfiles, Makefile, CI definition, contract checker, local compose, systemd units. Remote CI run `39736068436` passed Rust, Web and Contracts jobs on commit `ca56462`; full E2E remains local. |
| E01 Contract Foundation | DONE | Manifest v1.1, runtime info, deployment, node observation, log event, asset index schemas; generated examples validated with `jsonschema`; bundles recomputed and checked. |
| E02 Identity & Trust | PARTIAL | Argon2id users, admin/operator/viewer RBAC, CSRF, session cookie/bearer, publisher trust/revocation, one-time node enrollment, node revocation, audit. **mTLS NOT_RUN**. |
| E03 Registry & Lifecycle | DONE (local) | Immutable bundles with digest conflict rejection, Ed25519 signature (artifact + canonical manifest), stage/deploy/activate/disable/enable/upgrade/rollback/uninstall, receipts, audit. |
| E04 Single-node OCI Host | DONE (local) | Node heartbeat, digest-only Docker pull, container creation with limits, health probes, restart backoff, logs, metrics, data proxy. Rootless Docker on Linux `NOT_RUN`. |
| E05 Gateway & Capability | PARTIAL | Active-revision routing, READY+node-fresh filtering, API-prefix enforcement, timeout, GET retry, capability provides/requires validation. Named logical capability dispatch endpoint not implemented. |
| E06 Web Shell SDK | DONE (local) | React Shell, UMD remote loader with host React, nav/route/settings contributions, error boundary, reserved-route rejection, design tokens, responsive/dark themes. Cleanup/unmount SDK contract not implemented. |
| E07 Reconciler & Placement | DONE (local) | Desired/observed/effective separation, generation-aware observations, two-node placement, stale→UNREACHABLE, replacement slots, readiness-gated activation. Two **physical Linux** nodes `NOT_RUN`. |
| E08 Ops Center & Diagnostics | DONE (local) | Ops Center screens, node/instance metrics, log SSE with signed cursors, audit UI, recovery CLI, server-rendered `/bootstrap`. Historical log search out of scope. |
| E09 Full-stack Hello + v2 | PARTIAL | TS full-stack v1/v2 with independent image digests, signed bundles, permission diff review display, upgrade/rollback tests. Bad-image pull case not exercised; Java full-stack UI not delivered. |
| E10 Verification & Release | PARTIAL | Contract, runtime conformance, two-node failover, kernel restart, container security, Playwright visual tests. Remote CI now runs workspace tests/clippy/typechecks; real three-host acceptance and vulnerability scanning `NOT_RUN`. |

## Gate 1–4 / conformance matrix

| Test | Status | Evidence |
|---|---|---|
| C01 Java Spring Boot Fullstack v1, page/API visible | **PARTIAL** | Java 21 Spring Boot **backend** runs in OCI and serves Runtime v1 + `/api/hello`; no Java frontend remote. |
| C02 Go backend on Runtime v1 | **PASS (local)** | `tests/contract/run_conformance.sh`; Go 1.25 static image; gateway response. |
| C03 TS/Node Fullstack v1 and independent upgrade | **PASS (local)** | v1/v2 image digests differ; bundle signatures validate; upgrade/rollback E2E. |
| C04 Node A/B same image digest, two replicas | **PASS (local simulation)** | two node processes, same `hello-ts` OCI digest `sha256:6da03a97...`, 2 READY slots. Physical machines `NOT_RUN`. |
| C05 Close Node A, B continues; no permanent bad route | **PASS (local)** | `tests/acceptance/two_node_failover.sh`; Gateway retries GET to Node B; A becomes UNREACHABLE. |
| C06 Tampered/unsigned/digest-mismatch package rejected | **PARTIAL** | tampered manifest signature rejected with `SIGNATURE_OR_BUNDLE_INVALID`; version conflict rejected. OCI image **signature** verification not implemented; digest pull is enforced. |
| C07 Expired/revoked node credential rejected | **PASS (local)** | `node_revocation.sh`: unsafe endpoint 400, heartbeat 200 before revoke, 403 after; `node_quarantine.sh` proves live managed containers are removed. Token expiry/rotation and mTLS remain `NOT_RUN`. |
| C08 Resource quotas and host socket/hostPath/privileged denied | **PASS (local)** | `tests/acceptance/container_security.sh` inspects live containers: read-only, cap-drop ALL, no-new-privileges, forced UID 65532, actual `id -u` non-zero, memory/cpu/PID, no binds, loopback ports. |
| C09 Old browser tab across v1→v2 release | **NOT_RUN** | No compatibility-window or forced-reload protocol implemented; old tab gets CAPABILITY_UNAVAILABLE after drain. |
| C10 Incompatible DB migration blocks rollback | **NOT_IMPLEMENTED** | No migration engine in 0.0.1; rollback is route/binary only; must be blocked manually by policy. |
| C11 Kernel restart reconciles PG + observed state | **PASS (local)** | `tests/acceptance/kernel_restart.sh`; active version preserved, Gateway serves after restart. |
| C12 SSE auth, disconnect, cursor gap, backpressure, revoke | **PARTIAL** | operator-only SSE, forged cursor 400, signed cursors, gap events, disconnect UI, per-poll revocation check, endpoint-policy reuse and idle backoff; explicit flood/backpressure test `NOT_RUN`. |
| C13 Node Runtime exit/upgrade workload policy | **PARTIAL** | Graceful exit stops workloads by default; lease expiry and credential rejection enter quarantine and remove containers (`node_lease.sh`, `node_quarantine.sh`); restart re-adopts desired containers. The systemd unit includes an `ExecStopPost` cleanup safety net for crash/SIGKILL service stops; native SIGKILL still cannot run application code, so host/service supervision remains mandatory. |
| C14 390/1024/1440 light/dark screenshots | **PASS (local)** | Playwright matrix in `tests/ui/visual.spec.ts`; images under `artifacts/ui/`. |

## Review remediation (2026-10-22)

The first external review identified node revocation/lease, data-endpoint/SSRF, enrollment-token race, publisher-revocation, login throttling, non-root enforcement, SSE revocation, CI and capacity-scheduling gaps. Implemented in this pass: atomic `FOR UPDATE` + conditional token consumption; node lease/quarantine and container stop; rotated data token on revoke; allowlisted origin-only data endpoints with loopback-only plaintext; publisher trust re-check and fail-closed Gateway/assets/extensions; login rate limiting and tiered body limits; forced non-root container UID; SSE per-poll authorization; path traversal/response-size bounds; basic CPU/memory reservation scheduling; CI pnpm version fix plus workspace tests/clippy/typechecks. New tests: `node_quarantine.sh`, `node_lease.sh`, `auth_limits.sh`, `endpoint_policy.sh`, path/capacity/cleanup/IP-key unit tests, and strengthened `node_revocation.sh` / `container_security.py`.

Stage A.1 follow-up: login IP keys now use `peer.ip()` (not the ephemeral port), X-Forwarded-For is accepted only from explicitly trusted proxies, the limiter bounds/prunes buckets; quarantine cleanup propagates Docker failures, re-enumerates labels and exposes `QUARANTINE_CLEANUP_FAILED`; an independent monotonic lease watchdog quarantines even when heartbeat calls stall; SSE reuses the endpoint policy; placement re-evaluates capacity and global instance counts for every slot; the default insecure-transport flag is now `false` (demo explicitly opts in).

Stage A.1.1 follow-up: migration now transfers both `global_counts` and CPU/memory reservation to the target Node (with a unit regression test); Docker `inspect` has its own timeout; `run_once()` setup and `quarantine()` serialize through a lifecycle mutex so the final sweep waits for in-flight create/start; quarantine re-enumerates and retries actual stop/remove; the rate limiter uses a true sliding timestamp window and parses trusted-proxy chains from the trusted side.

Stage A.1.2 follow-up: STOP→START now restores per-deployment/global counts and CPU/memory reservation at the target; STOP migration never decrements an uncounted source; START migration transfers reservation in both directions. Docker `inspect`/`port_of`, `list_managed`, `is_running`, `version`, normal commands, pull and stop/remove are timeout-bounded; quarantine has a strict 45s total deadline, a 15s lifecycle-lock wait, re-enumerates/re-attempts cleanup and reports `QUARANTINE_CLEANUP_FAILED` on timeout.

Stage A.1.3.1 follow-up: deterministic retry tests now cover guarded retry success and permanent cleanup failure; the lifecycle lock timeout path is tested to make zero Docker calls. E2E gateway probes also retry through short Java readiness propagation windows. The initial attempt is bounded at 15s lock wait / 45s cleanup; a failed or unconfirmed attempt reports `QUARANTINE_CLEANUP_FAILED` and leaves managed instances in an explicit failure state. A detached retry task waits for the in-flight lifecycle operation, retries guarded stop/remove and clears the error only after an empty managed-container enumeration. Deterministic unit tests verify that a held lifecycle lock causes failure without any Docker scan.

Still **NOT_RUN / blocking**: Kernel↔Node mTLS and certificate rotation, three physical Linux amd64 hosts, real Rootless Docker, OCI image signatures/SBOM, SIGKILL host-level container cleanup, full SSE flood/backpressure testing, and Fencing Tokens for side-effecting workloads. The 25s Kernel stale threshold and 30s Node lease are not a substitute for a fencing/generation protocol; a reassignment race can still produce a short double-execution window. No production-ready claim is made.

## 0.0.2 Data Foundation (development)

Baseline: `v0.0.1-dev.1` / `4ce130b`, branch `feat/0.0.2-data-foundation`.

| Epic | Status | Evidence / limitation |
|---|---|---|
| D00 Data Capability Contract | DONE (contracts) | `contracts/openapi/{capability,data-catalog,data-integration}-v1.yaml`, capability/storage/catalog/integration JSON Schemas, examples and negative contract checks pass. |
| D01 Catalog Backend | PASS (CI) | Independent Node service and plugin-owned PostgreSQL schema tables; dataset/create/draft/publish/diff/write/idempotency verified in real OCI CI run `39892827048`. |
| D02 Catalog UI | PASS (CI) | Dynamic UMD extension; full real browser Dataset/Schema/Diff/Publish/Records flow and responsive screenshot matrix passed in CI run `39892827048`. |
| D03 Integration Backend | PASS (CI) | Independent HTTP/JSON source service with ConnectionTest, Discovery, Preview, mappings/specs/runs and SSRF negative test; real OCI CI run `39892827048`. |
| D04 Integration UI | PASS (CI) | Dynamic UMD extension; full real browser Source/Test/Discover/Preview/Mapping/Run/Quality/Lineage flow and responsive screenshot matrix passed in CI run `39892827048`. |
| D05 Ingestion Flow | PASS (CI) | Source→parse→map→validate→Catalog sink through the real Kernel Capability Gateway and real OCI plugin pair, run `39892827048`. |
| D06 Quality / Run History | PARTIAL | Run counts, history and batch lineage implemented; retention/quality edge cases limited. |
| D07 Integration Tests | PASS (CI) | GitHub Actions `39892827048`: two real Node runtimes, real OCI Catalog/Integration containers on distinct nodes, real Kernel Capability Gateway, multi-provider binding, migration concurrency, token-file security, full Chromium business flows, schema compatibility/quality checks, and 0.0.1 E2E `PASS=21 FAIL=0`; local Docker Desktop run remains `NOT_RUN`. |

Implemented platform increment:

- `kernel.capability_grants`, `kernel.plugin_storage_bindings`, additive migration `0002_data_foundation.sql`.
- Capability list/resolve/grant/revoke; workload token issuance; `/internal/v1/nodes/{nodeId}/instances/{instanceId}/env`; capability invoke endpoint with signed workload/caller context.
- Plugin storage binding with dedicated PostgreSQL schema/role and dev-only credential injection; no credential returned by APIs.
- Disable dependency protection for active capability consumers.
- Node runtime fetches workload env before container create and passes it as Docker env; old Kernel without the endpoint remains compatible for 0.0.1 plugins (404 → empty env).

Local evidence is recorded in `docs/acceptance/EVIDENCE.md` under `0.0.2 Data Foundation development evidence`.

Explicit NOT_RUN for this increment: OCI image builds for the two data plugins, real Node-proxied capability calls, real cross-plugin Golden Path, schema migration execution through a Kernel migration gate, browser E2E, three-host/mTLS/Fencing. No production claim.

## Explicit non-goals (unchanged)

AI RCA, Data Catalog, general DAG engine, historical log storage/search, arbitrary third-party code, production multi-Kernel HA, GPU scheduling, NAT-transparent relay, OCI image attestation/SBOM enforcement, multi-tenant isolation.

## Deviations requiring an ADR or release block

1. **Node transport:** bearer credentials over HTTPS-capable private network; mTLS/certificate lifecycle absent. Production release blocked.
2. **OCI adapter:** Docker CLI adapter (controlled arguments) rather than a linked Engine API client. The Docker socket is not exposed to plugins; see `docs/adr/ADR-010-oci-adapter.md`.
3. **Package signature scope:** Ed25519 covers `artifactDigest` and canonical manifest digest. Image signature is separate and not implemented.
4. **Java:** runtime is Java 21 but the frontend is not shipped for Java; C01 full-stack is partial.
5. **Two-node validation:** two Node processes share one Docker daemon. This validates protocol/placement/failover semantics but is not the required three-host Linux gate.

## 0.0.2 Security Remediation (2026-10-22)

- P0 backend role-scope bypass fixed in both data plugins; real Gateway Viewer/Operator
  authorization test added (`tests/acceptance/data_authz.sh`).
- P0 IPv4-mapped IPv6 and special-address SSRF classification fixed; real Connector
  negative test added (`tests/acceptance/data_ssrf.sh`).
- P1 migration SQL and ledger are atomic under a per-plugin advisory transaction lock;
  failure/replay locally verified.
- P1 grant provider binding is enforced at invocation.
- P1 workload tokens are bound to instance, node and node generation; liveness is
  checked at invocation and expired tokens can be refreshed only inside a bounded
  grace window after re-checking live state and grant. CI verifies refresh with a
  five-second TTL (`39892827048`).
- P1 migration failure records can no longer overwrite `APPLIED`.
- Remaining NOT_RUN: signed package migration plans, real multi-provider switch test,
  true concurrent migration interleaving test, production secret management/mTLS/Fencing.

## B2.1 Plugin identity hardening (2026-11-08)

Authority: [ADR-020](adr/ADR-020-plugin-identity-hardening.md).

**Defect closed.** Both data plugins accepted the unsigned `x-opsweave-user-role`
header as the caller's role (admin/operator → read+write) and never verified the
Kernel-signed `owu1` context. Because the Gateway sent both, the signed identity
was rejected and the unsigned header was the identity on the production path.
Rule and run rows recorded the role string (`"admin"`) as `created_by` rather
than a user id.

**Implemented.** One canonical resolver (`plugins/shared/plugin-identity.mjs`,
byte-copied into each plugin backend by `scripts/sync-plugin-identity.mjs`, with a
CI `--check` gate). It verifies `owu1` / `oww1` / `owa2`, binds `owu1` to the
receiving plugin, rejects expired/future/unknown-role/user-id-less tokens, and
returns `null` with no configured key. The Gateway no longer forwards the role
header (`gateway::identity_headers`, unit-tested as an exhaustive list).
`created_by` records `userId`, `automation:<principalId>` or `workload:<pluginId>`.

**Tests actually run (local, 2026-11-08).**

| Command | Result |
|---|---|
| `node --test tests/ci/b2_plugin_identity_attack.test.mjs` (real processes + real PostgreSQL 17) | **7/7 PASS** |
| same suite against the pre-fix plugin sources | **1/7 pass, 6 fail** — the reproduction |
| `node --test plugins/zabbix-source/backend/server.test.mjs` | **25/25 PASS** (shared module is behaviour-equivalent) |
| `node --test tests/ci/g13a2_endpoint_attack.test.mjs` | **8/8 PASS** |
| `./tests/reliability/run.sh --all` (real PostgreSQL, signed contexts now) | **4/4 PASS** (FT-01, FT-02, FT-06, FT-IDEM-01) |
| `cargo test -p opsweave-kernel` against `opsweave_b2_kernel` | **262/262 PASS** |
| `cargo fmt --all -- --check` | clean |
| `python3 tests/contract/validate_contracts.py` | passed (17 schemas, 6 examples validated) |

**Status split.** Identity: **implemented and locally verified**.
Workspace scoping of plugin data: **NOT implemented** — the data tables still
have no `workspace_id`, so the *identity* is correct while the *data* remains
platform-wide. Tracked as PR-A2 and a release blocker for any multi-tenant claim.
Real Zabbix / mTLS / OCI image signature: **NOT_RUN / BLOCKED** (unchanged).

## B2.1a Data-plane workspace isolation (2026-11-08)

Authority: [ADR-020](adr/ADR-020-plugin-identity-hardening.md) section 4a.

**Defect closed.** B2.1 made identity unforgeable, but neither plugin had a
workspace dimension at all: `catalog_datasets`, `catalog_schema_revisions`,
`catalog_quality_*`, `integration_sources` and their siblings had no
`workspace_id`, and every query was global. Any authenticated caller — and any
workload token, however narrowly scoped — read every dataset and source on the
platform.

**Implemented.**

| Layer | Change |
|---|---|
| `plugins/data-catalog` | `workspace_id` NOT NULL on `catalog_datasets` (backfilled to legacy), single chokepoint on dataset detail, workspace-scoped list / governance / entity-types, `workspaceScope()` helper |
| `plugins/data-integration` | `workspace_id` NOT NULL on `integration_sources`, chokepoint on source detail, workspace-scoped sources / ingestion-runs (joined through source) |
| `apps/kernel` | migration `0034_job_workspace.sql`; `SubmitJobRequest.workspaceId` validated against membership; `resolve_job_workspace`; `caller_workspaces` threads membership into publish/validate/preview; `service_catalog_get(.., workspaces)`; worker token derives `workspace:<uuid>` from the live lease; `worker_definition` returns `workspaceId` |
| web | workspace selector on job submit and governance; both default to the caller's only workspace |

**Tests actually run (local, 2026-11-08).**

| Command | Result |
|---|---|
| `node --test tests/ci/b2_workspace_isolation.test.mjs` (real processes + real PostgreSQL 17) | **3/3 PASS** |
| same suite against the pre-fix plugin sources | **0/3 pass, 3 fail** — the reproduction |
| `node --test tests/ci/b2_plugin_identity_attack.test.mjs` | **7/7 PASS** (unchanged) |
| `cargo test -p opsweave-kernel` (real PostgreSQL, migration 0034 applied) | **263/263 PASS** |
| `cargo clippy -p opsweave-kernel -p opsweave-pipeline-worker --all-targets -- -D warnings` | clean |
| `cargo fmt --all -- --check` | clean |
| `pnpm --filter @opsweave/platform-web test` | **469/469 PASS** |
| `pnpm --filter @opsweave/platform-web build` (tsc --noEmit) | clean |
| `node scripts/check-i18n.mjs` | OK — 2046 keys, 17 unused (unchanged baseline) |
| `node scripts/check-status-vocabulary.mjs` | clean |
| `python3 tests/contract/validate_contracts.py` | passed |

**NOT_RUN.** The full data-foundation CI (real OCI containers, two Node runtimes,
pipeline worker end to end) was not executed on this host — it requires the
Docker/registry path. `tests/ci/data_foundation_ci.sh` gained the fixture grant
the new rule requires (admin → legacy workspace, through the public API) so that
run is expected to work, but this is **NOT_RUN**, not PASS. Real Zabbix, mTLS,
OCI image signature and production secrets are unchanged and remain
NOT_RUN/BLOCKED.

## B2.2 Bounded reads and concurrent dispatch (2026-11-08)

Authority: [ADR-021](adr/ADR-021-bounded-reads-and-concurrent-dispatch.md).

**Defect A (response bounds).** Six call sites buffered an upstream body with
`response.bytes().await` and compared the result against a limit afterwards; the
only earlier check was `Content-Length`, which the upstream controls. Chunked or
unstated lengths bypassed the bound entirely, and the pipeline worker had no
bound at all.

**Defect B (serial worker).** `Worker::run_auto` ran exactly one job at a time,
so one slow source request held the entire worker.

**Implemented.**

- New crate `crates/http-body-guard` (`read_bounded`): refuses a declared
  oversize length before reading, consumes chunk by chunk, fails the moment the
  bound is crossed, and bounds the gap between chunks rather than the transfer.
  Wired into the Gateway, capability invoke, automation flow, the Node data proxy
  and both worker call sites.
- `OPSWEAVE_WORKER_CONCURRENCY` (default 4) and
  `OPSWEAVE_WORKER_CONCURRENCY_PER_SOURCE` (default 1), clamped `1..=64`. The
  worker does not claim a job it cannot start.
- `GET /api/v1/diagnostics` gains a `jobs` object: backlog, inFlight, failed,
  cancelled, expiredActiveLeases, avgWaitSeconds24h, avgRunSeconds24h,
  retryRate24h — read from the dispatcher's own tables, `null` (not `0`) for an
  empty window.
- Module structure: `incidents.rs` test suite moved to `incidents_tests.rs`,
  `investigations.rs` to `investigations_tests.rs`, both via `include!` so module
  scope is unchanged. Production lines: 8603 → 3027 and 4969 → 3266.

**Tests actually run (local, 2026-11-08).**

| Command | Result |
|---|---|
| `cargo test -p opsweave-http-body-guard` | **7/7 PASS** (incl. real-socket endless chunked upstream, declared-length refusal, idle timeout) |
| `./tests/acceptance/b2_response_bounds.sh` | **2/2 PASS** (no `bytes().await` anywhere; shared suite green) |
| `cargo test -p opsweave-pipeline-worker` | **20/20 PASS** (incl. per-source gate and clamp tests) |
| `cargo test -p opsweave-kernel` (real PostgreSQL) | **264/264 PASS** |
| `cargo test --workspace` (real PostgreSQL) | all suites green |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` | clean |
| `cargo fmt --all -- --check` | clean |

**NOT_RUN.** No throughput benchmark was run. The concurrency change is verified
correct, not measured faster; the defaults are conservative starting points, not
tuned values. Multi-worker takeover under the new dispatcher was exercised only
by the pre-existing unit suite, not by a live two-worker run.

**Not done in this phase.** Splitting `incidents.rs` / `investigations.rs`
*production* code by state machine / persistence / API was deliberately left out:
it would rewrite the modules whose behaviour B2.1 and B2.1a just changed, and
AGENTS.md forbids doing that inside the same change.
