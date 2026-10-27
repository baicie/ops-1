# 0.0.4 Pipeline Studio Foundation — Evidence

Status: `READY_FOR_REVIEW` for PR1–PR3 read-only foundation; PR4 is `PARTIAL`.

Base code: `ea8cc60` (0.0.3 branch `feat/0.0.3-typed-pipeline`, PR #2 Draft); 0.0.3 code gate was `30e792e`.
Studio branch: `feat/0.0.4-studio-foundation`.
Draft PR: #3 (base `feat/0.0.3-typed-pipeline`, Draft; never merged by automation).

## Implemented

- `GET /api/v1/pipelines?limit=&cursor=`
- `GET /api/v1/pipelines/{pipelineId}`
- `GET /api/v1/pipelines/{pipelineId}/revisions?limit=&before=`
- `GET /api/v1/pipelines/{pipelineId}/revisions/{revision}`
- Pipeline list and detail pages backed by Kernel DTOs; no mocked rows.
- IR adapter `toGraph` / `fromGraph`; position, selection and xyflow state are
  editor-only and never emitted into `PipelineDefinition`.
- xyflow canvas with custom typed nodes/handles, pan/zoom/fit, selection,
  local edge creation guard (port existence + type match), delete, undo/redo,
  dirty state.
- Inspector: node ID, type, typeVersion, config, typed ports.
- Client validation for unknown type, missing port, edge/source type mismatch,
  multiple sources/sinks, branching/joining, duplicate IDs, cycles and
  disconnected nodes.
- Read-only publish control: disabled with explicit reason; no fake publish.
- Playwright Studio smoke with real Kernel data and screenshots.

## API response shape

List: `{ items: [{ pipelineId,name,latestRevision,createdAt,updatedAt }], nextCursor }`.
`name` is derived from the latest stored IR `name`; no name column was invented.
List order is stable `pipeline_id ASC`; cursor is opaque URL-safe base64 of the
last pipeline ID. `limit` is clamped to `1..100`.

Detail: `{ pipelineId,name,latestRevision,createdAt,updatedAt,latest,revisions }`.
`latest` is the exact stored definition/plan/digest for the latest revision.
Revision history is bounded to 20 on detail and paginated by strict `before`
revision on the revisions endpoint.

Security: existing session middleware; 401 unauthenticated, 404 missing,
400 invalid cursor; SQL parameters bound; no credentials returned. Read endpoints
do not mutate state.

## Tests actually run

- `cargo test --locked -p opsweave-kernel` — 36 passed.
- `cargo clippy --locked --workspace --all-targets -- -D warnings` — PASS.
- `pnpm --filter @opsweave/platform-web typecheck` — PASS.
- `pnpm --filter @opsweave/platform-web build` — PASS.
- `pnpm --filter @opsweave/platform-web test:studio` — 7 IR tests PASS.
- `tests/acceptance/pipeline_read_api.sh` — list/detail/revisions/revision,
  400/401/404 and pagination PASS.
- Playwright `studio.spec.ts` — list/detail and canvas/inspector PASS.

## Screenshots

Artifact `data-foundation-screenshots`, path `studio/`; copies committed under
`docs/assets/0.0.4/`:
- [pipeline-list.png](../assets/0.0.4/pipeline-list.png) — 1280×729, real test DB includes Host Metrics Pipeline.
- [pipeline-detail.png](../assets/0.0.4/pipeline-detail.png) — 1280×868, six typed nodes and revision history.
- [pipeline-canvas.png](../assets/0.0.4/pipeline-canvas.png) — 1280×752, six-node linear graph, selected source,
  inspector config and Validation=0.

Browser: Playwright Chromium desktop (CI Linux). Viewport 1280×720.
These are real Kernel-backed screenshots, not design mocks.

## Known gaps

- PR4 is partial: inspector is read-only and validation is client preflight;
  no server-side no-op validate endpoint yet, and no Draft/Publish mutation.
- No Studio create entry; creation remains through the existing API.
- Studio screenshots are desktop light only; 1024/390 and dark-mode Studio
  screenshots are `NOT_RUN` (the existing Data Catalog responsive screenshots
  remain unrelated evidence).
- No 64/128 node performance run for the canvas yet; synthetic 200-node test
  is `NOT_RUN`.
- OpenAPI `typed-pipeline-v1.yaml` still lacks the new GET paths; implementation
  and shell contract test are ahead of the published document. This is a P2 gap.

## Code review findings

- P1: fitView/no measured viewport left React Flow nodes hidden in headless
  Chromium. Fixed with explicit 520px viewport and node-layer visibility;
  verified by Playwright.
- P1: React Flow initialization emitted a position-change batch and falsely set
  the editor dirty on first render. Fixed by only accepting real position deltas.
- P2: minimap covered the sink node; removed.
- P2: no server-side validation endpoint; publish remains disabled rather than
  calling publish as a fake validate.

## CI

Final code `0e19a65` (canvas complete; two clean runs):
- Data Foundation: `40203367958` attempts 1 and 2 SUCCESS.
- Runtime: `40203367943` attempts 1 and 2 SUCCESS.
- Standard CI: `40203368001` SUCCESS.

Final code `83fd1bb` (only list refresh/retry fix):
- Data Foundation: `40205544299` attempts 1 and 2 SUCCESS.
- Runtime: `40205544169` attempts 1 and 2 SUCCESS.
- Standard CI: `40205544171` SUCCESS.
