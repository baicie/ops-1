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

## G14.2 Two independent front-end applications (2026-11-09)

Authority: [ADR-022](adr/ADR-022-platform-core-and-applications.md) §2.7 and the
G14.2 implementation note.

**Defect closed.** `apps/platform-web` was one Vite bundle with two route trees
(`/admin/*`, `/app/*`) sharing one router. "Two surfaces" could not fail
independently, deploy independently, or keep one application's domain types out
of the other.

**Structure now.**

| Path | Contains | Must not import |
|---|---|---|
| `packages/ui` | shadcn primitives, icons, `styles.css`, shared presentational components | any application |
| `packages/platform-client` | HTTP client, contract types, i18n catalogs, access model, `useBusinessWorkspaces` | any application |
| `apps/platform-console` | platform routes only, `basename="/console"` | `apps/ops-web` |
| `apps/ops-web` | workspace routes only, `basename="/app"` | `apps/platform-console` |

`apps/platform-web` is deleted, not kept as a third entry: an entry that renders
both surfaces would restore the property being removed.

**Cross-application type leakage fixed.** `types.ts` was split: platform/pipeline
types stay in `packages/platform-client/src/contracts.ts`, Incident/Evidence/
Verdict types move to `apps/ops-web/src/types.ops.ts`. The console cannot import
an Incident type. `BusinessWorkspace` moved the other way — into Core — because
membership is a platform concept both applications need.

**Kernel serving.** `StaticSite` gained optional mounts; `/app` resolves inside
the ops bundle and answers with its own `index.html`. `OPSWEAVE_OPS_WEB_DIST` is
optional so an installation that has not adopted the split is unchanged.

**Gates moved with the code** (none relaxed): i18n (five source roots, 2046 keys,
17 unused — unchanged), status vocabulary, UI token ratchet (pass, zero debt),
CSS reachability (scan roots extended), and a generated `exports` map for both
packages checked by `scripts/sync-package-exports.mjs --check`.

**Tests actually run (local, 2026-11-09).**

| Command | Result |
|---|---|
| `pnpm --filter @opsweave/ui test` | **58/58 PASS** |
| `pnpm --filter @opsweave/platform-client test` | **113/113 PASS** |
| `pnpm --filter @opsweave/platform-console test` | **62/62 PASS** |
| `pnpm --filter @opsweave/ops-web test` | **236/236 PASS** |
| `pnpm --filter @opsweave/platform-console build` | succeeds |
| `pnpm --filter @opsweave/ops-web build` | succeeds |
| **build independence**: break `ops-web`, then build console | console still **exit 0** |
| `cargo test -p opsweave-kernel` (real PostgreSQL) | **265/265 PASS** (incl. new two-shell test) |
| `cargo clippy -p opsweave-kernel --all-targets -- -D warnings` | clean |
| `cargo fmt --all -- --check` | clean |
| `node scripts/check-i18n.mjs` / `check-status-vocabulary.mjs` / `check-ui-tokens.mjs` / `sync-package-exports.mjs --check` | all pass |

**NOT_RUN.** The Playwright suite was not executed (it needs a live Kernel with
both bundles served and a browser). Its spec paths were updated to the new
locations, but "paths updated" is not "tests passed" — status **NOT_RUN**.

**Not done in G14.2.** Separate origins, Application-scoped authorization, and
the OIDC bridge are G14.3. Nothing yet *enforces* that a caller of the ops
application holds the ops grant; the existing surface gate is unchanged.

## G14.2 cleanup and the console route regression (2026-11-09)

Authority: [ADR-022](adr/ADR-022-platform-core-and-applications.md), [rules/11](../rules/11-refactor-retirement-and-cleanup.md).

The split (`461d4da`) moved the code but left references to the deleted path and, in
two gates, left checks that pass while reading nothing. Rules 11 now requires the
three completion criteria below, and `tests/ci/check-retired-paths.mjs` enforces the
first of them in CI.

**Fixed — live references to retired identifiers (was 15, now 0).**

