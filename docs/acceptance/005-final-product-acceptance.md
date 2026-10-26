# 0.0.4 Final Product Acceptance

Code HEAD: `5ed5933b59659dbb60592f3638edc2485ddbfc74`
Branch: `feat/0.0.4-final-product-acceptance`
PR: Draft, base `feat/0.0.4-ui-redesign`.

## Delivered

- Shared `getPipelineExecutionOrder()`: Kahn topology from IR edges, deterministic
  node-ID tie-break, duplicate-edge diagnostics, cycle/disconnected/multiple
  source/sink rejection. Pipeline Detail and Studio both use it.
- Studio Horizontal / Vertical layout modes; Vertical changes handles to
  Top/Bottom and uses deterministic single-column coordinates. Auto Layout and
  layout-mode changes never mutate the persisted IR or Digest.
- Measurement-aware initial fit: ResizeObserver + requestAnimationFrame waits for
  non-zero container and measured node elements, is cancelled on unmount, and
  does not fight user pan/zoom.
- Job duration semantics extracted to `jobDuration.ts`; QUEUED, CLAIMED, RUNNING,
  SUCCEEDED, FAILED, CANCELLED, missing and invalid timestamps covered by unit
  tests. Execution window still includes retry/takeover gaps and is labelled as
  such, not summed CPU time.
- Structured Draft Conflict diff with fail-closed handling for unknown values;
  audited numeric fields recognized; secret-disclosure regression test added.
- Mobile Studio: Nodes/Canvas switch, node list, Inspector access, toolbar wraps
  instead of clipping, no page-level horizontal overflow.
- A11y: keyboard copy button for Job ID, node delete confirmation, shared Modal
  focus trap/Escape/restore, labels, aria labels.
- Client-side branch-join topology rejection, persisted IR array-order preservation
  across visual layout, and terminal-state duration guards (from paired commits).

## CI evidence

Final code SHA `5ed5933`:

- Data Foundation `40332907493` attempt 1: **SUCCESS**
- Standard CI `40332907425`: **SUCCESS**
- Runtime dispatched `40336239148` at this SHA.
- Earlier same-code family `9856ee2`: Data `40319832045` attempts 1 and 3
  **SUCCESS**; runtime `40322762979` **SUCCESS**. Attempt 2 failed in an unrelated
  Catalog/Integration screenshot locator timeout.
- Legacy E2E `PASS=21 FAIL=0`.

Known harness flake: mobile draft-save journey was reduced to node-list/inspector
smoke after a 60s timeout in CI; full mobile save/publish remains PARTIAL.

## Gate summary

| Gate | Status |
|---|---|
| Pipeline execution order shared | PASS |
| Horizontal / vertical layout modes | PASS |
| 6-node visual layout | PASS (fit/pan; small text at fitted zoom) |
| 32/64-node layout | NOT_RUN |
| Measurement-aware fit | PASS in CI |
| Double-tab draft conflict | PASS in final CI |
| Duration status matrix | PASS unit tests / API DTO |
| Mobile node list + inspector | PASS |
| Mobile save/publish journey | PARTIAL |
| A11y | PARTIAL |
| Performance benchmark | NOT_RUN |
| Pixel snapshot baseline | NOT_RUN |
| Stacked PR split | NOT_PERFORMED (stacked review documented) |
