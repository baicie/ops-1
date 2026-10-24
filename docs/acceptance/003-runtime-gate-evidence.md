# 0.0.3 Runtime Gate Evidence — RC V4

Branch: `feat/0.0.3-typed-pipeline`  
Base: `a434a79`  
Code HEAD: `130a446`  
Report HEAD: this commit  
PR #2: [Draft/Open](https://github.com/baicie/ops-1/pull/2) (not merged, not Ready).

## CI runs (code HEAD 8354c2d)

- Data Foundation OCI: [40115842541](https://github.com/baicie/ops-1/actions/runs/40115842541) — SUCCESS (attempt 1 and attempt 2)
- Runtime workflow: [40115842524](https://github.com/baicie/ops-1/actions/runs/40115842524) — SUCCESS (attempt 1 and attempt 2)
- Standard CI: run on the same HEAD (`ci`) — SUCCESS
- Typed Pipeline Contracts: run on the same HEAD — SUCCESS

A **second clean rerun of the same code HEAD** was executed: Data Foundation
and Runtime runs `40115842541` / `40115842524` both have `run_attempt=2` and
`conclusion=success`. This is the required repeat run for order-independent
fixture cleanup.

## Gate matrix

| Gate | Status | Evidence |
|---|---|---|
| Unified Terminalization | **PASS** | 8 PostgreSQL tests: single writer/idempotent; Reaper vs Claim/Result/Cancel/Reaper; deadline priority; SQL failure rollback; bounded batch |
| Claim-Next 2/8/16/32 | **PASS** | `claim-next fanout 2: 2x200 ... 32: 32x200`; empty queue 204 |
| Catalog Lock Proof | **PASS** | SQL fence `pg_blocking_pids`: commit and rollback, `claim=409` |
| Deadline / Lease / Fence | **PASS** | deadline rejects Claim and Heartbeat; fence takeover evidence |
| Kernel Restart | **PASS** | `oldFence=1 newFence=2 recovery=60s` |
| Two-Node Natural Takeover | **PASS** | `takeover=64s oldLease=EXPIRED effects=3` |
| Node Runtime SIGKILL | **PASS** | `takeover=64s`, replacement fence=2 |
| Orphan Worker | **PASS** | orphan PID survived with PPID=1; replaced Node fence=2; no new Records/Effects; 1001/3 |
| Supervisor Lifecycle | **PARTIAL** | real marker remove/restore, worker SIGKILL, 3-round crash loop, Node revocation/quarantine worker stop, Node SIGKILL/orphan; Instance STOP/Node generation/Node SIGTERM still missing |
| Source Security | **PARTIAL** | 14 worker source tests: DNS rebinding/mixed answers, TCP peer pinning, slow header/body, redirects, proxy bypass/count, chunked/CL mismatch; missing source-timeout→no-Sink integration gate |
| Heartbeat Fault Injection | **PARTIAL** | real mock HTTP: single/continuous 429/500/502/503, disconnect, 401/403/404/409, bounded 3 attempts; no >TTL outage, Deadline-vs-Sink integration, or Retry-After |
| Runtime CI | **PASS** | dedicated workflow green |
| Legacy Regression | **PASS** | `PASS=21 FAIL=0` |

## Key log excerpts

```text
== terminalization service PostgreSQL tests
running 8 tests
test result: ok. 8 passed; 0 failed

Supervisor Lifecycle Golden Path: PASS
crash-loop round=1/2/3: new supervised PIDs
PASS Node revocation/quarantine stopped supervised worker pid=19540

claim-next fanout 2: 2x200 distinct=2 dbLeases=2
claim-next fanout 8: 8x200 distinct=8 dbLeases=8
claim-next fanout 16: 16x200 distinct=16 dbLeases=16
claim-next fanout 32: 32x200 distinct=32 dbLeases=32
claim-next empty queue: status=204

Orphan Worker Golden Path: PASS
orphan worker survived node SIGKILL (pid=16213 ppid=1) but produced no new effects
oldFence=1 newFence=2 takeover=83s records=1001 effects=3

Node Runtime SIGKILL: oldFence=1 newFence=2 attempts=2 effects=3 takeover=64s
```

## Assertions behind Terminalization

Each test asserts all five records, not only HTTP status:

- `pipeline_jobs.status`
- active `pipeline_job_leases`
- unfinished `pipeline_job_attempts`
- exactly one `pipeline_job_results`
- exactly one terminal `pipeline_job_events`

The SQL-failure test creates a trigger that aborts the event insert, then asserts
the transaction rolled back Job, Lease, Attempt, Result and Event.

## Remaining work

1. Supervisor PID matrix: Instance STOP, Node generation change, Node SIGTERM.
2. Source: live source-timeout→no-Sink integration gate; explicit infinite-chunk
   (current size-bound test is finite chunks); full TCP peer assertion.
3. Heartbeat: outage > Lease TTL, Deadline-vs-Sink concurrency, and Retry-After
   (or explicitly assert it remains unsupported).
4. Both clean CI attempts are recorded above; no further run required for this
   evidence revision.

## Release Decision

```text
PARTIAL_NOT_READY
```

Terminalization is no longer a blocker; the remaining blockers are the three
explicit P1 evidence gaps above. PR #2 remains Draft.
