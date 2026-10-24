# 0.0.3 Typed Pipeline Contract Readiness

Date: 2026-10-23  
Branch: `feat/0.0.3-typed-pipeline-design`  
Base: `main` at `4ce130b`  
Implementation status: **BLOCKED by 0.0.2 version gate**

## Status

| Item | Status | Evidence |
|---|---|---|
| Architecture RFC | PASS | `docs/architecture/0.0.3-typed-pipeline-rfc.md` |
| Pipeline IR JSON Schema | PASS | `contracts/schema/pipeline-ir.v1.schema.json` |
| Durable Job JSON Schema | PASS | `contracts/schema/durable-job.v1.schema.json` |
| OpenAPI draft | PASS | `contracts/openapi/typed-pipeline-v1.yaml` |
| ADR-013 execution/persistence/recovery | PASS | `docs/adr/ADR-013-typed-pipeline-and-durable-jobs.md` |
| Trusted NodeRegistry signature conformance | PASS (contract) | `tests/contract/validate_typed_pipeline.py` verifies registry digest, required signature, exact port signatures and per-node config schema |
| Schema Revision conformance | PASS (contract) | Sink config revision is checked against `contracts/examples/schema-catalog.json`; unknown/unpublished revision rejected |
| Canonical JSON / digest | PASS (contract) | Pipeline, registry and execution-plan canonical digests are recomputed |
| Durable state machine / Claim / Checkpoint / Fence conformance | PASS (contract) | Duplicate claim, illegal transition, monotonic fence/checkpoint and stale-fence checks |
| Contract conformance CI | PASS | `typed-pipeline-contracts` run `39895921388` on `61c1f53` |
| Catalog Sink atomic fence boundary | **BLOCKED** | Existing `data.catalog.v1` has idempotent batch records but no Job/Fence identity; see `docs/architecture/0.0.3-fenced-sink.md` |
| Minimal executable closed loop | **BLOCKED** | PR #1 is Draft/Open, not merged to `main`; implementation gate closed |
| Real Lease/Fencing/Checkpoint/Sink E2E | **BLOCKED** | Requires Catalog fenced-receipt implementation plus Runtime after gate |
| Minimal HTTP/JSON Source → Dataset runtime | **NOT_RUN** | No runtime implementation is allowed before Gate C |

## Conformance result

```text
TYPED PIPELINE CONTRACT PASS
  pipeline schema: valid
  durable job schema: valid
  examples: 12 validated
  DAG/type/cycle/limits/state/fencing/schema checks: valid
  canonical JSON and digest checks: valid
  OpenAPI operations: 10 checked
```

The test is a contract/semantic test only. It **does not** execute a pipeline, does not claim a distributed run, and does not mock a Kernel/Worker E2E.

## Gate reason

The roadmap requires 0.0.2 to pass and enter `main` before 0.0.3 implementation begins. PR #1 is currently Draft/Open at `f207b75` (the 0.0.2 review-fix work is on `feat/0.0.2-data-foundation`). Per the explicit instruction, 0.0.3 runtime implementation is **not** being mixed into PR #1.

## Required next steps after gate opens

1. Merge 0.0.2 through the normal review process (human authorization required; not performed here).
2. Cut `feat/0.0.3-typed-pipeline` from updated `main`.
3. Implement the minimum worker path against these contracts.
4. Run real Kernel/PostgreSQL/Node/Capability tests for the ten RFC acceptance scenarios.
5. Do not claim PASS for the implementation until CI is green on the implementation commit.
