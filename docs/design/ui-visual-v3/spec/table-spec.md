# Table spec — 90% of the pixels, one rulebook

Status: **normative**. 9 of the 12 admin routes and all of the workspace routes put a table in the middle
of the page; there was no table spec until this file. Machine gate: `scripts/check-ui-metrics.mjs`
(geometry) + `scripts/check-ui-tokens.mjs` (source).

---

## 1. 现状实测

### 1.1 There are 17 tables on 9 pages, with 3–8 columns and no common rule

`[src]` — `<TableHead` counted per file, split on `<Table `:

| page | tables | columns per table |
|---|---|---|
| `/admin/nodes` | 3 | 8 / 5 / 7 |
| `/admin/governance` | 3 | 6 / 3 / 3 |
| `/admin/plugin-detail` | 3 | 6 / 4 / 7 |
| `/admin/access` | 2 | 5 / 6 |
| `/admin/pipelines` | 2 | 4 / 4 |
| `/admin/jobs` | 1 | 7 |
| `/admin/plugins` | 1 | 7 |
| `/admin/activity` | 1 | 5 |
| `/admin/diagnostics` | 1 | 3 |

Six of the nine pages have more than one table, so “the table” is not one component with variants — it is
17 hand-composed instances of a 30-line primitive.

### 1.2 The identity column is a 36-character UUID at 42% of the row

`Jobs.tsx:113`:

```tsx
<StackCell label={t('table.job')} className="job-id-cell …">
  <Link className="mono min-w-0 truncate" title={job.jobId} to={…}>{job.jobId}</Link>
</StackCell>
```

plus `styles.css:820`: `.job-id-cell { width: 42%; max-width: 360px; }` `[src]`. At 1440 the table is
~1126px wide, so the identity cell is ~470px — the review measured **470 / 1133 = 41%** with a different
instrument, which is the same number. A UUID is unique, sortable and meaningless: the eye can use exactly
two of those three.

### 1.3 Row height: 56 declared, 46 computed, 239 measured

| implementation | height | evidence |
|---|---:|---|
| `--ow-row: 56px` | 56 | `styles.css:53`, read by exactly **one** selector: `.nodes-table tbody tr` (styles.css:1811) |
| `.data-table td` | 46 | `padding: 12px` ×2 + 14px × 1.5 + 1px border (styles.css:381) — **dead CSS**, no JSX consumer left |
| shadcn `Table` rows | *none* | `components/ui/table.tsx` declares no row height; a row is as tall as its tallest cell |
| `/admin/activity` at 1024 | 63 | review measurement over 25 rows |
| `/admin/jobs` at 390 | ~239 | `docHeight 3341` ÷ 14 rows `[audit]` |

Four answers to “how tall is a row”, none of them written down.

### 1.4 Every card at 390 truncates at the same character

`Jobs.tsx:113` also carries `max-[768px]:max-w-[220px] truncate`, and `.responsive-table td .truncate
{ max-width: 220px }` (styles.css:971) repeats the number in CSS `[src]`. All 14 mobile cards are the same
UUID prefix cut at 220px, so the first line of every card is **identical pixels**: 14 cards, 4078px of
scroll (review), and no way to tell them apart before the second line. That is a specification defect, not
a truncation defect: nobody wrote down what the first line is *for*.

### 1.5 The table ships 223px of horizontal overflow

`artifacts/ui/visual-v3/audit/_metrics_r390-light-en.json` `[audit]`, route `/admin/jobs/1285fbe8-…`:

```json
"overflow": 223, "docScrollW": 613, "docClientW": 390,
"offenders": [
  { "tag": "code", "cls": "mono small", "left": 88, "right": 613 },
  { "tag": "table", "cls": "w-full border-collapse caption-bottom text-base", "left": 15, "right": 490 }
]
```

The same file records `overflow: 175` in zh-CN. **Nothing in the repository reads this file**: `ci.yml`
runs `typecheck`, three `check-*.mjs` scripts, four builds and `vitest` — no browser, no metrics. The
record was written and the release went out. That is the finding this spec’s gate exists to close.

### 1.6 Identical consecutive rows are rendered one at a time

`Activity.tsx:29` `PAGE_SIZE = 25`; the review counted **9 of 25 rows carrying the same event**. A page of
25 where 36% of the rows are one fact is a page spending a third of its area repeating itself.

