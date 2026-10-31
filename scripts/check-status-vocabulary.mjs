#!/usr/bin/env node
/**
 * Status-vocabulary gate.
 *
 * The v5 review found one enum spelled six ways on one screen - Ready, STAGED, Staged,
 * INSTALLED, and a toast to match - because each surface decided for itself whether to print
 * the localized label or the wire code. Prose cannot enforce that; a build step can.
 *
 * What is scanned is the *copy surface* and nothing else:
 *   - the two i18n catalogs (every message the reader can be shown),
 *   - JSX text nodes (inline copy that escaped the catalogs).
 * Comments, identifiers, filter keys, test fixtures and SVG path data are not copy and are
 * not scanned: a gate that cries wolf on `// the kernel can answer READY` gets switched off.
 *
 * Four rules:
 *   1. protocol-code-in-copy - a message may not BE a wire code, and Chinese copy may not
 *      embed one. The code belongs in data-status and in tooltips.
 *   2. uppercase-in-copy - no all-caps message unless it is a real acronym. Design tags are
 *      uppercased by CSS (.tag), so the catalog carries prose.
 *   3. raw-status-field - no JSX child may interpolate a raw state/status field. That
 *      expression is how INSTALLED reached a key/value grid beside a chip saying 'Installed'.
 *   4. blacklisted-copy - internals that must never be shown to a user.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'apps/platform-web/src');

/** Real acronyms. Anything else in caps is a wire code or a design tag wearing prose. */
const ACRONYMS = new Set(['CPU','GPU','MB','GB','MIB','GIB','API','URL','URI','JSON','YAML','HTTP','HTTPS','UTC','ISO','ID','IP','DNS','TLS','SSE','OCI','RBAC','UI','UX','OK','PDF','CSV','SHA256','CLI','SDK','ZIP','CSRF','SSO']);

const BLACKLIST = [
  { text: 'local-development', why: 'internal environment name' },
  { text: 'Invalid email or password', why: 'server sentence; must be a localized error code' },
  { text: 'plugin not found', why: 'server sentence; must be a localized error code' },
  { text: 'connected', why: 'raw socket token; the catalog has a state word', exact: true, lowercaseOnly: true },
];

/** Files whose whole job is to render protocol vocabulary. */
const ALLOWED_FILES = new Set([
  'components/status-tone.ts',
  'components/app/status.tsx',
  'components/app/status-indicator.tsx',
  'lib/installation-state.ts',
  'lib/installation-state.test.ts',
]);

function readCodes() {
  const text = fs.readFileSync(path.join(SRC, 'components/status-tone.ts'), 'utf8');
  const start = text.indexOf('export const STATUS_MAP');
  const end = text.indexOf('/** Lookup that never throws');
  const block = text.slice(start, end === -1 ? undefined : end);
  const codes = new Set();
  for (const m of block.matchAll(/^\s{2}([A-Z][A-Z0-9_]*)\s*:/gm)) codes.add(m[1]);
  codes.add('NO_DATA');
  return codes;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const CODES = readCodes();
const violations = [];
const rel = (file) => path.relative(SRC, file).split(path.sep).join('/');
const isAllowed = (relPath) => ALLOWED_FILES.has(relPath) || /\.test\.(ts|tsx)$/.test(relPath);

function flag(where, rule, detail) { violations.push({ where, rule, detail }); }

function checkCopy(where, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const hasCjk = /[\u3400-\u9fff]/.test(trimmed);
  if (hasCjk) {
    for (const token of trimmed.match(/[A-Z][A-Z0-9_]{2,}/g) || []) {
      if (ACRONYMS.has(token) || !CODES.has(token)) continue;
      flag(where, 'protocol-code-in-copy', '"' + token + '" is an English wire code inside localized copy; use the state word.');
    }
  } else {
    const bare = trimmed.replace(/[^A-Za-z0-9_]/g, '');
    const allCaps = bare.length > 0 && /[A-Z]/.test(bare) && bare === bare.toUpperCase();
    if (allCaps && !ACRONYMS.has(bare)) {
      const isCode = CODES.has(bare);
      flag(where, isCode ? 'protocol-code-in-copy' : 'uppercase-in-copy', isCode
        ? '"' + bare + '" is a wire code rendered as copy; use <Status> so it is localized.'
        : '"' + bare + '" is all-caps copy; write prose and let CSS uppercase .tag.');
    }
  }
  for (const entry of BLACKLIST) {
    const escaped = entry.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = entry.exact
      ? new RegExp('^' + escaped + '$', entry.lowercaseOnly ? '' : 'i')
      : new RegExp(escaped);
    if (pattern.test(trimmed)) flag(where, 'blacklisted-copy', '"' + entry.text + '" (' + entry.why + ')');
  }
}

for (const locale of ['en', 'zh-CN']) {
  const file = 'i18n/catalogs/' + locale + '.json';
  const json = JSON.parse(fs.readFileSync(path.join(SRC, file), 'utf8'));
  for (const [key, value] of Object.entries(json)) {
    if (typeof value === 'string') checkCopy(file + ' [' + key + ']', value);
  }
}

for (const file of walk(SRC)) {
  if (!/\.tsx$/.test(file)) continue;
  const relPath = rel(file);
  if (isAllowed(relPath)) continue;
  // <code>, <pre> and <kbd> hold identifiers, not copy: an error code or a key cap is
  // protocol detail and is allowed to stay verbatim. HTML entities (`&#8984;K`) are a
  // glyph, not a token. Both are blanked to spaces so line numbers stay true.
  const raw = fs
    .readFileSync(file, 'utf8')
    .replace(/<(code|pre|kbd)\b[^>]*>[\s\S]*?<\/\1>/g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/&#\d+;|&#x[0-9a-fA-F]+;|&[a-zA-Z]+;/g, ' ');
  const rows = raw.split('\n');
  let inBlockComment = false;
  for (let i = 0; i < rows.length; i += 1) {
    let line = rows[i];
    const where = relPath + ':' + (i + 1);
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    line = line.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/\/\/.*$/, '');
    const blockStart = line.indexOf('/*');
    if (blockStart !== -1 && line.indexOf('*/', blockStart) === -1) {
      line = line.slice(0, blockStart);
      inBlockComment = true;
    }
    // Rule 3: a raw state/status field printed as a JSX child.
    // The lookbehind is the whole point: `status={job.status}` passes a prop, while
    // `{data.state}` renders text. Only the second one is the defect.
    if (/(?<![=\w])\{\s*[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\.(?:state|status)\s*\}/.test(line)) {
      flag(where, 'raw-status-field', 'a state/status field is interpolated as text; use <Status> or deriveInstallationState().');
    }
    // Rules 1, 2 and 4 on inline JSX text.
    for (const m of line.matchAll(/>([^<>{}]+)</g)) checkCopy(where, m[1]);
  }
}

if (violations.length) {
  console.error('status-vocabulary: ' + violations.length + ' violation(s)');
  console.error('');
  for (const v of violations) console.error('  ' + v.rule + '  ' + v.where + '\n      ' + v.detail);
  console.error('');
  console.error('One vocabulary, one renderer: lib/installation-state.ts and components/app/status.tsx.');
  process.exit(1);
}

console.log('status-vocabulary: clean (' + CODES.size + ' protocol codes; catalogs + JSX text scanned)');
