# `/app/sources` — interaction state matrix and measured geometry

Captured 2026-11-01 against this worktree (`claude/sources-surface-6663ef`) by
`tests/ui/run-sources-audit.mjs`, driving real Chrome (`channel: chrome`) over the Vite dev server,
with `tests/ui/sources-fixture-api.mjs` answering the Kernel API routes. Every row below names the
screenshot it was read from — nothing here is asserted from component presence.

The fixture is a **fixture**, not a mock fallback: the page is never told which scenario is running.
Each state is produced by a real server answer (a 403, a 503, a 409, an empty array), so what the
page renders is its own derivation, not a prop someone set.

## 1. The eight states

| state | how it was produced | what the page does | evidence |
|---|---|---|---|
| **Loading** | every data route delayed (`slow`) | skeleton under `[data-async-state=loading]`; no zeros, no empty table | `state-slow.png` |
| **Ready** | populated registry, 12 connectors | KPI band + toolbar + table | `r1440-light-en__sources.png` |
| **Empty** | `GET /plugins` → `[]` | `EmptyState` naming the install path; **not** "0 connectors healthy" | `state-empty.png` |
| **Error** | `GET /plugins` → 500 | error panel with stable code + `requestId`; kernel's own sentence attributed, not substituted | `state-registry-down.png`, `state-error.png` |
| **Forbidden** | `GET /plugins` → 403 | permission wall; prints no resource detail it may not show | `state-forbidden.png` |
| **Conflict** | `GET /plugins` → 409 | its own panel (`[data-panel-state=conflict]`), distinct from a generic error | `state-conflict.png` |
| **Partial / Unknown** | `GET /capability-grants` → 403, plugins fine | Serving KPI renders `UNKNOWN` (not a number); notice bar says the grant list was withheld; every row reads "Reach unconfirmed" | `state-grants-forbidden.png` |
| **Stale** | first read answers, refresh refused with 503 | rows from the last good observation **stay on screen** (`rowsKept=12`) and a stale notice ages them (`[data-notice=stale]` = 1) | `state-stale.png` |

One more state the page distinguishes, because it is a different fact from "no connectors":

| state | produced by | what the page does | evidence |
|---|---|---|---|
| **No source capability registered** | `GET /capabilities` → `[]` | says the capability registry reports no source provider, rather than claiming the install has no connectors | `state-no-capabilities.png` |

### Why Partial and Stale are listed as separate rows

A 403 on grants is a fact about **this reader**, and silence from a refresh is a fact about **this
observation**. Folding either into the status column would print a health claim the platform cannot
support — which is what `AGENTS.md` forbids ("不得把 `UNKNOWN`/`PARTIAL`/`NO_DATA` 伪装成健康状态").
`state-grants-forbidden.png` is the one worth looking at: the Serving KPI refuses to be a number.

## 2. Geometry, measured (`page-template.md` §2.1, `table-spec.md` §4.2)

12 measurements = 3 viewports × 2 themes × 2 locales. Gate: `node scripts/check-ui-metrics.mjs
artifacts/ui/sources` → **PASS, 0 violations**.

| label | columns | row p95 | overflow | identity unique | NO_DATA / table | card facts | clipped |
|---|---:|---:|---:|---:|---:|---:|---:|
| r1440-light-en | 4 | 42.0 | −15 | 1.000 | 0 | — | — |
| r1440-light-zh | 4 | 42.0 | −15 | 1.000 | 0 | — | — |
| r1440-dark-en | 4 | 42.0 | −15 | 1.000 | 0 | — | — |
| r1440-dark-zh | 4 | 42.0 | −15 | 1.000 | 0 | — | — |
| r1024-light-en | 4 | 42.0 | −15 | 1.000 | 0 | — | — |
| r1024-light-zh | 4 | 42.0 | −15 | 1.000 | 0 | — | — |
| r1024-dark-en | 4 | 42.0 | −15 | 1.000 | 0 | — | — |
| r1024-dark-zh | 4 | 42.0 | −15 | 1.000 | 0 | — | — |
| r390-light-en | 3 | 93.2 (card) | −15 | 1.000 | 0 | 2 | 0 |
| r390-light-zh | 3 | 93.2 (card) | −15 | 1.000 | 0 | 2 | 0 |
| r390-dark-en | 3 | 93.2 (card) | −15 | 1.000 | 0 | 2 | 0 |
| r390-dark-zh | 3 | 93.2 (card) | −15 | 1.000 | 0 | 2 | 0 |

