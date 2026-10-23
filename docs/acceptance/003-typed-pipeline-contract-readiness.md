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
| Contract conformance tests | PASS (local) | `python3 tests/contract/validate_typed_pipeline.py` |
| Contract conformance CI | PASS | `typed-pipeline-contracts` run `39892613830` on `838cf51` |
| Minimal executable closed loop | BLOCKED | PR #1 is Draft/Open, not merged to `main`; implementation gate closed |
| Real Lease/Fencing/Checkpoint E2E | BLOCKED | Requires implementation after gate |

## Conformance result

```text
TYPED PIPELINE CONTRACT PASS
  pipeline schema: valid
  durable job schema: valid
  examples: 9 validated
  DAG/type/cycle/limits/state/fencing checks: valid
  OpenAPI operations: 10 checked
```

The test is a contract/semantic test only. It **does not** execute a pipeline, does not claim a distributed run, and does not mock a Kernel/Worker E2E.

## Gate reason

The roadmap requires 0.0.2 to pass and enter `main` before 0.0.3 implementation begins. PR #1 is currently Draft/Open at `48ab0b4` (the 0.0.2 review-fix work is on `feat/0.0.2-data-foundation`). Per the explicit instruction, 0.0.3 runtime implementation is **not** being mixed into PR #1.

## Required next steps after gate opens

1. Merge 0.0.2 through the normal review process (human authorization required; not performed here).
2. Cut `feat/0.0.3-typed-pipeline` from updated `main`.
3. Implement the minimum worker path against these contracts.
4. Run real Kernel/PostgreSQL/Node/Capability tests for the ten RFC acceptance scenarios.
5. Do not claim PASS for the implementation until CI is green on the implementation commit.
