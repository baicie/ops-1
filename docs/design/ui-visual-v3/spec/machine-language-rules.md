# Machine language rules — when the machine speaks, it speaks design

Status: **normative**. Covers the four ways machine vocabulary reached the screen: a state token rendered
as a box, an English sentence inside a Chinese page, a casing rule applied to a language without case, and
a measurement that nobody read. Gate: `scripts/check-ui-tokens.mjs` (R5, R6) + `scripts/check-ui-metrics.mjs`
(§5).

---

## 1. 现状实测

### 1.1 The state token is a component; the *placement* is not designed

`components/app/status-indicator.tsx:150` renders `NO_DATA` verbatim with a dashed border
(`.value-token--no-data { border-style: dashed }`, styles.css:1130), an `sr-only` localized meaning and a
`title`. The component is right. The usage is not: `grep -rho "NoData"` finds **53 call sites** and the
review counted **10 dashed boxes on `/admin/governance`** — that page renders `recordsExamined` and
`recordsFailed` for five datasets, and every empty one is its own dashed rectangle. Ten boxes that all say
“the source cannot answer” read as an unfinished page, and each one costs a border, a padding and a word.

### 1.2 Thirty-five Chinese messages carry an untranslated wire code

`[src]` — the catalog scan (zh-CN, 1194 messages) for a ≥3-letter uppercase Latin run in a string that also
contains CJK:

```
zh-CN messages: 1194   mixed CJK + CAPS: 35
  governance.failures.description  = 仅包含终态为 失败 或 ERROR 的运行。
  install.field.kernelApiMajor     = Kernel API 主版本
  diagnostics.field.apiMajor       = API 主版本
  install.chooseBundle.description = ZIP 包会依据 Kernel 信任库校验；OCI 镜像按摘要单独拉取。
```

`en`: **0** mixed messages. The defect only exists in the locale that has no uppercase — which is exactly
why the CSS could not reveal it: `text-transform: uppercase` **does nothing to Chinese characters**, so the
Latin half of `KERNEL 自有` shouts while the Chinese half is untouched. The review saw the symptom; the
cause is 35 strings, not 1.

### 1.3 Twenty-two uppercase rules, zero language guards

`grep -c "text-transform: uppercase"` = **22** in `styles.css`; `grep -c ":lang("` = **0**. So `.tag`,
`.eyebrow`, `.metric-label`, `.nav-section-label`, `.data-table th` and 17 more uppercase every string they
render, in both locales. `i18n/index.tsx:85` already sets `document.documentElement.lang = locale`, so the
fix needs no JavaScript — only a selector.

### 1.4 Durations and byte counts are formatted in English

`format.ts:35-38` `[src]`:

```ts
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
```

and `format.ts:22` `if (value === null || …) return 'No data';`. A zh-CN operator reads `15m 58s` and
`No data` inside a Chinese page. `check-ui-tokens.mjs` rule `format-locale` reports **4**: `'No data'` and
the three unit templates.

### 1.5 The destructive colour is already right — and nothing keeps it right

`[src]` 3 row verbs marked `danger: true` (`Plugins.tsx:302` disable, `:328` uninstall, `Nodes.tsx:160`
revoke) and 5 `variant="destructive"` buttons, all of them inside a `ConfirmAction`/`ConfirmDialog`
(`components/app/confirm-action.tsx`, used by 8 files). All three row verbs are irreversible *from the UI*
in this build — the disable path says so in its own comment. The rule below exists so the eighth
destructive control still has to argue for itself.

### 1.6 The measurement that shipped anyway

`artifacts/ui/visual-v3/audit/_metrics_r390-light-en.json` recorded `overflow: 223` on `/admin/jobs/{id}`
**and was never read by CI**: `.github/workflows/ci.yml` runs typecheck, three `check-*.mjs`, four builds and
`vitest` — no metrics consumer, no browser. The artifact is also **stale**: `capturedAt 2026-10-29T14:22Z`
against HEAD `7fd0c99` at `2026-10-30T18:05+08:00`. A record nobody reads and a record that no longer
describes HEAD are the same record.

---

## 2. 规则

### M1 — Three empty states, three renderings, and a budget

