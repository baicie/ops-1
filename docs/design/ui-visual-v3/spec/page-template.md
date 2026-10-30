# Page template — one page, one ruler

Status: **normative**. Applies to every route rendered by `apps/platform-web` (admin shell, workspace
shell, surface shell). Token values come from `token-table.md`; this file only says **where** they go.

---

## 1. 现状实测

### 1.1 The header is eight shapes and two components

34 `<PageHeader>` call sites resolve to 8 distinct prop shapes (`token-table.md` §1.4) `[src]`. Both
`components/app/page-header.tsx` and `components/Ui.tsx` export a component of that name, and
`.studio-page .page-header` (styles.css:832) adds a third CSS treatment (padding `2px 2px 8px` + a
`border-bottom`) on top of the admin one.

Height is never declared. It is the sum of whichever slots the page happens to pass:

```
text-only, no eyebrow, no description   = 31px  title line box (§1.4)
title + description                     ≈ 55px
eyebrow + title + description           ≈ 76px
eyebrow + title + description + actions  ≈ 76px (actions do not add height: align-items is flex-start)
```

so the first content block lands wherever the header's content ends. That is the mechanism behind the
review's “36 / 62 / 83px, first block at y=140 / 166 / 187”: **three pages, three shapes, three heights.**

### 1.2 The action row is not on the title's line

`.page-header { align-items: flex-start }` (styles.css:316) puts `.page-actions` at the top of the copy
column. Computed `[src]`:

| box | top | centre |
|---|---:|---:|
| action button (40px) | 0 | **20.0** |
| eyebrow line (11px × 1.5) | 0 | 8.3 |
| `h1` (26px × 1.2) | 20.5 | **36.1** |

Δ = **16.1px** between the button's centre and the title's centre on any page that passes an `eyebrow`
(`/admin/settings`, `/admin/diagnostics`, every studio page). The review measured 19px on settings; the
difference is its 4px description gap. Either way the button floats above the title — the defect is
structural (`flex-start` + a two-line copy column), not a per-page nudge.

### 1.3 The KPI band has three implementations and three gaps

| container | gap | padding | card |
|---|---|---|---|
| `.metric-grid` (styles.css:1134) | 12px | 0 | `.metric-card` min-height 92, gap 8 |
| `.module-strip` (styles.css:1152) | 8px | 12px 16px 16px | `.ow-metric` padding 12px 16px, no min-height |
| `.stat-strip` (styles.css:1355+) | 0 (shared hairlines) | 0 | `.ow-metric` with 11px labels |

Three containers × two card bodies = six renderings of “a row of KPIs on one page”. The two card bodies
disagree on the one thing that decides whether a band lines up: the height is `min-height: 92px` in one and
content-derived in the other.

### 1.4 Toolbars mix control heights within one row

`/admin/jobs` `[src]`: `Input` `h-9` = **36**, `Button` `h-9` = **36**, `SelectTrigger` `h-9` = **36**,
`TabsTrigger` `min-height: var(--ow-control-sm)` = **28**. One 8px baseline break inside a single flex row.
Same pattern in `/admin/activity`, `/admin/plugins`, `/admin/nodes`, `/admin/governance`.

---

## 2. 规则

### 2.1 The template

```
topbar                        56px   (--ow-topbar, sticky, one border-bottom)
──────────────────────────────────────────────────────────────────────────────
canvas gutter                 24px   (16px below 768)
  page-header                 80px   ≤—— fixed height, see token-table R5
  [gap]                       24px   (--page-stack gap)
  KPI band (0 or 1)           gap 16, 4 / 2 / 1 columns
  [gap]                       24px
  toolbar                     40px   ≤—— one control tier per row (C1)
  [gap]                       12px
  primary table panel         the only region allowed to scroll horizontally
  [gap]                       24px
  secondary panels            ≤ 2 per page, in reading order
```

**The order is fixed.** A page may omit a region; it may not reorder one. A page that needs something
else is a page whose design has not been decided yet — the answer is not a new region between the header
and the table.

### 2.2 Header: 80px, h1 26px, actions on the title's line

- `height: 80px; box-sizing: border-box; align-items: center`. A declared height, not a computed one.
- `h1` = `--ow-type-title` (26px), `line-height: 1.2`, one line at ≥1024, ellipsis after two lines below.
- `description` = `--ow-type-meta` (13px), **one line**, `text-overflow: ellipsis`. Overflow text moves into
  the page body above the first band. This is what keeps the height constant; without it the height is
  content-dependent again.
