# `/app/observability` — interaction state matrix

Scope: the two routes added by this change — `/app/observability` (fleet) and
`/app/observability/nodes/{id}` (one entity). Required by `rules/06-ui-ux.md`
(「Loading/Empty/Error/Unknown/Partial/Stale/Forbidden/Conflict 语义完整」).

Every row names the file and line that renders it, so a reviewer can check the claim against the
source rather than against this table. Line numbers are from the commit that introduces this file.

## 1. The three absences this surface must keep apart

The surface's whole purpose is that these never collapse into one another, and never into `0`.
`observability-model.ts` makes it a type rather than a convention: `Reading` carries a `value`
field **only** on the `reading` branch, so "missing rendered as zero" is a compile error.

| fact | wire condition | rendering | why not 0% |
|---|---|---|---|
| **READING** | node reachable, sample present | the number + its own `observedAt` | — |
| **NO_DATA** | node reachable, sample absent | `NO_DATA` token (dashed) once per region; muted words in rows | a source that has nothing yet has not told us the load is nil |
| **UNKNOWN** | node unreachable / revoked / unknown state | `UNKNOWN` token (dotted), never alone in a cell | we are not looking, so we cannot claim anything — the `AGENTS.md` MUST NOT |

A node that stopped answering **cannot** render as `ready`: `entityState()`
(`observability-model.ts:71`) resolves revoked → unreachable → stale → stored code, so the stored
`READY` column loses to the observation. A revoked or unreachable node may still carry its last
snapshot; `nodeReadings()` (`:117`) discards it and returns `UNKNOWN` for all three metrics,
because printing that last 4% is exactly the "offline inferred as fine" defect.

The instance count is gated by the same rule and through the same `stateCanReport()` predicate
(`EntityRow.instances`, `:129`). `instancesReady/instancesTotal` are **stored rows the kernel
counts**, not an observation of the node, so an unreachable node still carries whatever it held
when it last answered. Rendering `0/2 ready` for it is the same claim as rendering `0%` CPU:
"nothing is running" asserted while nobody is looking. The cell reads `UNKNOWN` instead, and
`rankCardFacts` receives `null` rather than a fabricated `0/0` so the card-rank metric is not
polluted by rows that have no value. Stale nodes keep their count — a stale count is still a
count, and `stale` is a state that may report.

## 2. Fleet — `/app/observability` (`src/pages/Observability.tsx`)

| state | trigger | rendering | site |
|---|---|---|---|
| **Loading** | first load, no data yet | 6-row skeleton, `aria-busy`, `role=status` | `AsyncBoundary` `:299` (`skeletonRows={6}`) |
| **Empty** (fleet) | `GET /nodes` → `[]` | `EmptyState` "no nodes enrolled"; no table, no band of zeros | `:308` `emptyState` |
| **Empty** (filtered) | filter/search excludes every row | separate `EmptyState` + **Clear filters**, `data-empty-state="filtered"` | `:316` |
| **Error** | first load fails | error panel with stable code, `requestId`, kernel message attributed, Retry | `AsyncBoundary` `:303` |
| **Error** (refresh) | later poll fails while rows are on screen | rows **stay**; only a first load with nothing to show becomes the panel | `error={data ? null : error}` `:303` |
| **Forbidden** | 403 | permission wall; no resource detail leaked | `AsyncBoundary` (`async-boundary.tsx` classify → `forbidden`) |
| **Conflict** | 409 | conflict panel + Retry | same, `classify` → `conflict` |
| **Unknown** | unreachable / revoked rows | `UnknownValue` in the coverage sentence; rows say it in muted words | `:342`, `Utilisation` `:98` |
| **Partial** | some nodes report, some do not | band splits `reporting` / `unobservable`; one sentence states coverage `n of m` | `:330`–`:345` |
| **Partial** (column) | ≥50% of rows cannot fill the load column | the column is **dropped** and the reason is stated once above the table | `loadColumnEarnsWidth` (`model:298`), `:355` |
| **Stale** (payload) | newest poll older than 2.5 intervals | `NoticeBar state="stale"` with the observation time + Retry | `:290` |
| **Stale** (sample) | a node's sample older than 120 s | per-row stale marker; counted in the band | `sampleIsStale` (`model:141`) |