| File | Was | Now |
|---|---|---|
| `tests/ci/g12_acceptance_ci.sh` | built `@opsweave/platform-web` (exit 0, zero bundles), served its dist | builds both apps with `--fail-if-no-match`; sets `OPSWEAVE_OPS_WEB_DIST` |
| `tests/ci/data_foundation_ci.sh` | same silent no-op build | both apps, `--fail-if-no-match` |
| `tests/runtime/start_kernel.sh` | `OPSWEAVE_WEB_DIST=apps/platform-web/dist` | console dist + `OPSWEAVE_OPS_WEB_DIST` |
| `tests/acceptance/kernel_restart.sh` | same | same |
| `tests/acceptance/g12_evidence_content.sh` | X3 grep scanned the deleted tree | scans both apps and `packages`, and no longer dies at the assignment |
| `tests/ci/g13a1_gateway_e2e.sh` | hand-run instructions named the deleted package | names `@opsweave/platform-console` |
| `scripts/check-i18n.mjs` | stale comment; missing root silently filtered out | comment fixed; missing root now **fails** |
| `packages/ui/src/code-rules.test.ts` | A5 scanned `pages/`, which no longer exists | scans page modules of both apps |
| `README.md`, `rules/06-ui-ux.md` | described the deleted app | describe the two apps and two packages |

**Fixed — gates that passed without reading anything.**

- **`pnpm --filter <missing> build` exits 0** (measured on pnpm 10.34.3). Four
  harnesses built zero bundles and reported success. `--fail-if-no-match` exits 1
  on no match and 0 on a real match (both measured).
- **`X="$(grep ... | wc -l)"` under `set -euo pipefail` aborts at the assignment**
  when grep matches nothing (measured: exit 1 with zero matches), so X3 never ran.
- **A5 scanned 0 of 113 files.** Pages moved from `pages/` to each app's top level,
  so the directory test matched nothing. Restored to 47 page modules; a deliberately
  injected write-response in `Incidents.tsx` now fails it (measured).
- **The shared source map silently overwrote duplicate keys** `App.tsx`, `main.tsx`
  and `index.ts`, so the console's `App.tsx` was never scanned. Keys are now
  repo-relative and a collision fails the suite.

**Defect found, NOT fixed — the Platform Console's in-app navigation is broken.**

`apps/platform-console/src/App.tsx` mounts `basename="/console"`, but every
destination it navigates to is still written as `/admin/*` (`AdminNavigation.ts`,
`Overview.tsx`, `Settings.tsx`, ...), and the route tree declares `overview`,
`plugins`, ... under the basename with no `/admin` segment.

| Probe (real render, jsdom, react-router 7.18.4) | Result |
|---|---|
| URL `/console/` | redirects to `/console/overview`, renders **OK** |
| URL `/console/overview` | renders **OK** |
| `<Link to="/admin/plugins">` under `basename="/console"` | href = **`/console/admin/plugins`** |
| does `/console/admin/plugins` match a declared route? | **no** (renders `/console/` → NotFound) |
| URL `/admin/overview` | **renders nothing** (basename mismatch) |

Before the split the router had **no basename** and declared `<Route path="/admin">`,
so `/admin/*` worked. `461d4da` introduced the basename without rewriting the
targets. Consequence: reaching the console and the console's Overview work; **every
sidebar and in-page link then leaves the route tree**. `ops-web` is internally
consistent (`basename="/app"` with `home`, `incidents`, ... and
`SURFACE_HOME.workspace = /app/home`); only `admin` is affected.

Not fixed here because the repair is a routing/ownership decision for G14.3
(prefix the route tree with `/admin` under the `/console` basename, or move the
targets to the basename and keep `/admin` as an alias), and the `/admin` spelling is
what 33 Playwright specs navigate to. Recorded so it cannot be mistaken for working.

**Tests actually run (local, 2026-11-09).**

| Command | Result |
|---|---|
| `pnpm --filter @opsweave/ui test` | **58/58 PASS** |
| `node scripts/check-i18n.mjs` | OK — 2046 keys, 17 unused (baseline unchanged) |
| `node scripts/check-status-vocabulary.mjs` / `check-ui-tokens.mjs --ratchet` / `sync-package-exports.mjs --check` | all pass |
| `node tests/ci/check-retired-paths.mjs` | 939 files scanned, 0 references |
| that check with a reintroduced reference | **exit 1**, names `README.md` |
| `check-i18n` with `packages/ui` renamed away | **exit 1**, refuses to scan |
| `bash -n` on the six edited shell scripts | all OK |

