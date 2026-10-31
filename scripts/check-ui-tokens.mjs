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
