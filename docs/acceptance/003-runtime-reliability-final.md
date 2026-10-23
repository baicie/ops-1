# 0.0.3 Runtime Reliability Final — Evidence Report

Date: 2026-10-23 (Asia/Shanghai)  
Branch: `feat/0.0.3-typed-pipeline`  
Base: `a434a79`  
Final code HEAD: `f58da5e`  
PR: [`#2`](https://github.com/baicie/ops-1/pull/2) — **Draft / Open / not merged**  
Working tree: clean after report commit.

## A. Commits in this pass

```text
22b2843  Record final runtime gate status and missing recovery evidence
c9b176f  Make claim-next atomic and run worker heartbeat independently
a964dbb  Verify completed effect sets through catalog service identity
f58da5e  Enforce strict batches, accepted totals and job deadlines
```

No main/tag/release changes. No force push.

## B. Architecture changes

### R1.1 Strict batch semantics

- Catalog fenced sink now rejects the **entire batch with 422
  RECORD_VALIDATION_FAILED before any record/receipt write** if any record is
  invalid.
- `COMMITTED` now means all records validated and the transaction committed;
  there is no partial accepted/rejected success path.
- Worker no longer uses `batch.len()` as accepted count: it requires receipt
  `accepted == batch.len()`, `rejected == 0`, `unknown == 0`.
- Kernel sums authoritative Receipt `accepted` values and requires the total to
  equal `output.accepted`.

### R1.2 Job deadline

- New migration `0008_job_deadline.sql` adds `deadline_at` computed from Job
  submission time + `timeout_seconds`.
- Claim rejects an expired deadline and marks the Job `FAILED` with
  `JOB_DEADLINE_EXCEEDED` plus event.
- Claim-Next reaps expired candidates, excluding them from selection.
- Heartbeat returns `JOB_DEADLINE_EXCEEDED` instead of extending execution.
- Kernel Result verification rejects expired jobs.

Remaining gap: no dedicated deadline E2E and no unified terminalization of
attempts/leases for the reaper path.

### R2. Atomic Claim-Next

Claim-Next now selects, terminates exhausted/deadline jobs, claims, creates Lease
and increments Fence in one PostgreSQL transaction with `FOR UPDATE SKIP LOCKED`.

Remaining gap: no two-connection PG concurrency test at 8/16/32 workers.

### R2. Heartbeat

Worker starts an independent Task after Claim with 10s cadence and a shared
cancellation flag. Heartbeat failure stops later checkpoint/sink writes.

Remaining gap: no 70s execution, 429/500/503, Kernel-outage or race injection E2E.

### R5. Authoritative completion

Kernel recomputes every `batch-N` Effect ID, queries the restricted Catalog
Service Identity for each Receipt, and verifies COMMITTED/Job/Pipeline/Revision/
Sink/Dataset/Schema/Digest/accepted totals before accepting SUCCEEDED.

## C. Gate Matrix

| Gate | Status | Evidence |
|---|---|---|
| Catalog Schema | **PASS** | live service principal + dynamic dataset CI |
| Dynamic Dataset | **PASS** | `dynamic dataset: ... -> job SUCCEEDED records=2` |
| Node-managed Worker | **PASS** | single Node auto-claim CI |
| Atomic Claim-Next | **PARTIAL** | code atomic; no PG concurrency test |
| Heartbeat | **PARTIAL** | independent task; no long/outage E2E |
| Job Deadline | **PARTIAL** | code + migration; no E2E |
| Result Correctness | **PASS** | strict strict batch + authoritative set |
| Kernel Restart | **NOT_RUN** | no process kill/restart test |
| Two-Node Takeover | **NOT_RUN** | no two-Node Runtime test |
| Supervisor Lifecycle | **PARTIAL** | code paths; no full negative E2E |
| Source Security | **PARTIAL** | SSRF address matrix; no full HTTP server matrix |
| Catalog Lock Proof | **PARTIAL** | same-row fence; no pg_blocking_pids test |
| Authoritative Completion | **PASS** | Kernel queries Catalog Receipts |
| Legacy Regression | **PASS** | CI below |
| Runtime CI workflow | **NOT_RUN** | `.github/workflows/typed-pipeline-runtime.yml` missing |

## D. Database assertions

CI-covered: unique Job state transition, monotonic fence on takeover, old fence
rejection, stable Effect IDs, no duplicate records after crash/retry, Snapshot
integrity, Result replay identity, and strict accepted totals.

NOT covered: 8/16/32 concurrent claims, natural lease expiry two-Node takeover,
Kernel restart, pg_locks blocking proof, deadline terminalization E2E.

## E. CI evidence

- Data Foundation OCI [39967592684](https://github.com/baicie/ops-1/actions/runs/39967592684) — **SUCCESS**
- Standard CI [39967592760](https://github.com/baicie/ops-1/actions/runs/39967592760) — **SUCCESS**
- Typed Pipeline Contract [39967592797](https://github.com/baicie/ops-1/actions/runs/39967592797) — **SUCCESS**
- 0.0.1 Legacy: PASS=21 FAIL=0
- 0.0.2 Data Foundation: PASS

Retained assertions:

```text
PASS  strict batch semantics rejected partial invalid batch before any write
PASS  dynamic dataset -> live schema pin -> job SUCCEEDED records=2
PASS  Node Runtime auto-claimed and completed job without manual worker invocation
PASS  stable Effect / snapshot / result replay gates
```

## F. Final decision

```text
PARTIAL_NOT_READY
```

Reason: R1 data-correctness fixes and authoritative completion are real and green,
but Kernel restart, two-Node automatic takeover, concurrency stress, long-running
heartbeat acceptance and the dedicated Runtime CI workflow are not executed.

PR #2 must remain Draft. No merge, tag, force-push or release was performed.
