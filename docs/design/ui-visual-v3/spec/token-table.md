# Token table — one value per job, four jobs

Status: **normative**. Applies to `apps/platform-web/src`. Machine gate: `scripts/check-ui-tokens.mjs`.
Supersedes nothing; there is no earlier token spec. `docs/design/ui-visual-v3/visual-audit.md` records
what the last six review rounds found; it is evidence, not a rule.

Every number below was produced by a command shown in §1 or §4. Numbers marked `[audit]` come from the
committed measurement artifacts under `artifacts/ui/visual-v3/` (captured 2026-10-29 against the deployed
build); numbers marked `[src]` are a census of HEAD `7fd0c99`; `[gate]` is the gate's own output.

---

## 1. 现状实测

### 1.1 Radius: eleven rendered values, three of them synonyms

`node /tmp/ow-gate/check-ui-tokens.mjs` reports **120 radius findings** `[gate]`: 107 `border-radius`
declarations in `styles.css` and 13 `rounded-*` utilities in TSX. Rendered values in use:

| value | count | what it dresses |
|---|---:|---|
| 6px | 28 | buttons, inputs, chips, code |
| 50% | 17 | avatars, dots, icon rings |
| 5px | 11 | inputs, small boxes |
| 4px | 10 | `code`, `kbd`, tags, table bits |
| 8px + `var(--ow-radius-md)` | 9 + 9 | panels, cards |
| 999px | 8 | badges, pills |
| 7px | 6 | icon buttons, react-flow |
| 1.5px / 9px / 12px + `var(--ow-radius-lg)` | 1 / 1 / 1 + 2 | one-offs |
| `--ow-radius-sm` / `--ow-radius-control` / `--ow-radius-card` | 1 / 1 / 10 | tokens |
| `rounded-md` / `rounded-sm` / `rounded-lg` / `rounded-[inherit]` | 6 / 5 / 1 / 1 | TSX utilities |

Eleven distinct treatments for a box corner. `999px`, `50%` and `9999px` are the *same pixels* on every
element in this product (max box height 44px < 999): three spellings, one look, three future bugs.

### 1.2 Type: eight declared tiers, nineteen sizes on screen

`styles.css` declares eight `--ow-type-*` tokens: 11, 12, 13, 14, 16, `clamp(20px,2.1vw,26px)`, 21,
`clamp(30px,4vw,44px)` `[src]`, plus one `.94em` (`code`, styles.css:175) and one `inherit`.

The audit's runtime census of computed `font-size` over 25 routes `[audit]`:

```
r1440-light-en: 19 distinct sizes
  8.5 ×10   9 ×5   9.5 ×16   10 ×190   10.5 ×6   11 ×147   11.3 ×1   12 ×1906   12.2 ×1
  12.7 ×1   13 ×750  13.5 ×312  14 ×3   15 ×23   16 ×55   20.3 ×5   21 ×1   24 ×8   26 ×31
```

Twelve of those nineteen are within 6px of each other. A reader cannot name the hierarchy from the page,
and neither can a stylesheet.

### 1.3 Controls and buttons: two component families, five heights

| height | where |
|---|---|
| 40px | `.btn` (`--ow-control-md`, styles.css:191) |
| 36px | shadcn `Button` default `h-9`, `Input` `h-9`, `SelectTrigger` `h-9`, `TableHead` `h-9` |
| 32px | `.icon-btn`, `.nav-link`, `--ow-control-sm` callers |
| 30px | `.topbar-command`, `.lang-select` |
| 28px | `.btn-small`, shadcn `Button size="sm"` (`h-7`), `[role=tab]` |
| 44px | shadcn `Button size="lg"` (`h-11`), `--ow-control-lg` |

`/admin/jobs`'s toolbar puts a 36px `Input`, a 36px `Button`, a 36px `Select` and a 28px `TabsTrigger`
on one line `[src]` — an 8px baseline break inside a single row, which is the defect the review saw as
“40/36/32 in one toolbar”. Buttons are split across two families: `<Button>`/`buttonVariants` at 113 call
sites and legacy `className="btn"` at 13.

### 1.4 Page headers: two components, eight shapes

`components/app/page-header.tsx` and `components/Ui.tsx` **both export `PageHeader`** `[src]`. Three files
import the second one (`OpsCenter.tsx`, `workspace.tsx`, `shells/surface/SurfaceChrome.tsx`). The two
components render the same three lines with different prop sets; the `Ui` copy has no `primary`/`meta`.