- `egress`: `.page-actions` sits **on the title's line**, vertically centred on the `h1`'s centre, not on the
  header's centre. `.page-header` becomes `display: grid; grid-template-columns: minmax(0,1fr) auto;
  align-items: start` with the copy column carrying `eyebrow / h1 / description` and the action row carrying
  `margin-top: <eyebrow height + h1 half>` — one value that closes the 16.1px gap above.
- At most one primary CTA per page, and it is the last control in the action row.
- `::before` eyebrow: optional, but if present it is the **route name**, uppercased only under `:lang(en)`.
  The eyebrow is what pushes the action row down today, so it is also why §1.2 has to be fixed in CSS and
  not by removing eyebrows from pages.

### 2.3 KPI band: one container, gap 16

- One container: `.metric-grid`, `display: grid`, `grid-template-columns: repeat(4, minmax(0,1fr))`,
  `gap: 16px`; at ≤1024 `repeat(2, …)`; at ≤640 `1fr`. Columns may be 4 or 2 — never 3 (a 4-col band that
  can be 3 columns cannot be scanned as a band).
- One card body: `.ow-metric` — `padding: 12px 16px`, `border-radius: var(--ow-radius-card)`,
  `min-height: 92px` (unconditional), `gap: 12px`. Label `--ow-type-label` 11px, value `--ow-type-title`
  26px with `font-variant-numeric: tabular-nums`, detail `--ow-type-meta` 13px, `justify-content:
  space-between`.
- **Why gap 16 and not 12**: the card's own horizontal padding is 16px. A gap smaller than the internal
  padding violates proximity — the space inside a card becomes tighter than the space between cards, and
  the band reads as a two-column list of six rows. 16 = the padding is the smallest gap at which the
  border, not the whitespace, is doing the grouping. 12 (today) is below it; 24 would break the band into
  pairs at 1024.
- **Why min-height 92 unconditionally**: a band whose cards are 92 and 68 tall in the same row puts the
  second row of values 24px below the first row of labels, and the eye reads a ragged edge as a loading
  state. 92 = 12 + 16 (label 11×1.45) + 12 + 31 (value 26×1.2) + 8 + 19 (detail 13×1.45) + 12 − 8 slack.
  The exact interior distribution is free; the total is not.
- **Deleted**: `.stat-strip` (its hairline grid is the third implementation), `.module-strip`, `.metric-card`,
  `.metric-label`, `.metric-value`. `.stat-strip` has 14 rules; all of them go.

### 2.4 Toolbar: one row, one height

- `.toolbar` is a single flex row: `height: 40px; gap: 12px; align-items: center`. No `flex-wrap` above
  768; below it, wrap and every control takes `min-height: 44px`.
- Every control inside one `.toolbar` is `--ow-control-md` (40). A tab strip, a chip or an icon button in a
  toolbar is not a dense context: it is a control standing next to other controls (rule C1).
- The search input is the only flexible child (`flex: 1 1 260px; max-width: 460px`); every other control is
  content-sized.
- `.toolbar-count` (`margin-left: auto`) stays; it is text, not a control.

### 2.5 Canvas, gutter, widths

| breakpoint | gutter | canvas max | table min-width |
|---|---|---|---|
| ≥1280 | 32 | 1480 (`--ow-readable`) | 0 (fills) |
| 1024–1279 | 24 | 1480 | 0 |
| 768–1023 | 16 | — | 620 (`.data-table` min-width) |
| <768 | 16 | — | 0 — the table becomes stacked cards (table-spec §2.5) |

**The first content block lands at y = 160** at ≥768: topbar 56 + header 80 + stack gap 24. One number,
the same on every page, assertable in CI. (`160` also fixes the review's 140 / 166 / 187.)

---

## 3. 迁移清单

| # | step | files | changes | effort | risk |
|---|---|---|---:|---|---|
| P1 | Canvas + ruler: one gutter scale, `--ow-readable` 1480 everywhere | `styles.css` | ~10 rules | 1h | pages that budget on a 1200px canvas reflow; screenshots must be re-taken |
| P2 | Header 80px fixed, description one line | `page-header.tsx`, `styles.css` | 2 files | 1h | any page whose description is a sentence loses text to an ellipsis — each such page moves its sentence into the body |
| P3 | Action row onto the title line | `styles.css` (`.page-header`, `.page-actions`) | 2 rules | 0.5h | studio pages: `.studio-page .page-header` overrides alignment and must be deleted with the same PR |
| P4 | KPI band: delete `.stat-strip` / `.module-strip` / `.metric-card`, keep `.metric-grid` + `.ow-metric` | `styles.css`, `Overview.tsx`, `OpsCenter.tsx`, `Pipelines.tsx`, `Plugins.tsx`, `Nodes.tsx` (6 files) | 3 containers → 1, ~40 JSX sites use `.ow-metric` already | 3h | `.stat-strip` is the compact band inside `PluginDetail` and `InstanceLogs`; those pages get a 92px card where they had a 40px ribbon — decide per page: keep the band and lose density, or drop the band and fold the numbers into the table header |
| P5 | Toolbar 40px, one tier | `styles.css`, `components/ui/tabs.tsx` | 3 rules | 1h | the tab strip grows 4px; three toolbars gain 12px each of height |
| P6 | One shape: fold `meta` into the description line or the body; keep `primary` last | `page-header.tsx`, 9 call sites that pass `meta`/`eyebrow` without `actions` | 9 sites | 2h | `/admin/instances/{id}/logs` passes `meta` (a status chip); it moves into the description line |
| P7 | Per-page ruler conformance (14 routes) | 12 page files | mechanical | 4h | the largest step; do it page-by-page with a screenshot per page at 1440/1024/390 |

**Total ≈ 12.5 hours** on top of `token-table.md`'s 15h, and it cannot start before T1–T4 land (the
tokens the template reads must exist).

---

## 4. 机器闸门

### 4.1 The measurement contract

The audit harness (whatever writes `_metrics_*.json`) must add one object per run:

```json
"config": {
  "label": "r1440-light-en",
  "template": {
    "headerHeight": 80,
    "firstBlockY": 160,
    "controlRow": [ { "selector": ".toolbar", "heights": [40, 40, 40] } ]
  }
}
```

`headerHeight` = `getBoundingClientRect().height` of `[data-testid=page-header]`; `firstBlockY` = the `top`
of the first element after `[data-testid=page-header]`'s parent; `controlRow` = one entry per
`.toolbar`, `.page-actions`, `.panel-head` with the measured height of every interactive child.

### 4.2 The gate

`scripts/check-ui-metrics.mjs --template <file…>` (full source in `table-spec.md` §4.4). Rule 2 fails
**closed**: a metrics file without the `template` object is a violation, because “we did not measure it”
has been the same outcome as “it is fine” for six rounds.

### 4.3 Proof on the real artifacts (they predate the contract)

```
$ node scripts/check-ui-metrics.mjs --template artifacts/ui/visual-v3/audit/_metrics_r1440-light-en.json
ok    r1440-light-en  pages=26  violations=0
FAIL  template-unmeasured  r1440-light-en  missing: headerHeight, firstBlockY, controlRow