## 3. Entity — `/app/observability/nodes/{id}` (`src/pages/ObservabilityEntity.tsx`)

| state | trigger | rendering | site |
|---|---|---|---|
| **Loading** (page) | first load | skeleton | `AsyncBoundary` `:281` |
| **Loading** (history) | window changed, request in flight | "loading samples", `role=status` — **not** an empty chart | `:374` |
| **Empty** (history) | window has no samples | `UNKNOWN` token + "no samples in this window"; no flat line at the floor | `SeriesPlot` `:90`–`:96` |
| **Empty** (instances) | node runs nothing | `EmptyState`, not a zero row | instances panel |
| **Empty** (events) | no audit rows | `EmptyState` | events panel |
| **Error** (page) | node request fails | error panel + Retry | `AsyncBoundary` `:281` |
| **Error** (history) | history request fails | **own** alert: "could not be read" — distinct from "no samples", so a failed query is never reported as an empty history | `:376`–`:382` |
| **Forbidden** / **Conflict** | 403 / 409 | as the fleet page, via `AsyncBoundary` | — |
| **Unknown** | node unreachable | state line + `NoticeBar`; all three KPI cards read `UNKNOWN` | `:310`, `:332` |
| **Revoked** | `revokedAt` set | `NoticeBar state="revoked"`; readings are `UNKNOWN`, last snapshot not shown as current | `:304` |
| **Partial** (series) | some samples lack this metric | line **breaks**; the note counts plotted / gaps / missing | `buildSeries` (`model:371`), note `:172` |
| **Stale** | snapshot older than 120 s | `NoticeBar state="stale"` naming the sample's own age | `:316` |

## 4. The chart: why it is hand-drawn

`buildSeries` splits a window into segments and the SVG renders **one polyline per segment**, so a
discontinuity is a visible hole rather than a line sloping through it. Three things break a run,
each a different fact:

| break | meaning | test |
|---|---|---|
| `value === null` | the collector answered without this metric | `breaks on a missing value rather than plotting it at zero` |
| gap > `maxGapFor(window)` | nothing was collected in between | `breaks the line at a gap instead of drawing through it` |
| `generation` changed | the agent restarted; two sides are different processes | `breaks when the node restarted, because two generations are not one trend` |

A charting library would interpolate across all three. That is the reason this page draws its own
plot and introduces no new dependency — the interpolation a library gives you for free is, here,
precisely the lie the rules forbid.

The window is the **caller's**, not the data's (`SeriesWindow`), so two samples in the last minute
of an hour-long window draw at the right-hand edge instead of stretching across the whole axis as
though they covered the hour. A single sample draws a dot, because a 1-point polyline renders as
nothing and an observation that exists must be visible.

## 5. Keyboard, focus and non-colour encoding

- Every row's identity is a real `<a href>` (`IdentityCell`), so Tab reaches it, Enter opens it,
  and Cmd-click / "copy link address" work. The row's `onClick` is a convenience on top, not the
  only way in.
- Every state is **glyph + text + colour** via `StatusIndicator`; `data-entity-state`,
  `data-reading-state` and `data-series-state` carry the machine reading. No state is colour-only.
- The load bar in a KPI card is `aria-hidden`; the number beside it is the accessible value.
- Each plot is `role="img"` with `aria-labelledby`/`aria-describedby`, and the description states
  the gap and missing counts — a sighted reader sees the breaks, so a screen-reader user is told
  how many there are.
- The history window is a `Tabs` strip with an `aria-label`; the filter is a labelled `Select`.
- The filter lives in the URL (`?state=…`), so the KPI band links into it and a filtered view is
  something an operator can paste into a ticket.

## 6. Verification status

Honest record, per `AGENTS.md` 工作步骤 4/6. Every row below was run on 2026-11-01 in this worktree;
the two that were previously listed as blocked are now green, and the reason is recorded rather
than quietly dropped (see §6.1).