Across 34 call sites the prop shapes are `[src]`:

| shape | sites |
|---|---:|
| title + description + eyebrow | 12 |
| title only | 7 |
| title + description + actions | 6 |
| title + description + eyebrow + actions | 3 |
| title + actions | 3 |
| title + description + meta | 1 |
| title + eyebrow | 1 |
| title + description + eyebrow + meta | 1 |

Eight shapes, therefore eight heights. `.studio-page .page-header` (styles.css:832) adds a `border-bottom`
and its own padding on top, so the studio shell renders a ninth treatment of the same element.

---

## 2. 规则

Rules are written so that a reviewer can decide *guilty or not* by reading one line of source. Each rule
names the token, the value, and why that value — not “one of them”, but *this* one.

### R1 — Radius: exactly three tiers

| token | value | what it may dress | why this value |
|---|---|---|---|
| `--ow-radius-control` | **6px** | buttons, inputs, selects, tabs, chips, inline `code`, row menus | 6px is the plurality today (28 declarations). On a 40px control a 4px corner reads as a hard rectangle in dark mode and a 10px corner bows the 1px border; 6px is the only value that stays optically flat on both the 32px and 40px control tiers. |
| `--ow-radius-card` | **10px** | panels, cards, KPI cards, dialogs, popovers, menus | already the value six card primitives are tested against (`styles.token-contract.test.ts`); 10 = 6 + 4 keeps the card/control ratio at 1.67, and it is the value the two largest surfaces (`.ow-metric`, `.panel`) already render, so moving to it costs no pixels on the surfaces a user looks at most. |
| `--ow-radius-pill` | **9999px** | badges, status pills, avatars, progress tracks, filter chips | `999px`, `50%` and `9999px` render identically here, so the choice costs nothing today and removes two future bugs: `50%` becomes an ellipse the moment width ≠ height (`.icon-btn` in a toast is 24×32 today), and `999px` is only equivalent while height < 1998px. |

**Violation** = any `border-radius` in `styles.css` outside the token block that is not
`var(--ow-radius-control|card|pill)`, `0`, `inherit`, or `9999px`; or any `rounded-sm|md|lg|xl|2xl|3xl|[Npx]`
utility in TSX. `rounded-full` is `9999px` and is allowed; `rounded-none` is `0` and is allowed.

**Deleted**: `--ow-radius-sm`, `--ow-radius-md`, `--ow-radius-lg`.

### R2 — Type: exactly four tiers

| token | value | job | why this value |
|---|---|---|---|
| `--ow-type-label` | **11px** | uppercase micro labels, table `th`, eyebrows, tags | the floor is set by the uppercase rule (§machine-language R-M2): an 11px uppercase label is optically ~12px; and 11px is the smallest size that keeps the CJK glyph box (0.9× the em of a dense label) out of the antialiasing mush on a 1× display. 89 existing declarations already read it. |
| `--ow-type-meta` | **13px** | table values, secondary copy, captions, table row detail | 13px is the largest size at which a **two-line** cell fits the 40px row target: 13×1.2 + 11×1.4 + 4+4 padding + 1 border = 40.0 (table-spec §2.3 derives this). Any larger and the row target is unattainable without deleting the two-line cell. |
| `--ow-type-body` | **15px** | reading copy, dialog body, form labels | one 2px step above `meta` — 15.4%, just over the ~10% threshold at which a size change is read as hierarchy rather than as noise; CJK has no ascender/descender cue, so a 13→14 step (7.7%) reads as a rendering accident. 14 and 16 both disappear into this tier. |
| `--ow-type-title` | **26px** | `h1`, one value at every viewport | 26px is what the current clamp already resolves to on desktop, so **no desktop pixel moves**; it removes the 20.0 / 21.5 / 26 spread the clamp produces across 390/1024/1440, and 26 = 15 × 1.73 keeps the title two clear steps above body. |

**Deleted**: `--ow-type-xs`, `--ow-type-sm`, `--ow-type-row`, `--ow-type-base`, `--ow-type-lg`,
`--ow-type-xl`, `--ow-type-metric`, `--ow-type-hero`, and the `.94em` on `code`.

**Documented exception**: `--ow-type-hero: clamp(30px,4vw,44px)` survives **only** on `/login` and the 403
surface — two single-block screens with no page header, no table and no toolbar (2 declarations). They are
named in the gate's exemption list, not silently tolerated.