| state | rendering | means | budget |
|---|---|---|---|
| **Missing** (`NO_DATA`) | `.value-token--no-data`: dashed 1px, `--ow-text-muted`, verbatim token in `title`, localized meaning in `sr-only` | a source exists, but it has no sample for *this entity* in this window | **at most 1 dashed token per region** (region = one panel or one table) |
| **Unknown** (`UNKNOWN`) | `.value-token--unknown`: dotted, inline, no box | the observation or the permission is unconfirmed | unlimited, but never as the only content of a cell |
| **Empty** (answered zero) | no border, no token — the component renders the localized “none” copy | the source answered, and the answer is nothing | the panel renders `EmptyState` once, not per row |

- **A column that would render `Missing` in ≥ 50% of its rows is not a column.** It is dropped and one
  sentence above the table states the reason and the remedy (“the quality runs have not been sampled for
  these datasets yet”). At 50% the dashed boxes are the majority of the column’s pixels, so the column is
  communicating *one* fact; carrying it once is the whole point.
- **Why dashed stays for Missing and never for Empty**: a dashed border reads as “a placeholder to be
  filled”. That is the correct promise for “a source exists, no sample yet”, and the wrong promise for “the
  answer is zero” — there is nothing to fill. Ten dashes on one screen are ten promises the page cannot keep.
- **Violation** = a JSX text node rendering `NO_DATA` outside `status-indicator.tsx`; a catalog message
  containing `NO_DATA`/`UNKNOWN`; more than one `.value-token--no-data` per `[data-region]`; a column with
  `noDataRatio ≥ 0.5` (measured, `table-spec.md` §4.1).

### M2 — Uppercase belongs to the language, not to the class

`text-transform: uppercase` is allowed **only** inside a `:lang(en)` scope:

```css
/* one rule, no redesign */
:where(.tag, .eyebrow, .metric-label, .nav-section-label, .data-table th) :is(span, a, time):lang(en),
:where(.tag, .eyebrow, .metric-label, .nav-section-label):lang(en) {
  text-transform: uppercase;
  letter-spacing: .06em;
}
```

- **The 22 rules keep their optics in `en` and lose nothing in `zh-CN`** — uppercase is a no-op on CJK, so
  this changes zero pixels in Chinese and zero pixels in English. What it removes is the mixed string in
  which half the glyphs shout because they happen to be Latin.
- **A mixed string is a copy defect, not a casing defect.** `仅包含终态为 失败 或 ERROR 的运行` must become
  `仅包含终态为失败或错误的运行`; an acronym that is genuinely an acronym (`API`, `CLI`, `ZIP`, `OCI`) may stay,
  and `scripts/check-status-vocabulary.mjs` already carries the acronym allowlist. **All 35 messages are
  classified before the rule turns green**: thirty use a real acronym and need nothing; five carry a run
  that is not an acronym — `ERROR`, `OPSWEAVE`, `REMOTES`, `SHA`, `ADR` — and each of the five needs a
  decision, not a regex.
- **Violation** = a `text-transform: uppercase` declaration whose rule does not contain `:lang(en)`; a
  catalog message with a `[A-Z]{3,}` run adjacent to CJK whose run is not in the acronym allowlist.

### M3 — Every unit and every number goes through `Intl`

```ts
export function formatDuration(locale: string, seconds: number): string {
  const whole = Math.round(seconds);
  const units = whole < 60 ? [whole, 'second']
    : whole < 3600 ? [Math.floor(whole / 60), 'minute']
    : [Math.floor(whole / 3600), 'hour'];
  const opts = { style: 'unit', unit: units[1], unitDisplay: 'narrow' } as const;
  return new Intl.NumberFormat(locale, opts).format(units[0]);
}
```

1. **One function, two units, no branch on locale.** `Intl` returns `15分` / `15m` from the same call; the
   catalog therefore needs no unit keys, and a locale added tomorrow gets units for free.
2. **`formatDuration` takes the locale explicitly.** The module already stores `activeLocale`
   (`format.ts:8`); passing it in makes the dependency visible and testable, and stops a formatter from
   silently reading a module global that a test forgot to set.
3. **Bytes** use `Intl.NumberFormat(locale, { style: 'unit', unit: 'megabyte', unitDisplay: 'narrow' })`
   with the unit chosen by magnitude (B/KiB/MiB/GiB/TiB keep their existing binary steps — the value stays,
   only the spelling localizes).
4. **`'No data'` is deleted from `formatBytes`.** A formatter returns a *value*; “no data” is a state, and
   states are M1’s job. `formatBytes(undefined)` returns `undefined` and the caller renders `<Missing>`.
5. **Dates already comply** (`formatDate` passes `activeLocale` to `toLocaleString`, `format.ts:13`);
   `RelativeTimeFormat` is used for the identity cell’s age (`table-spec.md` §2.1).