**NOT_RUN.** No Playwright browser run: the console route defect above means a
browser run would fail for that reason, not for the cleanup. No full
g12/data-foundation harness run (both need Docker, PostgreSQL and a kernel).

## G14.3 Application-scoped authorization (2026-11-09)

Authority: [ADR-022](adr/ADR-022-platform-core-and-applications.md) §2.2, §2.5 and the
G14.3 implementation note.

**Defect closed.** `access.allowedSurfaces` was a navigation declaration with no
server enforcement. "The ops application is installed" and "this account may use
it" were the same statement: any authenticated session could call
`/api/v1/incidents` and be filtered only by workspace membership. A platform
administrator was therefore an implicit operator of every business application.

**Implemented.**

| Piece | What it does |
|---|---|
| `kernel.applications` (0035) | registry: id, display name, surface prefix, required surfaces, enabled |
| `kernel.application_grants` (0035) | per-user grant with an explicit verb list; empty = "may open", no verbs |
| `/api/v1/apps/opsweave.ops/*` | separate router behind `require_ops_application`; `403 APPLICATION_FORBIDDEN` without a grant |
| `/api/v1/applications` | what this caller may open, and what it may not |
| `GET /api/v1/auth/me` | additive `applications` block |

The migration is behaviour-preserving: the console application goes to the set
the existing admin-surface predicate already covered; the ops application goes to
every existing workspace member plus pre-existing admins (who could already reach
`/app` and read nothing). Nobody gains access; accounts created afterwards start
with none until granted.

Legacy `/api/v1/incidents/*` keeps its original gate, per ADR-022 §2.6.

**Tests actually run (local, 2026-11-09).**

| Command | Result |
|---|---|
| `cargo test -p opsweave-kernel` (real PostgreSQL, migrations 0034+0035) | **270/270 PASS** |
| `cargo clippy -p opsweave-kernel --all-targets -- -D warnings` | clean |
| `cargo fmt --all -- --check` | clean |

Two of the 270 are the ruling stated as a test:
`an_admin_role_does_not_imply_an_application_grant` (admin refused without a
grant, admitted with one, verb list enforced, revocation effective on the next
call) and `a_disabled_application_is_refused_even_with_a_grant`.

**NOT_RUN / not done.**
- Separate origins and the OIDC Authorization Code + PKCE bridge (§2.7) are not
  implemented. Both applications are still served from one origin, so the cookie
  session continues to work; the single-origin reverse-proxy bridge remains the
  documented interim behaviour.
- The Ops Web client does not yet consult the `applications` block to hide
  entries it cannot use. The server refuses them, so this is a UX gap, not an
  authorization hole — but it is a gap and is not claimed as done.
- No browser run of the two applications against the new gate (Playwright
  **NOT_RUN**, unchanged from G14.2).

## G14.4 Ops observability product closure (2026-11-09)

Authority: [ADR-022](adr/ADR-022-platform-core-and-applications.md) §2.2, §2.5.

**Defect closed — and it was an authorization gap, not a boolean.** The task named
`observability` and `sources` as "pages implemented, still `shipped=false`". The
reason was real and is the reason neither could simply be flipped:

- `Observability` read `GET /api/v1/nodes`, the **platform console's** view. It
  carries `dataEndpoint`, `labels`, `capabilities` and the runtime adapter
  version, and its gate is "any authenticated session" — so an operator without
  platform rights would have seen 403s, and the sessions that did get data would
  have been reading platform inventory from the ops application.
- `Sources` reads `/api/v1/plugins`, `/api/v1/capability-grants` and
  `/api/v1/publishers`. Every one is a platform API, for the same reasons.

**Implemented.**

| Piece | What it does |
|---|---|
| `apps/kernel/src/ops_observability.rs` | `GET /api/v1/apps/opsweave.ops/observability/fleet`, behind the ops application grant, projecting only id, name, status, last-seen, staleness, ready/total instances and the resource sample |
| fleet payload | carries `covers` and `doesNotCover` so the page states what it is NOT (APM, traces, log search, service maps) instead of implying it is a unified observability platform |
| `FleetNode` / `FleetResponse` | the ops model no longer imports `NodeView`; a page cannot start rendering a node endpoint by accident |
| `observability` capability | `shipped: true`, with copy that says "node health only" and lists what is missing |

