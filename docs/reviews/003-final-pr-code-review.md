# OpsWeave 0.0.3 — Final PR Code Review

Reviewed range: `git diff a434a79...b2820d6`  
Code HEAD: `b2820d6`  
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

### P1-4 — No real Heartbeat > Lease TTL takeover test

- **File:** `tests/acceptance/` (missing)
- **Problem:** the current mock tests prove cancellation, but not the natural
  takeover after 60s with a second Worker and a persisted Snapshot.
- **Status:** `NOT_RUN`. This is a reliability evidence gap, not a known code
  correctness defect. The two clean CI runs on `a1d9184` do not cover it.
- **Required test:** `tests/acceptance/pipeline_heartbeat_ttl_takeover.sh` with
  fault injection only on Heartbeat, no database Lease mutation, oldFence=1,
  newFence=2, attempts=2, records=1001, effects=3, one Result, zero active leases.

### P1-5 — No Deadline vs Catalog Sink race test

- **Files:** `migrations/0009_deadline_authority.sql`, Catalog fence functions
- **Problem:** SQL uses `clock_timestamp()` and row locks, but there is no
  two-transaction test for (A) sink holding the authority row before Deadline and
  (B) sink waiting for the row until after Deadline.
- **Status:** `NOT_RUN`.
- **Risk:** a code change could accidentally use statement/transaction time or
  skip the recheck after waiting; current code review found no such defect, but
  the gate is not proven by execution.

### P1-7 — SIGTERM while a Job is active / restart backoff is not tested

- **File:** `tests/acceptance/supervisor_instance_generation_sigterm.sh`
- **Problem:** SIGINT/SIGTERM now stop and reap an idle supervised Worker, but no
  active Job or backoff sleep is running at signal time.
- **Status:** `NOT_RUN`; separate from the fixed orphan defect.

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

`PARTIAL_NOT_READY` until P1-4/P1-5/P1-7 execute in CI; Heartbeat retry timing
assertion and Source subprocess isolation remain follow-ups. PR stays Draft.

## CI for this review

- Data Foundation: `40156093797` — attempt 1 and attempt 2 SUCCESS
- Runtime: `40156093791` — attempt 1 and attempt 2 SUCCESS (on `a1d9184`)
- Standard CI: `40158381870` on `b2820d6` — SUCCESS
- Code: `a1d9184`; docs-only report commit follows.
