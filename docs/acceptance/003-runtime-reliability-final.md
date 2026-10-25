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
- Instance STOP and recovery are tested by scaling the Catalog deployment to
  zero and back; the recovered Worker has a new PID and the Node adopts the
  recovered Instance.
- Node generation change is tested against a real Node Runtime: the stale
  generation stops the Worker; restoring the durable generation and restarting
  the Node releases quarantine and starts exactly one new Worker.
- Node SIGTERM is tested against a live supervised Worker; the Node process exits
  and the harness records the orphan child PPID=1, then reaps only that PID.
- Worker self-SIGKILL is recovered by supervisor backoff (2s, 4s, … capped 30s);
  three consecutive kills produce three new supervised PIDs.

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

Tests cover DNS rebinding/mixed answers with deterministic resolution, actual
TCP peer pinning, slow header/body, infinite chunked body, redirect
301/302/303/307/308, malformed/truncated JSON, Content-Length mismatch,
environment proxy bypass with a counted proxy, and a normal allowed source.
A real published PipelineRevision with a slow HTTP source additionally proves
the Worker fails before any Snapshot/Sink write: records=0, effects=0, result=1.

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

A real local mock Kernel exercises single/continuous 429/500/502/503, transport
disconnect and 401/403/404/409; the Worker sends exactly 1 or 3 requests and
then cancels. A real Heartbeat-only fault proxy on Node A, followed by the real
60s `expires_at` and Node B takeover, proves oldFence=1 → newFence=2,
attempts=2, 1001 Records, 3 Effects, one Result and zero active Leases.
Deadline-vs-Sink concurrency, active-Job SIGTERM, timestamp-gap assertion and
Retry-After remain gaps.

## 6. Explicit Known Limits

These are not claimed as PASS:

1. Deadline-vs-Sink two-transaction race is not automated; the SQL authority
   function rechecks `clock_timestamp()` after the Job row lock in code review.
2. SIGTERM while a Job is active or during restart backoff is not automated;
   idle SIGINT/SIGTERM stop+reap is automated.
3. Heartbeat request timestamp-gap assertion and Retry-After remain gaps; the
   retry scheduling code no longer adds the full normal interval.
4. Physical multi-host, mTLS, rootless Docker, OCI attestation and production HA
   are outside this RC.

## 7. Terminalization State Machine

```text
QUEUED ──claim──> CLAIMED ──start──> RUNNING
  │                  │                │
  ├──cancel──────────┴────────────────┴──> CANCELLED
  ├──reaper(deadline/attempts)───────────> FAILED
  └──worker result───────────────────────> SUCCEEDED | FAILED | CANCELLED
```

Terminal states are absorbing. A second terminal transition is an idempotent
no-op only when the requested status matches; a different status is a conflict.
The Result row primary key guarantees at most one Result.

## 8. Worker Identity Trust Boundary

- Node enrollment creates a Node credential; only Node Runtime receives it.
- Worker identity is `n:<node>:i:<instance>:b:<boot>` and must match Node headers,
  generation, assigned Instance and Boot ID.
- Worker auth additionally requires a fresh Node heartbeat and READY/START
  Instance; an orphan worker loses authority when Node freshness/Lease/Fence
  expires.
- A Worker must never receive the Node credential through Pipeline input; it
  reads the Node identity file owned by Node Runtime.
- Kernel service identities (`opsweave.kernel.catalog`,
  `opsweave.pipeline.worker`) are narrower than arbitrary plugin principals.

## 9. Source Security Threat Model

Assets: external source URL, DNS answers, resolved IP, HTTP response bytes, and
the Catalog sink.

Trust boundaries:

1. Pipeline input/Config → Worker SourcePolicy;
2. DNS answer → pinned socket address;
3. HTTP client/proxy environment → actual TCP peer;
4. source JSON → bounded Record array;
5. Worker → Kernel workload token / Catalog fenced transaction.

Attacks and controls:

| Attack | Control | Test |
|---|---|---|
| loopback/private/metadata/metadata IPv6 | address classification, allowlist | address matrix; redirect tests |
| redirect to private | redirect policy none | 301/302/303/307/308 |
| DNS rebinding | resolve once, check every answer, pin resolved IP | deterministic rebinding/mixed tests; TCP peer assertion |
| environment proxy bypass | `.no_proxy()` | counted local proxy; zero proxy requests |
| chunked/CL oversized | length + streaming cap | chunked/CL tests |
| slow header/body | connect/request/read timeouts | local slow HTTP fixture; bounded failure |
| malformed/truncated JSON | JSON parse/shape failure | unit tests |

The tests use deterministic local resolution and a local proxy; they do not
prove a hostile system resolver cannot influence the process before the policy
is applied. Production should still use a trusted resolver/network policy.

## 10. Failure Recovery Runbook

1. **Job stuck RUNNING**: check `pipeline_jobs`, `pipeline_job_leases`,
   `pipeline_job_attempts`, `pipeline_job_results`, `pipeline_job_events`.
   Trigger a claim-next to run the bounded Reaper; do not issue ad-hoc full-table
   UPDATEs.
2. **Reaper suspected duplicate**: inspect `pipeline_job_results` primary key,
   event count per job, and active lease count; run the terminalization tests.
3. **Node lost**: confirm Node `last_seen_at`/status, wait for Lease expiry, let
   the other Node claim; verify old fence cannot write.
4. **Orphan worker suspected**: record PID/PPID/Boot/Worker/Lease/Fence; verify
   Node freshness and Lease expiry; confirm no new Effect/Records after takeover;
   terminate only the recorded harness-owned PID.
5. **Kernel restart**: restart Kernel, verify migrations, nodes re-enroll, then
   observe `claim-next` takeover; do not edit Lease expiry.
6. **CI failure**: preserve `/tmp/data-kernel.log`, node logs, worker logs and
   PostgreSQL query output; do not extend sleeps to hide races.
