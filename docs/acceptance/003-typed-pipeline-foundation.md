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
- deadline authority at Claim, Heartbeat, Snapshot, Sink and Result;
- full Node-managed Worker supervisor matrix: marker, Instance STOP/recovery,
  Node generation quarantine/release, Node revocation, Node SIGTERM, crash loop;
- bounded HTTP source security tests and a real slow-source no-Sink gate;
- deterministic Heartbeat HTTP fault injection for bounded retry and fatal codes.

## Boundary

This is a single-host CI reference: two independent Node Runtime processes, one
PostgreSQL, one Kernel, local OCI containers. It is not production HA, mTLS,
rootless-Docker certification, or OCI attestation.

## V5 scope note

This RC adds reliability and security evidence only; it does not add 0.0.4
business capability. The only remaining non-PASS gate is Heartbeat lifecycle
(outage > Lease TTL, Deadline-vs-Sink concurrency, Retry-After), recorded in
`003-runtime-gate-evidence.md`.

## Evidence

See `003-runtime-reliability-final.md` for semantics and
`003-runtime-gate-evidence.md` for commands, CI URLs and exact gate status.
