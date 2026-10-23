# 0.0.3 Typed Pipeline Foundation — Sprint 5 Gate Report

Date: 2026-10-23 (Asia/Shanghai)  
Branch: `feat/0.0.3-typed-pipeline`  
Verified HEAD: `2708c01`  
Base `main`: `a434a79`  
PR: [`#2`](https://github.com/baicie/ops-1/pull/2) — **Draft / Open / not merged**

## 1. Gate Status

| Area | Status | Evidence |
|---|---|---|
| Snapshot Integrity | **PARTIAL** | Server recomputes canonical digest/length, enforces 4 MiB, binds lease/fence, rejects forged/overwritten/tampered snapshots; >4 MiB actual-body test not automated |
| Result Replay Identity | **PASS** | Result row stores lease/fence/worker; same digest replay returns 200 after release, different digest returns 409 |
| Complete Effect Set | **PARTIAL** | Worker verifies every batch Receipt before success; Kernel requires one COMMITTED effect per batch, but does not query Catalog itself |
| Checkpoint Recovery Cursor | **PARTIAL** | Snapshot digest, completed batch and plan digest persisted; no dedicated cursor-based recovery test |
| Live Catalog Schema | **NOT_RUN** | Still uses `contracts/examples/schema-catalog.json`; no live Capability lookup or dynamic Dataset E2E |
| Node-managed Worker | **NOT_RUN** | Worker is still launched by test scripts |
| Kernel Restart | **NOT_RUN** | No process-level kill/restart E2E |
| Two-Node Takeover | **NOT_RUN** | Both workers ran on one Node |
| Catalog Lock Race | **PARTIAL** | Same Job row lock implemented; no pg_blocking_pids proof |
| Worker Identity Matrix | **PARTIAL** | Admin impersonation, old worker snapshot/lease, stale fence tested; revoke/generation/expiry matrix incomplete |
| HTTP Source Security | **PARTIAL** | Address matrix and SSRF golden path pass; redirect/DNS rebinding/chunked/slow server matrix not complete |
| 0.0.1 / 0.0.2 Regression | **PASS** | CI `39945064658` legacy and golden path success |

**PR #2 is not ready to become Ready.** Core correctness improved, but live Catalog Schema and Node-managed recovery remain `NOT_RUN`.

## 2. Implemented this round

### A1. Snapshot integrity

- Kernel computes canonical JSON (sorted keys, compact separators) from the submitted source.
- Server recomputes SHA-256; client-declared digest is not trusted.
- Server computes actual canonical byte length; client-declared length is not trusted.
- Actual payload is bounded to 4 MiB.
- Snapshot write requires current active Lease/Fence and matching Worker.
- A second write with different content is rejected with `SNAPSHOT_CONFLICT`.
- Snapshot GET verifies:
  - current Worker;
  - lease status and expiry;
  - stored content digest and length.
- Corrupted stored content fails closed with `SNAPSHOT_CORRUPT`; it does not refetch and continue.
- Snapshot is Job-bound and stored in PostgreSQL, not Worker memory.

Real CI:

```text
PASS  snapshot integrity rejects forged digest/length and pins content
PASS  tampered snapshot content fails closed
PASS  old worker cannot read snapshot after takeover
```

### A2. Result replay identity

Migration `0006_result_identity.sql` adds original `lease_id` and `worker_id` to Job Result.

Replay now requires all of:

- same Worker identity;
- same original Lease ID;
- same Fencing Sequence;
- same terminal Status;
- same Result Digest.

Different identity or digest returns `RESULT_CONFLICT`. Replay performs a pure read and does not alter Job state, audit or Catalog Receipts.

Real CI:

```text
PASS  fenced result persisted exactly once; same digest replay is idempotent and different digest conflicts
```

### A3. Complete effect set

- Worker keeps every logical batch Effect ID.
- Before SUCCEEDED, Worker queries each Receipt and requires:
  - COMMITTED status;
  - matching request digest.
- Kernel requires one committed Effect entry per reported batch and rejects an empty/incomplete set.
- Worker no longer relies solely on the final batch Receipt.

Remaining gap: Kernel still trusts the Worker's verified Effect set; it does not independently query Catalog through a Kernel-side Capability identity.

### Topology and capability forwarding retained

- Linear single-Source/single-Sink topology is enforced in Rust and Python validators.
- Capability invocation forwards query strings; this fixed Receipt lookup.
- Source snapshot is reused after crash even if the live source changes.

## 3. CI

- Data Foundation OCI CI `39945064658` — **SUCCESS**
- Standard CI `39945064774` — **SUCCESS**
- Typed Pipeline Contract CI `39945064805` — **SUCCESS**
- 0.0.1 Legacy: `PASS=21 FAIL=0`
- 0.0.2 Data Foundation: PASS

Relevant CI output:

```text
PASS  snapshot integrity rejects forged digest/length and pins content
PASS  tampered snapshot content fails closed
PASS  old worker cannot read snapshot after takeover
PASS  fenced result persisted exactly once; same digest replay is idempotent and different digest conflicts
PASS  custom map/filter config executed with different output
PASS  1001 records split into 3 durable batches; crash after batch 2 recovered without duplicates
Pipeline Worker Advanced Golden Path: PASS
Data SSRF Golden Path: PASS
```

## 4. Remaining blockers

### P0

None in the currently automated single-Node path.

### P1

- Live Catalog Schema resolution and dynamic Dataset UUID E2E.
- Node Runtime-supervised Worker with automatic Job discovery.
- Kernel process restart E2E.
- Two independent Node Runtime takeover.
- Kernel-side authoritative verification of all Effect Receipts.
- Dedicated checkpoint-cursor recovery test.
- Complete HTTP negative server matrix.
- Complete Worker identity revoke/generation/expiry matrix.
- Catalog lock blocking proof with `pg_blocking_pids()`.

### P2

- Worker concurrency/backpressure and graceful shutdown.
- Independent fence-token signature verification.
- Multi-host physical acceptance.

## 5. Acceptance boundary

This round hardened Snapshot integrity, Result replay identity, and multi-batch completion evidence on a real Kernel/PostgreSQL/Catalog OCI stack.

It did not implement the Sprint 5 target of live Catalog Schema, Node-managed Worker, Kernel restart, or two-Node takeover. Those are explicitly `NOT_RUN` or `PARTIAL`.

PR #2 remains Draft. No merge, tag move, force-push or release was performed.
