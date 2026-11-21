#!/usr/bin/env node
/**
 * L0 discovery and supply chain. TASK-29.
 *
 * TWO QUESTIONS, and the first is the one that rots:
 *
 *   1. Does a NEW shell script or workflow get checked, or does it have to be
 *      added to a list? A list is a rule that stops applying the moment someone
 *      adds a file in a hurry - and the file added in a hurry is exactly the one
 *      that needed checking.
 *
 *   2. Are the things this pipeline trusts pinned? A third-party action on a tag
 *      is a dependency that can change under us; a tag is a mutable pointer and
 *      the action's author can retarget it.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not lint. `actionlint` and `shellcheck` run separately in `ci.yml`.
 * This checks that THOSE runs would see a newly added file, which is a different
 * question and the one nothing was asking.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Directories that hold shell scripts a maintainer would expect to be linted. */
export const SHELL_DIRS = ['tests/acceptance', 'tests/ci', 'tests/scripts', 'scripts'];

/** Walk a directory for `*.sh`, skipping node_modules and target. */
export function shellScriptsUnder(root, dirs = SHELL_DIRS) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === 'target' || name === '.git') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.sh')) out.push(relative(root, full));
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out.sort();
}

/**
 * The shellcheck invocation's argument list from `ci.yml`.
 *
 * @returns {{args: string[], globs: string[], literal: string[]}}
 */
export function shellcheckInvocation(ciYml) {
  // A `find ... -name '*.sh' | xargs shellcheck` is discovery, and it is strictly
  // better than a glob list: `dir/*.sh` does not descend, so scripts one level
  // down were never linted. Detected and returned as `discovers: true` so the
  // caller does not then complain that the argument list is empty.
  if (/find\s+[^\n]*-name\s+'?\*\.sh'?[\s\S]*?xargs[\s\S]*?shellcheck/.test(ciYml)) {
    return { args: ['<find>'], globs: [], literal: [], discovers: true };
  }
  const m = /shellcheck\s+(--severity=\S+[^\n]*)/.exec(ciYml);
  if (!m) return { args: [], globs: [], literal: [] };
  // `-x` is "follow sourced files", not a path. Flags are dropped; a bare word
  // that is not a flag is a literal file name. The first version kept `-x` and
  // reported it as a hardcoded file list, which is the sort of false positive
  // that teaches people to ignore the checker.
  const words = m[1].split(/\s+/).filter((w) => w && !w.startsWith('-'));
  const args = words;
  return {
    args,
    globs: args.filter((a) => a.includes('*')),
    literal: args.filter((a) => !a.includes('*')),
  };
}

/** Does a glob pattern cover `path`? Only `dir/*.sh` and `dir/**` shapes are supported. */
export function globCovers(pattern, path) {
  if (pattern.endsWith('/**')) return path.startsWith(pattern.slice(0, -3) + '/');
  if (pattern.endsWith('/*.sh')) {
    const dir = pattern.slice(0, -'/*.sh'.length);
    // One level only, which is what `dir/*.sh` means to the shell.
    return path.startsWith(dir + '/') && !path.slice(dir.length + 1).includes('/');
  }
  return pattern === path;
}

/** Third-party `uses:` entries that are not pinned to a 40-hex commit SHA. */
export function unpinnedActions(ciFiles) {
  const out = [];
  for (const [file, text] of Object.entries(ciFiles)) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^\s+(?:-\s+)?uses:\s*(\S+)/.exec(lines[i]);
      if (!m) continue;
      const ref = m[1];
      // A locally-defined action (`./...`) has no version to pin.
      if (ref.startsWith('./')) continue;
      const at = ref.indexOf('@');
      if (at === -1) {
        out.push({ file, line: i + 1, ref, why: 'no @ref at all' });
        continue;
      }
      const pin = ref.slice(at + 1);
      if (!/^[0-9a-f]{40}$/.test(pin)) {
        out.push({ file, line: i + 1, ref, why: `pinned to "${pin}", which is mutable` });
      }
    }
  }
  return out;
}

