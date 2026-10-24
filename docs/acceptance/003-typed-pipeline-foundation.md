# 0.0.3 Typed Pipeline Foundation — Functional Scope

Branch: `feat/0.0.3-typed-pipeline`  
Base: `a434a79`  
PR #2: Draft/Open; not merged.

This branch implements the experimental typed pipeline runtime:

- signed Pipeline Registry and linear ExecutionPlan;
- immutable PipelineRevision with pinned Dataset/SchemaRevision/SchemaDigest;
- live Catalog Schema resolution through a restricted Kernel identity;
- dynamic Dataset → Published Schema → Pipeline → Job → Worker → fenced Records;
- PostgreSQL JobStore, Claim/Lease/Fence/Checkpoint/Snapshot/Result;
- Node Runtime-managed Worker and Claim-Next discovery;
- one authoritative Job terminalization service;
- fenced Catalog sink with stable Effect IDs and authoritative Receipts;
- strict all-or-nothing Catalog batches;
- deadline authority at Claim, Heartbeat, Snapshot, Sink and Result.

## Boundary

This is a single-host CI reference: two independent Node Runtime processes, one
PostgreSQL, one Kernel, local OCI containers. It is not production HA, mTLS,
rootless-Docker certification, or OCI attestation.

## Evidence

See `003-runtime-reliability-final.md` for semantics and
`003-runtime-gate-evidence.md` for commands, CI URLs and exact gate status.
