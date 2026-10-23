# 0.0.3 Runtime Gate Evidence

Date: 2026-10-24 (Asia/Shanghai)  
Branch: `feat/0.0.3-typed-pipeline`  
Base: `a434a79`  
Code HEAD: `99f2de8`  
PR #2: Draft / Open / not merged.

## Implemented and exercised

### Deadline authority
- `authorize_lease()` checks `clock_timestamp()` after the Job row lock.
- `fence_authorize()` / `fence_authorize_effect()` (migration 0009) check Deadline
  after taking the same row lock.
- Start, Heartbeat, Checkpoint, Result, Snapshot write/read and Catalog Sink reject
  expired Jobs.
- Past Results remain replayable.

CI assertions:

```text
PASS  expired deadline is rejected and terminalized
PASS  active lease cannot heartbeat past deadline
```

### Claim transaction outcomes
- Claim Core returns `Claimed` or `Terminalized`.
- Successful and terminal claims commit.
- Technical errors roll back.
- Attempts/Deadline terminalization revokes active leases, fails attempts and writes
  events.

### Strict Catalog batches
- Any invalid record rejects the whole batch with `422 RECORD_VALIDATION_FAILED`
  before writes.
- `COMMITTED` means all records were accepted.
- Worker requires `accepted == batch.len()`, `rejected == 0`, `unknown == 0`.
- Kernel aggregates authoritative receipt accepted counts.

### Node-managed worker identity
- Added `opsweave.pipeline.worker` service principal with only
  `dataset:read`/`dataset:write`.
- Node control credential may request this principal for a trusted worker; arbitrary
  plugin principals are rejected.
- This removed the accidental dependency on the first READY plugin instance having
  an Integration grant.

### Two independent Node Runtimes — natural Lease takeover
Real CI evidence:

```text
two-node job: 40f7d457-0b59-4936-aa9c-97e9d983c2e9
PASS  two independent Node Runtimes:
      job=40f7d457-0b59-4936-aa9c-97e9d983c2e9
      oldFence=1 newFence=2 attempts=2 effects=3
      takeover=65s oldLease=EXPIRED
Two-Node Takeover Golden Path: PASS
```

- Initial executor: Node A (real child Worker).
- Node A marker removed and Worker SIGKILLed.
- No database `expires_at` update.
- Lease expired naturally after 60s.
- Node B auto-claimed with fence 2.
- Snapshot reused; first committed Effect reused; 1001 job-scoped records and 3
  Effects exactly.

## Gate Matrix

| Gate | Status | Evidence |
|---|---|---|
| Catalog Schema | PASS | live Catalog service identity |
| Dynamic Dataset | PASS | dynamic UUID E2E |
| Node-managed Worker | PASS | single Node auto-claim |
| Atomic Claim-Next | PARTIAL | code atomic; no 2/8/16/32 PG concurrency test |
| Heartbeat | PARTIAL | independent Task; no 70s/fault E2E |
| Job Deadline | PASS | real claim/heartbeat rejection; Sink SQL code |
| Result Correctness | PASS | strict accepted + authoritative receipts |
| Kernel Restart | NOT_RUN | no process kill/restart test |
| Two-Node Takeover | PASS | natural 65s lease takeover in CI |
| Supervisor Lifecycle | PARTIAL | code paths; no PID-level negative matrix |
| Source Security | PARTIAL | SSRF address matrix; no full HTTP server matrix |
| Catalog Lock Proof | PARTIAL | same-row lock; no pg_blocking_pids test |
| Authoritative Completion | PASS | Kernel queries Catalog receipts |
| Legacy Regression | PASS | 0.0.1 PASS=21; 0.0.2 PASS |
| Runtime CI workflow | NOT_RUN | dedicated workflow not created |

## CI

- Data Foundation OCI [39983716889](https://github.com/baicie/ops-1/actions/runs/39983716889) — SUCCESS
- Standard/Contract runs on the same commit — SUCCESS
- 0.0.1 Legacy: PASS=21 FAIL=0
- 0.0.2 Data Foundation: PASS

## Decision

```text
PARTIAL_NOT_READY
```

Kernel restart, 2/8/16/32 concurrent Claim, 70s heartbeat fault injection, Catalog
`pg_blocking_pids` proof, Supervisor PID-level matrix and the dedicated Runtime CI
workflow remain unexecuted. PR #2 must remain Draft.
