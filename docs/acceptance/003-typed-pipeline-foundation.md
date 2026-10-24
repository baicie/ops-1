# 0.0.3 Typed Pipeline Foundation — Functional Baseline

Branch: `feat/0.0.3-typed-pipeline`  
Base: `a434a79`  
Functional HEAD: `dfa68ab`  
PR #2: Draft / Open / not merged.

## Functional baseline

This branch implements the 0.0.3 experimental typed pipeline runtime:

- signed typed Pipeline Registry and linear ExecutionPlan;
- immutable PipelineRevision with pinned Dataset UUID, Schema Revision and Schema Digest;
- live Catalog Schema resolution through a restricted Kernel service identity;
- dynamic Dataset → Published Schema → Pipeline → Job → Worker → fenced Records;
- PostgreSQL JobStore, Claim, Lease, Fence, Checkpoint, Snapshot and Result;
- Node Runtime-managed Worker with automatic Claim-Next discovery;
- catalog fenced sink with stable Effect IDs and Receipt recovery;
- strict all-or-nothing Catalog batches;
- Deadline authority across Claim, Heartbeat, Snapshot, Sink and Result.

## Evidence summary

- live dynamic Dataset E2E: PASS;
- single-Node automatic Worker: PASS;
- two independent Node Runtimes on one CI host: PASS (natural Lease expiry);
- Kernel SIGKILL/restart recovery: PASS;
- Node Runtime SIGKILL recovery: PASS (victim role is the non-provider Node);
- 1001-record multi-batch crash recovery: PASS;
- fenced Result replay and authoritative Receipt completion: PASS.

Detailed, reproducible evidence is in `003-runtime-gate-evidence.md` and
`003-runtime-reliability-final.md`.

## Boundary

This is not a production-HA certification. It is a single CI host with two
independent Node Runtime processes, one PostgreSQL, one Kernel and local OCI
Catalog providers. Physical multi-host acceptance remains `NOT_RUN`.

PR #2 remains Draft; nothing was merged, tagged or released.
