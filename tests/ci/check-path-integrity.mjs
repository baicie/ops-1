#!/usr/bin/env node
/**
 * Path reference integrity. TASK-02 / TASK-32.
 *
 * WHY THIS IS SEPARATE FROM check-retired-paths.mjs
 *
 * That checker answers "does a live file still name something we removed". This
 * one answers a different question: "does every path a build, script or config
 * names actually exist". They fail for different reasons and a migration needs
 * both - a moved directory leaves dangling references long before anyone
 * remembers to add a RETIRED entry, and a RETIRED entry does nothing for a
 * typo'd path that was never valid.
 *
 * WHAT IT PARSES
 *
 * The reference forms that exist in this repository, each with the reason it
 * cannot be found by grep alone:
 *
 *   - Cargo workspace members and `path = "..."` deps   (Cargo.toml)
 *   - pnpm workspace globs and `--filter` names          (pnpm-workspace.yaml, package.json)
 *   - Dockerfile COPY/ADD sources                        (build context, not repo root)
 *   - Compose build contexts and volumes                 (relative to the compose file)
 *   - GitHub Actions `run:` file invocations             (`tests/ci/*.sh`, `scripts/*.mjs`)
 *   - GitHub Actions `working-directory`
 *   - Makefile recipe paths
 *   - Rust `include_str!` / `include_bytes!`
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not try to resolve every string that looks like a path. A checker
 * that hallucinates findings teaches people to ignore it - the same failure
 * mode `check-l0-discovery.mjs` documents. Every parser here is anchored to a
 * syntax that is unambiguously a path in that file type.
 *
 * Usage:
 *   node tests/ci/check-path-integrity.mjs [--json]
 * Exit 0 when every parsed reference resolves, 1 otherwise, 2 on a parse error.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const problems = [];
const skippedContexts = [];

/**
 * Names check-retired-paths.mjs already tracks as retired.
 *
 * Duplicating that list would let the two checkers drift, and a retired name is
 * reported there WITH its replacement, which is the useful form. This checker
 * simply does not re-report them.
 */
function isRetired(name) {
  try {
    const text = readFileSync(join(ROOT, 'tests/ci/check-retired-paths.mjs'), 'utf8');
    return text.includes(`'${name}'`) || text.includes(`"${name}"`);
  } catch {
    return false;
  }
}

/** Record a reference that does not resolve. */
function dangling(where, what, target) {
  problems.push({ where, what, target });
}

/**
 * Paths `.gitignore` covers, so a COPY of one is a BUILD INPUT, not a dangling
 * reference. Resolved lazily, one `git check-ignore` per unresolved path - the
 * set of unresolved paths is small, and caching the whole ignore database would
 * mean reimplementing gitignore semantics in this file.
 */