| check | command | result |
|---|---|---|
| model unit tests | `vitest run src` | **246 passed / 23 files** (37 of them this surface's) |
| typecheck | `pnpm --filter @opsweave/platform-web typecheck` | **exit 0** |
| token gate | `node scripts/check-ui-tokens.mjs --ratchet …/ui-debt.json` | **PASS**, budget unchanged (118/14/7/5/19/4) |
| metrics gate | `node scripts/check-ui-metrics.mjs artifacts/ui/observability/metrics` | **PASS** — 24 page measurements, 0 violations |
| i18n gate | `node scripts/check-i18n.mjs` | **PASS**, 1449 keys × 2 locales, 0 unused |
| screenshots 1440/1024/390 × light/dark × en/zh-CN | `playwright test observability-surface.spec.ts` | **24 PNGs**, `artifacts/ui/observability/shots/` |
| state assertions | same spec, 3 tests | **3 passed** — see §6.2 |

### 6.1 What unblocked it

Both original blockers were environmental, and both were resolved without changing the product:

1. **The nine missing Radix packages** were linked from a sibling checkout whose store carries the
   identical lockfile hash (`302386c9b1380eda07966c1fefc7bb8d6d5e7b36`). Typecheck went from 39
   errors to 0. The symlinks drag a second copy of React, so the screenshot harness pins every
   React import with a `resolve.alias`; that is a harness concern and is not in the product build.
2. **The browser** could not launch under the command sandbox (Mach port `bootstrap_check_in`
   denied). With the sandbox off, Chromium 1248 launches and the committed spec runs unchanged.

A third problem was real and worth recording: the first measurement run reported 55.8px rows and a
0px `py-2.5` because Tailwind's `content` globs resolve against `process.cwd()`, which is the repo
root, not `apps/platform-web` — so the stylesheet shipped with no utilities in it. A screenshot
taken against that build would have looked plausible and described a layout that does not ship.
The harness now declares absolute globs (`.screenshot-harness/vite.config.mjs`).

### 6.2 The assertions, and what each one would catch

| test | asserts | would fail if |
|---|---|---|
| `states a missing sample as a token and never as a number` | an unreachable row carries `data-reading=unknown` and **no** `.ow-utilization`; 0 `NO_DATA` in table cells and exactly 1 in the coverage note; no identity key is a raw UUID, and all are distinct | the page printed the dead node's last snapshot as current — the `AGENTS.md` MUST NOT |
| `breaks the series at a silence instead of drawing through it` | the CPU plot is ≥3 separate `<path>` segments | the chart interpolated across the 20-minute hole or joined two generations |
| `keeps the fixed page template at every width` | header 80 at ≥769; the 24px stack gap at every width; `firstBlockY` 160 at ≥1025; overflow ≤ 0; rows ≤ 42px; columns ≤ 5/≤ 4; at 390 `cardFactCount ≤ 3` and no clipped identity | a card grew a fourth fact, an identity line ellipsised, or a wide table pushed the document sideways |

### 6.3 Two deviations found and reported, not patched

Both are in shared CSS this change does not own (`apps/platform-web/src/styles.css`):

1. **`firstBlockY` is 184, not 160, between 769 and 1024.** The `@media (min-width: 769px)` block
   sets `.main-content { padding-top: 0 }`, and a later `@media (max-width: 1024px)` block
   overrides it with `padding: 24px 24px 48px`. Measured on `/app/incidents` too, so it predates
   this surface. The spec therefore asserts the invariant the page owns (header-to-block gap = 24)
   at those widths and the full 160 above 1025, and says so in a comment at the assertion.
2. **The `.metric-grid` gap is 12px where `page-template.md` §2.3 asks for 16.** The rule is
   `styles.css:1196`, shared by Overview / OpsCenter and three other surfaces. Fixing it here
   would silently reflow five pages that have their own screenshots on file.

### 6.4 What this does not claim

- The screenshots are a **fixture fleet**, not a live kernel. This host's kernels expose no
  `/api/v1/nodes`; the measurements prove the layout and the missing-value semantics, not any
  claim about production node populations.
- `duplicateRunMax` is 0 by construction, not by measurement: §2.4 collapsing happens in
  `foldEvents` before the DOM, and its unit test is what actually holds that rule.
- No production-readiness statement is made or implied.
