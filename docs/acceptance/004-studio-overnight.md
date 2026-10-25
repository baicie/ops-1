# 0.0.4 Overnight Studio Delivery — Evidence

Status: `READY_FOR_REVIEW` for the vertical Studio slice; Preview is `NOT_IMPLEMENTED`.

## Baseline / branches

```text
0.0.3 code:        30e792e (PR #2, Draft)
Foundation base:   ea8cc60 → 3467965 (PR #3, Draft)
Validation:        feat/0.0.4-validation (PR #4, Draft)
Drafts/Execution:  feat/0.0.4-drafts (PR #5, Draft)
Final code tested: cc871ae
```

PR #5 is stacked on PR #4, which is stacked on PR #3/0.0.3. No PR was merged or marked Ready.

## Implemented vertical chain

```text
Login
→ Pipeline List / Detail
→ Open Studio
→ Create Draft
→ Edit source timeout in Inspector
→ Save Draft (If-Match optimistic version)
→ Refresh browser and reopen draft
→ Server Validate
→ Publish Draft (idempotent, atomic)
→ New immutable Published Revision
→ Run published revision
→ Job Detail shows SUCCEEDED, Attempts, Fence, Result {accepted:2,batches:1}
```

### Server Validation

`POST /api/v1/pipelines/validate`

- Reuses `pipeline.rs::validate_pipeline`; recomputes canonical digest.
- Live Catalog schema pin and trusted Node Registry.
- Returns `valid/errors/warnings/canonicalOrder/planDigest/digest`.
- No Revision, Job, Receipt or Catalog write.
- Operator role required; request bounded by Axum body limit.

### Draft persistence

Migration `0011_pipeline_drafts.sql`; published revisions remain immutable.

```text
POST /api/v1/pipelines/{id}/drafts
GET  /api/v1/pipelines/{id}/drafts
GET  /api/v1/pipelines/{id}/drafts/{draftId}
PUT  /api/v1/pipelines/{id}/drafts/{draftId}   + If-Match
POST /api/v1/pipelines/{id}/drafts/{draftId}/publish + If-Match + Idempotency-Key
```

- Draft definition is stored separately with server-calculated digest.
- Version is incremented with `WHERE version=$expected`; stale writes return
  `409 DRAFT_VERSION_CONFLICT`.
- Owner (or admin) visibility; update ownership enforced in SQL.
- Publish allocates revision under `UPDATE ... latest_revision+1 RETURNING` in the
  same transaction, revalidates, inserts the immutable revision and marks the draft.
- Same Idempotency-Key returns the same revision; another draft reusing it returns
  `409 IDEMPOTENCY_CONFLICT`; invalid DAG allocates no revision.

### Jobs

```text
GET /api/v1/jobs?pipelineId=&status=&limit=&cursor=
GET /api/v1/jobs/{jobId}
GET /api/v1/jobs/{jobId}/result
POST /api/v1/jobs
POST /api/v1/jobs/{jobId}/cancel
```

Job list is cursor-paginated newest-first; status filter is allowlisted. Job result
is read from `kernel.pipeline_job_results`. Studio Run page only offers published
revisions; Drafts cannot be submitted.

## Tests actually executed

```text
cargo fmt --all -- --check                                  PASS
cargo clippy --locked --workspace --all-targets -- -D warnings PASS (branch CI)
cargo test --locked -p opsweave-kernel                      36 passed
pnpm --filter @opsweave/platform-web typecheck              PASS
pnpm --filter @opsweave/platform-web build                  PASS
pnpm --filter @opsweave/platform-web test:studio            7 passed
tests/acceptance/pipeline_read_api.sh                       PASS
tests/acceptance/pipeline_validation_api.sh                 PASS
tests/acceptance/pipeline_draft_api.sh                      PASS
tests/acceptance/pipeline_publish_api.sh                    PASS
tests/acceptance/job_list_api.sh                            PASS
Playwright studio.spec.ts                                   4 tests PASS
```

Playwright 4th test starts a real auto-claim `opsweave-pipeline-worker` against
Kernel, waits for the submitted Job to become `SUCCEEDED`, and asserts the Result
panel is rendered. It is not a timer-based mock.

