/**
 * Counterfactuals for `check-retired-paths.mjs`.
 *
 * The gate reported zero references while `deployments/staging/Dockerfile` still
 * built a directory G14.2 had deleted. The reason was mechanical: the scanner
 * allowed a fixed set of file SUFFIXES, and `Dockerfile` has none, so every
 * Dockerfile in the repository was invisible to it - including the one that
 * produces the staging image. A gate that reads nothing passes silently, which is
 * worse than a gate that fails.
 *
 * Each case below builds a throw-away tree, runs the real scanner against it with
 * cwd set there, and asserts on the exit code and output. The last case is the one
 * that would have caught the staging defect.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCANNER = resolve(dirname(fileURLToPath(import.meta.url)), 'check-retired-paths.mjs');
const RETIRED = 'apps/platform-web';

/** Every live root the scanner insists on, so a fixture is "complete" not "convenient". */
const LIVE_ROOTS = [
  'apps', 'packages', 'plugins', 'tests', 'scripts', '.github',
  'deployments', 'contracts', 'crates', 'rules',
];
const LIVE_FILES = [
  'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'Makefile',
  'package.json', 'pnpm-workspace.yaml', 'docs/API.md', 'docs/RUNBOOK.md',
];

/** A tree the scanner accepts, plus whatever extra files a case wants. */
function fixture(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'retired-paths-'));
  for (const dir of [...LIVE_ROOTS, 'docs']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of LIVE_FILES) writeFileSync(join(root, file), '# placeholder\n');
  for (const [path, body] of Object.entries(extra)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

function scan(root) {
  try {
    const output = execFileSync(process.execPath, [SCANNER], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, output };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test('a clean tree passes, and says how many files it actually read', () => {
  const { code, output } = scan(fixture());
  assert.equal(code, 0, output);
  assert.match(output, /\d+ live files scanned/);
  // A count of zero means the scan read nothing, which must never read as success.
  // The fixture's live files are the nine root documents; the live root DIRECTORIES
  // start empty, so they contribute nothing to the count.
  const count = Number(/(\d+) live files scanned/.exec(output)?.[1] ?? 0);
  assert.ok(count >= LIVE_FILES.length, `only ${count} files were scanned`);
});

test('a retired identifier in a normal source file fails', () => {
  const { code, output } = scan(fixture({ 'apps/x/src/a.ts': `const p = '${RETIRED}';\n` }));
  assert.equal(code, 1, 'a live source reference must fail the gate');
  assert.match(output, /apps\/x\/src\/a\.ts/);
});

test('a retired identifier in an extensionless Dockerfile fails', () => {
  // The case that went unnoticed: the staging image is built from a file with no
  // suffix, so a suffix allow-list never read it.
  const { code, output } = scan(fixture({
    'deployments/staging/Dockerfile': `FROM node:22\nCOPY --from=b /src/${RETIRED}/dist /app/web\n`,
  }));
  assert.equal(code, 1, 'a Dockerfile is a build artefact and must be scanned');
  assert.match(output, /deployments\/staging\/Dockerfile/);
});

test('a suffixed Dockerfile variant (Dockerfile.prod) fails too', () => {
  const { code, output } = scan(fixture({ 'deployments/Dockerfile.prod': `# ${RETIRED}\n` }));
  assert.equal(code, 1, output);
  assert.match(output, /Dockerfile\.prod/);
});

test('dated evidence under docs/design is history, not drift', () => {
  const { code } = scan(fixture({ 'docs/design/old/record.md': `we used ${RETIRED}\n` }));
  assert.equal(0, code, 'a dated record may name a retired path');
});

test('a binary file with no suffix is not pulled into the text scan', () => {
  const root = fixture();
  // Invalid UTF-8: a text read would either throw or produce mojibake.
  // No suffix and not one of the named extensionless entries, so it must be skipped.
  mkdirSync(join(root, 'deployments', 'assets'), { recursive: true });
  writeFileSync(join(root, 'deployments', 'assets', 'logo'), Buffer.from([0xff, 0xfe, 0x00, 0x81]));
  const { code, output } = scan(root);
  assert.equal(code, 0, output);
});

test('a vanished live root fails rather than silently scanning less', () => {
  const root = fixture();
  execFileSync('rm', ['-rf', join(root, 'deployments')]);
  const { code, output } = scan(root);
  assert.equal(code, 1, 'a missing root must fail closed');
  assert.match(output, /missing/);
});
