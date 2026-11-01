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

Honest record, per `AGENTS.md` 工作步骤 4/6 — **this surface has not been seen in a browser.**

| check | command | result |
|---|---|---|
| model unit tests | `vitest run src/pages/observability-model.test.ts` | **37 passed** |
| token gate | `node scripts/check-ui-tokens.mjs --ratchet …/ui-debt.json` | **PASS**, budget unchanged |
| metrics gate | `node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit` | **PASS** (pre-existing artifacts; this surface is **not** in them) |
| i18n gate | `node scripts/check-i18n.mjs` | **PASS**, 1449 keys × 2 locales, 0 unused |
| parse / JSX | `esbuild` on all four files | **OK** |
| typecheck, this surface | `tsc --noEmit`, errors filtered to these files | **0 errors** |
| typecheck, repo-wide | `pnpm --filter @opsweave/platform-web typecheck` | **FAILS — blocked, pre-existing** |
| screenshots 1440/1024/390 × light/dark | `tests/ui/observability-surface.spec.ts` | **NOT RUN — blocked** |

**Why the last two are blocked.** Both are environment limits in this sandbox, not properties of
the change:

1. Nine declared dependencies (`@radix-ui/react-{dialog,dropdown-menu,label,select,separator,tabs,tooltip}`,
   `clsx`, `tailwind-merge`) are absent from every local pnpm store, and `registry.npmjs.org:443`
   is denied (`deny network-outbound registry.npmjs.org:443`). All 37 repo-wide `tsc` errors trace
   to those nine modules and their knock-on implicit-`any`/prop mismatches; filtering to the four
   files this change adds or edits gives 0. `tailwindcss` is in the same set, so `vite build` and
   `vite dev` both fail in the CSS pipeline before reaching any TSX.
2. No browser engine will start under this Seatbelt profile: Chromium dies on
   `bootstrap_check_in … Permission denied (1100)` (Mach port rendezvous), WebKit times out at
   launch, Firefox reports `Target crashed`. Local port binding is also `EPERM`, and the staging
   kernel is outside the network allowlist.

The screenshot spec is committed and ready. It must be run before this surface is called
reviewed — and because the 390px card layout is carried by Tailwind's `max-[768px]:*` utilities, a
screenshot taken **without** `tailwindcss` installed would show a layout that is not the shipping
one. That is worse than no screenshot, which is why none was faked.

To run once the registry and a browser are available:

```bash
pnpm install && OPSWEAVE_URL=http://127.0.0.1:5173 pnpm --filter @opsweave/ui-tests exec playwright test observability-surface.spec.ts
```

Artifacts land in `artifacts/ui/observability/` with a `_metrics_*.json` per viewport that
`check-ui-metrics.mjs` reads directly, so the geometry assertions (§2.2 column caps, §2.3 row
height, §2.5 card facts, §2.7 `NO_DATA` budget, overflow) are checked by the gate rather than by
eye.