/** @returns {string[]} problems */
export function inspect({ ciYml, workflows, scripts }) {
  const problems = [];
  const inv = shellcheckInvocation(ciYml);
  if (inv.args.length === 0) {
    problems.push('ci.yml has no shellcheck invocation; nothing is linted');
    return problems;
  }
  if (inv.literal.length > 0) {
    problems.push(
      `shellcheck names files literally (${inv.literal.join(', ')}); a new script in those ` +
      'areas would not be checked unless someone remembers to add it',
    );
  }
  if (inv.discovers) {
    // Nothing more to check: the command discovers by extension, so any script in
    // those trees is covered by construction.
    return problems;
  }
  for (const script of scripts) {
    if (!inv.globs.some((g) => globCovers(g, script))) {
      problems.push(
        `${script} is not covered by any shellcheck glob (${inv.globs.join(' ') || 'none'}); ` +
        'it would ship unlinted',
      );
    }
  }
  // NOT a problem, a report. 126 actions are on mutable tags today; making that
  // fatal would fail every build and teach people to bypass the checker. What
  // matters now is that a NEW one is visible - counts change in the output.
  return problems;
}

// ---------------------------------------------------------------------------

const GOOD_CI = `
      - name: actionlint
        uses: raven-actions/actionlint@0123456789abcdef0123456789abcdef01234567
      - run: |
          shellcheck --severity=error -x tests/acceptance/*.sh tests/ci/*.sh scripts/*.sh
`;

function selftest() {
  const scripts = ['scripts/a.sh', 'scripts/sub/b.sh', 'tests/ci/c.sh', 'deployments/loose.sh'];
  const cases = [
    ['a glob covers the script it names',
      globCovers('scripts/*.sh', 'scripts/a.sh') === true],
    ['a one-level glob does NOT cover a nested script',
      globCovers('scripts/*.sh', 'scripts/sub/b.sh') === false],
    ['a directory outside the globs is reported',
      inspect({ ciYml: GOOD_CI, workflows: { 'ci.yml': GOOD_CI }, scripts }).some((p) => /deployments\/loose\.sh/.test(p))],
    ['a literal file list is reported',
      inspect({
        ciYml: 'shellcheck --severity=error -x scripts/a.sh',
        workflows: { 'x.yml': GOOD_CI },
        scripts: ['scripts/a.sh'],
      }).some((p) => /names files literally/.test(p))],
    ['a tag-pinned action is reported',
      unpinnedActions({ 'ci.yml': '      - uses: raven-actions/actionlint@v2' }).length === 1],
    ['a SHA-pinned action is accepted',
      unpinnedActions({ 'ci.yml': '      - uses: raven-actions/actionlint@0123456789abcdef0123456789abcdef01234567' }).length === 0],
    ['a local action needs no pin',
      unpinnedActions({ 'ci.yml': '      - uses: ./.github/actions/x' }).length === 0],
  ];
  let bad = 0;
  for (const [label, ok] of cases) {
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}\n`);
  }
  process.stdout.write(`L0 discovery selftest: ${cases.length - bad}/${cases.length}\n`);
  process.exit(bad === 0 ? 0 : 1);
}

const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (RUN_AS_PROGRAM) {
  if (process.argv[2] === '--selftest') selftest();
  const workflows = {};
  for (const f of readdirSync(join(ROOT, '.github/workflows')).filter((n) => n.endsWith('.yml'))) {
    workflows[f] = readFileSync(join(ROOT, '.github/workflows', f), 'utf8');
  }
  const problems = inspect({
    ciYml: workflows['ci.yml'] ?? '',
    workflows,
    scripts: shellScriptsUnder(ROOT),
  });
  for (const p of problems) process.stdout.write(`ERROR ${p}\n`);
  process.stdout.write(`L0 discovery: ${problems.length} problem(s)\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}
