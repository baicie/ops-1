# 0.0.3 Runtime Reliability — Design and Fix Summary

Functional HEAD: `dfa68ab`  
PR #2: Draft / Open / not merged.

## Fixes landed

### Deadline as authority

- `authorize_lease()` checks `deadline_at` with `clock_timestamp()` after taking the
  Job row lock.
- `fence_authorize()` and `fence_authorize_effect()` (migration 0009) enforce the
  same deadline after their row lock.
- Claim, Start, Heartbeat, Checkpoint, Snapshot read/write, Catalog fenced Sink and
  Result all reject an expired Job.
- Completed Results remain readable by strict idempotent replay.

### Claim transaction semantics

- Claim Core returns `Claimed` or `Terminalized`.
- Successful and intentional-terminal claims commit.
- Database/technical errors roll back.
- Deadline and Attempts-Exhausted terminalization update Job, active Lease, active
  Attempt and Event.

### Strict batches and authoritative completion

- Catalog rejects any batch containing an invalid record before writing anything
  (`422 RECORD_VALIDATION_FAILED`).
- Worker requires `accepted == batch.len()`, `rejected = unknown = 0`.
- Kernel recomputes every `batch-N` Effect ID and fetches its Receipt through the
  restricted Catalog Service Identity; Job/Pipeline/Revision/Sink/Dataset/Schema/
  Digest/accepted totals must all match before SUCCEEDED.

### Worker identity and lifecycle

- Node-managed workers use a dedicated `opsweave.pipeline.worker` service principal
  with only Catalog read/write scope; arbitrary plugin principals cannot be requested.
- Independent Heartbeat Task runs every 10s; transient transport/5xx failures retry
  with bounded backoff; explicit 401/403/409/404 cancels execution.
- Workload tokens are refreshed before each batch and before final Effect verification,
  supporting jobs longer than the token TTL.
- Node Supervisor stops the live child when the marker is removed, Node is quarantined,
  or the bound Instance stops being READY; it uses bounded backoff and reaps children.

### Recovery harness

- Real PostgreSQL claim concurrency: 2/8/16/32 direct claims plus Claim-Next
  single/multi-job races.
- Real Catalog fence lock race with `pg_blocking_pids()` evidence for Commit and
  Rollback.
- Real Kernel SIGKILL and restart.
- Real two-Node natural Lease takeover.
- Real Node Runtime SIGKILL and restart (non-provider Node).
- 75+ second Job with independent heartbeat and a 15-second Kernel pause.
- Source negative tests: redirect, oversized chunked body, malformed JSON; source
  client disables environment proxies.

## Residuals

- Catalog reaper terminalization is not yet uniform with Claim Core.
- Supervisor quarantine/instance-stop/revocation has code but no dedicated full PID
  matrix.
- Source Security has address policy plus redirect/chunked/malformed tests, but no
  live DNS-rebinding/slow-header/slow-body matrix.
- Heartbeat transient retry is implemented; 429/500/503 injection is not a separate
  automated gate.
- Physical two-host acceptance is NOT_RUN.

These residuals keep the release decision at `PARTIAL_NOT_READY`.
