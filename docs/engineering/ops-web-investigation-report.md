# Ops Web: Investigation and Report surfaces — what exists, what does not

TASK-14. Written by reading the routes, the components and the specs. Nothing here
is a plan; every row says where the capability is today.

## The two standalone routes are placeholders, and that is deliberate

`apps/ops-web/src/App.tsx:86,91`:

```tsx
<Route path="investigations" element={<SurfaceNotYetPage capability="investigations" />} />
<Route path="reports" element={<SurfaceNotYetPage capability="reports" />} />
```

`SurfaceNotYetPage` renders a header with the capability's own i18n label and detail
copy. It is not an empty div and not a broken page: it says the surface is not
available yet, in both locales, through the message catalogue.

**This is a recorded state, not an oversight.** The question TASK-14 asks is whether
the *capability* exists elsewhere before building a second one.

## The capability IS implemented — inside Incident Detail

The investigation workflow is not missing; it is not given its own URL.

| piece | file | what it does |
|---|---|---|
| panel | `investigation-panel.tsx` | verdict, confidence, citations, "no verdict control" copy |
| layout | `investigation-layout.tsx` | analysis pane / rail, compact-mode tabs |
| model | `investigation-model.ts` | state machine for the panel, unit-tested |
| lists | `investigation-lists.test.ts` | ordering and empty states |
| rail | `IncidentDetail.tsx:903` | `data-testid="investigation-rail"`, three states: loading / ready / unavailable |

Two behaviours worth naming, because a second implementation would have to re-earn
them:

- **A late answer from a previous incident is dropped.** Switching incidents while a
  fetch is in flight does not paint the old incident's evidence into the new one —
  `investigation-panel.tsx:54`.
- **Citations open the evidence they name**, through
  `/api/v1/incidents/{id}/evidence/{evidenceId}/content` — not a cached copy.

## What is genuinely NOT implemented

1. **A standalone investigations list.** There is no page that answers "all
   investigations in this workspace". The rail shows one incident's investigation.
2. **Reports as a product surface.** No report model, no report route beyond the
   placeholder, no export.
3. **A cross-incident timeline.** `g11-incident-slice.spec.ts` covers a single
   incident's slice; nothing joins several.

## Why this document does not propose building them

The charter's journey is 告警 → 事件 → Evidence → 调查 → 人工裁决 → 报告. Steps 1–5
exist and are covered by browser specs (`g11-incident-slice`, `g11-incident-state-gaps`,
`g12-incident-route-identity`, `incident-evidence-kpi`, `incidents-workspace`).
Step 6 — the report — has no backend behind it: there is no report table, no
generation job, no schema.

**Building a Reports page against no artifact would be a second UI for nothing**, and
that is the failure this task exists to avoid. What a report should CONTAIN is a
product decision, not a rendering decision, and the Phase 6 report already records
that real Zabbix and real LLM verification are BLOCKED_ENV — the inputs a report
would summarise are the ones not yet verified.

## State

| surface | state |
|---|---|
| Incident → Evidence → Investigation → Verdict | **INTEGRATION_VERIFIED** through browser specs |
| Investigations list route | **NOT_IMPLEMENTED**, placeholder says so |
| Reports route | **NOT_IMPLEMENTED**, placeholder says so |
| Report artifact / generation | **NOT_IMPLEMENTED**, and no backend to build against |
| Real Zabbix / real LLM inputs | **BLOCKED_ENV** (Phase 6 report) |
