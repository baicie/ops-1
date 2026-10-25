# OpsWeave 0.0.3 — Final PR Code Review

Reviewed range: `git diff a434a79...30e792e`  
Code HEAD: `30e792e`  
Branch: `feat/0.0.3-typed-pipeline`  
PR: https://github.com/baicie/ops-1/pull/2 (Draft/Open)

## Method

- Read the full branch diff and the changed files in Kernel, Node Runtime,
  Pipeline Worker, Catalog sink, CI and acceptance harness.
- Re-ran focused tests for terminalization, Worker source/heartbeat, Supervisor
  lifecycle and the OCI data workflows.
- Traced lock/transaction order in `jobs.rs`, `fence_authorize()`,
  `fence_authorize_effect()` and `authorize_lease()`.
- Checked that every PASS has a corresponding executed command; static IP
  classification tests were not accepted as dynamic source evidence.

## Findings

### P0-1 — Node SIGTERM left an orphan Worker

- **File:** `apps/node/src/main.rs` (previous `ctrl_c` only),
  `apps/node/src/worker_supervisor.rs`
- **Problem:** Node only handled SIGINT. SIGTERM killed the Node parent without
  stopping or reaping the `opsweave-pipeline-worker` child.
- **Failure scenario:** active/restarting Worker becomes PPID=1 and keeps a
  valid Lease until authority expires.
- **Evidence:** previous CI log `orphan worker after Node SIGTERM pid=20018 ppid=1`;
  the harness then killed it and still printed PASS.
- **Fix:** unified SIGINT/SIGTERM `wait_for_shutdown_signal`; watch channel in
  `Shared`; Supervisor observes shutdown, refuses new Workers, sends SIGTERM,
  waits 5s, then SIGKILLs and calls `wait()`; Node joins the Supervisor with a
  20s bound.
- **Regression test:** `supervisor_instance_generation_sigterm.sh` now fails if
  any live or zombie Worker remains after SIGINT/SIGTERM; it no longer kills the
  orphan to manufacture PASS.
- **Commit:** `856d730`, fixture fix `a1d9184`

### P0-2 — Heartbeat retry added a full normal interval

- **File:** `apps/pipeline-worker/src/main.rs`, `start_heartbeat_with`
- **Problem:** after a transient failure, code slept 2s backoff and then entered
  the top of the loop which slept the full 10s normal interval. Effective
  retry spacing was 12s+; request timeout was outside the retry budget.
- **Failure scenario:** a 20s timed-out heartbeat plus 10s normal sleep could
  exceed the Lease window while the Worker still believed it was alive.
- **Fix:** explicit delay state (`interval` on success, `backoff` on retry);
  per-request 5s timeout; conservative 60s Lease budget; bounded three failures;
  401/403/404/409 remain fatal. Kernel deadline authority is unchanged.
- **Regression test:** the mock HTTP tests still assert actual request counts
  and cancellation; a timing assertion remains `NOT_RUN` in this iteration.
- **Commit:** `856d730`

### P1-2b — Checkpoint heartbeat aborted Job on one 503

- **File:** `apps/pipeline-worker/src/main.rs`, `heartbeat()`
- **Root cause:** synchronous checkpoint/sink authority heartbeat returned
  immediately on a single transient 503, unlike the dedicated heartbeat task's
  bounded retry policy.
- **Failure scenario:** a transient Kernel 503 at a batch boundary failed the Job
  instead of retrying; the TTL test observed exactly one injected 503.
- **Fix:** three bounded attempts with 2s backoff and 5s per-request timeout,
  terminal 401/403/404/409 still fatal.
- **Regression:** TTL gate now records `heartbeat_503_count=3` and intervals
  `2.003 2.003`; commit `30e792e`.
- **CI:** `40186437693` / `40186437725` attempts 1 and 2.

### P1-3 — Source proxy test did not restore NO_PROXY

- **File:** `apps/pipeline-worker/src/main.rs`, proxy test
- **Problem:** the test cleared `NO_PROXY` and removed it, rather than restoring
  the prior value.