`revoked` stays in `entityState` even though the fleet endpoint filters revoked
nodes out: the rule is the model's, not the endpoint's, and its tests were updated
to drive it through `status` rather than the removed `revokedAt` field.

**`sources` remains `shipped: false`, deliberately.** Flipping it would be the
substitution the brief forbids: the page renders and `pnpm build` passes, but a
workspace operator gets 403s and the sessions that do get data read platform
inventory from the ops application. It needs a workspace-scoped source-registry
endpoint first. The reason is now written at the registry row and in both E2E
assertions rather than left to be rediscovered.

**Tests actually run (local, 2026-11-09).**

| Command | Result |
|---|---|
| `cargo test -p opsweave-kernel` (real PostgreSQL) | **272/272 PASS** (incl. the projection test asserting no `dataEndpoint`/`labels`/`capabilities` leaks) |
| `cargo clippy -p opsweave-kernel --all-targets -- -D warnings` | clean |
| `cargo fmt --all -- --check` | clean |
| `pnpm --filter @opsweave/ops-web test` | **236/236 PASS** |
| `pnpm --filter @opsweave/ops-web build` | succeeds |
| ops-web / platform-console / ui / platform-client tests | 236 / 62 / 58 / 113 PASS |
| `check-i18n` / `check-status-vocabulary` / `check-ui-tokens` / `check-retired-paths` | all pass (2047 keys, 0 retired refs across 942 files) |

**E2E assertions updated with the fact, not around it.** Both specs that assert
the not-shipped count moved 5 → 4, and their comments now say why observability
was allowed to move and why sources was not. An assertion whose number changes
without its reason changing is how a registry stops meaning anything.

**NOT_RUN.** Playwright itself was not executed — the specs' assertions and paths
were updated, but "the assertion compiles" is not "the browser passed".

**Not done.** The Investigation panel already covers start / status / provider /
tool calls / hypothesis / evidence citation / human review / TEST_FIXTURE
labelling and is unchanged by this phase; no new product behaviour was added
there. Pipeline definitions are still not workspace-owned (G14.1 §4a).

## G14 phase closure (2026-11-09)

Full report: [g14-platform-app-migration-report.md](acceptance/g14-platform-app-migration-report.md).

**Delivered across six stacked PRs** (#65–#70): plugin identity hardening, data-plane
workspace isolation, bounded reads and concurrent dispatch, the Core/application
boundary ADR, two independent front-end applications, and application-scoped
authorization with an ops-owned fleet read.

**Verified locally:** kernel 274/274 against real PostgreSQL; ui/platform-client/
console/ops-web 58/113/62/236; both applications build and their builds are
independent (breaking ops-web leaves the console build exiting 0); the B2.1 attack
suite 7/7 (1/7 pre-fix); the B2.1a isolation suite 3/3 (0/3 pre-fix); the bounded
reader 7/7 including an endless chunked upstream over a real socket; contracts,
spec-coverage, PNG budget, i18n, status vocabulary, UI tokens and retired paths all
pass.

**NOT correctly verified — do not read this as ready:**

- **Playwright was never executed locally.** Spec paths and assertions were updated
  and the kernel routing has unit tests, but no browser run happened here.
- **CI state was unconfirmed at the time of writing**; several rounds of failures
  were fixed and the last push had not completed.
- **staging core-tier and full-tier were not recorded separately** in this phase.
- **No throughput benchmark**: the worker concurrency change is verified correct,
  not measured faster.

**Production conditions unchanged from the baseline:** mTLS, OCI image signature
verification, real Zabbix, three physical Linux hosts, production secret
management and OIDC across origins are all still NOT_RUN / NOT_IMPLEMENTED.

**Structural gaps left on purpose**, each with a reason in the report or ADR-022:
seven of the eight measured `Core → ops` dependency edges, pipeline definitions
not being workspace-owned, `sources` still reading platform APIs, the Ops Web not
yet hiding ungranted applications, `incidents.rs`/`investigations.rs` production
code not split, and the legacy `/api/v1/incidents/*` aliases.
