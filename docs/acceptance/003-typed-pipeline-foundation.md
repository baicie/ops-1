# 0.0.3 Typed Pipeline Foundation — Sprint 3 Report

Date: 2026-10-23 (Asia/Shanghai)  
Branch: `feat/0.0.3-typed-pipeline`  
Verified HEAD: `6a57229`  
Base `main`: `a434a79`  
PR: [`#2`](https://github.com/baicie/ops-1/pull/2) — Draft / Open / not merged

## 1. Status

| Area | Status | Evidence |
|---|---|---|
| Version Gate | **PASS** | main contains 0.0.2 Data Foundation |
| HTTP Source Security | **PARTIAL** | IP/DNS policy, no redirects, streaming bound, source override ignored; unit tests only for address matrix, no full real HTTP negative server matrix |
| True Typed Plan Execution | **PASS** | worker consumes plan.orderedNodes; custom map/filter pipeline produced a distinct one-row result |
| Runtime Schema Catalog | **PARTIAL** | still validates against signed Schema Catalog fixture; no live Catalog Capability lookup |
| Multi-Batch Effect Idempotency | **PASS** | 1001 records, 3 batches, crash after batch 2, 3 stable effects, no duplicates |
| Result Replay Correctness | **PARTIAL** | successful result requires fenced Receipt; duplicate/different result-digest matrix not fully covered |
| Node-managed Worker | **NOT_RUN** | CI still launches `opsweave-pipeline-worker` directly; Node Runtime lifecycle integration not implemented |
| Kernel Restart | **NOT_RUN** | durable DB state exists, process restart not exercised |
| Two-Node Takeover | **NOT_RUN** | both worker launches used Node B in this run |
| Catalog Lock Concurrency | **PARTIAL** | same-row transaction lock exists; no pg_locks wait instrumentation |
| Worker Identity Negative Matrix | **PARTIAL** | admin impersonation and boot/fence binding tested; revoked Node/Instance/generation/expiry matrix incomplete |
| 0.0.1 / 0.0.2 Regression | **PASS** | CI `39933199108`: golden-path and legacy-regression success |

## 2. Implemented this sprint

### HTTP Source Security

`apps/pipeline-worker` now:

- ignores Job Input `source`; only the immutable Revision source config is used;
- allows only HTTP/HTTPS and rejects URL credentials/fragments;
- classifies IPv4/IPv6: loopback, RFC1918, link-local, metadata, CGNAT, documentation, multicast, ULA, site-local, IPv4-mapped/compatible addresses;
- resolves DNS, validates all addresses, pins the selected address in the reqwest client;
- disables redirects;
- applies connect/read/total timeouts;
- streams response chunks and aborts before exceeding 4 MiB;
- caps records and JSON depth via serde;
- supports an explicit `OPSWEAVE_WORKER_SOURCE_ALLOWLIST` only for controlled CI fixtures.

Unit tests cover private/metadata/mapped/ULA/link-local addresses and localhost/non-HTTP schemes.

### Typed Plan Execution

The worker reads the persisted `plan`, verifies `planDigest`, uses `orderedNodes`, and executes built-ins by their pinned types:

- Source HTTP/JSON;
- Parse;
- Map with explicit `mappings`;
- Filter with field/op/value;
- Validate with `required`;
- Dataset Sink.

It no longer hardcodes `id/name` extraction. Unsupported types/configs fail explicitly.

Real CI:

```text
PASS  custom map/filter config executed with different output
```

### Durable Multi-batch Execution

- 1,000 record Catalog batch ceiling is respected by a 500-record worker batch.
- Stable logical batch id and effectId per batch.
- Monotonic checkpoint sequence before each batch.
- Existing Receipt is queried before write.
- Crash after batch 2 is recovered by a new attempt/fence; only missing batch 3 is written.
- 3 effect receipts; 1001 records exactly once.

Real CI:

```text
PASS  multi-batch crash after second batch recovered with 3 stable effects and no duplicates
```

### Fenced Sink Authorization

`fence_authorize_effect()` checks Job, Lease/Fence, Sink Node, Dataset UUID and
Schema Revision against the pinned revision while holding the Job row lock.
The Catalog writes receipt/records/lineage in the corresponding transaction.

## 3. CI evidence

- Data Foundation OCI CI `39933199108` — **SUCCESS**
- Standard CI `39933199109` — **SUCCESS**
- Typed Pipeline Contract CI `39933199114` — **SUCCESS**
- 0.0.1 legacy: `PASS=21 FAIL=0`
- 0.0.2 Data Foundation Golden Path: PASS

Real pipeline evidence:

```text
pipeline worker completed job ... batches 1 accepted 2
PASS  single worker executed Source→Parse→Map→Filter→Validate→Sink and completed
PASS  worker crash before sink recovered by second worker with higher fence
PASS  committed effect recovered by receipt without duplicate sink write
pipeline worker completed job ... batches 1 accepted 1
PASS  custom map/filter config executed with different output
pipeline worker completed job ... batches 3 accepted 1001
PASS  multi-batch crash after second batch recovered with 3 stable effects and no duplicates
```

## 4. Remaining issues

### P0

None in the executed single-node path.

### P1

- **Runtime Schema Catalog** still uses `contracts/examples/schema-catalog.json`; live Catalog lookup and dynamic Dataset UUID are not implemented.
- **Node-managed Worker** lifecycle is not integrated; test harness starts the binary directly.
- **Kernel restart** recovery is not exercised.
- **Two-Node takeover** is not exercised; both workers ran on Node B.
- **Catalog lock-wait interleaving** (writer first, Claim waits) lacks a pg_locks barrier test.
- **HTTP Source real negative matrix** lacks a live test server for redirect, DNS rebinding, oversized chunked body and connection interruption; only address-policy unit tests exist.
- **Result replay** duplicate same/different digest matrix is not fully automated.
- **Worker identity negative matrix** incomplete: revoked Node, revoked Instance, stale generation, expired Node credential.
- **Job Input source override** is ignored by code but not explicitly asserted in a negative test.

### P2

- Independent signed fence-token verification at Catalog; current boundary is same-DB `SECURITY DEFINER`.
- Multi-host physical acceptance.
- Worker concurrency/backpressure and Node Runtime-managed lifecycle.

## 5. Boundary

This run demonstrates:

- real PostgreSQL JobStore and lease/fence takeover;
- real Catalog OCI fenced write and stable effect receipt;
- real typed plan execution for two different pipeline configs;
- multi-batch crash recovery with no duplicate side effects;
- 0.0.1/0.0.2 regression.

It does **not** yet demonstrate Node Runtime-managed worker lifecycle, live Catalog schema resolution, Kernel restart, or two independent Node takeover.

PR #2 remains Draft. No merge, tag move, force-push or release was performed.
