# Golden Path timing: measured, not estimated

TASK-13. Every number here comes from `STEP result=… secs=…` lines that
`tests/ci/run_step.sh` already emits, pulled from two real `data-foundation.yml`
runs. Nothing was inferred from a scheduler total.

## The instrumentation already existed

`data_foundation_ci.sh` routes 45 steps through `run_step.sh`, which prints one line
per step:

    STEP result=PASS name=supervisor_lifecycle start=… end=… secs=96

41 such lines appear in a run. **No new instrumentation was needed**; what was
missing was anyone reading them.

## Two runs of the SAME commit

| run | total across 41 steps |
|---|---|
| 45110138967 | 936 s (15.6 min) |
| 45106622557 | 1075 s (19.1 min) |

**139 seconds apart on identical code.** Any optimization claim smaller than that is
inside the noise, and a single run cannot distinguish an improvement from a slow
afternoon. This is the number that makes every row below readable.

## Where the time actually goes (run 45110138967)

| seconds | step |
|---|---|
| 197 | `pipeline_long_heartbeat_negatives` |
| 107 | `pipeline_orphan_worker` |
| 96 | `supervisor_lifecycle` |
| 81 | `pipeline_node_runtime_sigkill` |
| 77 | `pipeline_heartbeat_ttl_takeover` |
| 72 | `pipeline_two_node_takeover` |
| 70 | `kernel_restart_takeover` |
| 63 | `source_timeout_no_sink` |
| 37 | `supervisor_instance_generation_sigterm` |
| 21 | `demo_data_up` |
| 15 | `pipeline_long_heartbeat` |

The top five are 553 s of 936 s — **59 % of the harness in five steps**, and every
one of them is a lease, TTL, heartbeat or takeover scenario.

## The four categories, applied

TASK-13 asks for `REQUIRED_REAL_TIME`, `CONSERVATIVE_WAIT`, `POLLABLE_WAIT`,
`CLEANUP_WAIT`. Auditing the slowest step (`pipeline_long_heartbeat_negatives`,
197 s):

| fixed sleep | where | category |
|---|---|---|
| 70 s | case 6, after `kill -STOP` on the kernel | **REQUIRED_REAL_TIME** — it must exceed `LEASE_TTL` (60 s) or the assertion "a lease that outlived its TTL cannot write a terminal state" is not being tested at all |
| 3 s × 2 | after `kill -CONT` and after a state change | **POLLABLE_WAIT** in principle, but bounded by a `wait_status` loop, not a fixed sleep |
| 0.25 s | a poll interval | **POLLABLE_WAIT**, already a poll |

**Case 6 is skipped by default** (`OPSWEAVE_NEG_TERMINAL` is unset), so the 70 s does
not run in CI today. The 197 s is state polling, not that sleep.

## What this analysis does NOT support

**No optimization is proposed, and none was made.** The evidence points the other
way:

- The five slowest steps are **built out of real waits**. `pipeline_heartbeat_ttl_takeover`
  and `kernel_restart_takeover` exist to observe what happens after a lease or a
  heartbeat expires; shortening those waits shortens the interval under test.
- Changing the production `LEASE_TTL` to speed the harness is forbidden by TASK-13
  and by every instruction this repository has on the subject.
- The 139 s run-to-run variance means an optimization would need several runs on
  each side to be distinguishable from noise — which is a larger change than this
  task, and would itself cost more CI time than it saves.

## What WOULD be worth doing, and its cost

If Golden Path time is the goal, the lever with evidence behind it is **not** inside
these steps:

1. `pipeline_long_heartbeat_negatives` at 197 s is the largest, and it is a SEQUENCE
   of independent cases. Running them concurrently would need each case to own its
   job, worker and lease — measurable, and the repository already has the isolation
   primitives (`start_long_job`, `stop_worker`) to do it. Not attempted here.
2. The remaining four are each a single scenario against one platform; they are
   candidates for the same treatment and the same precondition.

Neither is done in this phase, and both would need several runs per side to prove a
difference larger than 139 s.

## Bottom line

Golden Path is **936–1075 s** on this repository today, 59 % of it in five
lease-and-heartbeat scenarios, and the measurement cannot resolve a change smaller
than ~15 %. **Nothing was optimized, because the measurement does not yet support a
claim that anything was improved.**
