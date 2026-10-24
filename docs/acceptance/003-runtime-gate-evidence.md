# 0.0.3 Runtime Gate Evidence — RC V5

Branch: `feat/0.0.3-typed-pipeline`  
Base: `a434a79`  
Code HEAD: `5984e3c`  
Report HEAD: this commit  
PR #2: [Draft/Open](https://github.com/baicie/ops-1/pull/2) (not merged, not Ready).

## CI runs (same code HEAD)

- Data Foundation OCI: [40132150776](https://github.com/baicie/ops-1/actions/runs/40132150776) — SUCCESS, attempts 1 and 2
- Runtime workflow: [40132150489](https://github.com/baicie/ops-1/actions/runs/40132150489) — SUCCESS, attempts 1 and 2
- Standard CI: run `40132150522` on the same HEAD — SUCCESS
- Typed Pipeline Contracts: run `40132150497` on the same HEAD — SUCCESS

Both Data Foundation and Runtime have `run_attempt=2` and `conclusion=success`.
The second run was a clean rerun of the same commit, not a code change.

## Gate matrix

| Gate | Status | Evidence |
|---|---|---|
| Unified Terminalization | **PASS** | 8 PostgreSQL tests: single writer/idempotent; Reaper vs Claim/Result/Cancel/Reaper; deadline priority; SQL failure rollback; bounded batch |
| Claim-Next 2/8/16/32 | **PASS** | 2/8/16/32 all 200 with distinct Leases; empty queue 204 |
| Catalog Lock Proof | **PASS** | SQL fence `pg_blocking_pids`: commit and rollback, `claim=409` |
| Deadline / Lease / Fence | **PASS** | deadline rejects Claim and Heartbeat; fence takeover evidence |
| Kernel Restart | **PASS** | `oldFence=1 newFence=2 recovery=60s` |
| Two-Node Natural Takeover | **PASS** | `takeover=64s oldLease=EXPIRED effects=3` |
| Node Runtime SIGKILL | **PASS** | `takeover=64s`, replacement fence=2 |
| Orphan Worker | **PASS** | PPID=1 old worker; new fence=2; stale HTTP heartbeat/result rejected 403; results=1, records=1001, effects=3 |
| Supervisor Lifecycle | **PASS** | marker remove/restore; Worker SIGKILL; 3-round crash loop; Instance STOP and recovery; Node generation quarantine and release; Node SIGTERM; Node revocation/quarantine; orphan |
| Source Security | **PASS** | 14 deterministic Worker source tests + OCI timeout→no-Sink gate: DNS rebinding/mixed answers, TCP peer pin, slow header/body, infinite chunked, redirects, proxy bypass/count, CL mismatch, malformed, normal |
| Heartbeat Fault Injection | **PARTIAL** | real mock HTTP: single/continuous 429/500/502/503, disconnect, 401/403/404/409, bounded 3 attempts; no >Lease-TTL outage, Deadline-vs-Sink integration, or Retry-After |
| Result Correctness | **PASS** | exactly one Result in terminalization, orphan and timeout tests |
| Runtime CI | **PASS** | dedicated workflow green twice |
| Data Foundation OCI | **PASS** | full two-node OCI golden path |
| Legacy Regression | **PASS** | `PASS=21 FAIL=0` |

## Supervisor PID evidence

```text
Supervisor Lifecycle Golden Path: PASS
crash-loop round=1/2/3: new supervised PIDs
PASS Node revocation/quarantine stopped supervised worker pid=18091
PASS Instance STOP stopped supervised worker pid=19150
PASS Instance STOP recovery started worker pid=19589
PASS Node generation change (1 -> 2) stopped supervised worker pid=19589
PASS Node generation quarantine released; worker pid=20018
PASS Node SIGTERM terminated Node A pid=19771
orphan worker after Node SIGTERM pid=20018 ppid=1
Supervisor Instance STOP/Generation/SIGTERM: PASS
```

The Node SIGTERM orphan was the harness-owned child; the test explicitly records
PPID=1 and terminates that PID, leaving no unowned worker.

## Orphan stale-authority request

After Node A took over with fence=2, the test sent real Kernel requests using the
old Node B credential, Boot ID, Worker ID and old Lease/Fence:

```text
stale request: heartbeat=403 code=FORBIDDEN result=403 results=1 records=1001 effects=3
PASS Orphan Worker Golden Path:
  oldFence=1 newFence=2 takeover=83s records=1001 effects=3
```

The old fence was rejected after Node revocation/freshness loss; no new Record,
Effect or Result was created. This is request-path evidence, not a database-only
observation.

## Claim-Next

```text
claim-next fanout 2: 2x200 distinct=2 dbLeases=2
claim-next fanout 8: 8x200 distinct=8 dbLeases=8
claim-next fanout 16: 16x200 distinct=16 dbLeases=16
claim-next fanout 32: 32x200 distinct=32 dbLeases=32
claim-next empty queue: 204
```

## Source Security

`cargo test -p opsweave-pipeline-worker`: **18 passed, 0 failed** (14 source
security/behavior tests + 4 Heartbeat mock tests). The OCI gate additionally ran:

```text
PASS slow source timed out without Sink Effect
  status=FAILED records=0 effects=0 result=1
Source Timeout No Sink: PASS
```

The OCI source test is a real published PipelineRevision, real Worker, real slow
HTTP server and real Catalog; it is not a unit-only claim.

## Terminalization

```text
== terminalization service PostgreSQL tests
running 8 tests
test result: ok. 8 passed; 0 failed
```

Each test asserts all five records: Job status, active Lease, unfinished Attempt,
exactly one Result, exactly one terminal Event. The SQL-failure test aborts the
Event insert and verifies full rollback.

## Remaining work

1. Heartbeat: outage longer than Lease TTL, Deadline-vs-Sink concurrency and
   Retry-After are **NOT_RUN**. The mock HTTP transient/fatal matrix is PASS.
2. Physical multi-host, mTLS, rootless Docker, OCI attestation and production HA
   remain outside this RC.

## Release Decision

```text
PARTIAL_NOT_READY
```

All P0/P1 gates except Heartbeat's three lifecycle/outage scenarios are PASS.
The remaining gaps are reliability evidence, not a known correctness defect;
PR #2 remains Draft.
