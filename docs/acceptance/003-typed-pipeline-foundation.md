# 0.0.3 Typed Pipeline Foundation — Runtime Sprint 1 Report

Date: 2026-10-23 (Asia/Shanghai)  
Branch: `feat/0.0.3-typed-pipeline`  
Code HEAD: `e2c6ebb`  
Base `main`: `a434a79` (squash merge of PR #1, OpsWeave 0.0.2 Data Foundation)  
PR: [`#2`](https://github.com/baicie/ops-1/pull/2) — Draft, not merged

## 1. Status Summary

| Phase | Status | Evidence |
|---|---|---|
| Version Gate | **PASS** | PR #1 merged as `a434a79`; `main` contains Data Foundation code |
| Fenced Sink Contract | **PASS** | stable `effectId`, signed fence grant schema, fenced Catalog OpenAPI, atomic DB function |
| Registry Signature Verification | **PASS** | Ed25519 signature checked by Python conformance and Rust `trusted_registry()` |
| Rust Validator / Planner | **PASS** | `apps/kernel/src/pipeline.rs`, 8 focused tests |
| Durable JobStore | **PASS** | PostgreSQL migration 0003 + real HTTP/PostgreSQL acceptance `Pipeline JobStore Golden Path` |
| Lease / Fencing | **PASS** | claim/start/heartbeat/checkpoint, lease expiry takeover, stale result/checkpoint rejection |
| Catalog Sink Atomicity | **PASS** | real Catalog endpoint + `kernel.fence_authorize()` same-transaction row lock; fenced write tests |
| Cross-Attempt Idempotency | **PASS** | stable `effectId`; duplicate receipt returned; 2 records remain 2 after retry |
| Worker Runtime | **NOT_RUN** | no real Node/Worker execution loop in this sprint |
| Crash / Restart Recovery | **PARTIAL** | lease-expiry takeover passed; full Kernel/Worker restart E2E not run |
| Multi-Node Golden Path | **NOT_RUN** | single-node API/DB/Catalog path only |
| 0.0.1 / 0.0.2 Regression | **PARTIAL** | 0.0.2 golden-path passed; 0.0.1 legacy rerun depends on external Java download |

## 2. Implemented

### Sprint A — Fenced Sink Contract

- `contracts/schema/sink-receipt.v1.schema.json` now includes:
  - `effectId = "efx:" + sha256(canonical_json({jobId,pipelineId,pipelineRevision,sinkNodeId,logicalBatchId}))`;
  - `requestDigest`, pipeline revision, sink node and logical batch;
  - attempt and fencing sequence are not part of effect identity.
- `contracts/schema/fence-grant.v1.schema.json` and `contracts/openapi/data-catalog-fenced-v1.yaml`.
- `contracts/examples/node-registry.json` is now signed with a real Ed25519 signature over
  `{schemaVersion, registryDigest, entries}`; trusted key fixture is
  `contracts/examples/trusted-registry-keys.json`.
- Python conformance now verifies the signature and rejects:
  - unknown key ID;
  - altered signature;
  - altered registry entries;
  - forged pipeline ports/config/digest;
  - type mismatch, cycle, unknown node type, node limit;
  - duplicate claim, stale fence and invalid state transitions.

### Sprint B — Rust Core

`apps/kernel/src/pipeline.rs`:

- typed `PipelineDefinition`, `PipelineNode`, `InputPort`, `OutputPort`, `TypedEdge`;
- trusted `NodeRegistry` + Ed25519 signature verification;
- canonical JSON and digest;
- exact port signature check against the registry;
- node-type-specific config schema validation;
- schema revision pin against a trusted schema catalog;
- DAG cycle detection and deterministic topological order;
- max 64 nodes / 128 edges / 10,000 records / 8 MiB plan bounds;
- immutable revision is persisted by the JobStore migration; publish uses a unique `(pipeline_id, revision)` and digest.

8 focused Rust tests pass, including forged port, cycle, bad registry signature, config error, unknown schema revision and stable effect identity.

### Sprint C — Durable JobStore

`apps/kernel/migrations/0003_typed_pipeline.sql` and `apps/kernel/src/jobs.rs`:

- `pipeline_definitions`, `pipeline_revisions`, `pipeline_plans`;
- `pipeline_jobs`, `pipeline_job_attempts`, `pipeline_job_leases`,
  `pipeline_job_checkpoints`, `pipeline_job_results`, `pipeline_job_events`;
- HTTP APIs:
  - create/publish/get plan;
  - submit job with idempotency key and request digest;
  - claim / start / heartbeat / checkpoint / result / cancel.
- Claim transaction row-locks the job, expires old leases, increments fencing sequence, creates attempt and lease atomically.
- Heartbeat/checkpoint/result reject stale fence and expired leases.
- Job pins pipeline revision and digest.
- Audit events use the existing `kernel.audit_events` schema.

Real acceptance `tests/acceptance/pipeline_jobs.sh` passed in CI:
idempotent submit, duplicate claim rejection, claim/start/heartbeat/checkpoint,
forced lease expiry/takeover with higher fence, stale worker result/checkpoint
rejection and exactly one result row.

### Sprint D — Atomic Catalog Sink

`kernel.fence_authorize(uuid, uuid, bigint)` is a restricted `SECURITY DEFINER`
function with fixed `search_path`, no PUBLIC execute, and execute grant only to
the Catalog role. It takes `FOR UPDATE` on the same `pipeline_jobs` row as
Claim. Catalog calls this function **inside its records transaction**, so:

- old writer lock first → new Claim waits for the Catalog transaction;
- new Claim first → old writer sees a higher current fence and is rejected;
- records, effect receipt and lineage commit in one Catalog transaction.

`plugins/data-catalog/backend/server.mjs` adds:

- `POST /datasets/{uuid}/fenced-records`;
- `GET /datasets/{uuid}/effect-receipts?effectId=...`;
- stable effect receipt table and unique `effect_id`;
- request digest, cross-attempt receipt reuse, UNKNOWN lookup;
- old `/records` endpoint unchanged.

Real CI passed:
- old worker fenced write committed;
- retry after takeover returned the original receipt with no duplicate records;
- old worker's new effect after new Claim returned `409` at the Catalog boundary;
- effect receipt lookup returned `COMMITTED`.

## 3. Actual commands / CI

- Standard CI `39909484807` — **SUCCESS**
  - rust, web, contracts.
- Data Foundation OCI CI `39909484846` — **golden-path SUCCESS**
  - `Pipeline JobStore Golden Path: PASS`
  - `Catalog Fenced Sink Golden Path: PASS`
  - legacy-regression was rerun after an external Temurin download returned HTTP 403; see unresolved note.
- `typed-pipeline-contracts` runs are success.
- Local:
  - `cargo test -p opsweave-kernel`: 27 passed;
  - Python contract validator: PASS;
  - `cargo clippy -p opsweave-kernel --all-targets -- -D warnings`: PASS.

## 4. Findings / residual risks

- **P1 Worker Runtime missing**: the current real path exercises Kernel APIs, PostgreSQL JobStore and the Catalog sink directly but does not yet run a Node-runtime worker executing the built-in nodes. Therefore the full `Submit → Claim → Execute → Checkpoint → Fenced Sink → Receipt → Complete` pipeline is `NOT_RUN` at the Worker level.
- **P1 Kernel restart**: job rows persist, but a real process restart/recovery test has not been run.
- **P1 signature boundary**: Registry signature verification is real; Catalog fence verification currently relies on the Kernel `SECURITY DEFINER` authority and does not independently verify a signed fence token. This is safe for the same-database first version but should be hardened before cross-database deployment.
- **P1 multi-node**: no two-Node claim/takeover E2E.
- **P1 0.0.1 legacy**: the legacy job was rerun after an external Java download HTTP 403; the failure was environmental, not a code regression. Final rerun result must be recorded before claiming full legacy PASS.
- **P2**: old Catalog `/records` compatibility passed Data Foundation Golden Path; a dedicated fenced/legacy mixed-client test is not yet separate.

## 5. Next steps

1. Implement a real Worker loop (Rust or Node) that executes the six built-in nodes and calls the fenced Catalog route.
2. Add Kernel restart recovery and Worker crash/takeover E2E with controlled barriers.
3. Add two-Node NodeRuntime claim/takeover.
4. Add independent fence-token signature verification at Catalog (or document the same-DB authority as the supported boundary).
5. Re-run 0.0.1 legacy after external download availability and record the final result.

No PR #2 merge, tag move, force-push or release was performed.
