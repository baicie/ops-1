# 0.0.3 Typed Pipeline Foundation — Sprint 6 Report

Date: 2026-10-23 (Asia/Shanghai)  
Branch: `feat/0.0.3-typed-pipeline`  
Verified HEAD: `c503155`  
Base `main`: `a434a79`  
PR: [`#2`](https://github.com/baicie/ops-1/pull/2) — **Draft / Open / not merged**

## 1. Status Matrix

| Item | Status |
|---|---|
| Live Catalog Schema | **NOT_RUN** |
| Dynamic Dataset E2E | **NOT_RUN** |
| Node-managed Worker | **PASS** |
| Automatic Job Discovery | **PASS** |
| Two-Node Takeover | **NOT_RUN** |
| Kernel Restart | **NOT_RUN** |
| Authoritative Effect Verification | **PARTIAL** |
| 0.0.1 / 0.0.2 Regression | **PASS** |

## 2. Milestone 2 — Node-managed Worker: PASS

Implemented:

- Kernel internal `POST /internal/v1/pipeline-jobs/claim-next`:
  - authenticates the enrolled Node worker identity;
  - selects only `QUEUED` jobs without an active lease;
  - actual job mutation reuses the existing atomic `claim_job` CAS path.
- Worker without `OPSWEAVE_WORKER_JOB_ID` enters automatic discovery:
  - Claim-Next → Start → Definition → Snapshot → Pipeline → Result;
  - polls with bounded sleep instead of busy-spin;
  - graceful Ctrl-C shutdown.
- Node Runtime supervisor:
  - `apps/node/src/worker_supervisor.rs`;
  - starts the trusted worker child only when the Node has a READY instance;
  - passes the Node identity file path, not a credential in Pipeline config;
  - binds a new boot ID per child start;
  - restarts a crashed worker;
  - `kill_on_drop` prevents orphaned children on Node shutdown;
  - disabled unless `OPSWEAVE_NODE_WORKER_ENABLED=1`;
  - additionally gated by a per-Node enable marker so ordinary tests are not stolen.
- Worker source allowlist is inherited from the trusted Node process.

Real CI output:

```text
Pipeline Worker Advanced Golden Path: PASS
submitted 1a30af0b-4a7e-4f36-acb7-bdc1313a834c for node-managed execution
PASS  Node Runtime auto-claimed and completed job without manual worker invocation
      (node 2a6ed03d-4a71-4a7d-9129-b5ce84b75229, receipts 1)
Node-managed Worker Golden Path: PASS
```

This is a single Node Runtime on the CI host. It is **not** a two-Node or multi-host proof.

## 3. Milestone 1 — Live Catalog Schema: NOT_RUN

The production Pipeline publish path still loads:

```text
contracts/examples/schema-catalog.json
```

No dynamic Dataset UUID, Published Schema Digest fetch, or Catalog Capability
lookup was implemented in this round. The existing static validation remains only
a conformance fixture, and no claim is made that production publish uses live
Catalog metadata.

## 4. Correctness retained

- Snapshot canonical digest/length are recomputed server-side; tampering fails closed.
- Result replay is bound to the original lease, fence, worker and digest.
- Worker verifies every batch Receipt before SUCCEEDED.
- Linear topology and fenced sink remain unchanged.
- Capability query forwarding remains in place.

## 5. CI

- Data Foundation OCI CI `39948152697` — **SUCCESS**
- Standard CI `39948152704` — **SUCCESS**
- Typed Pipeline Contract CI `39948152724` — **SUCCESS**
- 0.0.1 Legacy: PASS=21 FAIL=0
- 0.0.2 Data Foundation: PASS

## 6. Remaining

### P0

- Live Catalog Schema and dynamic Dataset E2E are not implemented, so the
  production publish path is still Fixture-backed.

### P1

- Two independent Node Runtime takeover.
- Kernel process restart E2E.
- Kernel-side authoritative Effect verification through Catalog.
- Checkpoint cursor recovery test.
- Complete HTTP negative matrix and Worker identity revoke/generation matrix.
- Catalog lock-wait proof.

### P2

- Worker concurrency/backpressure.
- Multi-host physical acceptance.

## 7. Boundary

Milestone 2 single-Node automatic scheduling and supervision passed on a real
Kernel/PostgreSQL/Catalog OCI stack. Milestone 1 is not delivered, and distributed
recovery (two Nodes, Kernel restart) is not delivered.

PR #2 remains Draft. No merge, tag move, force-push or release was performed.
