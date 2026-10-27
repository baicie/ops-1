# 0.0.4 Product Hardening — Evidence

Status: `READY_FOR_REVIEW` for the hardening slice. Preview is a bounded MVP;
hard cancellation, mobile Studio editing and performance gates remain `PARTIAL/NOT_RUN`.

## Security model

| Principal | Job summary | Job result | Cancel |
|---|---|---|---|
| Admin | all | all | all |
| Operator | own jobs only | own jobs only | own jobs only |
| Viewer | summary metadata only | 403 | 403 |
| Legacy Job with `submitted_by = NULL` | admin only | admin only | admin only |
| Worker / Node | dedicated workload identity; unchanged internal APIs | — | — |

Migration `0013_job_submitter.sql` adds nullable `submitted_by`; it does **not**
invent owners for historical jobs. List filtering is in SQL, not the UI.

Verified by `tests/acceptance/job_authorization.sh` with two real users:
Operator B receives 404 for A's job/result/cancel and cannot see it in list;
Viewer C receives summary 200, result 403, cancel 403; Admin can cancel and read
the durable CANCELLED result; diagnostics follow the same policy.

## Publish concurrency

`publish_draft()` catches PostgreSQL SQLSTATE `23505` from the unique
`pipeline_drafts_publish_key_idx` update, rolls back the allocated revision and
returns deterministic `409 IDEMPOTENCY_CONFLICT`. Same-draft same-key requests
replay the one published revision.

`publish_concurrency.py` with real HTTP/PostgreSQL:

```text
8 concurrent same key across two drafts → [200,409,200,409,200,409,200,409]
8 concurrent different keys same draft  → one 200, seven 409, no 500
latestRevision advanced exactly per successful logical publish
lost-response retry returned the same revision
```

## Legacy CI / JRE

Root cause: the pinned Tsinghua mirror path for Temurin 21.0.12.1 returned 404.
Fix: use official Adoptium 21.0.13+9 assets and checked SHA-256:

```text
x64:     a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd
aarch64: b1734db7ade49c3f6acc6ae06233b8c2dd90e3e2f00f67000ae1c972aaa64d8c
URL: https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.13%2B9/
```

Local download hash matched x64. CI Java OCI build succeeded and the legacy E2E
reported `PASS=21 FAIL=0` in the full green Data Foundation run.

## Preview / Dry-Run

```http
POST /api/v1/pipelines/preview
```

Request: typed definition, explicit sampleInput, optional maxRecords/start/stop.
Response: previewId, status, nodeOutputs, errors, processedRecords, elapsedMs,
truncated.

Safety boundary:

- Pure transforms extracted into `crates/pipeline-transform`; the production
  Worker and Kernel Preview use the exact same Map/Filter/Validate code.
- Source node consumes only explicit sample input; no external HTTP fetch.
- Sink terminates preview and reports would-be rows; no Catalog client exists in
  the preview engine.
- No Revision, Job, Job Result, Receipt, Catalog Effect or Dataset row is written.
- Unsupported node types fail closed with `UNSUPPORTED_PREVIEW_NODE`.
- Operator role required; Viewer 403.

Budgets:

```text
sample records: 100
input JSON:     256 KiB
output payload: 256 KiB (sample rows cleared + truncated=true)
nodes:          64
sample rows/node: 10
```

These are hard request/work bounds. There is intentionally no fake async timeout:
the MVP performs no Source IO and its CPU work is bounded by the record/byte caps.
A hard cancellable execution boundary is `NOT_IMPLEMENTED`.

Tested with `tests/acceptance/preview_api.sh`: COMPLETED transforms, record limit,
missing mapping failure, 401, and before/after equality of Revision count, Job
count and Catalog record count. Browser test 9 exercises the real Preview panel.

## Job diagnostics

```http
GET /api/v1/jobs/{jobId}/diagnostics
```

Returns authorized, bounded events (500), attempts (50), leases (50), checkpoints
(100) and terminal Result. No bearer tokens, node secrets, raw source responses or
request headers are returned. Diagnostics require owner/admin; Viewer gets 403.

Browser test renders Timeline, Attempts, Checkpoints and Result from the real
successful Worker job. The same API is covered for CANCELLED jobs by the job
authorization test.

## Frontend

- Draft conflict now preserves local edits, shows `DRAFT_VERSION_CONFLICT`,
  server/local node+edge counts, and offers Keep editing / Reload latest /
  explicit Use local & retry.
- Playwright two-page conflict test proves local `timeoutSeconds=19` survives a
  stale save and the conflict UI is visible.
- Responsive screenshots: 1024 laptop, 390 mobile, 1440 true app dark mode
  (localStorage theme, not merely `prefers-color-scheme`).
- Dirty unload warning (`beforeunload`) added.
- True dark screenshot verified with the app theme toggle label.

## Actual tests

