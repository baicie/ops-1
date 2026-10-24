# 0.0.3 Runtime Gate Evidence — RC V4

Branch: `feat/0.0.3-typed-pipeline`  
Base: `a434a79`  
Code HEAD: `8354c2d`  
Report HEAD: this commit  
PR #2: [Draft/Open](https://github.com/baicie/ops-1/pull/2) (not merged, not Ready).

## CI runs (code HEAD 8354c2d)

- Data Foundation OCI: [40112009168](https://github.com/baicie/ops-1/actions/runs/40112009168) — SUCCESS (attempt 1 and attempt 2)
- Runtime workflow: [40112009148](https://github.com/baicie/ops-1/actions/runs/40112009148) — SUCCESS (attempt 1 and attempt 2)
- Standard CI: run on the same HEAD (`ci`) — SUCCESS
- Typed Pipeline Contracts: run on the same HEAD — SUCCESS

A **second clean rerun of the same code HEAD** was executed after the docs-only
change: Data Foundation and Runtime runs `40112009168` / `40112009148` both have
`run_attempt=2` and `conclusion=success`. This is the required repeat run for
order-independent fixture cleanup.

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
| Supervisor Lifecycle | **PARTIAL** | real marker removal, worker SIGKILL restart, SIGKILL/orphan; no complete Instance STOP/Quarantine/Generation/revocation PID matrix |
| Source Security | **PARTIAL** | address matrix + redirects 301/302/303/307/308 + chunked/CL-mismatch/malformed; no live DNS-rebinding/slow-header/proxy fixture |
| Heartbeat Fault Injection | **PARTIAL** | decision table for 429/500/503/401/403/404/409; bounded retry; no mock-server HTTP injection |
| Runtime CI | **PASS** | dedicated workflow green |
| Legacy Regression | **PASS** | `PASS=21 FAIL=0` |

## Key log excerpts

```text
== terminalization service PostgreSQL tests
running 8 tests
test result: ok. 8 passed; 0 failed

Supervisor Lifecycle Golden Path: PASS

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

1. Complete Supervisor PID matrix: Instance STOP, Quarantine, generation change,
   credential revocation, Node SIGTERM, repeated crash loop.
2. Source live fixture: DNS rebinding, slow header/body, actual proxy environment
   (HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY), TCP peer IP proof.
3. Heartbeat mock Kernel: single/continuous 429/500/503, transport disconnect,
   >TTL outage, 401/403/404/409 and deadline.
4. Run the final clean CI twice; record both run URLs.

## Release Decision

```text
PARTIAL_NOT_READY
```

Terminalization is no longer a blocker; the remaining blockers are the three
explicit P1 evidence gaps above. PR #2 remains Draft.