- **Violation** = a `return` in `format.ts` containing a quoted English word or a hard-coded `s`/`m`/`h`/
  `ms` unit suffix; any `toLocaleString()` without an explicit locale.

### M4 — Destructive colour is for irreversible, and irreversible lives in `⋯`

| verb class | examples in this product | colour | placement |
|---|---|---|---|
| irreversible | uninstall, revoke, delete | `--ow-danger` | row `⋯` menu, plus `ConfirmAction` |
| reversible | disable, stop, restart, retry, rollback | no danger tone | a row button or the `⋯` menu |
| read-only | copy, open, inspect | muted | anywhere |

- **Why the distinction is colour and not wording**: `--ow-danger` is the only red in the palette. If it
  appears on a verb that can be undone, the operator learns that red means “this needs a click”, and the one
  control that truly cannot be undone loses its only signal.
- **Why `⋯` and not an inline button**: an irreversible verb inside a row that is itself a click target
  (every list row navigates) is one mis-click from a confirmation dialog that the operator did not intend to
  open. The menu is a deliberate second gesture.
- **`disable` keeps `danger` in this build** because its own comment states it is not restorable from the UI
  (`Plugins.tsx:298-302`). When enable lands, the flag comes off — the rule is about reality, not the verb.
- **Violation** = a `variant="destructive"` or `danger: true` on a verb in the reversible class; a
  destructive verb rendered outside a `RowActions`/`ConfirmAction`.

### M5 — A recording that nothing reads is not evidence

The numbers that already exist (`_metrics_*.json`) are the only machine-readable geometry this project owns.
They are promoted to a **gate input**:

```yaml
      # ci.yml job web-metrics (new), after the audit harness has captured this commit
      - run: node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit   # no --max-age-hours flag exists; see below
```

1. `overflow > 0` on any route at any viewport **fails the build** (`table-spec.md` §4.3 proves the red).
2. **Staleness is not detected at all.** An earlier revision of this document described a `--max-age-hours` option that would reject artifacts older than the commit. The script never implemented it: running it returns `no such file or directory` with exit 2. `capturedAt` is recorded but nothing compares it to anything.
   test. Today’s files are 28 hours older than HEAD `7fd0c99`, which is the mechanical definition of
   “recorded, shipped, ignored”. In CI the default is off so the proof above stays reproducible; in the job
   it is on, because that job captures its own artifacts.
3. A route with **no measurement** fails. Absence has never once meant “fine”; it has meant “nobody looked”,
   six times in a row.

---

## 3. 迁移清单

| # | step | files | changes | effort | risk |
|---|---|---|---:|---|---|
| M1a | Classify the 35 mixed zh-CN messages: 30 keep their acronym, 5 need prose (`ERROR`→`错误`, `OPSWEAVE`/`REMOTES`→a localized sentence, `SHA`→`SHA256`, `ADR`→`架构决策记录`) | `i18n/catalogs/zh-CN.json` | 5 values | 1h | `ERROR` is *not* in the acronym allowlist, so the gate will point at each one; a reviewer must approve the 11 acronyms rather than the gate deciding |
| M1b | One dashed token per region: `recordsExamined` / `recordsFailed` stop rendering per-cell `NoData`; a column with ≥ 50% absence is dropped with one sentence | `Governance.tsx`, `Diagnostics.tsx`, `PluginDetail.tsx` | 3 pages | 2h | dropping a column changes what a screenshot shows; needs a before/after at 1440 |
| M2 | `:lang(en)` scope for 22 rules, one rule | `styles.css` | 1 rule replacing 22 declarations | 1h | zero visible change in either locale (uppercase is a no-op on CJK); verify with a zh-CN screenshot that no spacing shifted (letter-spacing was scoped with it) |
| M3 | `formatDuration(locale, s)` + `formatBytes` via `Intl`, delete `'No data'` | `format.ts`, `Diagnostics.tsx`, `jobDuration.ts`, `Jobs.tsx` | 4 files, 6 call sites | 1.5h | `jobDuration.ts` has its own label logic (`executionLabel`, `spanLabel`) and must not double-format; its unit tests are the contract |
| M4 | Keep the 3 danger verbs, add the rule to the gate | none (already compliant) | 0 | 0.5h | the rule can only fail on *new* code; that is the point |
| M5 | Wire `check-ui-metrics.mjs` into CI (no staleness guard exists; build the guard and the flag together) | `.github/workflows/ci.yml`, new job `web-metrics` | 1 job, ~15 lines | 2h | the job needs a browser and a seeded session — `staging-preview.yml` already does exactly this, so the first version can live there |

