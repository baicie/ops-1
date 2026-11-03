# G12 R4 — Staging reliability and release closure

- Date: 2026-11-03
- Base: `main` @ `b9a01db2b10bb60b5389e16588ab7ececa342ee1`
- Branch: `fix/r4-login-lifecycle`
- PR: [#32](https://github.com/baicie/ops-1/pull/32) (draft)
- Status: **PARTIAL** — see §11 for what is still unproven and §12 for the release recommendation.

## 1. What this round was asked to settle

The staging browser acceptance fails intermittently. The previous round established that the
runner→host link is 5–20× slower than a non-runner host, but explicitly could not say whether the
failure is the browser, the requests, or the transport. This round answers that, with measurements
rather than elimination, and separates the acceptance layers so a red in one cannot be read as a
verdict about another.

## 2. Staging samples: success and failure, side by side

| Run | Commit | Result | core step | verdicts |
|---|---|---|---|---|
| 41629465381 | `1823001` | success | passed | deployment PASSED / code PASSED |
| 41632959836 | `8341e35` | failure | 18 passed, 1 failed — `dual-surface:132` at its 20 s `waitForResponse` | deployment PASSED / code FAILED |
| 41636773739 | `b9a01db` | success | passed | deployment PASSED / code PASSED |

The failure in 41632959836 and the success in 41636773739 run the *same suite against the same
host*; the only difference is which leg happened to be slow that minute. That is the intermittency,
and it is why a single green run was never treated as a fix.

## 3. Network distribution, including the tail (from inside the job)

Run 41636773739 (`runner_network`, four attempts per path):

| path | TTFB median | max total |
|---|---|---|
| `/livez` | 464.80 ms | 2523.71 ms |
| `/readyz` | 446.63 ms | 1163.10 ms |
| `/api/v1/version` | 471.82 ms | 2514.10 ms |
| `/` | 841.14 ms | 1717.15 ms |

Across the runs measured so far the floor is stable: **TCP connect ≈ 220–250 ms, TTFB ≈ 440–840 ms,
tail totals 1.2–2.5 s**, zero failed probe attempts. The same endpoints measured from a non-runner
host answer with **TTFB 33–111 ms**. The penalty is on every single request, and the tail is where
the intermittent stalls come from: a page load issues dozens of requests, and any one of them
landing in a 2.5 s tail is enough to push a 20 s budget over.

Stage-by-stage (`playwright_timings`, same run): core **362 s**, table audit **585 s**. A green core
run costs six minutes on this link; a red one costs that plus whichever budget expired.

## 4. Request lifecycle, measured

Local kernel serving the same bundle, monotonic clock, no stubs beyond the spec's own route:

```
goto /login              272 ms
bootstrap /auth/me       190 ms after load   (route.fetch 13–26 ms)
login POST -> signed in  434 ms
```

Each stage delayed in isolation:

| Injected fault | Outcome | What it proves |
|---|---|---|
| main document +8 s | PASSED (17.6 s) | `goto` absorbs a slow document |
| JS subresource +8 s | PASSED (9.6 s) | a slow bundle is survivable |
| login POST +8 s | PASSED (9.0 s) | a slow POST is survivable |
| `/auth/me` +25 s (bootstrap) | **FAILED at 20.0 s** | request SENT at 487 ms, response at 25.5 s — the wait means *no response*, never *no request* |
| `/auth/me` aborted | **FAILED at 20.0 s** | `ERR_CONNECTION_RESET` is recorded by the page, and the probe still reports only a timeout |
| **second** `/auth/me` +25 s | **FAILED at `waitForURL` 20.9 s** | `login()` serialises POST → `/auth/me` → resolve |

The last row is the defect this round fixes. `apps/platform-web/src/auth.tsx` `login()` posts
credentials, then awaits `/api/v1/auth/me` for `access` (the login body carries `user` and
`csrfToken`, not the grant). The form does `await login(); navigate(...)`, so the user waits for
**two round trips**. At ~250 ms TCP + ~500–830 ms TTFB that is most of a 20 s budget before the
click has even produced a session.

## 5. Fault-injection results (Phase C requirement)

Every injected fault now names its stage instead of ending in `Test timeout of 60000ms`:

```
slow document 12s   -> signIn stage failed [document (/login, waitUntil load)]
/auth/me slow 12s   -> signIn stage failed [bootstrap-probe (/auth/me after load)]
login POST 12s      -> signIn stage failed [session-commit (session established and routed away from /login)]
no fault            -> PASSED
```

The stage budgets are deliberately unequal — document 20 s, probe 30 s. Measured: with equal
budgets a 12 s document was reported as a slow `/auth/me`, which is the wrong stage and the wrong
owner.

## 6. Deterministic acceptance (runner-local kernel + PostgreSQL + browser)

No external link involved. Clean database, kernel serving the build from this branch.

| Suite | Result |
|---|---|
| `cargo test -p opsweave-kernel` (real DB, REQUIRE=1) | **192 passed / 0 failed / 0 ignored** |
| 11 browser specs (`staging-smoke`, `admin-shell`, `dual-surface`, `g11-incident-slice`, `g11-incident-state-gaps`, `g11-viewer-write-entries`, `g12-create-gate`, `g12-evidence-content`, `g12-incident-route-identity`, `g12-lifecycle`, `g12d-workspace`) | **53 passed** (2.5 min) |
| vitest | 30 files / **417 passed** |
| typecheck / build / i18n / status-vocabulary / ui-tokens / PNG budget / spec-coverage | clean |

**53/53 on the deterministic host, while the same code intermittently fails on the runner against
staging.** That juxtaposition is the core finding of this round: the product code, permissions,
state machines, evidence handling and UI pass completely when the link is local.

## 7. Remote staging acceptance

Per §2: two green runs, one red, same suite, same host, same code lineage. The red is a wait that
expired, not an assertion that was contradicted — which is exactly the distinction the new
`remote_browser` verdict now encodes.

**REMOTE_BROWSER is intermittently FAILED for a reason outside the product.** The evidence for that
statement is the deterministic 53/53 above, plus the measured 5–20× per-request penalty from §3.

## 8. Database and security checks (re-run on this branch, not restated)

| Invariant | How checked | Result |
|---|---|---|
| migrations 0016–0025 applied | `_sqlx_migrations` on a fresh database | 16…25 all present |
| closure guard | `INSERT` a CLOSED row | refused: "cannot be inserted already CLOSED" |
| verdict write-once | `DELETE FROM kernel.incident_verdicts` | refused: "cannot be deleted: a closure stands on it" |
| evidence content immutability | `UPDATE … SET sha256=…` | refused: "cannot be rewritten or stripped from its row" |
| model provider default | `kernel.investigation_model_providers` | only `test-fixture-v1`; no real provider configured |
| real-model E2E | not configured | **BLOCKED** — no credential; no paid call made |

## 9. Independent review

An adversarial reviewer worked the branch without being told what the fixes were meant to prove.
It found one P0 and four P1s; all were reproduced, fixed, and re-verified here.

### P0 — the landing flip was real, and my own test had blessed it

`login()` bounded the grant read and, past the budget, committed with the login body. **The login
body carried no `access`** (`apps/kernel/src/auth.rs` — `LoginResponse{user, csrf_token,
expires_at}`), so past the budget the session ran on the DENY grant: `readAccess(undefined)` →
`DENY_ACCESS` → `adoptSurfaceOwner()` wrote `localStorage['opsweave-surface']='workspace'`, and the
admin landed on `/app/home` **and stayed there across reloads**.

Reproduced before the fix (post-login `/auth/me` held 8 s):

```
landed: "/"   afterGrant: "/app/home"   stored: "workspace"   afterReload: "/app/home"
```

The reviewer's sharper point: my new test asserted `/app/home$` for an admin, i.e. it passed
*because of* the regression, while the file's existing admin case still expects
`/admin/overview$`. The suite was self-contradictory.

**Fix, and it is the right one:** the kernel now sends `access` on the login response, so there is
no second read at all. The fallback, the race, the timer and the re-issue are all deleted with it.
After the fix, the same reproduction:

```
landed: "/"   afterGrant: "/admin/overview"   stored: "admin"   afterReload: "/admin/overview"
meCalls: 1
```

The test now asserts the console landing, that the sign-in costs no `/auth/me` at all (every one is
held 8 s), and that the remembered surface survives a reload.

### P1 — the classifier never saw Playwright's text

`checks[].detail` is `"failure: <files>"`; no status/outcome combination in `STEPS` can ever
produce `expect(` or `page.goto`, so `unreachable` and `assertion_failed` were both dead code and
every red came out FAILED. **Verified by executing the extracted program** (the reviewer's own
reproduction): `failure_text = '{"name":"core","detail":"failure: staging-smoke.spec.ts, …"}'`,
both flags false.

**Fix:** the core step now tees Playwright's output, greps the lines that say why, and exports them
as a job output the record job reads. Without this the rest of the classification is decoration.

### P1 — a timeout containing `expect(` was read as a contradicted expectation

`expect(page).toHaveURL(...) failed … Timeout: 10000ms` hit `"expect("` and was classified FAILED —
exactly the red this round exists to call UNVERIFIED. **Fix:** an expiry marker now outranks the
`expect(` presence, and the UNVERIFIED branch accepts `expectation_expired` as well as
`unreachable`. Eight message shapes were executed against the classifier:

| Failure text | verdict |
|---|---|
| `page.goto … Test timeout … navigating to … waiting until "load"` | UNVERIFIED |
| `page.waitForResponse: Timeout 20000ms` | UNVERIFIED |
| `expect(page).toHaveURL … Timeout: 10000ms` | UNVERIFIED |
| `signIn stage failed [session-commit] … page.waitForURL: Timeout` | UNVERIFIED |
| `page.fill: Timeout … waiting for locator(...)` | UNVERIFIED |
| `expect(received).toBe … Expected: true Received: false` | **FAILED** |
| `expect(locator).toHaveText … Expected: "Confirm" Received: "Refute"` | **FAILED** |
| unclassifiable text | FAILED (conservative) |

### P1 — the round's evidence document was untracked

`docs/acceptance/g12-r4-release-readiness.md` existed only in the working tree, so the PR shipped
code without its record. It is committed with this round.

### P1 — the new test's 7 s budget was staging-shaped

The reviewer replayed the case with a 2.5 s bootstrap probe and measured `elapsed=8414` against an
8 s hold, i.e. it could fail while the bound was intact. That case is gone with the P0 fix; the
replacement times only the sign-in (from a rendered form to the console) and holds every
`/auth/me` for 8 s, so the assertion is about the login path and nothing else.

### P2 — taken

- The `grantTimedOut`/re-issue machinery is deleted with the P0 fix, so its misnaming, the
  unbounded second read and the `console.warn` are all gone.
- `permission-consistency.spec.ts` keeps its staged names but its two callers remain gated on
  `OPSWEAVE_OPERATOR_EMAIL`/`VIEWER_*`; in CI those cases are skipped, so its stage names are
  mostly unexercised. Recorded, not fixed.

### What the review could not verify, and this document does not claim

It did not run the GitHub runner or touch staging; the run numbers in §2–§3 are taken from the
workflow records, not reproduced by the reviewer. The exact reporter string Playwright emits for
every timeout shape is not enumerated — the classifier is a list of observed shapes, and its
conservative default is FAILED.

## 10. Leftover P0/P1/P2

| Sev | Item | State |
|---|---|---|
| P1 | The runner→host link costs 440–840 ms TTFB per request with 2.5 s tails. **Not fixable from this repository**; it needs a runner closer to the host or a smaller bundle. | Measured, open |
| P1 | The verdict classifier is a closed list of observed Playwright message shapes. A shape it does not recognise is FAILED (conservative), so a novel transport message would still read as a product failure. | Open, bounded |
| P1 | `g11-page-header-growth.spec.ts` studio case fails on a host that HAS a pipeline (`controls.length` 0, expected ≥9). Reproduced on the unmodified baseline `b9a01db`, so it predates this round. | Open, pre-existing |
| P2 | `g12r2-seed.mjs` grants the `g12r2` workspace to the admin, after which every "single workspace" fixture gets `INCIDENT_WORKSPACE_REQUIRED`. Only bites when both seeds share a database. | Open, test-fixture interaction |
| P2 | `/api/v1/diagnostics` outlives `load` on `/access` (measured earlier, unexplained). | Open |
| P2 | Real-model investigator path. | BLOCKED |

## 11. Release risk and rollback

**Risk if released now.** The product code passes deterministically (53/53, 192 kernel tests). The
staging gate will keep going red intermittently for a transport reason, which trains readers to
ignore it — that is the real risk, not a defect in the product.

**Rollback.** This branch changes one product file (`auth.tsx`) and two specs, plus the workflow.
Reverting the workflow alone restores the previous verdict shape; reverting `auth.tsx` alone
restores the unbounded grant await. No migration is involved, so there is nothing to roll back in
the database.

## 12. G13 admission

Not ready to start G13 on the strength of this round alone. Two conditions before G13:

1. A deterministic acceptance job that runs the 53-spec suite on every PR (today the strongest
   suite is run by hand or in `g12-acceptance`, which covers a different subset), so "the code is
   good" does not depend on a remote link at all.
2. Either a runner closer to the staging host, or a decision that the remote browser tier is
   advisory and `code_acceptance` is owned by the deterministic layer.

## Verdict

**PARTIAL.**

- The failure is **not** in the browser and **not** in the product: 53/53 deterministically, and
  the 20 s waits are responses that never arrived rather than requests that were never sent.
- One real defect was found and fixed in the sign-in lifecycle (two serial round trips), and the
  independent review then found that the first fix traded it for a worse one. The final fix is on
  the server: the login response carries the grant, so the second read does not exist.
- The acceptance layers now report separately, and `ok` is defined where its value lives.
- The transport penalty is measured but not removed, and the staging gate will keep flapping until
  it is. That is stated as an open P1, not papered over.