```text
cargo test --locked -p opsweave-pipeline-transform   2 passed
cargo test --locked -p opsweave-pipeline-worker      18 passed
cargo test --locked -p opsweave-kernel               36 passed
cargo clippy --workspace --all-targets -D warnings   PASS
cargo fmt --all --check                              PASS
pnpm platform-web typecheck/build                    PASS
Vitest studio IR                                    7 passed
Playwright studio.spec.ts                           7 passed
pipeline_read / validation / draft / publish         PASS
publish_concurrency.py                               PASS
job_list_api / job_authorization                     PASS
preview_api                                          PASS
Legacy 0.0.1 E2E                                     PASS=21 FAIL=0
```

## CI

Full green runs:

- Data Foundation `40257687664` on `492a13d`: **SUCCESS**
- Runtime `40257687709` on `492a13d`: **SUCCESS**
- Data Foundation `40260648468` on `65775ef`: **SUCCESS**
- Runtime `40260648446` on `65775ef`: **SUCCESS**
- Legacy `PASS=21 FAIL=0` in both Data runs.
- Standard CI `40260648441` on `65775ef` failed only because `Cargo.lock` was
  missing the new workspace crate; fixed by `3d9b5c0`.
- Standard CI on `a818b67` succeeded (`40263910776`).
- Data Foundation `40263910759` on `a818b67`: attempt 1 failed in the pre-existing
  `capability_multi_provider` revoke test after all hardening tests passed;
  attempt 2 **SUCCESS**. This is one complete green run on the final code SHA.
- Runtime `40263910815` on `a818b67`: **SUCCESS**.
- Standard CI `40263910776` on `a818b67`: **SUCCESS**.
- Docs head `63c5415` has no product-code delta; its Data/Runtime reruns were in
  progress at report time.

## Screenshots

Real Chromium CI, real Kernel/PostgreSQL/Worker:

- [Server Preview](../assets/0.0.4/hardening/pipeline-preview.png)
- [Draft Conflict](../assets/0.0.4/hardening/pipeline-conflict.png)
- [Job Timeline / Result](../assets/0.0.4/hardening/job-detail.png)
- [Mobile Pipeline List](../assets/0.0.4/hardening/pipeline-list-mobile.png)
- [Laptop Pipeline List](../assets/0.0.4/hardening/pipeline-list-laptop.png)
- [True Dark Mode](../assets/0.0.4/hardening/pipeline-list-dark.png)
- [Published Revision](../assets/0.0.4/hardening/pipeline-published.png)

## Findings

### Fixed P1

1. Job IDOR: result/cancel had no ownership check. Fixed with `require_job_access`
   and SQL list filtering; `submitted_by` migration; cross-user tests.
2. Admin job list accidentally filtered to own jobs. Fixed `view_all` predicate.
3. Cross-draft publish key race could return 500. Fixed SQLSTATE 23505 handling
   and concurrent tests.
4. Legacy JRE URL 404. Replaced with official verified Adoptium asset; Java OCI
   and legacy E2E pass.
5. Cargo.lock omitted the new transform crate, breaking `--locked` CI. Fixed.
6. Dark-mode test was only emulating media preference. Fixed to set the real app
   theme and assert the toggle.
7. Draft conflict could discard local edits implicitly. Fixed explicit resolution
   actions and E2E proof local config survives.

### P2 / backlog

- Preview has no hard wall-clock cancellation or asynchronous job; bounded pure
  execution only. Source IO preview remains out of scope.
- Preview startNode is limited to the source; arbitrary mid-graph start is rejected.
- Job Cancel browser E2E is not implemented; API authorization/cancel is tested.
- Mobile Studio canvas editing is desktop-first; list/job pages are viewable at 390.
- 64/128 node canvas performance and memory measurements are NOT_RUN.
- Focus trap/dialog A11y is partial; visible focus and labels exist.
- Viewer summary policy is role-based platform visibility, not per-resource grants.
- Diagnostics queries are capped but not cursor-paginated.

## Gate matrix

| Gate | Status |
|---|---|
| Job IDOR / result / cancel authorization | PASS |
| Cross-user negative tests | PASS |
| Publish same-key concurrency | PASS |
| Publish different-key concurrency | PASS |
| Legacy JRE source + SHA | PASS |
| Java OCI build / legacy E2E | PASS |
| Preview pure transforms | PASS |
| Preview no Catalog/Job/Receipt writes | PASS |
| Preview hard timeout/cancel | PARTIAL (bounded, not cancellable) |
| Preview Source IO | NOT_IMPLEMENTED (intentionally) |
| Job diagnostics API/UI | PASS |
| Job FAILED/takeover diagnostics E2E | PARTIAL |
| Draft conflict UX | PASS |
| Job cancel API authorization | PASS |
| Job cancel browser E2E | NOT_RUN |
| Responsive 1024/390 | PASS (list) / PARTIAL (Studio editing) |
| Dark Mode | PASS |
| A11y | PARTIAL |
| Canvas performance | NOT_RUN |
| Data/Runtime/Contracts full CI | PASS on 492/657; final a818 pending |
