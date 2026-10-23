# 0.0.3 Typed Pipeline Foundation — Gate Report

Date: 2026-10-23 (Asia/Shanghai)  
Design branch: `feat/0.0.3-typed-pipeline-design`  
Branch HEAD before this report: `cf9171f`  
Base: `main` at `4ce130b`  
Status: **CONTRACT PASS / RUNTIME BLOCKED**

## 1. 0.0.2 Gate

| Item | Result |
|---|---|
| PR #1 | OPEN, Draft, not merged |
| Reviewed/final 0.0.2 code | `f207b75` |
| Standard CI | `39892827005` SUCCESS |
| Data Foundation OCI CI | `39892827048` SUCCESS |
| 0.0.1 regression | PASS=21 FAIL=0 |
| 0.0.2 review blockers | No new P0/P1 found |
| Human action required | mark Ready and merge PR #1 |

The runtime phase is **BLOCKED** because PR #1 has not entered `main`. No
0.0.3 runtime code was added to PR #1.

## 2. 0.0.3 Contract Status

| Area | Status | Evidence |
|---|---|---|
| Architecture RFC | PASS | `docs/architecture/0.0.3-typed-pipeline-rfc.md` |
| ADR-013 execution/persistence/recovery | PASS | `docs/adr/ADR-013-typed-pipeline-and-durable-jobs.md` |
| Pipeline IR JSON Schema | PASS | `contracts/schema/pipeline-ir.v1.schema.json` |
| Durable Job JSON Schema | PASS | `contracts/schema/durable-job.v1.schema.json` |
| Trusted NodeRegistry signature | PASS (contract) | Registry digest, signature metadata and exact port signatures are checked |
| Node-specific Config Schema | PASS (contract) | `configSchema` validated with Draft 2020-12 + format checker |
| Schema Revision validation | PASS (contract) | `schema-catalog.json` fixture; unknown/unpublished revision rejected |
| Canonical JSON digest | PASS (contract) | Pipeline/registry/plan canonical digest recomputed |
| Job state machine | PASS (contract) | Illegal transitions, duplicate claim, fence sequence, checkpoint sequence, result key |
| OpenAPI draft | PASS | `contracts/openapi/typed-pipeline-v1.yaml` and fenced Catalog extension |
| Contract conformance CI | PASS | `typed-pipeline-contracts` run `39895921388` on `61c1f53` |
| Catalog Sink atomic fence | **BLOCKED** | Existing Catalog has no Job/Fence identity; see `docs/architecture/0.0.3-fenced-sink.md` |

Contract result:

```text
TYPED PIPELINE CONTRACT PASS
  pipeline schema: valid (trusted registry signature source)
  durable job schema: valid
  examples: 12 validated
  DAG/type/cycle/limits/state/fencing/schema checks: valid
  canonical JSON and digest checks: valid
  OpenAPI operations: 10 checked
```

This is a contract/semantic test only. It is not a pipeline execution claim.

## 3. Runtime Status

| Area | Status | Reason |
|---|---|---|
| Pipeline Core | **BLOCKED** | Version Gate C not satisfied |
| Pipeline Validator / Planner executable | **BLOCKED** | Contract only; no runtime implementation |
| Durable JobStore | **BLOCKED** | Requires runtime branch after merge |
| Lease / Heartbeat / Fencing | **BLOCKED** | Requires JobStore implementation |
| Worker MVP | **BLOCKED** | Requires Node/Worker implementation |
| Checkpoint / Recovery | **BLOCKED** | Requires JobStore + Worker |
| Catalog fenced sink atomicity | **BLOCKED** | No Catalog fence receipt transaction/config in 0.0.2 |
| Real two-Node E2E | **BLOCKED** | Requires runtime and fenced sink |
| Source → Parse → Map → Filter → Validate → Dataset E2E | **NOT_RUN** | No runtime implementation permitted before Gate C |

No Mock Sink, fake job success, or simulated distributed test is counted as
PASS.

## 4. Sink Atomicity Finding

The 0.0.2 `data.catalog.v1` `POST /datasets/{id}/records` operation provides
idempotent batches but no Job/Fence identity. The rejected pattern is:

```text
Kernel checks lease -> Catalog writes records
```

This has a TOCTOU race after a new claim. The required additive extension is a
signed fence grant + Catalog `fenced-records` route + receipt written in the
same Catalog transaction as records/lineage, with a Kernel sink-reservation
protocol to prevent old/new writer overlap. It is specified in
`docs/architecture/0.0.3-fenced-sink.md`; it remains **BLOCKED** until the
Catalog implementation and real E2E exist. Existing `/records` remains
unchanged for 0.0.2 compatibility.

## 5. Required Unblock Sequence

1. Human review authorizes marking PR #1 Ready and merges it to `main`.
2. Fetch merged `main`; verify the 0.0.2 Data Foundation and all CI checks.
3. Create `feat/0.0.3-typed-pipeline` from the merged base and record Base SHA.
4. Implement Pipeline Core, JobStore, Worker and Catalog fenced receipt in
   separate commits/PR slices.
5. Run real Kernel/PostgreSQL/Node/OCI/Catalog E2E for all failure scenarios.
6. Do not report runtime PASS until the sink-boundary stale-fence test passes.

## 6. P0/P1/P2

- **P0** none in the 0.0.3 contract draft; runtime is blocked by the version gate.
- **P1** Catalog sink atomicity is unresolved and explicitly BLOCKED; do not
  implement a Kernel-only fence check.
- **P1** 0.0.2 D06 UNKNOWN/retention/signed-plan/restart coverage remains
  incomplete.
- **P2** UI/editor work is deferred to 0.0.4.

## 7. Commits / CI

- Design branch: `feat/0.0.3-typed-pipeline-design`
- Contract commit: `61c1f53`
- Contract CI: [`39895921388`](https://github.com/baicie/ops-1/actions/runs/39895921388)
- Contract CI workflow: `.github/workflows/typed-pipeline-contracts.yml`
- 0.0.2 PR: [`#1`](https://github.com/baicie/ops-1/pull/1), Draft/Open
- No merge, no Ready state change, no tag movement, no release.
