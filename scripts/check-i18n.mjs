#!/usr/bin/env node
/**
 * Message-catalog gate for the Web shell (AGENTS.md「前端与国际化」, rules/06-ui-ux.md).
 *
 * Checks, in this order:
 *   1. every catalog is valid JSON with `<namespace>.<key>` style keys and non-empty values;
 *   2. no key present in the default catalog ("en") is missing from another locale, and no
 *      locale invents a key the default catalog does not have;
 *   3. no catalog key is unreferenced by the source tree (unused keys are reported, not fatal);
 *   4. no message key is built at runtime from a template literal (that would defeat check 3).
 *
 * Exit code is 1 when keys are missing (or a key/catalog is malformed), 0 otherwise.
 * Usage: node scripts/check-i18n.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Frozen by tests: Playwright specs assert English copy, so `en` must stay the default. */
// Must match DEFAULT_LOCALE in apps/platform-web/src/i18n/index.tsx.
const DEFAULT_LOCALE = 'zh-CN';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every source tree whose literals must come from the catalog (G14.2).
 *
 * The gate previously scanned one application. Now that the design system, the
 * shared client and two applications are separate packages, scanning only one of
 * them would let a hardcoded string ship in any of the others - the exact hole
 * rules/06 exists to close, made bigger by splitting the codebase. A new
 * workspace package must be added here, and the list is deliberately explicit so
 * forgetting is a visible omission rather than a silent one.
 */
const SOURCE_ROOTS = [
  join(ROOT, 'apps', 'platform-web', 'src'),
  join(ROOT, 'apps', 'platform-console', 'src'),
  join(ROOT, 'apps', 'ops-web', 'src'),
  join(ROOT, 'packages', 'ui', 'src'),
  join(ROOT, 'packages', 'platform-client', 'src'),
].filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory());

/** One catalog set, shared by every application: a key is either translated or it is not. */
const CATALOG_DIR = join(ROOT, 'packages', 'platform-client', 'src', 'i18n', 'catalogs');

const KEY_SHAPE = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'catalogs']);
/** A template literal handed straight to t()/translate() makes keys untraceable statically. */
const DYNAMIC_KEY = /\b(?:t|translate)\(\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?`[^`]*\$\{/g;

const problems = [];
const warnings = [];

function fail(message) {
  problems.push(message);
}

function listSourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      found.push(...listSourceFiles(join(dir, entry.name)));
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

/** Comments would otherwise make an unreferenced key look used. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every quoted literal in a file; keys are only ever referenced as literals. */
function stringLiterals(text) {
  const literals = new Set();
  for (const match of text.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\\n]*)`/g)) {
    const literal = match[1] ?? match[2] ?? match[3];
    if (literal) literals.add(literal);
  }
  return literals;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function loadCatalogs() {
  const catalogs = new Map();
  for (const file of readdirSync(CATALOG_DIR).filter((name) => name.endsWith('.json')).sort()) {
    const locale = file.slice(0, -'.json'.length);
    const path = join(CATALOG_DIR, file);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (cause) {
      fail(`catalog ${file} is not valid JSON: ${cause.message}`);
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      fail(`catalog ${file} must be a flat JSON object of "namespace.key": "message"`);
      continue;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (!KEY_SHAPE.test(key)) fail(`catalog ${file}: key "${key}" is not in <namespace>.<key> form`);
      if (typeof value !== 'string' || value.trim() === '') fail(`catalog ${file}: key "${key}" has an empty or non-string message`);
    }
    catalogs.set(locale, parsed);
  }
  return catalogs;
}

const catalogs = loadCatalogs();

if (!catalogs.has(DEFAULT_LOCALE)) {
  console.error(`[i18n] FATAL: default catalog ${DEFAULT_LOCALE}.json is missing from ${relative(ROOT, CATALOG_DIR)}`);
  process.exit(1);
}

const reference = catalogs.get(DEFAULT_LOCALE);
const referenceKeys = Object.keys(reference);
const otherLocales = [...catalogs.keys()].filter((locale) => locale !== DEFAULT_LOCALE);

// --- 2. missing keys, in both directions -------------------------------------
for (const locale of otherLocales) {
  const catalog = catalogs.get(locale);
  for (const key of referenceKeys) {
    if (!(key in catalog)) fail(`missing key "${key}" from ${locale}.json (present in ${DEFAULT_LOCALE}.json)`);
  }
  for (const key of Object.keys(catalog)) {
    if (!(key in reference)) fail(`key "${key}" exists in ${locale}.json but not in ${DEFAULT_LOCALE}.json`);
  }
}

// --- 3/4. usage scan ---------------------------------------------------------
const sourceFiles = SOURCE_ROOTS.flatMap((root) =>
  listSourceFiles(root).map((file) => ({ file, root })),
);
const usedLiterals = new Set();
for (const { file } of sourceFiles) {
  const text = stripComments(readFileSync(file, 'utf8'));
  for (const literal of stringLiterals(text)) usedLiterals.add(literal);
  for (const match of text.matchAll(DYNAMIC_KEY)) {
    fail(`${relative(ROOT, file)}:${lineOf(text, match.index)} builds a message key from a template literal; pass a literal key so the catalog check can see it`);
  }
}

const knownKeys = new Set(referenceKeys.concat(otherLocales.flatMap((locale) => Object.keys(catalogs.get(locale)))));
const unusedKeys = [...knownKeys].filter((key) => !usedLiterals.has(key)).sort();

// --- report ------------------------------------------------------------------
const summary = [
  `[i18n] default locale: ${DEFAULT_LOCALE}`,
  ...[...catalogs.entries()].map(([locale, catalog]) => `[i18n] catalog ${locale}.json: ${Object.keys(catalog).length} keys`),
  `[i18n] scanned ${sourceFiles.length} source files under ${SOURCE_ROOTS.map((root) => relative(ROOT, root)).join(', ')}`,
];

if (unusedKeys.length > 0) {
  warnings.push(...unusedKeys.map((key) => `unused key "${key}" (declared in the catalog, referenced by no source file)`));
}

console.log(summary.join('\n'));

if (warnings.length > 0) {
  console.warn(`\n[i18n] ${warnings.length} warning(s):`);
  for (const message of warnings) console.warn(`  WARN ${message}`);
}

if (problems.length > 0) {
  console.error(`\n[i18n] ${problems.length} error(s):`);
  for (const message of problems) console.error(`  ERROR ${message}`);
  console.error(`\n[i18n] FAILED`);
  process.exit(1);
}

console.log(`\n[i18n] OK — ${knownKeys.size} keys across ${catalogs.size} locale(s), ${unusedKeys.length} unused`);