**Total ≈ 9 hours**, and M5 is the only one that needs infrastructure.

---

## 4. 机器闸门

### 4.1 Already wired, already red

`check-ui-tokens.mjs` rules R5 (`uppercase-guard`) and R6 (`format-locale`) cover M2’s casing half and M3:

```
$ node scripts/check-ui-tokens.mjs | head -8
FAIL  radius-tier      120  budget 0
FAIL  control-tier      15  budget 0
FAIL  type-tier          7  budget 0
FAIL  one-header         5  budget 0
FAIL  uppercase-guard   22  budget 0
FAIL  format-locale      4  budget 0
check-ui-tokens: FAIL (6 rule(s) over budget)
$ echo $?
1
```

R5’s findings are the 22 selectors, printed with `file:line`; R6’s are `format.ts:22` (`'No data'`) and the
three duration templates.

### 4.2 The one rule this file adds

Append to `check-ui-tokens.mjs` (after R6) — it turns the 35-message census into an assertion:

```js
// R7 machine vocabulary inside translated copy -------------------------------
const ACRONYMS = new Set(['CPU','GPU','MB','GB','MIB','GIB','API','URL','URI','JSON','YAML','HTTP',
  'HTTPS','UTC','ISO','ID','IP','DNS','TLS','SSE','OCI','RBAC','UI','UX','PDF','CSV','SHA256','CLI','SDK','ZIP','CSRF','SSO']);
const catalogs = join(SRC, 'i18n', 'catalogs');
for (const name of readdirSync(catalogs)) {
  const messages = JSON.parse(readFileSync(join(catalogs, name), 'utf8'));
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value !== 'string') continue;
    if (!/[\u4e00-\u9fff]/.test(value)) continue;
    for (const run of value.match(/[A-Z][A-Z0-9]{2,}/g) || []) {
      if (!ACRONYMS.has(run)) add('machine-copy', name, 0, key + ' = ' + value.slice(0, 60));
    }
  }
}
```

On today’s tree it reports **5**:

```
extensions.error.notRegistered      -> OPSWEAVE, REMOTES
governance.failures.description    -> ERROR
pluginDetail.artifactTrust.description -> SHA
workspace.notYet.incidents.missing -> ADR
```

Two of the five are worse than the casing problem: `extensions.error.notRegistered` puts the internal
global `window.__OPSWEAVE_REMOTES__` in front of an operator, and `pluginDetail…` prints a truncated
`SHA256` as `SHA`. The allowlist is the same one
`scripts/check-status-vocabulary.mjs` uses (`ACRONYMS`, `scripts/check-status-vocabulary.mjs:31`) — two gates,
one definition, so a code cannot be an acronym for one and a wire token for the other.

### 4.3 The measurement gate

`check-ui-metrics.mjs` (full source in `table-spec.md` §4.5). The 223px record fails it today:

```
$ node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit/_metrics_r390-light-en.json
FAIL  overflow>0  r390-light-en  /admin/jobs/1285fbe8-9bb8-459f-b073-af245d32b3ae  +223px  worst: <code> mono small right=613
check-ui-metrics: FAIL (1 violation(s) across 25 page measurements)
$ echo $?
1
```

and the clean 1440 run passes the same script (`table-spec.md` §4.4, `exit 0`). The staleness flag is what
stops the *next* release from shipping on this file:

```
(removed: this block quoted a flag the script never implemented)

---

## 5. 不做什么

- **No copy rewrite beyond the 35 messages.** The tone of voice, the sentence length and the terminology are not in scope; only the untranslated machine vocabulary is.
- **No new state token.** `NO_DATA`, `UNKNOWN` and `STALE` stay the protocol vocabulary; this spec designs their *rendering and budget*, not their names. Renaming them would break `data-status` and the e2e selectors that read it.
- **No `Intl.RelativeTimeFormat` beyond the identity cell.** Every other timestamp keeps `formatDate`; a second age format would be a second thing to learn.
- **No locale addition.** Only `en` and `zh-CN` are in scope (AGENTS.md), and the unit work is done by `Intl` precisely so that a third locale costs nothing later.
- **No danger-tone redesign.** `--ow-danger` is unchanged; the rule is about *which verbs* may use it.
- **No change to `check-status-vocabulary.mjs`.** The acronym set moves to a shared module when R7 lands; the existing gate keeps its behaviour and its tests.

