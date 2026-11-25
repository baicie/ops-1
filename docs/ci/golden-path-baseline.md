# Phase 8 TASK-23: a baseline measured from samples, not from a pair

Measured 2026-11-25 against `main 18b5e876`. Every number comes from the 41
`STEP result=… secs=…` lines `tests/ci/run_step.sh` already emits; nothing was
inferred from a scheduler total.

## What the previous baseline got wrong

`docs/ci/golden-path-timing.md` (TASK-13) compared **two runs of one commit** and
reported a 139-second difference, concluding that any optimization smaller than
that is inside the noise.

The comparison was right. The conclusion was not.

Those two runs are 10 minutes apart (03:59 and 04:09 on 2026-11-23), and the
139 seconds is **one step**:

| step | run 45110138967 | run 45106622557 | spread |
|---|---|---|---|
| `pipeline_long_heartbeat` | **15 s** | **166 s** | **151 s** |
| every other step | — | — | 0–4 s |

Calling that "noise" is wrong in the direction that matters: it says the platform
is unpredictable, when in fact 40 of 41 steps are reproducible to within a few
seconds. One step moved, and it moved for a reason.

## Where the 151 seconds actually is

Both logs are identical up to `the lease stayed ACTIVE across the outage`. After
that, one poll:

```
fast:  04:17:20  row lock released
       04:17:22  PASS the job reached SUCCEEDED          (2 s)
slow:  03:40:32  row lock released
       03:43:06  PASS the job reached SUCCEEDED          (154 s)
```

That poll is `until_state "the job to reach a terminal state" 180` — it waits for
the pipeline JOB to finish, and the job is the thing under test. Both runs reached
it with `records=1001 effects=3`, so the work was the same.

**I could not establish why the job finished in 2 s in one run and 154 s in the
other.** The logs agree on the work done and disagree on the duration. This is
recorded as an open question rather than attributed to "the runner", because a
154-second swing in a workload's runtime is a fact someone should explain before
anyone quotes a golden-path duration as a service-level number.

## Six samples of the current main

Six consecutive `data-foundation.yml` runs, same workflow, same runner type,
2026-11-24 12:20 → 16:38 UTC:

| run | commit | total (sum of 41 steps) |
|---|---|---|
| 45439543841 | `18b5e876` | 1087 s |
| 45429239557 | `f7180a4e` | 1079 s |
| 45419908993 | `a0dd08a6` | 1076 s |
| 45410012691 | `71d90d63` | 1081 s |
| 45392635761 | `4c913ccd` | 1082 s |
| 45381556033 | `8d8cef98` | 1077 s |

**Spread: 11 seconds across six runs.** That is the resolution of this
instrument. Any future claim of improvement below 11 s is not measurable here.

Note that `pipeline_long_heartbeat` is **166 s in all six**, spread 0 — the 15-second
run above was the outlier, not the fast case.

## The time, by class

A single total conflates three different things. `golden-path-baseline.mjs`
classifies by step name, in one table, rather than by duration:

| class | median sum | steps | what it is |
|---|---|---|---|
| `WORK` | 653 s | 37 | the assertions and their setup |
| `JOB_RUN` | 426 s | 4 | the workload running, polled under a bounded timeout |
| `FIXED_WAIT` | 0 s | 0 | designed waits (none register today) |
| `FIXTURE` | 0 s | 0 | image builds and pulls (in a different job) |

`JOB_RUN` is 39% of the total and is **the subject**, not overhead. A
`pipeline_orphan_worker` that takes 107 s is a takeover that took 107 s; making the
poll cheaper would change nothing.

## Cold and warm cache: NOT RECORDED

The brief asks for cold and warm cache to be kept apart. **This baseline does not
do that**, because the workflow uses `Swatinem/rust-cache` but never reports
whether it hit, and inferring it from durations would be the same guess this
document exists to avoid.

The fix is to publish the cache-hit output from the workflow and record it per
sample. That is a workflow change, not a report change, and it is not made here
so that the gap stays visible rather than being filled with an assumption.

## What this does not claim

- **No optimization is proposed.** The baseline exists so a future one can be
  judged; nothing in this document says any step is slow.
- **No lease TTL was touched.** The brief forbids it and the numbers above are the
  current ones.
- **Not staging.** `data-foundation.yml` runs on a GitHub `ubuntu-24.04` runner.
- **The 151-second `pipeline_long_heartbeat` swing is unexplained**, and it is the
  largest single variance in the dataset.

## Using it

```bash
node tests/ci/golden-path-baseline.mjs --runs <id>,<id>,...
node tests/ci/golden-path-baseline.mjs --sha <sha> --samples 8
node tests/ci/golden-path-baseline.mjs --from-dir <dir>   # saved STEP logs
```
