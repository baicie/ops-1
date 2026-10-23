# ADR-013: Typed Pipeline Execution and Durable Job Recovery

- Status: Proposed / design only
- Date: 2026-10-23
- Deciders: OpsWeave architecture review
- Related: RFC 0.0.3, `contracts/schema/pipeline-ir.v1.schema.json`, `contracts/schema/durable-job.v1.schema.json`
- Gate: 0.0.2 must be merged to `main` before implementation

## Context

0.0.2 proves a data foundation with two independent plugins and a real Kernel Capability Gateway. 0.0.3 needs a typed pipeline runtime and durable job worker, but must not become a generic distributed workflow platform. The critical risks are:

1. an accepted graph that cannot be typed or deterministically executed;
2. a worker that writes after losing its lease;
3. a Kernel/Worker restart that duplicates an external side effect;
4. a "lease expired" assumption that the old worker has stopped;
5. mixing PostgreSQL transactional atomicity with cross-system idempotency.

## Decision

1. **IR is the source of truth.** Pipeline definitions are immutable, canonical JSON with a digest. `PipelineRevision` pins a digest. No UI graph format or database row is authoritative.
2. **Static validation before publication.** Node registry membership, port types, required inputs, DAG acyclicity, deterministic topological order and hard bounds are checked before a revision is published. Unknown types and cycles are rejected, not deferred to runtime.
3. **Built-in nodes only.** Source, Parse, Map, Filter, Validate and Sink are finite built-ins. No arbitrary scripts, no arbitrary HTTP in a node, no generic DAG optimizer.
4. **PostgreSQL job store.** Job state, attempts, leases, fences, checkpoints and results are persisted in PostgreSQL with explicit CAS/row-lock transitions. The implementation reuses the existing Kernel database and Node identity.
5. **Fencing at the side-effect boundary.** A lease is eligibility to try, not proof of exclusive execution. Every external write must present the current fence or use a sink-side idempotency key bound to the job/attempt/checkpoint. A stale worker is rejected before the side effect commits.
6. **Checkpoint is bounded state, not an event log.** A checkpoint contains an input cursor and a digest of resumable state, with monotonic sequence and fencing sequence. It is append-only and bounded by size.
7. **Separate atomicity domains.** PostgreSQL transitions are atomic in one transaction. Sink effects use a separate idempotent boundary and are verified by a unique `(jobId, fenceSequence)`/sink key. We do not claim a database transaction covers a remote sink.

## Consequences

Positive:
- deterministic plan and auditability;
- no silent acceptance of unexecutable graphs;
- stale workers cannot claim success at a fenced sink;
- restart recovery has a clear source of truth;
- finite scope prevents 0.0.3 from becoming an unbounded workflow platform.

Negative / costs:
- one more persistence layer and migration path;
- workers must implement fencing and idempotency explicitly;
- built-in node registry must be versioned and kept backwards-compatible;
- UI editor is intentionally deferred to 0.0.4.

## Rejected alternatives

- **SQLx/Postgres advisory lock only, no fence**: insufficient after a lease expires; old worker may still write.
- **At-least-once with automatic replay**: can duplicate external effects; violates the bounded sink contract.
- **Generic script executor**: violates security and scope gates.
- **Separate scheduler identity system**: duplicates Node enrollment and Capability authorization.
- **Kafka/Wasm/distributed DAG optimizer**: no 0.0.3 gate and unnecessary complexity.

## Implementation gate

No runtime code may be merged to `main` until:
1. PR #1 (0.0.2) is merged;
2. `feat/0.0.3-typed-pipeline` is cut from updated `main`;
3. contract conformance tests and the Schema/OpenAPI review pass;
4. the 10 acceptance scenarios in the RFC have a real CI environment plan.