check-ui-metrics: FAIL (1 violation(s) across 25 page measurements)
$ echo $?
1
```

### 4.4 Proof the rule accepts a conforming run

```
$ node scripts/check-ui-metrics.mjs --template fixture-template.json      # 80 / 160 / [40,40,40]
ok    fixture-template-ok  pages=1  violations=0

check-ui-metrics: PASS (1 page measurements, no horizontal overflow)
$ echo $?
0
```

### 4.5 Proof it catches a mixed control row

```
$ node scripts/check-ui-metrics.mjs --template fixture-mixed.json         # [40,32,40]
FAIL  control-row-mixed  fixture-template-mixed  .toolbar -> 40/32

check-ui-metrics: FAIL (1 violation(s) across 1 page measurements)
$ echo $?
1
```

The static half — one `PageHeader`, no `h-7|h-9|h-11` on a control box — is `check-ui-tokens.mjs` rules
R4 and R2, already wired and already red (`token-table.md` §4).

---

## 5. 不做什么

- **No new layout primitives.** No CSS grid framework, no container queries. Four breakpoints (1280 / 1024 / 768 / 640) and one column model.
- **No per-page custom header.** A page that needs a different header is a page that needs a different *route* (e.g. a detail page under a `h2`, not a `h1`).
- **No template for `/login` and `/403`.** Two single-block screens, no topbar, no table. They keep their own layout and their `--ow-type-hero` exception (`token-table.md` R2).
- **No sticky table headers in this pass.** It changes scroll behaviour on 12 tables and belongs to its own spec with its own measurement.
- **No print stylesheet, no RTL work, no zoom-level audit.** Out of scope; each is a separate budget.

