# 0.0.4 UI/UX Redesign — Evidence

Status: `PASS` for the implemented desktop/laptop/mobile visual gates; A11y and
canvas-scale performance remain `PARTIAL/NOT_RUN`.

## What changed

- Full-bleed Studio workspace: icon-rail global navigation at ≥1200px, 200px
  node palette, flexible canvas, 300px inspector, toggleable Preview console.
- Deterministic linear graph layout with 260px node spacing and human-readable
  node titles. Raw storage types moved to Inspector Advanced.
- Node cards: category icon/tint, full title, node ID secondary, 2-line config
  summary, separate typed port rows, 8px handles.
- Neutral node borders; accent only on selection. Smoothstep edges with a semantic
  edge token and hover/selection emphasis.
- Toolbar: Undo, Redo, Auto layout, Preview, Detail, Create draft; Save/Validate/
  Publish appear for drafts. Draft badges and conflict console remain compact.
- Pipeline Detail: four semantic metric cards with label/value separation;
  execution-path strip; revision table; bounded recent-job table.
- Job History: search, pipeline filter, status filters, duration, bounded UUID.
- Job Detail: pipeline name H1, status/revision/short-run metadata, four metrics,
  Advanced ID/fence/lease, Timeline, Attempts, Checkpoints and Result.
- Mobile: desktop tables become labelled cards at ≤620px; no page-level horizontal
  overflow. Studio becomes a single-column canvas-first layout at ≤760px.
- Dark mode uses real app theme state; graph background/edge tokens have dark values.
- Removed the temporary xyflow `display/visibility !important` workarounds; explicit
  workspace sizing and node dimensions now determine measurement.

## Visual QA

`tests/ui/visual-layout.spec.ts` asserts:

```text
PASS  pipeline detail: 4 cards, height > 70, label/value non-overlap
PASS  job UUID single-line height < 32, no page overflow
PASS  studio at 1440: canvas width > 700, height > 480, nodes visible
PASS  390 mobile / pipelines and /jobs: page scrollWidth <= clientWidth + 1
```

The same suite runs inside the real Data Foundation browser smoke with a real
Kernel, PostgreSQL and Worker.

## Before / After

Before (old UI, committed earlier):

- `docs/assets/0.0.4/pipeline-detail.png`
- `docs/assets/0.0.4/pipeline-canvas.png`
- `docs/assets/0.0.4/job-detail.png`
- `docs/assets/0.0.4/job-history.png`

After (real Chromium CI, code `613a51e`, run `40275262391`):

- `docs/assets/0.0.4/ui-redesign/studio.png` — 1440×900
- `docs/assets/0.0.4/ui-redesign/pipeline-detail.png` — 1280×1123
- `docs/assets/0.0.4/ui-redesign/pipeline-list.png`
- `docs/assets/0.0.4/ui-redesign/job-history.png`
- `docs/assets/0.0.4/ui-redesign/job-detail.png`
- `docs/assets/0.0.4/ui-redesign/mobile.png` — 390×844
- `docs/assets/0.0.4/ui-redesign/dark.png` — 1440×900, real app dark theme
- `docs/assets/0.0.4/ui-redesign/preview.png`
- `docs/assets/0.0.4/ui-redesign/conflict.png`

## Functional protection

The existing Playwright flow still passes:

```text
Login → Pipeline List → Detail → Studio
→ Create Draft → edit timeoutSeconds → Save → refresh
→ Validate → Publish
→ Run → Job SUCCEEDED → Timeline / Checkpoints / Result
```

Plus: preview, draft conflict, responsive/dark screenshots.

## CI

- Data Foundation `40275262391` on `613a51e`: **SUCCESS**
- Runtime `40275262472` on `613a51e`: **SUCCESS**
- Standard CI `40275262392` on `613a51e`: **SUCCESS**
- Legacy E2E inside Data Foundation: `PASS=21 FAIL=0`
- Visual Layout suite: **PASS**

Commit `613a51e` is the last full visual-gate code SHA. A tiny Job History
duration-column commit follows; it does not alter the evaluated layout or E2E
selectors, but needs its own CI on push.

## Review findings

### P0

None.

### P1 fixed

1. Metric labels and values visually concatenated due to missing metric classes.
2. Recent Job UUIDs wrapped into 8+ lines and inflated row height.
3. Job Detail used full UUID as H1.
4. Studio canvas was squeezed by fixed global nav/palette/inspector.
5. Node titles were storage types and truncated; all nodes had accent borders.
6. Mobile Pipeline List table collapsed into blank/tall rows.

### P2 remaining

- Mobile Studio Canvas is browse/limited-edit, not full drag-and-drop.
- A11y focus trap, delete confirmation and keyboard graph editing are partial.
- 64/128-node canvas performance and memory are NOT_RUN; current 6-node layout
  was validated visually.
- Job History duration is a UI-derived `updatedAt - createdAt`, not a dedicated
  backend execution-duration field.
- Preview console is intentionally bounded (no Source IO, no hard cancel).
- The global icon rail auto-collapse uses `:has()` and modern Chromium; supported
  by the supported browser matrix.