**Violation** = any `font-size` in `styles.css` that is not `var(--ow-type-label|meta|body|title)` or
`inherit`; or any declared `--ow-type-*` whose value is not one of 11/13/15/26px.

### R3 — Controls: exactly two heights

| token | value | job | why this value |
|---|---|---|---|
| `--ow-control-sm` | **32px** | in-row and dense controls: tabs, filter chips, icon buttons, table row menus | 40 − 8: the two tiers must differ by one step of the 4/8/12/16/24/32 spacing scale, or the pair reads as a mistake rather than a hierarchy. 28 (today) is 40 − 12 = 1.5 steps, and it also leaves only 4px of ring around a 20px glyph. |
| `--ow-control-md` | **40px** | every form control: buttons, inputs, selects, primary row actions | already the documented value (`styles.css:92`): 36 measured 37px in the browser and no phone control met the 40px touch floor. 40 × 2 = 80 = header height, so the grid closes. |

**Rule C1 (one row, one height).** Inside one horizontal control row (`.toolbar`, `.page-actions`,
`.panel-head`, `.wizard-actions`) every control uses the **same** tier. A 36px input beside a 28px tab
trigger is a violation regardless of both being individually legal.

**Rule C2 (mobile floor, not a tier).** `@media (max-width: 767px)` gives every interactive control
`min-height: 44px`. This is a constraint on the two tiers, not a third tier: the value is never
authored per component.

**Deleted**: 28 (sm), 30 (`.topbar-command`, `.lang-select`), 34, 36 (all `h-9`), 38, 44 (`lg`, `--ow-control-lg`), 46.

**Violation** = any `(min-)height` in `24..48px` outside the token block that is not 32 or 40 and whose
selector is not in the decoration list; or `h-7|h-9|h-11` on a control box in `components/ui/`.

### R4 — Buttons: exactly two sizes, one family

| size | height | padding | type |
|---|---|---|---|
| `sm` | 32 (`--ow-control-sm`) | 0 12 | `--ow-type-meta` |
| `md` (default) | 40 (`--ow-control-md`) | 0 16 | `--ow-type-body` |
| `icon` | 32 or 40 **square**, chosen by the row it sits in | 0 | 16px glyph |

**Deleted**: `lg` (44), the 28px `sm`, `.btn-small`, and the legacy `.btn` family. One family survives:
the shadcn copy-in `Button` in `components/ui/button.tsx`; the 13 `className="btn …"` sites move to it.

### R5 — One page header

`components/app/page-header.tsx` is the only `PageHeader`. `components/Ui.tsx`'s export is deleted and its
three importers repointed. One shape:

```
┌ header 80px ─────────────────────────────────────────────┐
│ eyebrow 11px (optional, route-level)                     │
│ h1 26px/1.2            ·            [actions 40px][primary]│
│ description 13px, one line, ellipsis                     │
└──────────────────────────────────────────────────────────┘
```

The height arithmetic, so that no one has to re-derive it: `12 padding + 26×1.2 (31.2) + 4 gap + 13×1.6
(20.8) + 12 padding = 80.0`, and the block is `height: 80px; box-sizing: border-box; align-items: center`
— a declared height, not a computed one. `description` is **one line**; anything longer belongs in the page
body above the first table. That single constraint is what makes the height a constant.

See `page-template.md` for where the header sits and what may follow it.

---

## 3. 迁移清单

Ordered so that each step is independently shippable and the gate's budget can be lowered as it lands.
Effort is a single engineer who has read this file; “risk” is what can break visibly.

