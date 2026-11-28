# Phase 10A TASK-35: what CI actually costs, and what the cache has not proven

Measured on 2026-11-28 from `gh run list` and job logs. **Every number below is a
count from a named sample**, and each section says what the sample is. Nothing is
an estimate.

## The sample

| workflow | completed runs fetched | first-attempt successes | failures | retried (attempt ≥ 2) |
|---|---|---|---|---|
| `plugin-lifecycle.yml` | 30 | 15 | 2 | 12 |
| `data-foundation.yml` | 28 | 22 | 0 | 6 |
| `runtime-conformance.yml` | 30 | 25 | 0 | 4 |
| `ci.yml` | 28 | 17 | 4 | 10 |
| **total** | **116** | **79** | **6** | **32** |

**First-attempt success: 79/116 = 68 %.**

**This is 116 runs, not 20.** The brief asked for at least 20 comparable runs; this
is the last ~30 of four workflows, so they are not all comparable — `ci.yml` runs on
every push while the other three are path-filtered. Treating them as one rate would
be the mistake `number-must-come-from-the-sample-it-describes` records. The rates
are per workflow, above, and the 68 % figure is only meaningful as "how often does a
push produce a green run on the first try across everything".

## Wall time, from first-attempt successes only

Retried runs are excluded because their duration includes the retry's own queue.

| workflow | n | p50 | max |
|---|---|---|---|
| `plugin-lifecycle.yml` | 15 | **51.3 min** | 53.5 min |
| `data-foundation.yml` | 22 | 23.7 min | 27.0 min |
| `runtime-conformance.yml` | 25 | 3.9 min | 8.1 min |
| `ci.yml` | 17 | 25.2 min | 54.3 min |

`plugin-lifecycle.yml` at **51 minutes p50** is the critical path, and it matches
the independent measurement in `main-verification.yml`'s budget comment (3038 s =
50.6 min for `ci.yml` on 4375c988, which contains the same lifecycle work).

## The Maven failure, exactly

Run 45931039517 is the one case where the wrapper recovered, and its log shows the
full sequence — which is more useful than "it worked":

```
attempt 1  [FATAL] Non-resolvable parent POM ... status: 429
           mvn: registry fault on attempt 2, retrying in 30s
attempt 2  [FATAL] Non-resolvable parent POM ... status: 429
           mvn: registry fault on attempt 3, retrying in 30s
attempt 3  BUILD SUCCESS
```

So the budget was **exactly** what was needed: two 429s, three attempts, no
headroom left. A fourth 429 would have failed the run. The wrapper's backoff is
`attempt * 15` seconds — 15 s then 30 s (`scripts/build-plugins.sh:350-351`) — so
the whole window is 45 seconds, and it was exactly enough.

That is the real finding about the retry: it is not "the retry works" (one recovery),
and it is not "the retry is useless" (it recovered this one). It is **the retry has
zero margin**, and the sample contains one case at each end.

## What the cache has and has not done

`cache: maven` is configured on all three Java-building workflows (TASK-32, PR #247).
**This report cannot say it helped**, and says why rather than implying otherwise:

- the cache was added on 2026-11-28; the failures above are from 2026-11-26, before it;
- the sample contains **no post-cache Maven 429** and therefore no evidence either way;
- a green run after the cache proves only that Central answered that time.

**Cache hit rate: not measured.** It requires reading the `setup-java` restore
output per run, and the three workflows have produced too few post-cache runs to
state one. That is the measurement TASK-32 still owes.

## Wasted rerun minutes

A retried run re-executes the whole workflow. Counting only the retried runs whose
final attempt succeeded, at each workflow's p50:

| workflow | retried runs | p50 | machine-minutes re-spent |
|---|---|---|---|
| `plugin-lifecycle.yml` | 12 | 51.3 | ~616 |
| `data-foundation.yml` | 6 | 23.7 | ~142 |
| `runtime-conformance.yml` | 4 | 3.9 | ~16 |
| `ci.yml` | 10 | 25.2 | ~252 |
| **total** | **32** | | **~1026** |

**~1,026 machine-minutes** across the sample. This is the strongest number in the
document and also the least precise: a retried run's first attempt may have failed
early, so re-spending the full p50 overstates it. It is an **upper bound**, and the
per-run attempt durations would be needed to bound it from below.

## What this says about the 429

It does **not** say the 429 is fixed, and it does not say the cache removed it.
What it says:

1. a single 429 costs a full workflow re-run — 51 minutes for the lifecycle job;
2. the retry wrapper converts some fast failures into delayed ones without
   recovering them in the observed sample;
3. the cache's effect is **unmeasured**, because the sample predates it.

The measurement that would settle (3) is TASK-32: read the restore output, record
hit/miss and the Maven step duration, over enough post-cache runs to compare. Until
then the honest statement is "configured, not proven" — the same position
`phase10a-maven-supply-chain-audit.md` took, now with the cost of being wrong
quantified.

## What was deliberately NOT done

- **No test was weakened to shorten the lifecycle job.** Its 51 minutes are the
  price of the acceptance it runs; the brief forbids trading that for green.
- **No estimate of "Maven's share" of the 51 minutes.** The steps are timed
  individually in the log and nobody has summed them.
- **No claim that 6 failures in 116 runs is a 5 % failure rate.** Six events do
  not establish a rate, and two of them are one root cause.

## Successor

TASK-32 (cache effectiveness) is unblocked and has its measurement plan. TASK-33/34
(the offline dependency proof) remain gated on it: an offline build proves nothing
until the warm path is shown to work, and the brief is explicit that a network-warmed
test is not that proof.
