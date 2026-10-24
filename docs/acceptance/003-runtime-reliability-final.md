# 0.0.3 Runtime Reliability — Design, Failure Semantics, Known Limits

Branch: `feat/0.0.3-typed-pipeline`  
Base: `a434a79`  
This document describes behavior, not CI evidence (see `003-runtime-gate-evidence.md`).

## 1. Job Terminalization

All terminal transitions go through one internal service in `apps/kernel/src/jobs.rs`.
It takes the Job row lock and performs, in one transaction:

1. reject/observe an already-terminal Job (idempotent no-op);
2. update `pipeline_jobs.status` and last error;
3. revoke or release every ACTIVE Lease;
4. finalize all CLAIMED/RUNNING Attempts;
5. insert exactly one `pipeline_job_results` row (`ON CONFLICT DO NOTHING`);
6. insert one terminal Event only when the transition was actually applied;
7. commit, then write Audit outside the Job lock.

Callers:

- Claim-Next bounded Reaper;
- Claim Core deadline;
- Claim Core attempts exhausted;
- Worker Result (`SUCCEEDED`/`FAILED`/`CANCELLED`);
- User Cancel;
- any future explicit terminal path.

### Deterministic priority

If both conditions are true, **`JOB_DEADLINE_EXCEEDED` wins over
`JOB_ATTEMPTS_EXHAUSTED`**. The Reaper computes the code from the same predicate
it selects, and Claim Core checks deadline first after the Job row lock.

### Reaper bounds

The Reaper never runs an unbounded `UPDATE`. It selects at most 100 candidates
with `FOR UPDATE SKIP LOCKED`, then calls the terminalization service for each.
Remaining Jobs are handled by subsequent Claim-Next calls.

### Concurrency semantics

- Reaper vs Claim: both need the Job row lock; one terminal transition wins.
- Reaper vs Result: Result needs the same Job row lock and a live Lease; after
  terminalization the Result is rejected and cannot overwrite the terminal state.
- Reaper vs Cancel: the first transition wins; the second observes terminal.
- Reaper vs Reaper: SKIP LOCKED prevents duplicate work; events/results are unique.
- Reaper vs Heartbeat: Heartbeat needs the Job row lock and a live Lease; after
  terminalization it fails closed.
- SQL failure inside terminalization rolls back the whole transaction; a trigger
  injection test verifies Job/Lease/Attempt/Result/Event remain unchanged.

### Result semantics

Every terminal state has exactly zero or one Result row (primary key enforces at
most one). SUCCEEDED additionally requires Kernel-side Catalog Receipt
verification. A replayed Result with the same worker/lease/fence/digest is
idempotent; a different one is a conflict.

## 2. Deadline / Lease / Fence

- Deadline is evaluated after the Job row lock with database `clock_timestamp()`,
  not the application process clock.
- Claim, Start, Heartbeat, Checkpoint, Snapshot, Catalog fenced Sink and Result
  all reject after the deadline.
- **Linearization contract:** a Claim or Heartbeat that obtained authorization
  before the deadline may complete its own transaction; a transaction is not
  retroactively invalidated by commit time. The Catalog fenced SQL rechecks
  deadline inside the Catalog write transaction, so a write that reaches Catalog
  after the deadline is rejected even if an earlier authorization was valid.
  We do not claim "no database COMMIT can ever occur after the deadline".
- Fence is monotonic per Job. The old worker cannot write after a higher fence
  exists; Catalog applies the same Job row lock and fence check.

## 3. Supervisor and Orphan Workers

- Worker authentication requires Node READY, non-revoked, matching generation,
  READY/START Instance, and **fresh Node `last_seen_at`**
  (`OPSWEAVE_NODE_STALE_SECONDS`, default 25s).
- `kill_on_drop(true)` is not considered proof for SIGKILL. A SIGKILLed Node
  cannot run Drop; the worker may survive as an orphan.
- The orphan test preserves the old worker and observes PID/PPID/Boot/Lease/Fence.
  The replacement Node takes over after natural Lease expiry; the old worker's
  old fence cannot commit new Catalog effects. The test observes no Records or
  Effect increase after takeover.
- Marker removal, Instance no longer READY, Node quarantine and Node generation
  change are checked by the supervisor's 500ms control loop; it kills the live
  child.
- Worker self-SIGKILL is recovered by supervisor backoff (2s, 4s, … capped 30s).

## 4. Source Security

Implemented:

- explicit `SourcePolicy` constructed from env at Worker startup (unit tests use
  explicit allowlists; no global env mutations between parallel tests);
- `http`/`https` only, no credentials, no fragment;
- localhost/private/metadata/ULA/link-local/mapped IPv6 rejection;
- all DNS answers checked and the first address pinned through `Client::resolve`;
- no redirects; `.no_proxy()` to ignore environment proxies;
- Content-Length cap, streaming chunk cap, total timeout, per-read timeout;
- source JSON array/items shape and record count limits.

Tests currently cover redirect 301/302/303/307/308, malformed JSON,
Content-Length mismatch/truncated body, oversized chunked body and address
classification. A live DNS-rebinding/slow-header/proxy fixture matrix is not yet
implemented and remains a P1 gap.

## 5. Heartbeat Failure Policy

- 10s cadence, 60s Lease.
- 2xx: success.
- 401/403/404/409: fatal; cancellation flag is set immediately.
- 429/500/502/503/transport error: bounded retry; at most 3 transient failures,
  2s fixed backoff between retries. `Retry-After` is not trusted/implemented.
- After the third transient failure the worker cancels; it does not retry forever.
- A cancelled worker checks the flag before opening a new Sink Effect.
- Kernel deadline/cancel/fence checks remain authoritative; a stale worker cannot
  commit after the new fence.

The status decision table is unit-tested; deterministic HTTP fault injection
against a mock Kernel is not yet implemented.

## 6. Explicit Known Limits

These are not claimed as PASS:

1. Full Supervisor PID matrix for Quarantine, Instance STOP, Node generation and
   credential revocation is not yet a single complete automated matrix.
2. Source Security lacks live DNS rebinding, slow-header/slow-body and real proxy
   environment tests.
3. Heartbeat lacks deterministic 429/500/503 mock-server injection; only the
   decision table and bounded retry are tested.
4. Physical multi-host, mTLS, rootless Docker, OCI attestation and production HA
   are outside this RC.
