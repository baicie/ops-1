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
import { join, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? fallback : argv[i + 1];
};
const ROOT = resolve(flag('root', join(HERE, '..')));
const RATCHET = flag('ratchet', null);
// A ratchet path that does not resolve used to leave every budget at zero, so the script failed every
// rule regardless of the code. Three separate runs in one week reported that as a real regression. A
// gate that fails by default teaches people to ignore it, so an unresolvable path is now an error
// about the path rather than a verdict about the code.
if (RATCHET !== null && !existsSync(RATCHET)) {
  console.error('check-ui-tokens: cannot read the ratchet file ' + RATCHET);
  console.error('Without it every budget is zero and every rule fails, which says nothing about the code.');
  console.error('Pass the path this repository uses: docs/design/ui-visual-v3/spec/ui-debt.json');
  process.exit(2);
}
if (RATCHET === null) {
  console.error('check-ui-tokens: no --ratchet given.');
  console.error('Every budget would be zero and every rule would fail, which says nothing about the code,');
  console.error('and four separate reports have read that output as a regression. Pass the path instead:');
  console.error('  node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json');
  process.exit(2);
}
// G14.2: the stylesheet and the primitives it styles now live in packages/ui,
// and the two applications consume them. The token rules must scan all three, or
// a radius tier added in a new application would pass unchecked.
const UI_SRC = join(ROOT, 'packages', 'ui', 'src');
const SRC_ROOTS = [
  UI_SRC,
  join(ROOT, 'apps', 'platform-console', 'src'),
  join(ROOT, 'apps', 'ops-web', 'src'),
].filter((dir) => existsSync(dir));
const cssPath = join(UI_SRC, 'styles.css');
if (!existsSync(cssPath)) {
  console.error('check-ui-tokens: ' + relative(ROOT, cssPath) + ' not found (wrong --root?)');
  process.exit(2);
}
const css = readFileSync(cssPath, 'utf8');
const cssLines = css.split('\n');

const DECORATION = ['.avatar', '.brand-', '.empty-icon', '.skeleton', '.progress',
  '.attention-icon', '.entity-icon', '.investigation-slot-mark', '.dot', '.bar', '.track',
  '.spinner', '.glyph', '.rail', '.swatch', '.chart', '.timeline', '.hairline',
  '.node-summary', '.node-type-icon', '.event-marker', '.step-index'];
const CONTROL_TIERS = [32, 40];
const RADIUS_OK = /(var\(--ow-radius-(control|card|pill)\)|^0$|^inherit$|^9999px$)/;
const TYPE_TIERS = [11, 13, 15, 26];
const TYPE_TOKENS = ['--ow-type-label', '--ow-type-meta', '--ow-type-body', '--ow-type-title'];
// ADR-017 §D5 names these three display exceptions. A clamp is a range, not a tier: the title's
// maximum is 26 and its 390 floor is 20. The metric figure stays 21 so the KPI zeros do not
// outshout the health verdict; the login hero is the one display headline.
const TYPE_EXEMPT_TOKENS = new Set(['--ow-type-title', '--ow-type-metric', '--ow-type-hero']);
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
for (const root of SRC_ROOTS) {
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) tsxFiles.push(p);
    }
  })(root);
}
const repoRelative = (file) => {
  for (const root of SRC_ROOTS) {
    if (file.startsWith(root + sep)) return relative(root, file);
  }
  return relative(ROOT, file);
};
for (const file of tsxFiles) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const hits = line.match(/rounded-(sm|md|lg|xl|2xl|3xl|\[[^\]]+\])/g);
    if (hits) for (const hit of hits) add('radius-tier', repoRelative(file), i + 1, hit);
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
    if (hits) for (const hit of hits) add('control-tier', repoRelative(file), i + 1, hit + ' on a control box');
  });
}

// R3 type ladder: four tiers -------------------------------------------------
const declared = new Map();
for (const line of cssLines) {
  const m = line.match(/--ow-type-([a-z-]+):\s*([^;]+);/);
  if (m) declared.set('--ow-type-' + m[1], m[2].trim());
}
for (const [token, value] of declared) {
  if (TYPE_EXEMPT_TOKENS.has(token)) continue;
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
const appHeader = join(UI_SRC, 'page-header.tsx');
for (const file of tsxFiles) {
  const text = readFileSync(file, 'utf8');
  if (/export function PageHeader\b/.test(text) && file !== appHeader) {
    add('one-header', repoRelative(file), 0, 'second PageHeader implementation');
  }
  if (/import \{[^}]*\bPageHeader\b[^}]*\} from '[^']*components\/Ui'/.test(text)) {
    add('one-header', repoRelative(file), 0, 'imports PageHeader from components/Ui');
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
const formatPath = join(ROOT, 'packages', 'platform-client', 'src', 'format.ts');
if (existsSync(formatPath)) {
  readFileSync(formatPath, 'utf8').split('\n').forEach((line, i) => {
    if (!/\breturn\b/.test(line)) return;
    if (/toLocaleString|Intl\./.test(line)) return;
    const words = line.match(/'[A-Za-z][A-Za-z ]{2,}'/g);
    if (words) add('format-locale', 'format.ts', i + 1, words.join(' '));
    if (line.includes(BT) && /[}][smhd][^a-z]/i.test(line)) add('format-locale', 'format.ts', i + 1, line.trim());
  });
}

