# Staging preview on the runner: three-stage measurement, and what it does and does not prove

- Date: 2026-11-03
- Commit under test: `bdcc394` (main), image `ghcr.io/baicie/opsweave:bdcc394…`
- Failing run: [staging-preview 41559982306](https://github.com/baicie/ops-1/actions/runs/41559982306)
- Host: `82.156.234.84:3000` (single staging host, unchanged by this work)
- Status: **PARTIAL.** The failure is localised to the runner↔host path; it is NOT proven to be
  a network fault, and no global timeout was raised and no retry loop was added.

## 1. What failed, in the runner's own words

Run 41559982306, job `smoke the preview`, step *Playwright core paths*:

```
✘ 11 dual-surface.spec.ts:141 › the legacy URLs land on their canonical /admin path … (3.0m)
     Error: page.goto: Test timeout of 180000ms exceeded.
     Call log:
       - navigating to "***/access", waiting until "load"
✘ 14 dual-surface.spec.ts:237 › the switcher is usable at 390px … (20.1s)
     TimeoutError: page.waitForResponse: Timeout 20000ms exceeded while waiting for event "response"
17 passed (6.1m)
```

Both are waits that never resolved. Neither is a failed assertion: no expectation about the
product was contradicted - the browser never got far enough to make one. The same commit's
`ui-table-audit` step in the same job finished 6/6, so the host was serving throughout.

## 2. Stage 1 - the runner itself

Not measurable from here. The GitHub-hosted runner's CPU, memory and Chromium start-up cost are
only visible inside the job. What the log does show is that other specs on the same runner were
normal (admin-shell 3.7-21 s, staging-smoke 0.45-19 s), so a per-runner stall is not supported by
the evidence either. **Recorded as UNMEASURED rather than guessed at.**

## 3. Stage 2 and 3 - measured from a host that is not the runner

The point of running these from a different machine is that they separate "the host is healthy"
from "this path can use it".

### Stage 3: the host, on its own (direct HTTP, 2026-11-03)

| Path | status | TTFB | total |
|---|---|---|---|
| `/` | 200 | 0.067 s | 0.096 s |
| `/api/v1/version` | 200 | 0.049 s | 0.051 s |
| `/livez` | 200 | 0.093 s | 0.095 s |
| `/readyz` | 200 | 0.051 s | 0.053 s |
| `/app/incidents` | 200 | 0.092 s | 0.111 s |
| `/api/v1/diagnostics` | 401 (no session, as designed) | 0.032-0.052 s | 0.03-0.05 s |

`/api/v1/version` reports `commitSha = bdcc394…`, i.e. the host is serving the commit under test.

### Stage 2: the browser leg this case actually walks

The failing case navigates 18 legacy URLs plus two probes. Each was timed separately, three
rounds, in a real Chromium:

```
round 1: total=1032ms worst={"route":"/governance","ms":177} median=71ms
round 2: total=665ms  worst={"route":"/pipelines","ms":69}  median=56ms
round 3: total=641ms  worst={"route":"/pipelines","ms":72}  median=51ms
```

`/access` - the route the runner stalled on - answered and the `load` event fired in **227 ms**;
`domcontentloaded` in 191 ms. The whole 21-navigation case takes **28-38 s** here.

### The same suite, same commit, same image

```
OPSWEAVE_URL=http://82.156.234.84:3000 OPSWEAVE_EXPECTED_SHA=bdcc394…
pnpm --filter @opsweave/ui-tests exec playwright test \
  staging-smoke.spec.ts dual-surface.spec.ts admin-shell.spec.ts
  -> 19 passed (1.8m)
```

Against the runner's `17 passed (6.1m)` with two 180 s/20 s stalls at the same commit.

## 4. What the three stages support

| Claim | Evidence | Verdict |
|---|---|---|
| The host serves the commit under test and is healthy | `/api/v1/version`, `/livez`, `/readyz`, 6/6 audit step in the same run | **SUPPORTED** |
| The product routes and pages work | same suite 19/19 from a non-runner host, 1.8 min | **SUPPORTED** |
| The failure is a product regression | no assertion failed; only waits | **NOT SUPPORTED** |
| The failure is the runner↔host path | runner 6.1 min + two 180 s waits vs 1.8 min elsewhere at the same SHA and image; `/access` load 227 ms elsewhere | **CONSISTENT, NOT PROVEN** |
| The runner machine itself is unhealthy | other specs on it were normal | **NOT SUPPORTED** |

The honest summary: *every measurement available outside the runner points at the path between
the runner and this host; nothing measured inside the job isolates it.* That is why this document
does not say "it is the network".

## 5. What was changed, and what was deliberately not

**Changed - the case stops depending on `load`.** `dual-surface.spec.ts`'s legacy-URL case awaits
`page.goto(from, { waitUntil: 'commit', timeout: 30_000 })`. The case asserts *where* a URL lands,
which is known once the navigation commits and the client redirects; it never reads a resource
whose availability `load` reports. The default made 21 legacy URLs depend on the last subresource
of 21 pages loading. A per-navigation budget also names the leg that is slow, instead of spending
the whole test's 180 s inside whichever `goto` happened to be in flight.

This does **not** make a slow path fast, and it is not presented as a fix for the runner leg.

**Not changed, and why:**
- no global Playwright timeout was raised (that would hide the next stall instead of localising it);
- no retry loop was added around the smoke job;
- no assertion was relaxed: every URL mapping the case checks is still checked.

## 6. Separation of the two verdicts

`health.json` now carries a `verdicts` object, and the two questions are answered separately:

```
deployment_environment : PASSED | FAILED | NOT_RUN     identity + health of the host
code_acceptance        : PASSED | FAILED | UNVERIFIED  the browser suites
```

`code_acceptance` is `UNVERIFIED` - never `PASSED` - when the suite records a timeout, reset,
DNS failure or a `waitForResponse` that never fired. A run that did not reach the product is not
evidence that the product is fine, and it is also not evidence that it is broken. A green code
run does not certify a deployment either: `deployment_environment` is computed from the served
commit and the health probes, which the suites do not check.

## 6.1 Second observation, after the split verdict shipped (run 41594502897, b3681b5)

This run is the first in which the two verdicts were computed from live facts, and it is worth
recording because **both** of them behaved as designed for the first time:

```
verdicts: {"deployment_environment": "PASSED", "code_acceptance": "FAILED"}
deployment_facts: {"deploy_job": "success", "served_sha": "b3681b55…", "expected_sha": "b3681b55…",
                   "deploy_healthy": true}
```

- The deployment verdict is now answerable: served SHA equals the built SHA, and the deploy job's
  own result is a success. The preceding run (`873aa6f`) had reported `UNVERIFIED` here because
  the record job was parsing a file that lives in the deploy job's artifact; that is fixed in
  `b3681b5` and this run is the evidence.
- `code_acceptance` is `FAILED`, and this time it is a real suite failure: 16 passed, 2 failed
  with `page.goto … Test timeout of 60000ms exceeded`. The failing legs were `navigate to /login`
  (admin-shell case 6) and the sign-in probe (dual-surface case 9).

The same suite, same commit, same host, from a non-runner machine: **19 passed (1.2 min)**. Host
`/livez` answered in 33–42 ms throughout. So the earlier conclusion stands unchanged and is
re-confirmed: nothing measured outside the runner supports a product or host defect, and the
runner-side cause remains **unproven**.

One measurable improvement did come out of the first observation: the legacy-URL case, which
previously consumed its whole 180 s budget on the runner (`2026-11-02` run), took **1.2 min** in
this run because each navigation now has its own 30 s budget and waits for `commit` rather than
`load`.

The two cases that failed here are the same shape, so they were given the same treatment after
this run: `admin-shell.spec.ts`'s `login()` and `dual-surface.spec.ts`'s `signIn()` now await
`commit` with a 30 s budget. That makes the failing leg nameable; it does not make a slow path
fast, and it is not offered as a fix for the runner.

## 6.2 Third observation: giving the sign-in legs their own budget made it worse (run 41597654753, ec658d2)

The previous run's two failures were both `page.goto('/login')` waiting for `load`, so the same
treatment the legacy-URL case received was applied to `signIn()` and `login()`: `commit` plus a
30 s navigation budget. Measured on the next run:

```
16 passed, 3 failed (5.0 min)
  dual-surface:108  waitForResponse /api/v1/auth/me  20.2 s
  dual-surface:132  waitForResponse /api/v1/auth/me  20.2 s
  dual-surface:145  expect(page).toHaveURL           53.1 s (Timeout: 10000ms)
```

Two failures became three. `commit` returns before the bundle executes, so the cost of the slow
path moved onto the next, *shorter* budget: the 20 s bootstrap probe (which starts before the
navigation) and the 10 s `expect` default. **The change was reverted** — the sign-in helpers keep
default `load` and the test's own budget.

What was kept, because it targets a real binding constraint rather than moving cost around: the
legacy-URL case waits for `commit` (its subject is where the URL lands, not that a page finished
loading), and its redirect assertions now use `page.waitForURL(..., { timeout: 30_000 })` instead
of `toHaveURL`'s 10 s default, because after `commit` the client redirect happens only once the
bundle has run.

The lesson is recorded because it is the second time this shape appeared: on a slow leg, every
wait that is shortened becomes the next failure's budget. That is why this document does not
claim the runner problem is fixed, and why no global timeout was raised.

## 6.3 Fourth observation: the reverted tree is green, with both verdicts right (run 41601617851, f834402)

After the revert, the same commit's run completed **green**, and it is the first run in this
document where both verdicts are `PASSED`:

```
verdicts: {"deployment_environment": "PASSED", "code_acceptance": "PASSED"}
deployment_facts: {"deploy_job": "success", "served_sha": "f834402e…", "expected_sha": "f834402e…",
                   "deploy_healthy": true}
core paths:   19 passed (2.7 min)   slowest case 49.5 s (the legacy-URL case), no stall
table audit:   6 passed (7.0 min)
```

This does not prove the runner path is fixed, and it is not presented as such: two runs earlier
at `b3681b5` and one at `ec658d2` failed on the same workflow, same host, same suite. What it does
establish is that **(a)** the split verdict reports the truth in both directions - it said
`deployment_environment: PASSED` because the served SHA matched and the deploy job reported
success, and `code_acceptance: PASSED` because the suites actually ran and passed; and **(b)** the
revert did not leave the suite in a state that only fails, which was worth checking rather than
assuming.

The legacy-URL case is the clearest single data point: 180 s timeout before its per-navigation
budget (`b09a07f`), 1.2 min on a slow run (`b3681b5`), 53 s failure at the expect default
(`ec658d2`), 49.5 s pass here.

## 7. Still open

1. **The runner-side cause is UNPROVEN, and the failure is INTERMITTENT.** Four runs of the same
   workflow at `b3681b5`, `ec658d2` and `f834402` produced two failures and two passes with no
   code difference that could account for it (the reverted tree and the tree that failed both use
   default `load` on the sign-in path). Isolating it needs something this environment cannot read:
   the job's network counters.

   **The probe now exists.** Two steps were added to the `smoke` job, and neither touches a
   threshold, a retry or an assertion:

   - *Measure the runner-side network path* (`id: netprobe`) runs after Chromium is installed and
     immediately before the first Playwright step. For `/livez`, `/readyz`, `/api/v1/version` and
     `/` it runs `curl -w` with a JSON template **four times per path** and records DNS resolution,
     TCP connect, TLS handshake (`n/a` on the http origin), time to first byte and total, plus the
     runner's `nproc`, load average and free memory. It writes
     `artifacts/staging-preview/runner-network.json` (uploaded with the `staging-smoke` artifact)
     and exports a compact summary that the record job carries into `health.json` as
     `runner_network`. A failed attempt is recorded with its curl exit code and stderr, announced
     with `::warning::`, and the step still exits 0: a failed probe is data about the path, not a
     red job, and the file is written on every path, including `STAGING_BASE_URL` being empty.
   - *Record Playwright wall-clock durations* (`id: timings`) runs after the last Playwright step.
     Each Playwright step writes its own start/end markers (the end via an `EXIT` trap, so a failed
     step still has one), and this step records elapsed seconds per step next to that step's
     outcome in `artifacts/staging-preview/playwright-timings.json`, carried into `health.json` as
     `playwright_timings`. A slow run (`success`, long) is now distinguishable from a failed one
     (`failure`, any duration).

   Neither new key is read by the `verdicts` expressions: they are computed before the diagnostics
   are attached, and a degraded `runner_network` cannot turn a suite failure into `UNVERIFIED` or
   a green run into anything else. This was checked locally by composing `health.json` with a
   synthetic all-failed network summary and with no summary at all: the verdicts were identical in
   all three cases.

   **What it will settle.** On the next failing run, if the runner's own DNS/connect/TTFB/TLS
   numbers for `/livez` and `/readyz` are also stalled, the path between runner and host is
   implicated with evidence from the machine that failed. If those probes are normal while
   Playwright stalls, the path is not the binding constraint and the next place to look is the
   browser/process side of the runner (the timings file names which step was slow). In neither
   case does the probe fix anything; it replaces elimination with a measurement taken inside the
   job.

   **Not yet measured in-job.** These two steps have only been validated locally (YAML parse,
   embedded-Python compile, and a dry run of the probe against `http://82.156.234.84:3000`). The
   first real in-job measurement is the next push to `main`, and no runner-side number is claimed
   here until a run reports one.
2. **`/api/v1/diagnostics` stays in flight after `load`** on `/access` (measured here: still
   pending 500 ms after load, answering in 30-50 ms when called directly with no session). It did
   not cause the observed failure - the failure was `load` itself never firing - but a request
   that outlives the page's load event is worth its own look, because on a slow path it is the
   first thing a navigation waits behind.
3. **Only the core tier was run.** The surfaces and seeded-data tiers were skipped by the tier
   rule, as recorded in the same `health.json`.