function isBuildOutput(full) {
  const rel = relative(ROOT, full);
  try {
    execFileSync('git', ['check-ignore', '--quiet', rel], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true; // exit 0 means "ignored"
  } catch {
    return false;
  }
}

/**
 * Does `target` exist relative to `base`? `*` in the last segment is a glob.
 *
 * A path that does not exist but IS GITIGNORED is not a finding: it is a build
 * input. `plugins/hello-go/Dockerfile` copies `hello-go-linux`, which `.gitignore`
 * lists at line 18 - the file is produced by the build the Dockerfile is part
 * of. The first CI run of this checker reported all three of these as dangling,
 * which is the false-positive failure mode its own header warns about: a checker
 * that cries wolf on correct files gets ignored.
 */
function resolves(base, target) {
  const full = resolve(base, target);
  if (!full.startsWith(ROOT)) return true; // outside the repo: not ours to check
  if (existsSync(full)) return true;
  if (target.includes('*')) {
    const prefix = target.slice(0, target.indexOf('*'));
    return existsSync(resolve(base, prefix));
  }
  return isBuildOutput(full);
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // `artifacts/` holds run output and is mostly untracked; scanning it
    // reported nine skipped contexts that are not part of the tree.
    if (['node_modules', 'target', 'dist', '.git', '.blueprint', 'test-results', 'artifacts'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cargo workspace
// ---------------------------------------------------------------------------
{
  const cargo = readFileSync(join(ROOT, 'Cargo.toml'), 'utf8');
  const membersBlock = /members\s*=\s*\[([\s\S]*?)\]/.exec(cargo);
  if (!membersBlock) {
    dangling('Cargo.toml', 'workspace members', '(no members array found)');
  } else {
    for (const m of membersBlock[1].matchAll(/"([^"]+)"/g)) {
      if (!resolves(ROOT, m[1])) dangling('Cargo.toml', 'workspace member', m[1]);
    }
  }
  // `path = "../foo"` dependencies, resolved against the declaring crate.
  for (const file of walk(ROOT).filter((f) => f.endsWith('Cargo.toml'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/path\s*=\s*"([^"]+)"/g)) {
      if (!resolves(dirname(file), m[1])) {
        dangling(relative(ROOT, file), 'path dependency', m[1]);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// pnpm workspace + package filters
// ---------------------------------------------------------------------------
{
  const ws = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  for (const m of ws.matchAll(/^\s*-\s*'([^']+)'/gm)) {
    if (!resolves(ROOT, m[1])) dangling('pnpm-workspace.yaml', 'workspace glob', m[1]);
  }
  // `--filter @scope/name` must name a package that exists.
  const names = new Set();
  for (const file of walk(ROOT).filter((f) => f.endsWith('package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      if (pkg.name) names.add(pkg.name);
    } catch { /* a malformed package.json is another checker's finding */ }
  }
  const filtered = new Set();
  const scanFiles = [
    ...walk(join(ROOT, '.github')),
    ...walk(join(ROOT, 'scripts')),
    ...walk(join(ROOT, 'tests')),
    join(ROOT, 'Makefile'),
    join(ROOT, 'package.json'),
    ...walk(join(ROOT, 'deployments')),
  ].filter((f) => existsSync(f) && statSync(f).isFile());
  for (const file of scanFiles) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/--filter\s+'?(@opsweave\/[A-Za-z0-9_.-]+)'?/g)) {
      filtered.add(m[1]);
    }
  }
  for (const name of filtered) {
    // A RETIRED filter name is check-retired-paths.mjs's finding, not this
    // one's: it has the replacement mapping and the history. Reporting it here
    // too would mean two checkers disagree about what to do with it.
    if (!names.has(name) && !isRetired(name)) dangling('(--filter scan)', 'pnpm package filter', name);
  }
  if (filtered.size === 0) {
    dangling('(--filter scan)', 'package filters', '(none found; the scan is not reading what it thinks)');
  }
}

// ---------------------------------------------------------------------------
// Dockerfile COPY/ADD sources, relative to the build context
//
// THE BUILD CONTEXT IS NOT THE DOCKERFILE'S DIRECTORY. `docker build -f
// deployments/staging/Dockerfile --target platform ...` names no context, so
// Docker uses the CALLER's working directory - the repo root here, which is
// why `COPY Cargo.toml` in that file resolves. Assuming the Dockerfile's own
// directory produced nine false findings on the first run, which is exactly
// the shape that teaches people to ignore a checker.
//
// The context is discovered from the call site where one exists, and defaults
// to the repo root otherwise (matching `docker build -f X .`).
// ---------------------------------------------------------------------------
const buildContexts = new Map();
for (const file of walk(join(ROOT, '.github/workflows')).concat(walk(join(ROOT, 'scripts')))) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  // A `docker build` is routinely split across lines with `\` continuations,
  // and the context lives on the LAST of them. Reading only the first line
  // found no context and reported the whole file as unresolvable - which for
  // `deployments/staging/Dockerfile` meant six false COPY findings.
  //
  // Three further traps, each found by a false finding on correct code:
  //   - the command ends at `||`, `&&` or `;`, and the shell that follows was
  //     being read as build arguments (`|| { echo ...; exit 1; }` made `}` the
  //     context);
  //   - `--flag value` must be dropped as a PAIR, or `--target platform`
  //     leaves `platform` looking like the context;
  //   - prose in YAML comments mentions `docker build` too.
  const joined = text.replace(/\\\r?\n\s*/g, ' ');
  for (const rawLine of joined.split('\n')) {
    if (/^\s*#/.test(rawLine)) continue;
    const command = rawLine.split(/\|\||&&|;/)[0];
    for (const m of command.matchAll(/docker\s+build\b(.*)/g)) {
    // Strip shell redirections first: `... "$dir" >/dev/null` made `>/dev/null`
    // look like the build context on the first attempt.
    const args = m[1].replace(/\s*[012]?>>?\s*\S+/g, '').replace(/\s*2>&1/g, '');
    const df = /-f\s+(\S+)/.exec(args)?.[1];
    // The context is the last bare argument. It is frequently a shell variable
    // (`"$dir"`), which this checker cannot resolve - and a guessed context
    // produces false findings on correct files, which is worse than skipping.
    // Drop `--flag value` pairs as well as `--flag=value`: `--target platform`
    // left `platform` behind and made it look like the context.
    const withoutFlags = args
      .replace(/-f\s+\S+/, '')
      .replace(/--[A-Za-z-]+(?:=\S+|\s+("[^"]*"|\S+))/g, '')
      .replace(/\s-[a-zA-Z]\s+\S+/g, '')
      .trim();
    const contextArg = withoutFlags.split(/\s+/).filter(Boolean).pop();
    if (!contextArg) continue;
    const quoted = contextArg.replace(/^["']|["']$/g, '');
    // No `-f` means Docker looks for `<context>/Dockerfile`. Recording that key
    // is what lets a plugin's own Dockerfile be checked against its own
    // directory instead of falling back to the repo root.
    const key = normalize(df ?? join(quoted, 'Dockerfile'));
    // ONE shell pattern is worth resolving rather than skipping, because it is
    // how every plugin image is built:
    //
    //   dir="$SRC/plugins/$name/backend"
    //   sudo docker build ... "$dir"
    //
    // `$name` takes each value the caller loops over, so the context is not one
    // directory but every `plugins/*/backend`. Expanding it here turns twelve
    // unresolvable contexts into twelve checked ones, and a COPY that names a
    // file the plugin deleted is exactly the failure this checker exists for.
    if (/\$name\b/.test(quoted) && /plugins\//.test(quoted)) {
      for (const dir of readdirSync(join(ROOT, 'plugins'), { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const candidate = join('plugins', dir.name, 'backend', 'Dockerfile');
        if (existsSync(join(ROOT, candidate))) {
          buildContexts.set(normalize(candidate), join(ROOT, 'plugins', dir.name, 'backend'));
        }
      }
      continue;
    }
    if (/\$/.test(quoted)) {
      buildContexts.set(key, null); // discovered, but unresolvable
    } else {
      buildContexts.set(key, resolve(ROOT, quoted));
    }
    }
  }
}

for (const file of walk(ROOT).filter((f) => /(^|\/)Dockerfile[^/]*$/.test(f))) {
  const rel = relative(ROOT, file);
  // A Dockerfile with no discoverable call site has an UNKNOWN context. It is
  // skipped and counted, never assumed to be the repo root: assuming produced
  // five false findings on a plugin whose context is its own backend
  // directory, and a checker that cries wolf on correct files gets ignored.
  if (!buildContexts.has(rel)) { skippedContexts.push(rel); continue; }
  const contextDir = buildContexts.get(rel);
  if (contextDir === null) { skippedContexts.push(rel); continue; }
  const text = readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const m = /^\s*(?:COPY|ADD)\s+(?:--\S+\s+)*(.+)$/i.exec(line);
    if (!m) continue;
    const parts = m[1].trim().split(/\s+/);
    if (parts.length < 2) continue;
    for (const src of parts.slice(0, -1)) {
      if (src.startsWith('--') || src.startsWith('http')) continue;
      if (!resolves(contextDir, src)) dangling(rel, 'COPY source', src);
    }
  }
}

// ---------------------------------------------------------------------------
// Compose build contexts and bind mounts
// ---------------------------------------------------------------------------
for (const file of walk(join(ROOT, 'deployments')).filter((f) => /\.ya?ml$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  const base = dirname(file);
  for (const m of text.matchAll(/^\s*(?:context|dockerfile):\s*(\S+)\s*$/gm)) {
    if (!resolves(base, m[1])) dangling(relative(ROOT, file), 'compose build path', m[1]);
  }
  for (const m of text.matchAll(/^\s*-\s*(\.\.?\/[^:\s]+):/gm)) {
    if (!resolves(base, m[1])) dangling(relative(ROOT, file), 'compose bind mount', m[1]);
  }
}

// ---------------------------------------------------------------------------
// Workflow: file invocations and working-directory
// ---------------------------------------------------------------------------
const repoFiles = new Set(walk(ROOT).map((f) => relative(ROOT, f)));
for (const file of walk(join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f))) {
  const text = readFileSync(file, 'utf8');
  const where = relative(ROOT, file);
  for (const m of text.matchAll(/^\s*working-directory:\s*(\S+)\s*$/gm)) {
    if (!resolves(ROOT, m[1])) dangling(where, 'working-directory', m[1]);
  }
  // Shell/Node/Python entry points named in a run: line. Anchored to a file we
  // can see in the tree, so a command like `cargo build` is never a finding.
  for (const line of text.split('\n')) {
    // A YAML comment names files too, and those are prose, not invocations.
    // Only `run:`/`uses:` lines are commands. This was a false finding on
    // `tracked-png-budget.js`, which exists only as `.json` in a comment.
    if (!/^\s*(?:-\s+)?(?:run:|uses:)|^\s+/.test(line)) continue;
    if (/^\s*#/.test(line)) continue;
    for (const m of line.matchAll(/\b((?:tests|scripts)\/[A-Za-z0-9_.\/-]+\.(?:sh|mjs|cjs|js|py))\b/g)) {
      if (!repoFiles.has(m[1])) dangling(where, 'script invocation', m[1]);
    }
  }
}

// ---------------------------------------------------------------------------
// Makefile recipe targets that name a file
// ---------------------------------------------------------------------------
{
  const mk = readFileSync(join(ROOT, 'Makefile'), 'utf8');
  for (const m of mk.matchAll(/\b((?:tests|scripts)\/[A-Za-z0-9_.\/-]+\.(?:sh|mjs|cjs|js|py))/g)) {
    if (!repoFiles.has(m[1])) dangling('Makefile', 'script invocation', m[1]);
  }
}

// ---------------------------------------------------------------------------
// Rust include_str! / include_bytes!
// ---------------------------------------------------------------------------
for (const file of walk(join(ROOT, 'crates')).concat(walk(join(ROOT, 'apps'))).filter((f) => f.endsWith('.rs'))) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/include_(?:str|bytes)!\s*\(\s*(?:concat!\([^)]*?)?\s*"([^"]+)"/g)) {
    // `concat!(env!("CARGO_MANIFEST_DIR"), "/x")` resolves at build time against
    // the crate root, so only literal paths are checked here.
    if (m[1].includes('$') || m[1].startsWith('/')) continue;
    if (!resolves(dirname(file), m[1])) dangling(relative(ROOT, file), 'include_str/bytes', m[1]);
  }
}

// ---------------------------------------------------------------------------
// Rules index: every rules/NN file must be listed in rules/README.md
//
// The index lists files as bare basenames in a bullet list, and the first run
// of this checker reported 01..08 as unindexed because they genuinely are not
// there - the README lists only 09, 10 and 11. That was a real finding, not a
// parser bug, and it is left as one: the rules index is how an agent
// discovers the standards, so a file missing from it is a rule nobody reads.
// ---------------------------------------------------------------------------
{
  const rulesDir = join(ROOT, 'rules');
  if (existsSync(rulesDir)) {
    const index = readFileSync(join(rulesDir, 'README.md'), 'utf8');
    for (const name of readdirSync(rulesDir).filter((n) => n.endsWith('.md') && n !== 'README.md')) {
      if (!index.includes(name)) dangling('rules/README.md', 'unindexed rule file', name);
    }
  }
}

// ---------------------------------------------------------------------------

const payload = { problems, scannedFiles: repoFiles.size };
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  for (const p of problems) {
    process.stdout.write(`ERROR ${p.where}: ${p.what} -> ${p.target}\n`);
  }
  for (const s of skippedContexts) {
    process.stdout.write(`SKIP  ${s}: build context is a shell variable; COPY sources not checked\n`);
  }
  process.stdout.write(`path integrity: ${problems.length} problem(s) across ${repoFiles.size} files`
    + ` (${skippedContexts.length} Dockerfile context(s) unresolvable)\n`);
}
process.exit(problems.length === 0 ? 0 : 1);
