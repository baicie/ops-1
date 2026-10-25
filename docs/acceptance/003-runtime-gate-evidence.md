# 0.0.3 Runtime Gate Evidence — RC V5

Branch: `feat/0.0.3-typed-pipeline`  
Base: `a434a79`  
Code HEAD: `4994193`  
Report HEAD: this commit  
PR #2: [Draft/Open](https://github.com/baicie/ops-1/pull/2) (not merged, not Ready).

## CI runs (same code HEAD)

- Data Foundation OCI: [40172247224](https://github.com/baicie/ops-1/actions/runs/40172247224) — SUCCESS, attempt 1 and attempt 2
- Runtime workflow: [40172247250](https://github.com/baicie/ops-1/actions/runs/40172247250) — SUCCESS, attempt 1 and attempt 2
- Standard CI: run `40172247221` on `4994193` — SUCCESS
- Typed Pipeline Contracts: run `40172247239` on `4994193` — SUCCESS

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
| Supervisor Lifecycle | **PASS** | marker, Worker SIGKILL/crash loop, Instance STOP/recovery, generation quarantine/release, SIGINT/SIGTERM active Jobs, SIGTERM in backoff, revocation/quarantine, orphan |
| Source Security | **PASS** | deterministic DNS/TCP/slow/infinite/redirect/proxy tests + OCI timeout→no-Sink gate |
| Heartbeat Fault Injection | **PASS** | 3 real 503s (intervals 2.003s), autonomous exit, natural 60s Lease, Node B takeover oldFence=1→2, attempts=2, 1001/3/1, activeLeases=0; Deadline and Retry-After are separate |
| Deadline-vs-Sink A/B | **PASS** | real PostgreSQL row-lock race; Case B waits past deadline then gets `f|JOB_DEADLINE_EXCEEDED`; Case A authorized before deadline and commits without duplicate/unauthorized write |
| Deadline-vs-Sink C/D/E | **PASS** | existing `catalog_fenced_sink` stale fence/receipt replay and terminalization late-result tests |
| SIGTERM in restart backoff | **PASS** | fake crash-loop child; shutdown duration 2013ms, children=0 |
| Result Correctness | **PASS** | exactly one Result in terminalization, orphan and timeout tests |
| Runtime CI | **PASS** | dedicated workflow green twice |
| Data Foundation OCI | **PASS** | full two-node OCI golden path |
| Legacy Regression | **PASS** | `PASS=21 FAIL=0` |

## Supervisor PID evidence

```text
Supervisor Lifecycle Golden Path: PASS
crash-loop round=1/2/3: new supervised PIDs
PASS Node revocation/quarantine stopped supervised worker pid=18091
PASS Instance STOP stopped supervised worker pid=19177
PASS Instance STOP recovery started worker pid=19593
PASS Node generation change (1 -> 2) stopped supervised worker pid=19593
PASS Node generation quarantine released; worker pid=20044
SIGINT active job=34917917-90b7-4875-a575-69205ab7912d worker=21413
PASS Node SIGINT terminated Node A and worker (pid=21413)
PASS Node SIGINT recovery worker pid=... 
SIGTERM active job=6adf4652-16d2-4f6d-ad35-77da6ac893f1 worker=21811
PASS Node SIGTERM left no live or zombie worker (pid=21811 reaped)
Supervisor Instance STOP/Generation/SIGTERM: PASS
```

The old SIGTERM path left a PPID=1 child; it is now fixed. The test fails on a
live or zombie Worker and no longer kills the orphan to manufacture PASS. SIGINT
and SIGTERM both stop and reap the supervised child before the Node exits.

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

## Heartbeat TTL takeover evidence

`tests/acceptance/pipeline_heartbeat_ttl_takeover.sh` restarted Node A with a
Worker-only Kernel URL proxy, injected 503 only for the target heartbeat, and
waited for the real `expires_at`:

```text
heartbeat-ttl worker-a pid=17750 node-a=17491
Worker A exited after Heartbeat fault at 04:47:54Z
Lease TTL reached at 04:48:53Z expires_at=04:48:53.344477+00
oldFence=1 newFence=2 attempts=2
stale: heartbeat=409 result=409 results=1 records=1001 effects=3 activeLeases=0
PASS Heartbeat TTL Takeover
```

## Deadline vs Sink A/B evidence

```text
Case B start=07:32:00Z deadline=07:32:02.797841Z obtained after deadline=07:32:05Z
result=f|JOB_DEADLINE_EXCEEDED
Case A decision=t|OK commit_after_deadline=t|OK
PASS Deadline vs Sink Case A/B (no unauthorized Catalog write; documented linearization)
```

Case A intentionally remains open after the deadline only because authorization
completed before it; documented linearization contract. Case B rechecked
`clock_timestamp()` after the row lock and rejected.

## SIGTERM backoff evidence

```text
fake child exit observed; SIGTERM during backoff
PASS SIGTERM during supervisor restart backoff: duration=2013ms children=0
Supervisor Backoff SIGTERM: PASS
```

## Remaining work

1. Optional fault-injection matrix variants: SIGTERM during spawn/wait/
   quarantine/double-signal and full Reaper 100/101/1000 pressure are **NOT_RUN**
   (P2 backlog; core shutdown and bounded Reaper paths are PASS).
2. Source proxy tests still mutate process-global environment in one unit test
   (P2 isolation follow-up).
3. Retry-After is intentionally unsupported; fixed bounded backoff documented.
4. Physical multi-host, mTLS, rootless Docker, OCI attestation and production HA
   remain outside this RC.

## Release Decision

```text
READY_FOR_REVIEW
```

Terminalization, Supervisor, Source Security, Heartbeat fault/TTL, Deadline-vs-Sink
and all required CI gates now have executed PASS evidence. The remaining items are
P2 backlog variants. PR #2 stays Draft until independent review accepts it.