---

## 2. 规则

### 2.1 Identity: one per row, in human language (R1)

**Every row opens with exactly one identity cell, and the identity cell is never a raw id.**

```
⟨name⟩ · ⟨disambiguator⟩ · ⟨age⟩          e.g.   host-metrics · r9 · 18h ago
```

| part | source | rule |
|---|---|---|
| `name` | the entity’s own human name (`pipeline.name`, `node.name`, `plugin.displayName`) | never an id, never a wire code |
| `disambiguator` | **4 hex chars** of the canonical UUID (first 4) | only when `name` is not unique on the page; **8 chars** when a page can show > 100 rows |
| `age` | `Intl.RelativeTimeFormat(locale, { numeric: "auto" })` | the absolute timestamp moves to the detail page and to `title` |

**Why 4 hex chars**: with 14 rows on screen the birthday collision probability over 65 536 buckets is
1 − exp(−14×13 / (2×65 536)) = **0.19%** — invisible in practice. At 200 rows it is 26%, which is why the
rule switches to 8 chars above 100 rows. The number is derived, not chosen.

**The full id is always available, never displayed**: `title` on the identity cell, and a `CopyButton`
(`components/Ui.tsx:115`, already exists) as the first item of the row menu. Hover text is not a substitute
for a copy affordance — a 36-character UUID cannot be transcribed by eye.

**Violation** = a cell whose first child renders a value matching `^[0-9a-f]{8}-[0-9a-f]{4}-`, or any cell
that renders `jobId` / `subjectId` / `digest` without `formatIdentity()`. The gate asserts it per page as
`identityKey[]` (§4.1) and requires `distinct(identityKey) / identityKey.length = 1.000`.

### 2.2 Column degradation: a column earns its width (R2)

For the rows actually on screen (n ≥ 10):

| distinct-value ratio | verdict |
|---|---|
| 0 distinct (all rows equal) | **delete the column**; the value belongs in the page header or the panel title |
| < 0.2 (fewer than one distinct value per five rows) | **demote to inline secondary** — inside the identity cell’s second line, or as a toolbar filter |
| ≥ 0.2 | keep as a column |

**Why 0.2**: at that ratio a reader finds a difference in every fifth row, which is the rate at which a
column is *scanned*. Below it the column is *read* — top to bottom, once — and a column read once costs the
same as one line of panel subtitle. The review’s “2 of 6 columns constant in 14/14 rows” sits at ratio
0.07, nearly three times below the threshold.

Two hard caps, because degradation is what keeps them affordable:

| viewport | max columns | what happens to the rest |
|---|---|---|
| ≥ 1024 | **5** | rank by distinct ratio; the tail moves inline |
| 768–1023 | **4** | ditto |
| < 768 | **3 facts per card** (§2.5) | ditto |

### 2.3 Row height: 40px, and here is the arithmetic (R3)

```
40px = 1px  border-bottom
     + 4px  padding-top   + 4px padding-bottom
     + 15.6 13px × 1.2    ← the value line (--ow-type-meta)
     + 15.4 11px × 1.4    ← the meta line  (--ow-type-label)
```

**A two-line cell fits in 40px** because the second line is a *smaller tier doing a smaller job*: 13px for
the value the row is about, 11px for the qualifier (status word, count, age). That 11px line is the label
tier, so a two-line cell introduces no new type size. Padding is 4, not 8: at 8 the two lines need 48px, and
48 is how the review measured 63–84px rows once a cell’s content starts wrapping.

- Desktop (≥768): every table declares `height: 40px` on `tbody tr`, `vertical-align: middle`. A cell that
  needs a third line is carrying a column that §2.2 says should have been demoted.
- Header row **32px** (`--ow-control-sm`), 11px labels uppercased only under `:lang(en)`, one `border-bottom`.
- 390: rows are cards (§2.5); 40px does not apply to a card.

### 2.4 Collapse: three in a row is one fact (R4)

Consecutive rows with identical `(eventType, action, subjectId)` collapse into one row rendering the run:
the first occurrence’s timestamp, `× N`, and the run’s first→last span. Threshold **3**:

- 2 identical rows can be two genuine actions (a retry that succeeded, a double submit the server accepted
  twice). Collapsing a pair hides an event.
- 3 identical rows on one page can only be a poller, a fan-out or a retry loop: the per-row text is
  identical by construction, so the only information left is the count.

On the measured `/admin/activity` page (9 of 25 rows identical) the page renders **17 rows instead of 25**,
and the run is 1/17 of the page instead of 9/25. Expanding is one click and is not persisted.

### 2.5 The 390 card: the first line is the key (R5)

```
┌ card ≤ 132px ─────────────────────────────────┐
│ host-metrics · r9 · 18h ago               [⋯] │   identity 13px, one line, not ellipsised
│ status      Running                           │   3 facts, label 11 / value 13
│ attempts    2 / 3                             │
│ duration    15m 58s                           │
└───────────────────────────────────────────────┘
```

- The first line **is** the §2.1 identity key, and it is not truncated by a fixed width. If it does not
  fit, the `name` part ellipsises and `disambiguator · age` never does — those are what make the card
  distinguishable.
- At most **3 facts** per card, ranked by the §2.2 rule (highest distinct ratio wins). Facts 4…n are not
  rendered at 390; they live on the detail page.
- The `⋯` action sits on the identity line, not on a row of its own — that alone is 32 of today’s 239px.
- 132 = 12 padding + 20 identity + 8 gap + 3 × 22 facts + 12 padding + 12 slack. A target, not a constant:
  the gate asserts ≤ 140.
- `identityKey` uniqueness must be 1.000 at 390. That is the rule the 14 identical cards violated.

### 2.6 Overflow: the container never scrolls on a phone (R6)

- `<768`: the table **must not** be a table. The live path is the `max-[768px]` stack utilities in
  `table-kit.tsx`; `.data-table` and `.responsive-table` in `styles.css` are **dead** (no JSX consumer —
  `grep -rn responsive-table --include=*.tsx` returns one comment) and are deleted with S1.
- `<768`: no fixed `max-width` in `ch`/`px` on a mono element inside a card. `code`, `.mono` and `<pre>` get
  `overflow-wrap: anywhere; max-width: 100%`. **The 223px offender was `<code class="mono small">` with
  `right: 613` in a 390px viewport.**
- `≥768`: horizontal scrolling is allowed, but only on the table’s own wrapper
  (`div.relative.w-full.overflow-auto`, `components/ui/table.tsx:11`), never on `document`.
  `document.scrollWidth ≤ document.clientWidth` is a hard assertion on every route and viewport (§4).

### 2.7 Empty and missing values inside a table (R7)

Cross-reference `machine-language-rules.md` §2. In a cell, `NO_DATA` may appear **at most once per table**;
when a column would render it in ≥ 50% of rows, the column is dropped and one sentence above the table
says why. A dashed box per cell — the review counted 10 on `/admin/governance` — renders one fact ten times.

---

## 3. 迁移清单

Column counts from §1.1. Effort assumes `token-table.md` T1–T4 and `page-template.md` P2 have landed.

| # | page | tables × cols | identity today | change | effort | risk |
|---|---|---|---|---|---:|---|
| S1 | `table-kit.tsx` | — | — | add `formatIdentity()`, `IdentityCell`, `CollapseRun`, `RowFacts`; delete the dead `.data-table` / `.responsive-table` CSS | 2h | the kit is used by 9 pages; a prop change touches all of them at once |
| S2 | `/admin/jobs` | 1 × 7 | raw 36-char UUID at 42% width | identity `host-metrics · r9 · 18h ago`; `jobId` → `title` + menu copy; 7 columns → 5 (fold `revision` and `attempts` into the identity meta line) | 3h | the whole row is clickable today and must stay clickable; the menu must stop propagation (it already does) |
| S3 | `/admin/activity` | 1 × 5 | event type + actor uuid | collapse runs ≥ 3 (25 → 17 on the measured page); actor → name | 2h | collapse must run **before** slicing the page, or a run is split across pages |
| S4 | `/admin/nodes` | 3 × (8/5/7) | node uuid | 8 → 5 columns; the two `--ow-row: 56px` selectors die with the 40px rule | 2.5h | the 8-column table is the widest surface; the 3 dropped columns must exist on the node detail page or the data is lost |
| S5 | `/admin/governance` | 3 × (6/3/3) | dataset name (ok) | merge the two 3-column tables; `recordsExamined` / `recordsFailed` stop rendering per-cell `NO_DATA` (§2.7) | 2h | merging changes the page’s information architecture; needs a screenshot review |
| S6 | `/admin/plugins`, `/admin/plugin-detail` | 1 × 7, 3 × (6/4/7) | plugin id (ok) | column caps, row height, identity format on the two detail tables | 2h | plugin detail already has a `KV` grid plus 3 tables; the template allows ≤ 2 secondary panels |
| S7 | `/admin/access`, `/admin/pipelines`, `/admin/diagnostics` | 2 / 2 / 1 tables | mixed | row height + column caps only | 1.5h | small surface, low risk |
| S8 | 390 cards, all 9 pages | — | 14 identical truncations | §2.5 card layout; 239px → ≤ 140px | 3h | the largest visible change; needs one screenshot per page at 390 light + dark + zh-CN |