| # | step | files | changes | effort | risk |
|---|---|---|---:|---|---|
| T1 | Declare the new token set, keep the old names as aliases | `styles.css` (1 file) | +7 lines | 0.5h | none: aliases keep the tree building |
| T2 | Radius: 107 CSS declarations + 13 TSX utilities → 3 tokens | `styles.css`, `components/ui/*.tsx` (13 files) | 120 edits | 3h | `50%`→pill on non-square boxes changes avatars to pills; check `.icon-btn` in toast (24×32) |
| T3 | Type: 8 tokens → 4, delete `.94em` | `styles.css` | 9 declarations | 1h | 12px→13px reflows 121 declarations; long zh labels wrap (expected, the gate re-checks overflow) |
| T4 | Controls: 6 heights → 2, plus rule C1 on 5 toolbars | `styles.css`, `components/ui/{button,input,select,tabs}.tsx` | 15 + 6 edits | 2.5h | tabs grow by 4px in three toolbars; `/admin/activity` pagination row grows 8px |
| T5 | Buttons: delete `.btn` family, move 13 sites | `styles.css`, 13 page files | 13 JSX edits | 2h | a legacy `.btn.active` state (filter chips) has no shadcn equivalent — map to `variant="secondary"` + `aria-pressed` |
| T6 | One `PageHeader`: delete `Ui.tsx` copy, repoint 3 importers | `components/Ui.tsx`, 3 files | 3 imports | 1h | `SurfaceChrome` is the 403 page: it must keep rendering a header without actions |
| T7 | Header height 80px + one shape (drop `meta`/`primary` slots or fold them) | `components/app/page-header.tsx`, 34 call sites | 34 call sites, mechanical | 4h | pages that put a status chip in `meta` must move it into the description line or the body |
| T8 | Single `:lang(en)` uppercase | `styles.css` (22 rules) | 22 selectors | 1h | **none visible in zh-CN** — uppercase already does nothing to CJK; this only stops the Latin half of a mixed string from shouting |

**Total ≈ 15 hours**, one file (`styles.css`) plus 20 component files, and 0 API changes.

---

## 4. 机器闸门

`scripts/check-ui-tokens.mjs`, run by `ci.yml` in the `web` job right after `check-status-vocabulary.mjs`.
It is a ratchet: it takes a `--ratchet` file of today's counts and refuses to let any of them rise. The
budget file is lowered by the PR that lands each row of §3, and reaches `{}` when T8 lands.

```yaml
      - run: node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json
```

### Proof it goes red (the tree as it stands at HEAD `7fd0c99`)

```
$ node scripts/check-ui-tokens.mjs
FAIL  radius-tier      120  budget 0
FAIL  control-tier      15  budget 0
FAIL  type-tier          7  budget 0
FAIL  one-header         5  budget 0
FAIL  uppercase-guard   22  budget 0
FAIL  format-locale      4  budget 0

  radius-tier  styles.css:175  border-radius: 4px;
  radius-tier  styles.css:207  border-radius: 7px;
  control-tier  components/ui/button.tsx:19  h-9 on a control box
  uppercase-guard  styles.css:318  .eyebrow
  format-locale  format.ts:22  'No data'
...
check-ui-tokens: FAIL (6 rule(s) over budget)
$ echo $?
1
```

### Proof it goes green without touching the tree (ratchet at today's counts)

```
$ node scripts/check-ui-tokens.mjs --ratchet ui-debt.json   # {radius-tier:120, control-tier:15, ...}
ok    radius-tier      120  budget 120
ok    control-tier      15  budget 15
ok    type-tier          7  budget 7
ok    one-header         5  budget 5
ok    uppercase-guard   22  budget 22
ok    format-locale      4  budget 4

check-ui-tokens: PASS
$ echo $?
0
```

### Proof the ratchet actually ratchets

With the radius budget set one below reality (`radius-tier: 119`):

```
$ node scripts/check-ui-tokens.mjs --ratchet ui-debt-tighter.json
FAIL  radius-tier      120  budget 119
ok    control-tier      15  budget 15
...
check-ui-tokens: FAIL (1 rule(s) over budget)
$ echo $?
1
```

### The script

