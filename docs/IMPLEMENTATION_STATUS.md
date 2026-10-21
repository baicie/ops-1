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
| Plugins | TypeScript/Node 22, Go 1.25, Java 21.0.12.1 Spring Boot 3.3.5 |

The production reference target is **Linux amd64 + Rootless Docker + three physical hosts**. That target was not available and is **NOT_RUN**.

## Epic status (plan/01-001)

| Epic | Status | What was actually built / tested |
|---|---|---|
| E00 Project Bootstrap | DONE (local) | Cargo + pnpm workspaces, lockfiles, Makefile, CI definition, contract checker, local compose, systemd units. Clean-checkout CI was not executed on a remote runner (`NOT_RUN`). |
| E01 Contract Foundation | DONE | Manifest v1.1, runtime info, deployment, node observation, log event, asset index schemas; generated examples validated with `jsonschema`; bundles recomputed and checked. |
| E02 Identity & Trust | PARTIAL | Argon2id users, admin/operator/viewer RBAC, CSRF, session cookie/bearer, publisher trust/revocation, one-time node enrollment, node revocation, audit. **mTLS NOT_RUN**. |
| E03 Registry & Lifecycle | DONE (local) | Immutable bundles with digest conflict rejection, Ed25519 signature (artifact + canonical manifest), stage/deploy/activate/disable/enable/upgrade/rollback/uninstall, receipts, audit. |
| E04 Single-node OCI Host | DONE (local) | Node heartbeat, digest-only Docker pull, container creation with limits, health probes, restart backoff, logs, metrics, data proxy. Rootless Docker on Linux `NOT_RUN`. |
| E05 Gateway & Capability | PARTIAL | Active-revision routing, READY+node-fresh filtering, API-prefix enforcement, timeout, GET retry, capability provides/requires validation. Named logical capability dispatch endpoint not implemented. |
| E06 Web Shell SDK | DONE (local) | React Shell, UMD remote loader with host React, nav/route/settings contributions, error boundary, reserved-route rejection, design tokens, responsive/dark themes. Cleanup/unmount SDK contract not implemented. |
| E07 Reconciler & Placement | DONE (local) | Desired/observed/effective separation, generation-aware observations, two-node placement, stale→UNREACHABLE, replacement slots, readiness-gated activation. Two **physical Linux** nodes `NOT_RUN`. |
| E08 Ops Center & Diagnostics | DONE (local) | Ops Center screens, node/instance metrics, log SSE with signed cursors, audit UI, recovery CLI, server-rendered `/bootstrap`. Historical log search out of scope. |
| E09 Full-stack Hello + v2 | PARTIAL | TS full-stack v1/v2 with independent image digests, signed bundles, permission diff review display, upgrade/rollback tests. Bad-image pull case not exercised; Java full-stack UI not delivered. |
| E10 Verification & Release | PARTIAL | Contract, runtime conformance, two-node failover, kernel restart, container security, Playwright visual tests. Real three-host acceptance and vulnerability scanning `NOT_RUN`. |

## Gate 1–4 / conformance matrix

| Test | Status | Evidence |
|---|---|---|
| C01 Java Spring Boot Fullstack v1, page/API visible | **PARTIAL** | Java 21 Spring Boot **backend** runs in OCI and serves Runtime v1 + `/api/hello`; no Java frontend remote. |
| C02 Go backend on Runtime v1 | **PASS (local)** | `tests/contract/run_conformance.sh`; Go 1.25 static image; gateway response. |
| C03 TS/Node Fullstack v1 and independent upgrade | **PASS (local)** | v1/v2 image digests differ; bundle signatures validate; upgrade/rollback E2E. |
| C04 Node A/B same image digest, two replicas | **PASS (local simulation)** | two node processes, same OCI digest `sha256:11f0315e...`, 2 READY slots. Physical machines `NOT_RUN`. |
| C05 Close Node A, B continues; no permanent bad route | **PASS (local)** | `tests/acceptance/two_node_failover.sh`; Gateway retries GET to Node B; A becomes UNREACHABLE. |
| C06 Tampered/unsigned/digest-mismatch package rejected | **PARTIAL** | tampered manifest signature rejected with `SIGNATURE_OR_BUNDLE_INVALID`; version conflict rejected. OCI image **signature** verification not implemented; digest pull is enforced. |
| C07 Expired/revoked node credential rejected | **PARTIAL** | revoke endpoint + heartbeat token check implemented; expiry/rotation not implemented; mTLS `NOT_RUN`. |
| C08 Resource quotas and host socket/hostPath/privileged denied | **PASS (local)** | `tests/acceptance/container_security.sh` inspects live containers: read-only, cap-drop ALL, no-new-privileges, memory/cpu/PID, no binds, loopback ports. |
| C09 Old browser tab across v1→v2 release | **NOT_RUN** | No compatibility-window or forced-reload protocol implemented; old tab gets CAPABILITY_UNAVAILABLE after drain. |
| C10 Incompatible DB migration blocks rollback | **NOT_IMPLEMENTED** | No migration engine in 0.0.1; rollback is route/binary only; must be blocked manually by policy. |
| C11 Kernel restart reconciles PG + observed state | **PASS (local)** | `tests/acceptance/kernel_restart.sh`; active version preserved, Gateway serves after restart. |
| C12 SSE auth, disconnect, cursor gap, backpressure, revoke | **PARTIAL** | operator-only SSE, forged cursor 400, signed cursors, gap events, disconnect UI; explicit backpressure/flood and revoke-mid-stream tests `NOT_RUN`. |
| C13 Node Runtime exit/upgrade workload policy | **PARTIAL** | Node leaves containers running on exit and re-adopts; failover test kills Node A and recovers. Systemd upgrade procedure is documented only. |
| C14 390/1024/1440 light/dark screenshots | **PASS (local)** | Playwright matrix in `tests/ui/visual.spec.ts`; images under `artifacts/ui/`. |

## Explicit non-goals (unchanged)

AI RCA, Data Catalog, general DAG engine, historical log storage/search, arbitrary third-party code, production multi-Kernel HA, GPU scheduling, NAT-transparent relay, OCI image attestation/SBOM enforcement, multi-tenant isolation.

## Deviations requiring an ADR or release block

1. **Node transport:** bearer credentials over HTTPS-capable private network; mTLS/certificate lifecycle absent. Production release blocked.
2. **OCI adapter:** Docker CLI adapter (controlled arguments) rather than a linked Engine API client. The Docker socket is not exposed to plugins; see `docs/adr/ADR-010-oci-adapter.md`.
3. **Package signature scope:** Ed25519 covers `artifactDigest` and canonical manifest digest. Image signature is separate and not implemented.
4. **Java:** runtime is Java 21 but the frontend is not shipped for Java; C01 full-stack is partial.
5. **Two-node validation:** two Node processes share one Docker daemon. This validates protocol/placement/failover semantics but is not the required three-host Linux gate.