**Total ≈ 18 hours.** S1 first and alone; S2 and S8 together (same page, same defect).

---

## 4. 机器闸门

### 4.1 The measurement contract

The audit harness writes, per route:

```json
"pages": { "/admin/jobs": {
  "overflow": -15,
  "identityKey": ["host-metrics · r9 · 18h ago", "…"],
  "rowHeight": { "p50": 40, "p95": 40 },
  "columns": 5,
  "distinctRatio": [0.93, 0.41, 0.28, 0.21, 0.35],
  "duplicateRunMax": 1,
  "noDataPerTable": 1,
  "cardFactCount": 3,
  "offenders": [ … ]
} }
```

### 4.2 What fails

| assertion | threshold | where it comes from |
|---|---|---|
| `overflow > 0` | fails | §1.5, the 223px record |
| `overflow` missing | fails | §1.5 — “not measured” has meant “fine” for six rounds |
| `distinct(identityKey).length / identityKey.length` | `< 1.0` fails | §2.1, §2.5 — the 14 identical cards |
| `rowHeight.p95` | `> 42` fails | §2.3 |
| `columns` | over the viewport cap fails | §2.2 |
| `min(distinctRatio)` among kept columns | `< 0.2` fails | §2.2 |
| `duplicateRunMax` | `> 2` fails | §2.4 |
| `noDataPerTable` | `> 1` fails | §2.7 |
| `cardFactCount` | `> 3` fails | §2.5 |

### 4.3 Proof it goes red on the data that shipped

```
$ node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit/_metrics_r390-light-en.json
FAIL  overflow>0  r390-light-en  /admin/jobs/1285fbe8-9bb8-459f-b073-af245d32b3ae  +223px  worst: <code> mono small right=613
FAIL  r390-light-en  pages=26  violations=1

check-ui-metrics: FAIL (1 violation(s) across 25 page measurements)
$ echo $?
1
```

### 4.4 Proof it goes green on a measured-clean run

```
$ node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit/_metrics_r1440-light-en.json
ok    r1440-light-en  pages=26  violations=0

check-ui-metrics: PASS (25 page measurements, no horizontal overflow)
$ echo $?
0
```

Same script, same tree, two datasets: the red is caused by the 223px, not by a harness that is always red.
(The zh-CN sibling `_metrics_r390-light-zh.json` fails the same way at 175px.)

### 4.5 The script

