# 0.0.3 Typed Pipeline Foundation — Sprint 4 Report

Date: 2026-10-23 (Asia/Shanghai)  
Branch: `feat/0.0.3-typed-pipeline`  
Verified HEAD: `5178312`  
Base `main`: `a434a79`  
PR: [`#2`](https://github.com/baicie/ops-1/pull/2) — Draft / Open / not merged

## 1. Status

| Area | Status | Real evidence |
|---|---|---|
| Version Gate | **PASS** | main contains 0.0.2 Data Foundation |
| Source Snapshot Pin | **PASS** | snapshot persisted in PostgreSQL before sink; recovery after source file changed still produced 1001 pinned records |
| Effect Receipt Digest | **PARTIAL** | COMMITTED same digest reused; different digest fails; 401/403/404/500/timeout matrix not all automated |
| Checkpoint Recovery | **PARTIAL** | snapshot digest, completed batch and sequence persisted; recovery combines Receipts and snapshot; no dedicated cursor-replay test |
| Result Replay | **PARTIAL** | same digest replay returns 200 after lease release; different digest returns 409; completed-receipt verification only uses last batch |
| HTTP Source Negative Matrix | **PARTIAL** | address-policy matrix passes in CI; redirect/DNS-rebinding/chunked/slow-connection server matrix not all automated |
| TypedEdge / Linear Topology | **PARTIAL** | 0.0.3 rejects non-linear topology in Rust and Python contract; no dedicated branch/merge negative fixture yet |
| Runtime Catalog Schema | **NOT_RUN** | still uses `contracts/examples/schema-catalog.json` for publish validation |
| Node-managed Worker | **NOT_RUN** | CI still invokes `opsweave-pipeline-worker` directly |
| Kernel Restart | **NOT_RUN** | no real Kernel kill/restart E2E |
| Two-Node Takeover | **NOT_RUN** | workers still ran on one Node |
| Catalog Lock Race | **PARTIAL** | same Job row lock implemented; no pg_locks blocking proof |
| Worker Identity Negative Matrix | **PARTIAL** | admin impersonation, boot/fence binding tested; revoke/generation/expiry matrix incomplete |
| 0.0.1 / 0.0.2 Regression | **PASS** | CI `39939865143` legacy and golden path success |

## 2. Implemented

### Source Snapshot and deterministic recovery

Migration `0005_pipeline_snapshots.sql` plus internal endpoints:

```text
GET  /internal/v1/pipeline-jobs/{job_id}/snapshot
POST /internal/v1/pipeline-jobs/{job_id}/snapshot
```

- snapshot is stored in PostgreSQL, capped at 4 MiB;
- bound to Job and current active fence;
- stores `sourceDigest`, length, parsed source and optional ETag;
- Worker loads the snapshot on every attempt; it never refetches the live source after pinning;
- Job Input `source` is ignored;
- a changed live source after a crash cannot change the recovered input.

Advanced acceptance changes `data-hosts-large.json` after crashing on batch 2, then
recovers; the final count remains exactly 1001 records.

### Effect receipt digest check

Before writing a batch, the Worker computes the request digest and:

- COMMITTED same digest: reuse Receipt;
- COMMITTED different digest: fail with `EFFECT_DIGEST_CONFLICT`;
- UNKNOWN: fail closed without creating a new Effect;
- 401/403/500: fail, not treated as missing;
- only true absence creates a new fenced effect.

### Checkpoints

Checkpoint state now contains:

- total records;
- completed batch count;
- snapshot digest;
- monotonically increasing sequence per attempt.

Recovery uses the pinned snapshot plus stable Receipts. It does not use a full
re-run as the only deduplication mechanism.

### Result replay

Kernel Job Result now supports an authenticated idempotent replay:

- same Worker identity + same status + same Result Digest after lease release returns the original Job;
- different digest returns `409 RESULT_CONFLICT`;
- other Worker identity cannot reuse the result.

CI evidence:

```text
PASS  fenced result persisted exactly once; same digest replay is idempotent and different digest conflicts
```

### Linear topology enforcement

0.0.3 formally limits executable Pipelines to exactly one Source and one Sink with
linear intermediate nodes. Rust validator and Python contract validator reject other
topologies. This prevents publishing a Pipeline the Runtime cannot faithfully execute.

### Capability query forwarding

Kernel Capability invocation now forwards the query string to the plugin proxy.
This fixed receipt lookup (`?effectId=...`) through the capability path.

## 3. CI evidence

- Data Foundation OCI CI `39939865143` — **SUCCESS**
- Standard CI `39939865084` — **SUCCESS**
- Typed Pipeline Contract CI `39939865074` — **SUCCESS**
- 0.0.1 legacy: `PASS=21 FAIL=0`
- 0.0.2 Data Foundation: PASS

Runtime outputs:

```text
PASS  custom map/filter config executed with different output
PASS  1001 records split into 3 durable batches; crash after batch 2 recovered without duplicates
Pipeline Worker Advanced Golden Path: PASS
PASS  fenced result persisted exactly once; same digest replay is idempotent and different digest conflicts
```

Existing SSRF CI output also passes:

```text
PASS  ipv4-loopback blocked
PASS  ipv4-private blocked
PASS  ipv4-metadata blocked
PASS  ipv6-loopback blocked
PASS  ipv6-ula blocked
PASS  ipv6-link-local blocked
Data SSRF Golden Path: PASS
```

## 4. Remaining

### P1

- Runtime Schema Catalog remains a fixture; no live Catalog Capability lookup or dynamic Dataset acceptance.
- Node Runtime does not supervise/start/stop the Worker; tests still launch the binary manually.
- No Kernel process kill/restart E2E.
- No two independent Node Runtime takeover.
- No pg_locks instrumentation for Catalog lock ordering.
- No complete real HTTP negative server matrix (redirect, DNS rebinding, chunked oversized, slow/interrupted).
- Worker identity revoked/generation/expiry matrix incomplete.
- Result completion checks only the last batch Receipt, not all batch Receipts.
- No dedicated checkpoint-cursor replay test.

### P2

- Node-managed worker concurrency/backpressure and graceful shutdown.
- Independent signed fence token verification.
- Multi-host physical acceptance.

## 5. Boundary

This sprint demonstrates deterministic source pinning, digest-checked Effects,
multi-batch crash recovery, and result replay on a real Kernel/PostgreSQL/Catalog OCI
runtime.

It does **not** complete Node-managed Worker, live Catalog Schema resolution,
Kernel restart or two-Node takeover. These are explicitly `NOT_RUN` or `PARTIAL`.

PR #2 remains Draft. No merge, tag move, force-push or release was performed.