```js
#!/usr/bin/env node
/**
 * check-ui-tokens.mjs - the static half of the UI spec gate.
 * Source text only: no browser, no server, no build.
 * Rules: docs/design/ui-visual-v3/spec/token-table.md + page-template.md + machine-language-rules.md
 *
 *   node scripts/check-ui-tokens.mjs                     strict: zero offenders
 *   node scripts/check-ui-tokens.mjs --ratchet debt.json  migration: counts may not rise
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? fallback : argv[i + 1];
};
const ROOT = resolve(flag('root', join(HERE, '..')));
const RATCHET = flag('ratchet', null);
const SRC = join(ROOT, 'apps', 'platform-web', 'src');
const cssPath = join(SRC, 'styles.css');
if (!existsSync(cssPath)) {
  console.error('check-ui-tokens: ' + relative(ROOT, cssPath) + ' not found (wrong --root?)');
  process.exit(2);
}
const css = readFileSync(cssPath, 'utf8');
const cssLines = css.split('\n');

const DECORATION = ['.avatar', '.brand-', '.empty-icon', '.error-icon', '.skeleton', '.progress',
  '.attention-icon', '.entity-icon', '.investigation-slot-mark', '.dot', '.bar', '.track',
  '.spinner', '.glyph', '.rail', '.swatch', '.chart', '.timeline', '.hairline', '.metric-value',
  '.node-summary', '.node-type-icon', '.event-marker', '.step-index'];
const CONTROL_TIERS = [32, 40];
const RADIUS_OK = /(var\(--ow-radius-(control|card|pill)\)|^0$|^inherit$|^9999px$)/;
const TYPE_TIERS = [11, 13, 15, 26];
const TYPE_TOKENS = ['--ow-type-label', '--ow-type-meta', '--ow-type-body', '--ow-type-title'];
const CONTROL_PRIMITIVES = ['button.tsx', 'input.tsx', 'select.tsx', 'checkbox.tsx', 'switch.tsx', 'tabs.tsx'];
const GLYPH_HEIGHTS = ['h-2', 'h-3', 'h-3.5', 'h-4', 'h-5', 'h-6'];

const findings = [];
const add = (rule, file, line, text) => findings.push({ rule, file, line, text: String(text).trim().slice(0, 140) });

/** Token blocks are the one place a literal is legal; blank them, keep line numbers. */
const body = css
  .replace(/:root \{[\s\S]*?\n\}/m, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/html\[data-theme="dark"\] \{[\s\S]*?\n\}/m, (m) => m.replace(/[^\n]/g, ' '))
  .split('\n');
/** Selector for a declaration, walking back to the line that opened the rule. */
const selectorAt = (i) => {
  for (let j = i; j >= 0 && j > i - 6; j -= 1) {
    const cut = body[j].split('{');
    if (cut.length > 1) return cut[0].trim();
  }
  return body[i].split('{')[0].trim();
};

// R1 radius: three tiers, and they are tokens --------------------------------
for (let i = 0; i < body.length; i += 1) {
  const decls = body[i].match(/border-radius:\s*[^;]+;/g);
  if (!decls) continue;
  for (const decl of decls) {
    const value = decl.replace(/border-radius:\s*/, '').replace(';', '').trim();
    const parts = value.split(/\s+/).filter((p) => p !== '0');
    if (parts.some((p) => !RADIUS_OK.test(p))) add('radius-tier', 'styles.css', i + 1, decl);
  }
}
const tsxFiles = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) tsxFiles.push(p);
  }
})(SRC);
for (const file of tsxFiles) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const hits = line.match(/rounded-(sm|md|lg|xl|2xl|3xl|\[[^\]]+\])/g);
    if (hits) for (const hit of hits) add('radius-tier', relative(SRC, file), i + 1, hit);
  });
}

// R2 control height: exactly 32 or 40, declared once --------------------------
for (let i = 0; i < body.length; i += 1) {
  const decls = body[i].match(/(?:min-)?height:\s*\d+px/g);
  if (!decls) continue;
  const selector = selectorAt(i);
  if (DECORATION.some((d) => selector.includes(d))) continue;
  for (const decl of decls) {
    const px = Number(decl.match(/(\d+)px/)[1]);
    if (px < 28 || px > 48 || CONTROL_TIERS.includes(px)) continue;
    add('control-tier', 'styles.css', i + 1, selector + ' -> ' + px + 'px');
  }
}
for (const file of tsxFiles) {
  if (!CONTROL_PRIMITIVES.includes(file.split('/').pop())) continue;
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (GLYPH_HEIGHTS.some((g) => line.includes(g + ' '))) return;
    const hits = line.match(/\bh-(6|7|8|9|10|11|12)\b/g);
    if (hits) for (const hit of hits) add('control-tier', relative(SRC, file), i + 1, hit + ' on a control box');
  });
}

// R3 type ladder: four tiers -------------------------------------------------
const declared = new Map();
for (const line of cssLines) {
  const m = line.match(/--ow-type-([a-z-]+):\s*([^;]+);/);
  if (m) declared.set('--ow-type-' + m[1], m[2].trim());
}
for (const [token, value] of declared) {
  const px = value.match(/^(\d+)px$/);
  const named = TYPE_TOKENS.includes(token);
  if (!px) { if (named || TYPE_TIERS.length) add('type-tier', 'styles.css', 0, token + ': ' + value + ' is not one of the four tiers'); continue; }
  if (!TYPE_TIERS.includes(Number(px[1]))) add('type-tier', 'styles.css', 0, token + ': ' + value);
}
for (let i = 0; i < body.length; i += 1) {
  const decls = body[i].match(/font-size:\s*[^;]+;/g);
  if (!decls) continue;
  for (const decl of decls) {
    const value = decl.replace(/font-size:\s*/, '').replace(';', '').trim();
    if (/var\(--ow-type-/.test(value)) continue;
    if (value === 'inherit') continue;
    add('type-tier', 'styles.css', i + 1, decl);
  }
}

// R4 one page header ---------------------------------------------------------
const appHeader = join(SRC, 'components', 'app', 'page-header.tsx');
for (const file of tsxFiles) {
  const text = readFileSync(file, 'utf8');
  if (/export function PageHeader\b/.test(text) && file !== appHeader) {
    add('one-header', relative(SRC, file), 0, 'second PageHeader implementation');
  }
  if (/import \{[^}]*\bPageHeader\b[^}]*\} from '[^']*components\/Ui'/.test(text)) {
    add('one-header', relative(SRC, file), 0, 'imports PageHeader from components/Ui');
  }
}

// R5 uppercase only where the language has case ------------------------------
for (let i = 0; i < body.length; i += 1) {
  if (!/text-transform:\s*uppercase/.test(body[i])) continue;
  if (/:lang\(en\)/.test(body[i])) continue;
  add('uppercase-guard', 'styles.css', i + 1, selectorAt(i));
}

// R6 formatters speak the locale, not English -------------------------------
const BT = String.fromCharCode(96);
const formatPath = join(SRC, 'format.ts');
if (existsSync(formatPath)) {
  readFileSync(formatPath, 'utf8').split('\n').forEach((line, i) => {
    if (!/\breturn\b/.test(line)) return;
    if (/toLocaleString|Intl\./.test(line)) return;
    const words = line.match(/'[A-Za-z][A-Za-z ]{2,}'/g);
    if (words) add('format-locale', 'format.ts', i + 1, words.join(' '));
    if (line.includes(BT) && /[}][smhd][^a-z]/i.test(line)) add('format-locale', 'format.ts', i + 1, line.trim());
  });
}

// report ---------------------------------------------------------------------
const RULES = ['radius-tier', 'control-tier', 'type-tier', 'one-header', 'uppercase-guard', 'format-locale'];
const counts = Object.fromEntries(RULES.map((r) => [r, 0]));
for (const f of findings) counts[f.rule] += 1;
const budget = RATCHET ? JSON.parse(readFileSync(RATCHET, 'utf8')) : null;
let over = 0;
for (const rule of RULES) {
  const limit = budget ? (budget[rule] || 0) : 0;
  if (counts[rule] > limit) over += 1;
  console.log((counts[rule] > limit ? 'FAIL' : 'ok  ') + '  ' + rule.padEnd(16) + String(counts[rule]).padStart(4) + '  budget ' + limit);
}
console.log('');
for (const f of findings) {
  if (budget && counts[f.rule] <= (budget[f.rule] || 0)) continue;
  console.log('  ' + f.rule + '  ' + f.file + (f.line ? ':' + f.line : '') + '  ' + f.text);
}
console.log('');
console.log(over === 0 ? 'check-ui-tokens: PASS' : 'check-ui-tokens: FAIL (' + over + ' rule(s) over budget)');
process.exit(over === 0 ? 0 : 1);
```

Runtime facts the static gate cannot see (header height 80, first block at y=160, one control height per
toolbar) are asserted by `page-template.md` §4 against the same `_metrics_*.json` contract.

---

## 5. 不做什么

- **No colour work.** The palette is not in this spec. `--ow-*` colour tokens already resolve; R1–R5 do not touch them, and a colour change would double the review surface without moving any of the measured defects.
- **No spacing scale change.** 4/8/12/16/24/32 stays. Only three gaps move (page-template §2).
- **No new component library.** No second UI kit; the shadcn copy-in under `components/ui/` is the only one (AGENTS.md §前端与国际化).
- **No `--ow-type-hero` migration.** `/login` and `/403` keep their display size. They are two screens with one text block each; folding them into the ladder would add a fifth tier to buy nothing.
- **No font file.** Inter is still not bundled (`styles.css:97`); the token stays and resolves to the system stack. Shipping a webfont is a separate decision with a separate budget.
- **No dark-mode palette audit.** The three tiers are chosen so they render on both themes (all three are geometry, not colour); photographic verification is out of scope here.
- **No dependency bumps, no build changes, no API or contract changes.**

