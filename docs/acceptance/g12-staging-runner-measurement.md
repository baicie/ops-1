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

## 7. Still open

1. **The runner-side cause is UNPROVEN.** Isolating it needs something this environment cannot
   read: the job's network counters. A `curl -w` timing probe emitted *inside* the smoke job
   before Playwright starts would settle stage 1 and stage 2 from the runner's own view; that is
   a change to the workflow's diagnostics, not to its thresholds, and is the recommended next step.
2. **`/api/v1/diagnostics` stays in flight after `load`** on `/access` (measured here: still
   pending 500 ms after load, answering in 30-50 ms when called directly with no session). It did
   not cause the observed failure - the failure was `load` itself never firing - but a request
   that outlives the page's load event is worth its own look, because on a slow path it is the
   first thing a navigation waits behind.
3. **Only the core tier was run.** The surfaces and seeded-data tiers were skipped by the tier
   rule, as recorded in the same `health.json`.
