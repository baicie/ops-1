# Incidents workspace — interaction state matrix

AGENTS.md §5 asks for a state matrix alongside the screenshots. Every row below was rendered by
Chrome against the build in this branch, not asserted from the component tree.

The dataset was seeded through the real API on a throw-away PostgreSQL database
(`opsweave_incidents_ui`), read by a real kernel on `127.0.0.1:18291`: 12 incidents (including one
run of 4 identical events), 7 evidence rows covering all three trust levels, and 1 recorded
verdict. The happy path is unstubbed.

Four states cannot be produced on demand from live data — 403, 409, a 500 and a slow response.
Those install a Playwright `page.route` that answers with the real HTTP status. Every one is named
"forced" in its test title in `tests/ui/incidents-workspace.spec.ts`.

## List page — `/app/incidents`

| State | How it arrives | What is drawn | Testid | Screenshot |
|---|---|---|---|---|
| Loading | request in flight | 3 skeleton bars, `aria-busy`; **no count printed** | `incidents-loading` | `state-loading-1440-light.png` |
| Ready | 200 with rows | KPI band + table + pager; count printed | `incidents-table`, `incidents-count` | `list-{1440,1024,390}-{light,dark}-{en,zh-CN}.png` |
| Stale | rows on screen, later refresh failed | rows kept, freshness line names the failure | `incident-freshness[data-stale=true]` | (covered by unit tests; the seeded kernel cannot fail mid-session on demand) |
| Empty | 200 with `items: []` | `EmptyState`, no dashed token, no `0`, secondary CTA | `incidents-empty[data-empty-state=none]` | `state-empty-1440-light.png` |
| Filtered | 200, empty because filters excluded everything | `EmptyState` with a "clear filters" remedy | `incidents-empty[data-empty-state=filtered]` | (same component, different copy) |
| Forbidden | **403** | permission wall naming the refusal | `incidents-forbidden` | `state-forbidden-1440-light.png` |
| Conflict | **409** | conflict panel + retry | `incidents-conflict` | `state-conflict-1440-light.png` |
| Failed | 500 / network | failure notice carrying the **stable error code** + retry | `incident-list-failed` | `state-failed-1440-light.png` |

Rules the matrix enforces, each with a test:

* **A refusal is never drawn as an absence.** The 403/500/409 tests each assert
  `incidents-empty` has count 0.
* **A count is only printed when the list answered.** `incidentCountKnown()` gates the toolbar;
  the 403 test asserts `incidents-count` is absent. Printing "0 on this page" beside a permission
  wall states a number the kernel never sent.
* **Only a genuine 200-with-no-items draws the empty state.** That is its own test.
* **The collector boundary survives the redo.** `incidents-boundary-collectors` is asserted
  present and non-empty; Zabbix and Nebula are still not connected and the copy still says so.

## Detail page — `/app/incidents/:id`

| State | How it arrives | What is drawn | Testid |
|---|---|---|---|
| Loading | incident request in flight | skeletons, `aria-busy`, `data-detail-state=loading` | `incident-detail` |
| Ready | 200 | KPI band + workspace grid + evidence + verdict | `incident-workspace`, `incident-timeline`, `incident-identity` |
| Not found | **404** | names the id, says the record does not exist | `incident-not-found` |
| Forbidden | **403** | permission wall; explicitly *not* "not found" | `incident-detail-forbidden` |
| Conflict | **409** | conflict panel + retry | `incident-detail-conflict` |
| Failed | 500 / network | failure notice with code + retry | `incident-detail-error` |
| Evidence: loading | evidence request in flight | loading line inside the panel | `incident-evidence[data-evidence-state=loading]` |
| Evidence: present | 200 with rows | table + `TrustSummary` + `TrustLegend` | `incident-evidence[data-evidence-state=present]` |
| Evidence: missing | 200, no rows | "no evidence recorded", not a failure | `incident-evidence-empty` |
| Evidence: forbidden | **403** | refusal; the remedy is a grant, not a retry | `incident-evidence-forbidden` |
| Evidence: unavailable | 500 / network | failure notice + retry | `incident-evidence-unavailable` |
| Verdict: open | no verdict, status ≠ CLOSED | the form | `incident-verdict[data-verdict-state=open]` |
| Verdict: recorded | verdict present | the record; the form is gone (write-once) | `incident-verdict-record` |
| Verdict: sealed | status CLOSED | no write offered | `incident-verdict-sealed` |

## Trust — the field that is not what it looks like

`insert_evidence` validates `trust` against the closed set and stores it. It does **not** verify a
signature on this build (that lands on branch `8423e86`). So the page never says "verified":

| Level | Tone | Glyph | Border | English copy |
|---|---|---|---|---|
| `SOURCE_ATTESTED` | `info` — **never `ok`** | shield | solid | "Source attested" |
| `OPERATOR_ASSERTED` | `neutral` | people | dashed | "Operator asserted" |
| `UNVERIFIED` | `warn` | dashed circle | dotted | "Unverified" |

Asserted by test: the three tones are three distinct values, none of them is `ok`, the three
chips are visually distinct, the baseline sentence renders exactly once, the legend exactly once,
and the summary's `data-weakest` equals the floor of the rendered rows (not their best).

## Keyboard

`focus-create-1440-light.png` is captured after Tab-reaching `incident-create-open` from the top of
the document; the test also asserts the focused element paints an outline or shadow.

## Geometry

`metrics/_metrics_r1440-light-en.json` is written by the spec from a live measurement and passed to
`scripts/check-ui-metrics.mjs`, which parses its thresholds out of `table-spec.md` §4.2:

```
ok    r1440-light-en  pages=1  violations=0
check-ui-metrics: PASS
```

A second test measures the 390 card directly (word wrapping, clipping, document overflow) because a
column-count check passes on a card whose content reference runs off the edge.