```js
#!/usr/bin/env node
/**
 * check-ui-metrics.mjs - the geometry half of the UI spec gate.
 *
 * Reads the _metrics_*.json files the audit harness writes and fails on the numbers a human
 * review cannot check by eye. The rule that matters: a page with no measurement is a FAIL,
 * not a pass - artifacts/ui/visual-v3/audit/_metrics_r390-light-en.json recorded 223px of
 * horizontal overflow on /admin/jobs/{id} and shipped anyway, because nothing read it.
 *
 *   node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit/_metrics_r390-light-en.json
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const inputs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ROOT = process.cwd();

function expand(list) {
  const out = [];
  for (const item of list) {
    const p = resolve(item);
    if (statSync(p).isDirectory()) {
      for (const name of readdirSync(p)) if (/_metrics_.*\.json$/.test(name)) out.push(join(p, name));
    } else out.push(p);
  }
  return out;
}
if (inputs.length === 0) {
  console.error('check-ui-metrics: pass one or more _metrics_*.json files or a directory');
  process.exit(2);
}

let failures = 0;
let pages = 0;
for (const file of expand(inputs)) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const label = (doc.config && doc.config.label) || relative(ROOT, file);
  const pageMap = doc.pages || {};
  let localFailures = 0;
  for (const [route, m] of Object.entries(pageMap)) {
    if (!m || typeof m !== 'object' || m.error) continue;
    pages += 1;
    if (typeof m.overflow !== 'number') {
      console.log('FAIL  overflow-unmeasured  ' + label + '  ' + route);
      localFailures += 1;
      continue;
    }
    if (m.overflow > 0) {
      const worst = (m.offenders || [])[0];
      const who = worst ? ' worst: <' + worst.tag + '> ' + (worst.cls || '') + ' right=' + worst.right : '';
      console.log('FAIL  overflow>0  ' + label + '  ' + route + '  +' + m.overflow + 'px' + who);
      localFailures += 1;
    }
  }
  console.log((localFailures ? 'FAIL  ' : 'ok    ') + label + '  pages=' + Object.keys(pageMap).length + '  violations=' + localFailures);
  failures += localFailures;
}

// rule 2 - template geometry: fail closed when the measurement is absent ---------
if (process.argv.includes('--template')) {
  for (const file of expand(inputs)) {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const label = (doc.config && doc.config.label) || relative(ROOT, file);
    const shape = (doc.config && doc.config.template) || {};
    const missing = ['headerHeight', 'firstBlockY', 'controlRow'].filter((k) => !(k in shape));
    if (missing.length) {
      console.log('FAIL  template-unmeasured  ' + label + '  missing: ' + missing.join(', '));
      failures += 1;
      continue;
    }
    if (shape.headerHeight !== 80) {
      console.log('FAIL  header-height  ' + label + '  ' + shape.headerHeight + ' != 80');
      failures += 1;
    }
    if (shape.firstBlockY !== 160) {
      console.log('FAIL  first-block-y  ' + label + '  ' + shape.firstBlockY + ' != 160');
      failures += 1;
    }
    for (const row of shape.controlRow || []) {
      const heights = [...new Set(row.heights)];
      if (heights.length > 1) {
        console.log('FAIL  control-row-mixed  ' + label + '  ' + row.selector + ' -> ' + heights.join('/'));
        failures += 1;
      }
    }
  }
}
console.log('');
console.log(failures === 0
  ? 'check-ui-metrics: PASS (' + pages + ' page measurements, no horizontal overflow)'
  : 'check-ui-metrics: FAIL (' + failures + ' violation(s) across ' + pages + ' page measurements)');
process.exit(failures === 0 ? 0 : 1);
```

`--template` adds the page-template assertions (header 80, first block y 160, one control height per row);
`page-template.md` §4 shows that half red, green and mixed.

### 4.6 Wiring

```yaml
# .github/workflows/ci.yml, job `web`, after check-status-vocabulary.mjs
      - run: node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json
# new job `web-metrics`: run the audit harness against the built app, then
      - run: node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit
```

`check-ui-metrics.mjs` needs no browser — only the JSON. The browser half is the existing audit harness;
the missing piece is that `ci.yml` never ran it. Until `web-metrics` exists, wiring the gate into
`staging-preview.yml` (which already runs `playwright test`) closes the hole with no new infrastructure.

---

## 5. 不做什么

- **No virtualisation.** 25 rows per page (`Activity.tsx:29`) is the paging rule; windowing 25 rows buys nothing and costs a scroll-position contract.
- **No sort/filter framework.** No table has a sort head today; adding one is a component API change that deserves its own spec.
- **No CSV export, no column picker, no density toggle.** A density toggle would reintroduce the third row height this spec exists to remove.
- **No table on `/login`, `/403`, `/admin/ops-center`.** OpsCenter renders cards; the two error screens render one message.
- **No mobile sheet for row actions.** At 390 the `⋯` menu stays a Radix dropdown; a sheet is a different interaction with its own focus contract.
- **No API change.** Every field the identity cell needs (`name`, `revision`, `createdAt`) is already in `apps/platform-web/src/types.ts`.

