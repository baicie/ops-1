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
| E00 Project Bootstrap | DONE (local) | Cargo + pnpm workspaces, lockfiles, Makefile, CI definition, contract checker, local compose, systemd units. Remote CI run `39729298391` passed Rust, Web and Contracts jobs on commit `338b42c`; full E2E remains local. |
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

Still **NOT_RUN / blocking**: Kernel↔Node mTLS and certificate rotation, three physical Linux amd64 hosts, real Rootless Docker, OCI image signatures/SBOM, SIGKILL host-level container cleanup, full SSE flood/backpressure testing, and Fencing Tokens for side-effecting workloads. The 25s Kernel stale threshold and 30s Node lease are not a substitute for a fencing/generation protocol; a reassignment race can still produce a short double-execution window. No production-ready claim is made.

## Explicit non-goals (unchanged)

AI RCA, Data Catalog, general DAG engine, historical log storage/search, arbitrary third-party code, production multi-Kernel HA, GPU scheduling, NAT-transparent relay, OCI image attestation/SBOM enforcement, multi-tenant isolation.

## Deviations requiring an ADR or release block

1. **Node transport:** bearer credentials over HTTPS-capable private network; mTLS/certificate lifecycle absent. Production release blocked.
2. **OCI adapter:** Docker CLI adapter (controlled arguments) rather than a linked Engine API client. The Docker socket is not exposed to plugins; see `docs/adr/ADR-010-oci-adapter.md`.
3. **Package signature scope:** Ed25519 covers `artifactDigest` and canonical manifest digest. Image signature is separate and not implemented.
4. **Java:** runtime is Java 21 but the frontend is not shipped for Java; C01 full-stack is partial.
5. **Two-node validation:** two Node processes share one Docker daemon. This validates protocol/placement/failover semantics but is not the required three-host Linux gate.