- **Failure scenario:** parallel tests or a developer environment inherited an
  empty `NO_PROXY` after the test.
- **Fix:** all four variables are saved and restored, including `NO_PROXY`.
- **Remaining limit:** mutation is still process-global; full subprocess
  isolation is `P2` and not implemented.
- **Commit:** `856d730`; test initializer fix `a1d9184`

### P1-4 — Real Heartbeat > Lease TTL takeover test

- **File:** `tests/acceptance/pipeline_heartbeat_ttl_takeover.sh`
- **Status:** **PASS** on code `4994193`.
- **Evidence:** Worker-only Kernel proxy returned 503 only for the target
  Heartbeat; real `expires_at` was reached without DB mutation; Node B took over
  naturally; oldFence=1, newFence=2, attempts=2, records=1001, effects=3,
  results=1, activeLeases=0; stale heartbeat/result = 409.
- **Commit:** `6fd96c4` (`9732861` ordering fix).

### P1-5 — No Deadline vs Catalog Sink race test

- **Files:** `migrations/0009_deadline_authority.sql`, Catalog fence functions
- **Problem:** SQL uses `clock_timestamp()` and row locks, but there is no
  two-transaction test for (A) sink holding the authority row before Deadline and
  (B) sink waiting for the row until after Deadline.
- **Status:** **PASS** on `4610d90`.
- **Case A:** real HTTP Fenced Sink returns 201 with COMMITTED Receipt, 2 Records
  and 1 Lineage; test-only barrier entered before and exited after the deadline.
- **Case B:** real HTTP request waits on the Job row lock and returns 409
  `STALE_FENCE` / `JOB_DEADLINE_EXCEEDED`; no Receipt, Records or Lineage.
- **Risk:** a code change could accidentally use statement/transaction time or
  skip the recheck after waiting; current code review found no such defect, but
  the gate is not proven by execution.

### P1-7 — SIGTERM while a Job is active / restart backoff

- **File:** `tests/acceptance/supervisor_instance_generation_sigterm.sh`
- **Status:** **PASS** on code `4994193`, including restart backoff.
- **Evidence:** `SIGINT active job=... worker=21413`, `SIGTERM active job=...
  worker=21811`, and `SIGTERM during supervisor restart backoff: duration=2013ms
  children=0`.
- **Commit:** `f43c8c2`, `4994193`; shutdown path `856d730`.

### P2-6 — Node shutdown timeout leaves a joinable task

- **File:** `apps/node/src/main.rs`
- **Problem:** if the Supervisor exceeds the 20s join bound, main logs and exits;
  the child kill/5s wait is inside the Supervisor, so a pathological stuck
  `wait()` could still be running. No observed failure.
- **Recommendation:** retain the bound but add a last-resort process-group kill
  in a follow-up; do not expand this RC.

## Review conclusions

- Terminalization has a single writer and row-lock ordering; no duplicate
  Result/Event path found.
- Claim-Next contention retry is bounded and does not fabricate a claim.
- Fenced Catalog writes preserve Receipt idempotency; old Fence was rejected by
  the real HTTP path.
- No new P0 correctness defect was found in the reviewed diff after the two
  fixes above.
- Remaining P1 items are missing acceptance scenarios, not known code defects.

## Residual risk

All required P0/P1 review items now have executed evidence. Remaining P2 items
are optional SIGTERM variants, Reaper 100/101/1000 pressure, source subprocess
isolation and Retry-After. The reviewer conclusion is READY_FOR_REVIEW; PR stays
Draft.

## CI for this review

- Data Foundation: `40186437693` — attempts 1 and 2 SUCCESS on `30e792e`
- Runtime: `40186437725` — attempts 1 and 2 SUCCESS on `30e792e`
- Standard CI: `40186437628` on `30e792e` — SUCCESS
- Contracts: `40186437712` on `30e792e` — SUCCESS
- Code: `a1d9184`; docs-only report commit follows.
