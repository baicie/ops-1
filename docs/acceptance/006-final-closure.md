# 0.0.4 Final Closure — Code 3fe6f81

## Closed

- Viewport lifecycle: ResizeObserver + measured-node rAF, explicit invalidation for
  layout/view commands, no fixed sleeps, no auto-reset after user pan.
- Two explicit view modes: Readable (default zoom 0.9, pan for remaining nodes)
  and Fit All (fitView with relaxed min zoom). Toolbar controls both.
- Layout mode toggle rebuilds positions and handles; View State never enters IR.
- Mobile Node List now uses `getPipelineExecutionOrder()`; invalid topology shows
  `?` indices instead of a fake execution path.
- JSON config fields are controlled with a local raw-text buffer. Valid JSON
  updates typed config; invalid JSON keeps user text, marks `aria-invalid`, and
  disables Save until it parses. Server reloads/conflict recovery resync text.
- Mobile Studio toolbar wraps; no page-level overflow; node list + inspector smoke.
- Job duration unit matrix (7 tests) and topology/IR/layout tests (35 total).

## CI

- Data Foundation `40350354877` on `3fe6f81`: SUCCESS (attempt 1)
- Standard CI `40350354798` on `3fe6f81`: SUCCESS
- Runtime `40336239148` on `5ed5933`: SUCCESS (backend unchanged after this)
- Data `40332907493` on `5ed5933`: attempts 1 and 2 SUCCESS
- Legacy E2E: PASS=21 FAIL=0

## Open

- Mobile full Create→Save→Validate→Publish E2E still times out in CI; only the
  deterministic node-list/inspector smoke is gated. Feature remains PARTIAL.
- Readable view intentionally shows only the first region; Fit All is the
  overview mode. Six-node Fit All text remains small.
- 32/64 node performance baseline, A11y full keyboard graph, and pixel snapshots
  were not completed.
- 0.0.5 Data Governance code was not started in this sprint; no schema/API was
  invented without a separately reviewed contract.