// R7 spacing: a literal may be on the 4/8/12/16/24/32 scale, never off it ---
// B6 (code-rules.md) ranks the sources for a number: semantic token > the 4/8/12/16/24/32
// scale > a named constant > a raw literal. Radius, control height and font size must use a
// token (R1-R3); spacing is allowed to use a scale value, so the only violation here is a
// spacing px value that is on NEITHER. This rule was budgeted in ui-debt.json from #15 onward
// and never emitted by any script, so the budget guarded nothing: a rule that reports 0 because
// it does not exist is indistinguishable from a rule that reports 0 because the code is clean.
const SPACING_PROPS = ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'gap', 'row-gap', 'column-gap'];
const SPACING_SCALE = [4, 8, 12, 16, 24, 32];
const offScaleTokens = (value) => {
  // `var(--ow-space-4)` is the good state, not a literal; `calc(...)` and `0` carry no number.
  const stripped = value.replace(/var\([^)]*\)/g, ' ');
  return [...stripped.matchAll(/(-?\d+(?:\.\d+)?)px/g)]
    .map((m) => Math.abs(Number(m[1])))
    .filter((px) => px !== 0 && !SPACING_SCALE.includes(px));
};
let spacingDeclarations = 0;
for (let i = 0; i < body.length; i += 1) {
  for (const m of body[i].matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) {
    if (!SPACING_PROPS.includes(m[1])) continue;
    spacingDeclarations += 1;
    const off = offScaleTokens(m[2]);
    if (off.length) add('spacing-off-scale', 'styles.css', i + 1, m[1] + ': ' + m[2].trim());
  }
}
// The same literal in a utility class is the same defect: `mt-[18px]` is a raw spacing value
// that no token and no scale step backs.
const SPACING_UTILITY = /\b(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y)-\[(-?\d+(?:\.\d+)?)px\]/g;
for (const file of tsxFiles) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(SPACING_UTILITY)) {
      if (!SPACING_SCALE.includes(Math.abs(Number(m[1])))) {
        add('spacing-off-scale', repoRelative(file), i + 1, m[0]);
      }
    }
  });
}
if (spacingDeclarations === 0) {
  // rules/11: a gate must report its scan volume and fail when that volume is zero. Zero here
  // means the selector above stopped matching, not that the stylesheet has no spacing.
  console.error('check-ui-tokens: R7 scanned 0 spacing declarations in styles.css; the rule is not reading what it thinks it reads.');
  process.exit(2);
}

// report ---------------------------------------------------------------------
const RULES = ['radius-tier', 'control-tier', 'type-tier', 'one-header', 'uppercase-guard', 'format-locale',
  'spacing-off-scale'];
const counts = Object.fromEntries(RULES.map((r) => [r, 0]));
for (const f of findings) counts[f.rule] += 1;
const budget = RATCHET ? JSON.parse(readFileSync(RATCHET, 'utf8')) : null;
// A key in the budget that no rule ever emits is the failure this repository already shipped
// once: it reads as a guarded number and guards nothing. Refuse to run rather than print a
// green line for it.
if (budget) {
  const unknown = Object.keys(budget).filter((k) => !RULES.includes(k));
  if (unknown.length) {
    console.error('check-ui-tokens: the ratchet file budgets rules that are never emitted: ' + unknown.join(', '));
    console.error('A budget nothing can exceed is not a gate. Either implement the rule or delete the key.');
    process.exit(2);
  }
}
let over = 0;
for (const rule of RULES) {
  const limit = budget ? (budget[rule] || 0) : 0;
  if (counts[rule] > limit) over += 1;
  console.log((counts[rule] > limit ? 'FAIL' : 'ok  ') + '  ' + rule.padEnd(16) + String(counts[rule]).padStart(4) + '  budget ' + limit);
}
console.log('');
console.log('scanned: ' + tsxFiles.length + ' TSX files, ' + spacingDeclarations + ' spacing declarations in styles.css');
for (const f of findings) {
  if (budget && counts[f.rule] <= (budget[f.rule] || 0)) continue;
  console.log('  ' + f.rule + '  ' + f.file + (f.line ? ':' + f.line : '') + '  ' + f.text);
}
console.log('');
console.log(over === 0 ? 'check-ui-tokens: PASS' : 'check-ui-tokens: FAIL (' + over + ' rule(s) over budget)');
process.exit(over === 0 ? 0 : 1);