Thresholds: columns ≤ 5 @≥1024 and ≤ 4 @768–1023; row p95 ≤ 42 @≥768 (a card is not a row, §2.3);
overflow ≤ 0; identity distinct = 1.000; NO_DATA ≤ 1 per table; card facts ≤ 3.

Page template, measured at 1440: topbar 56 → header **80** (declared, not content-derived) → KPI
band (one, `.metric-grid`, 4 columns) → toolbar → table panel → secondary panels. Fixed order.

### Two columns are demoted, both by §2.2's own rule

`table-spec.md` §2.2: a column earns its width, or it moves inline. Measured over the 12 rows
on screen:

- **Reach** — distinct ratio **0.17**, below the 0.2 floor. On a healthy install nearly every
  connector is callable, so the column was two values down twelve rows. It is **demoted, not
  deleted**: the exceptions ride the identity cell's qualifier line, and the toolbar's "nothing may
  call it" filter selects them. The first metrics run failed on exactly this (`distinct-ratio-low`,
  12 labels) and the artifacts above are the re-run.
- **Publisher** — kept at 1440 (ratio 0.67), dropped below 1024 to hold §2.2's 4-column cap. The
  drawer prints it per connector either way.

### The 390 card

Line 1 is the identity key plus the status badge and the row menu; line 2 is the qualifier and the
demoted facts. Getting there needed a fix: Status *and* Trust were both line-1 items, which squeezed
`.ow-ident` to 8px and clipped the `· acme.zabbix` disambiguator on the two rows that share the name
"Zabbix" (`card-clipped`, 4 labels). Trust now carries `cardLineAfter`. §2.5 allows the **name** to
ellipsise and never the tail, so that tail is the thing the gate watches.

The clipping detector was verified to have a red side — forcing `max-width: 90px` onto the identity
line takes it from 0 to 2 and back to 0 on release. A detector that cannot fail proves nothing.

## 3. Keyboard, focus and non-colour encoding

| requirement | how |
|---|---|
| identity is a real control | the connector name is the row's own disclosure button, not a click handler on a `<div>` |
| row menu reachable | `RowActions` (shared) — 32px trigger, own `aria-label`, Radix keyboard handling |
| drawer / form | Radix dialog: focus trap, Escape, focus restore, scroll lock |
| focus visible | inherited `:focus-visible` ring from the shared stylesheet; no `outline: none` added |
| state not colour-only | every `StatusIndicator` prints glyph **+ word**; `data-indicator` / `data-trust` / `data-reach` carry the machine reading |
| trailing header cell | omitted (slot, not column) — the menu keeps its accessible name, and a titled constant column would feed `min(distinctRatio)` |

## 4. What this page cannot answer, and says so

No invented data stands in for any of these.

1. **Last successful collection.** Kernel API v1 has no such field. `PluginSummary.updatedAt` is
   when the plugin *record* changed, so printing it under "last collected" would be a number that
   looks like an observation. The column is **deleted** (§2.7: a column no row can answer is removed,
   not filled with dashes) and the drawer states the missing interface once.
2. **Saving connector configuration.** No kernel route persists a per-connector config document.
   The form validates in full and shows exactly what it *would* send, then says the interface is
   missing. A Save button that silently did nothing would be the demo-driven failure `AGENTS.md`
   forbids. `Save` is disabled and labelled.
3. **Evidence trust** is derived from signature state + publisher trust, and only ever *lowered*.
   A verified signature from a revoked publisher reads `OPERATOR_ASSERTED`, never `SOURCE_ATTESTED`;
   an absent signature state reads `UNKNOWN`, never `UNVERIFIED` ("we did not look" ≠ "it is unsigned").

## 5. Credentials — the security boundary

`rules/03-security.md`: secrets are references with short-lived grants and must never reach a log,
manifest, URL or error response. The form has **no field that accepts secret material**.

`r1440-light-en__config-refused.png` is the proof: a pasted `ghp_0123456789abcdef…` is refused, the
message names the rule, **the rejected value is never echoed**, and Save stays disabled. `type="text"`
is deliberate — a password field would imply this is where a secret goes. The stored-credential row
reads "No credential reference is stored for this connector"; an existing reference would show a
masked hint only (`secret://t…en`), never a value, and the field never pre-fills from one.

Covered by `src/pages/sources-model.test.ts` (39 cases): bearer/JWT/PEM/`sk_`/`ghp_`/base64/hex
shapes all rejected, and the rejection carries a code rather than the input.
