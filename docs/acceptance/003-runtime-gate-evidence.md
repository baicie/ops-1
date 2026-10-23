# 0.0.3 Runtime Gate Evidence — V2

Date: 2026-10-23 (Asia/Shanghai)  
Branch: `feat/0.0.3-typed-pipeline`  
Base: `a434a79`  
Code HEAD: `6ca22dd`  
PR #2: Draft / Open / not merged.

## Implemented this pass

### Deadline authority

- `authorize_lease()` now checks `deadline_at` using `clock_timestamp()` after the
  Job row lock is acquired, so a lock wait cannot authorize work with a stale
  transaction timestamp.
- `fence_authorize()` and `fence_authorize_effect()` (migration `0009`) check the
  deadline after acquiring the Job row lock.
- Start, Heartbeat, Checkpoint, Result, Snapshot write and Snapshot read reject
  expired Jobs.
- Catalog Sink cannot commit a new Effect after the deadline.
- Result replay for an already persisted terminal Result remains a pure read.

### Claim transaction semantics

- Claim Core now returns `ClaimOutcome::Claimed` or `ClaimedOutcome::Terminalized`.
- Successful Claim commits atomically.
- Intentional terminalization commits.
- Technical/database errors roll back.
- Attempts exhaustion and deadline now terminate the Job, revoke active leases,
  fail active attempts and write an event.

### Remaining correctness gap

The Claim-Next reaper still performs a bulk `UPDATE` for exhausted/deadline Jobs
without the same attempts/lease/event fan-out as Claim Core. It is excluded from
selection after the update, but terminalization consistency is not uniform yet.

## Executed tests

Data Foundation OCI CI [39972487260](https://github.com/baicie/ops-1/actions/runs/39972487260) — SUCCESS.

New real assertions:

```text
PASS  expired deadline is rejected and terminalized
PASS  active lease cannot heartbeat past deadline
```

The full Data Foundation suite, dynamic Dataset live Catalog path, Node-managed
single-Node Worker, strict batch, authoritative Effect completion and legacy
regressions remain green.

## Gate status

| Gate | Status |
|---|---|
| Deadline authority across start/heartbeat/checkpoint/result/snapshot | PASS |
| Deadline at Catalog SQL fence | PASS (code; no lock-wait-during-deadline E2E) |
| Claim transaction rollback/commit separation | PASS |
| Uniform Terminalization | PARTIAL |
| Claim concurrency 2/8/16/32 | NOT_RUN |
| 70s Heartbeat / network fault E2E | NOT_RUN |
| Catalog lock `pg_blocking_pids` proof | NOT_RUN |
| Kernel Restart | NOT_RUN |
| Two-Node Automatic Takeover | NOT_RUN |
| Supervisor lifecycle E2E | NOT_RUN |
| HTTP Source full negative matrix | NOT_RUN |
| Runtime CI workflow | NOT_RUN |
| Legacy regression | PASS |

## Decision

```text
PARTIAL_NOT_READY
```

The P0 deadline authorization hole and Claim commit/rollback separation are fixed
and covered by real CI. The required concurrency, Heartbeat-fault, Kernel restart,
Two-Node takeover, Supervisor and Catalog-lock E2E remain unexecuted, so PR #2
cannot become Ready.