## CI

Final code `cc871ae`:

- Data Foundation `40216437617`: attempt 1 **SUCCESS**; attempt 2 golden-path
  PASS but overall FAIL because the legacy-regression registry container step
  returned `curl 404`; attempt 3 failed at the same unchanged legacy step.
- Runtime `40216437610`: attempts 1 and 2 **SUCCESS**.
- Contracts `40216437622`: **SUCCESS**.
- Standard CI `40216437634`: **SUCCESS**.

Docs/evidence head `fda1b92` (contains no product code):
- Data Foundation `40218203551`: golden-path and all Studio/browser tests PASS;
  overall FAIL at the same legacy registry `curl 404`.
- Runtime, contracts and standard CI on `fda1b92`: SUCCESS.

The repeated failure is isolated to the pre-existing legacy-regression job
`docker run ... registry:2` setup, not to the Studio code path. Attempt 1 on the
same SHA is a complete green run.

## Screenshots (real Chromium, real PostgreSQL/Kernel)

- [pipeline-list.png](../assets/0.0.4/pipeline-list.png)
- [pipeline-detail.png](../assets/0.0.4/pipeline-detail.png)
- [pipeline-canvas.png](../assets/0.0.4/pipeline-canvas.png)
- [pipeline-draft-saved.png](../assets/0.0.4/pipeline-draft-saved.png)
- [pipeline-validated.png](../assets/0.0.4/pipeline-validated.png)
- [pipeline-published.png](../assets/0.0.4/pipeline-published.png)
- [job-history.png](../assets/0.0.4/job-history.png)
- [job-detail.png](../assets/0.0.4/job-detail.png)

Browser/Viewport: Playwright Chromium Linux, 1280×720. Commit `cc871ae`.

## Review findings

### P0

None found in the delivered vertical slice.

### P1 (fixed)

| Finding | Failure scenario | Fix | Commit |
|---|---|---|---|
| Published editor digest/status leaked into local edits | old PUBLISHED digest attached to modified definition | `fromGraph` always emits DRAFT + empty digest; server recomputes | `0e3517e` |
| Inspector was editable without a Draft | user believes published revision is editable | inputs disabled; explicit create-draft notice | `0529c0b` |
| Stale pipeline load could overwrite current page | rapid route/draft switch shows wrong pipeline | load sequence guard | `74e44ce` |
| Initial React Flow layout set Dirty | opening Studio showed unsaved changes | compare IR nodes/edges to baseline; only real edits dirty | `0e3517e` |
| Draft update updated another user's row | cross-user draft overwrite | SQL `created_by` ownership predicate | `c2fa946` |
| Draft save error/refresh path could use stale cursor | Retry/Refresh no-op | reload token + cursor stack | `0e3517e` |

### P2 / remaining debt

- Server Validation errors carry code/message but not precise node/field IDs for
  every `PipelineError`; client local validation supplies node IDs.
- `GET /api/v1/jobs/{id}/result` exposes the bounded result output to any
  authenticated viewer; per-tenant scope is not modeled in this version.
- Job Detail exposes only durable Job fields and Result; Attempt/Checkpoint/Lease
  history remains a diagnostics follow-up.
- Preview / Dry-Run is `NOT_IMPLEMENTED`; no fake Preview button exists.
- 1024/390/dark Studio screenshots and 64/128-node performance are `NOT_RUN`.
- Responsive Studio canvas is desktop-first; mobile uses generic shell only.
- Create Pipeline entry still comes from the API; no dedicated create page.
- OpenAPI is updated for validation/draft/publish/job-list, but some legacy
  create responses remain broader than implementation.

## Gate matrix

| Gate | Status |
|---|---|
| Foundation hardening | PASS |
| Server validation | PASS |
| Inspector editing | PASS |
| Draft persistence / refresh | PASS |
| Optimistic concurrency | PASS |
| Atomic Publish / idempotency | PASS |
| Immutable published revisions | PASS |
| Job list/detail/result | PASS |
| Real Worker completion E2E | PASS |
| Preview | NOT_IMPLEMENTED |
| Responsive/dark/Studio perf | NOT_RUN |
| Diagnostics attempts/checkpoints | PARTIAL |
