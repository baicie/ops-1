# 0.0.3 Typed Pipeline Foundation — Runtime Sprint 2 Report

Date: 2026-10-23 (Asia/Shanghai)  
Branch: `feat/0.0.3-typed-pipeline`  
Verified HEAD: `49582b1`  
Base `main`: `a434a79` (0.0.2 merge)  
PR: [`#2`](https://github.com/baicie/ops-1/pull/2) — Draft / Open / not merged

## 1. Final Status

| Area | Status | Evidence |
|---|---|---|
| Version Gate | **PASS** | main contains merged 0.0.2 Data Foundation |
| Worker Identity | **PARTIAL** | Node credential + boot-bound worker; admin session rejected; full revoked/generation matrix not all run |
| Revision Immutability | **PASS** | same revision + different digest returns 409 in real API test |
| Job Result Invariants | **PARTIAL** | SUCCEEDED requires a validated fenced receipt; duplicate/digest matrix not fully covered |
| Runtime Schema Catalog | **PARTIAL** | Runtime still uses a signed test fixture Schema Catalog; real Catalog capability lookup is not implemented |
| Trusted Registry Signature | **PASS** | Ed25519 signature and unknown-key/tamper rejection |
| Rust Validator / Planner | **PASS** | `apps/kernel/src/pipeline.rs`, 8 focused tests |
| Durable JobStore | **PASS** | PostgreSQL migration + real HTTP API test |
| Lease / Fencing | **PASS** | claim/start/heartbeat/checkpoint, expiry takeover, stale result/checkpoint |
| Fenced Sink Authorization | **PASS** | sink node/dataset/schema/effect bound to pinned plan; stale effect rejected |
| Catalog Sink Atomicity | **PARTIAL** | same-job row lock + fenced write; inverse lock-wait timing not instrumented |
| Cross-Attempt Idempotency | **PASS** | stable effectId; receipt reused; no duplicate rows |
| Pipeline Engine | **PASS** | built-in Source/Parse/Map/Filter/Validate/Sink worker |
| Single Worker E2E | **PASS** | real HTTP source, PostgreSQL job, Catalog OCI fenced write |
| Crash / Restart Recovery | **PARTIAL** | crash before/after sink and takeover passed; Kernel process restart not run |
| Multi-Node Golden Path | **NOT_RUN** | both workers used the same physical Node |
| 0.0.1 / 0.0.2 Regression | **PASS** | CI `39921641768`: golden-path and legacy-regression success |

## 2. Implemented Runtime

### Worker identity and operation binding

- Worker operations moved to authenticated internal endpoints:
  - `/internal/v1/pipeline-jobs/{id}/claim`
  - `/internal/v1/pipeline-jobs/{id}/definition`
  - `/internal/v1/pipeline-jobs/{id}/start|heartbeat|checkpoint|result`
- Worker authenticates with the enrolled **Node control credential**, not an admin browser session.
- Headers and body must agree on node, instance, generation, boot ID and worker ID.
- Worker ID is boot-qualified: `n:<node>:i:<instance>:b:<boot>`.
- Instance must belong to the Node and be `READY`; Node must be `READY` and not revoked.
- Lease operations compare the lease's worker ID, so another worker cannot use an existing lease.
- Admin session through the worker endpoint is rejected.
- A stale Node generation is rejected with `STALE_NODE_GENERATION`.

### Pipeline Core

`apps/kernel/src/pipeline.rs` implements typed definitions, Ed25519 signed registry,
canonical digest, exact port signature, config schema validation, schema pins,
DAG cycle detection, deterministic topological order and resource bounds.

### Durable JobStore

Migration `0003_typed_pipeline.sql` and `apps/kernel/src/jobs.rs` provide jobs,
attempts, leases, checkpoints, results, events, claim CAS, monotonic fence,
lease expiry/takeover and idempotent submit.

### Fenced Catalog sink

- Migration `0004_pipeline_sink_scope.sql` adds `fence_authorize_effect()`.
- It compares the request sink node, dataset UUID and schema revision against the
  immutable pipeline revision definition, while holding the same job row lock.
- Catalog performs the fence check, records and receipt in one transaction.
- Stable `effectId` excludes attempt and fence.
- Old `/records` remains unchanged.

### Worker

New crate `apps/pipeline-worker`:

- Node credential authentication and boot-qualified identity.
- Claim → Start → Definition → bounded HTTP/JSON Source → Parse → Map → Filter →
  Validate → Checkpoint → fenced Catalog write → Receipt → Complete.
- Node-side source host allowlist and bounded body/record limits.
- Crash injection before and after the sink.
- Stable effect ID and receipt-first recovery.

## 3. Real CI Evidence

Data Foundation OCI CI `39921641768` — **SUCCESS**:

```text
PASS  pipeline published/validated with trusted registry
PASS  job persisted QUEUED
PASS  duplicate key/different input rejected
PASS  claim/start/heartbeat/checkpoint passed
PASS  lease expiry/takeover and old-fence rejection passed
PASS  fenced result persisted exactly once
Pipeline JobStore Golden Path: PASS

PASS  old worker fenced write committed
PASS  cross-attempt effectId returned original receipt without duplicate records
PASS  new claim after old fence rejected old worker's new sink effect
PASS  effect receipt lookup supports UNKNOWN recovery
Catalog Fenced Sink Golden Path: PASS

PASS  same revision/different digest rejected
PASS  admin session cannot impersonate a worker
PASS  single worker executed Source→Parse→Map→Filter→Validate→Sink and completed
PASS  worker crash before sink recovered by second worker with higher fence
PASS  committed effect recovered by receipt without duplicate sink write
Pipeline Worker Golden Path: PASS
```

- Standard CI `39921641719` — **SUCCESS** (rust/web/contracts).
- Contract CI `39921641797` — **SUCCESS**.
- 0.0.1 legacy regression: **PASS=21 FAIL=0**.
- 0.0.2 Data Foundation: **PASS**.

Worker crash/recovery evidence:
- `OPSWEAVE_WORKER_CRASH_BEFORE_SINK`: process exits before any Catalog write; second worker claims after lease expiry with fence 2 and completes.
- `OPSWEAVE_WORKER_CRASH_AFTER_SINK`: process exits after Catalog receipt; second worker finds the existing receipt and completes without a second record batch.

## 4. Remaining Risks / NOT_RUN

- **P1 Kernel restart recovery**: job state is durable, but the Kernel process is not restarted in this test.
- **P1 Multi-Node takeover**: both workers currently use the Node Runtime on the same physical Node; cross-Node takeover is `NOT_RUN`.
- **P1 runtime schema catalog**: the Kernel still validates against a signed fixture
  `contracts/examples/schema-catalog.json`; production lookup through the real Catalog
  capability is not implemented.
- **P1 Catalog lock-wait interleaving**: same-transaction row lock is implemented,
  but a `pg_locks` measurement proving “Catalog writer first, Claim waits” is not yet
  automated.
- **P1 worker identity negative matrix**: full revoked Node, revoked Instance and
  expired workload-token tests are not all automated; admin impersonation and stale
  fence/lease binding are.
- **P1 result duplicate digest**: same-fence duplicate receipt path is implemented;
  a dedicated different-digest conflict test is not yet present.
- **P2** independent signed fence-token verification at Catalog; current first version
  uses the same-database `SECURITY DEFINER` authority.
- **P2** no full `pg_locks`/SIGKILL Node-runtime recovery test.

No PR #2 merge, Ready transition, tag move, force-push or release was performed.
