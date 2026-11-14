#!/usr/bin/env node
/**
 * Spec-to-workflow coverage, checked by reading the files that actually run.
 *
 * Why this exists. A spec that is correct but referenced by no workflow provides no CI
 * guarantee, and nothing in the repository noticed that: `tests/ui/g11-incident-slice.spec.ts`
 * asserted two behaviours that were broken on `main` for want of a run. A file count, a test
 * count or "the spec is in the repo" cannot distinguish that from a real gate; only the command
 * line of a workflow can.
 *
 * What it reads, and what it deliberately does not guess:
 *   - every `*.spec.ts` under tests/ui  -> the file inventory;
 *   - every `*.sh` under tests/         -> named, so a script that only calls other scripts is
 *                                          followed one level (g12_acceptance_ci.sh -> g12_*.sh);
 *   - every workflow under .github/workflows -> its `run:` blocks and its `paths:` filters.
 *
 * The verdict per spec is one of:
 *   COVERED        named on the command line of a harness or workflow that runs it
 *   EXPLICIT_SKIP  present in the tree and named by NOBODY, but listed in KNOWN_UNRUN below
 *                  with a reason and an owner. This is the only way to silence the check, and
 *                  the list is meant to shrink.
 *   NOT_REFERENCED present, correct or not, and no workflow would ever execute it.
 *
 * It also checks the other direction, which is the failure that let #24 need a second commit:
 * for each workflow, every input its job reads must be inside that workflow's `paths:` filters
 * for the event that triggers it. "The spec is wired in" and "editing the spec reruns the job"
 * are different claims, and only the second one keeps a gate alive.
 *
 * Usage: node tests/ci/check-spec-coverage.mjs [--json]
 * Exit 0 when every spec is COVERED or EXPLICIT_SKIP and no workflow reads an input it would not
 * be triggered by; exit 1 with the named gaps otherwise.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const ROOT = process.cwd();
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const UI = join(ROOT, 'tests', 'ui');

/**
 * Specs that exist, would run if invoked, and are invoked by nothing. Each entry is a decision
 * with a reason, not a parking space: the check fails if one of these is actually covered (a
 * stale excuse), and a new unreferenced spec without an entry fails the check.
 */
const KNOWN_UNRUN = new Map([
  ['b1-visual-review.spec.ts', 'G01 design-review capture only; its assertions are historical and were superseded by ui-table-audit + the V3 matrix.'],
  ['b2-job-detail-longid.spec.ts', 'G08 batch B long-id audit; the behaviour it measured is now asserted by ui-table-audit.spec.ts.'],
  ['b3-b4-audit.spec.ts', 'G08 batch B/C audit harness; kept as a measurement tool, run by hand against staging.'],
  ['b4-remaining.spec.ts', 'G08 batch B remainder; superseded by admin-polish.spec.ts for the pages it shares.'],
  ['b5-probe.spec.ts', 'A probe, not a test: it prints measurements and asserts nothing.'],
  ['b5-visual-matrix.spec.ts', 'V3 before/after capture harness; run by hand with V3_OUT, never gating.'],
  ['g12r2-compare.spec.ts', 'G12 R2 before/after capture; needs the R2 seed and a browser matrix, captured once as evidence.'],
  ['g12r2-matrix.spec.ts', 'G12 R2 28-combination matrix; same seed requirement, recorded in its design note.'],
  ['g12r2-states.spec.ts', 'G12 R2 state capture; superseded in CI by g12d-workspace + the investigation panel assertions.'],
  ['g12r2-races.spec.ts', 'G12 R2 race capture; its R4 case needs two concurrent suites against one kernel, which no CI host arranges.'],
  ['incidents-workspace.spec.ts', 'G12 D layout capture; the same geometry is asserted by g12d-workspace.spec.ts in CI.'],
  ['permission-consistency.spec.ts', 'Cross-surface permission capture; superseded by dual-surface + g12-create-gate for the create path.'],
  ['g12d-probe.spec.ts', 'A probe used while building the D workspace spec; asserts nothing.'],
  ['g11-viewer-write-entries.spec.ts', 'ADR section 4.5 guard; needs its own record fixture and is run by hand with g11-incident-slice.'],
  ['g14-css-fix-evidence.spec.ts', 'Evidence capture for the 2026-11-09 token fixes; needs the live local stack (Kernel + enqueued nodes + a logged-in admin) and its value is the two committed screenshots, not a CI assertion.'],
  // The visual-audit rounds (V3..V10) are evidence instruments, not product regressions: each
  // captured a before/after pair with an env-selected output folder and a seed this repository's
  // CI does not build. They are kept because they are the measurement, and the behaviour they
  // were measuring has since moved into ui-table-audit / admin-polish / the responsive spec.
  ['ui-verbs-v6.spec.ts', 'V6 control-surface audit; its row-verb assertions moved to admin-polish.spec.ts.'],
  ['v5-acceptance.spec.ts', 'V5 interaction-state capture pack; superseded by admin-polish state matrix.'],
  ['v5-remediation.spec.ts', 'V6 remediation evidence capture; evidence only, asserts the round it documents.'],
  ['v7-structural.spec.ts', 'V7 structural measurement at reported viewports; superseded by g11-page-header-growth + the responsive spec.'],
  ['v8-debt-closeout.spec.ts', 'V8 close-out measurement of three debts; evidence instrument.'],
  ['v10-declutter.spec.ts', 'V10 before/after instrument for the declutter round; evidence only.'],
  ['visual-v3-flagship.spec.ts', 'V3 flagship audit, MODE=before|after capture; needs the V3 seed + branded Chrome.'],
  ['visual-v4-audit.spec.ts', 'V4 audit, V4_TAG-selected capture; same seed requirement.'],
]);

/** Read a file, or '' when it is missing (a workflow may reference a path this checkout lacks). */
const read = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };

/**
 * Every spec file under tests/ui, recursively, as a path relative to tests/ui.
 *
 * Recursive because a spec in a subdirectory is still a spec: the first version read only the
 * top level and would have reported a nested spec as "0 unreferenced" without ever looking at it.
 */
function listSpecs(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(join(dir, prefix || '.'))) {
    const rel = prefix ? prefix + '/' + name : name;
    const full = join(dir, rel);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) out.push(...listSpecs(dir, rel));
    else if (name.endsWith('.spec.ts')) out.push(rel);
  }
  return out;
}

/** Every spec file in tests/ui, by path relative to that directory. */
const specFiles = listSpecs(UI).sort();

/**
 * Only lines that INVOKE a runner count.
 *
 * This is the whole point of the checker, and the first version got it wrong in the same way it
 * was built to catch: it searched the raw workflow text, so a `paths:` filter entry, a step
 * `name:`, an echo string, or a comment that happened to contain `foo.spec.ts` counted as "this
 * workflow runs foo.spec.ts". Measured: with every real `playwright test … visual-layout.spec.ts`
 * removed, the checker still reported COVERED because the path filter the same commit added
 * named the file.
 *
 * A line counts when it contains a runner invocation AND the spec. `playwright test` may span
 * several lines through backslash continuations, so a continuation is folded into its command
 * first. Comments are dropped, whole-line and trailing.
 */
const RUNNER = /\b(playwright\s+test|npx\s+playwright\s+test|pnpm\b[^\n]*\bplaywright\s+test|yarn\s+playwright\s+test)\b/;

/**
 * The bodies of a workflow's `run:` steps, and nothing else.
 *
 * Reading the whole YAML is what let a `paths:` filter entry count as an execution: the first
 * version scanned the file, so adding `- 'tests/ui/v.spec.ts'` to a path filter made the checker
 * report the spec as covered even after every real invocation was deleted. A `paths:` entry is a
 * TRIGGER, not a command; only `run:` text and step `with:`/`env:` values could ever execute
 * something, and only `run:` does. Measured on this tree: with the real invocations removed and
 * the path filter left, the whole-file scan still printed COVERED.
 */
function runBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const start = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!start) continue;
    const indent = start[1].length + (lines[i].trimStart().startsWith('- run:') ? 2 : 0);
    const inline = start[2];
    if (inline && !/^[|>]/.test(inline)) {
      out.push(inline.trim());
      continue;
    }
    // Block scalar (`run: |` / `run: >`) or the next lines indented deeper than `run:`.
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim()) { out.push(''); continue; }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent && !/^\s*-/.test(line)) break;
      if (lineIndent < indent) break;
      out.push(line);
    }
  }
  return out.join('\n');
}

/** Every non-comment command line, continuations folded. Used for workflow `run:` blocks. */
function commandLines(text) {
  const lines = text.split('\n').filter((line) => !/^\s*#/.test(line)).map((line) => line.replace(/\s+#.*$/, ''));
  const folded = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    while (/\\\s*$/.test(line) && i + 1 < lines.length) {
      line = line.replace(/\\\s*$/, ' ') + lines[i + 1].trim();
      i += 1;
    }
    folded.push(line);
  }
  return folded;
}

/** Command lines that actually invoke a test runner. Used for harness bodies only. */
function invocations(text) {
  return commandLines(text).filter((line) => RUNNER.test(line));
}

const harnessFiles = new Map(); // basename -> invocation lines of that .sh
for (const dir of ['tests/ci', 'tests/acceptance']) {
  let names = [];
  try { names = readdirSync(join(ROOT, dir)); } catch { continue; }
  for (const name of names) {
    if (name.endsWith('.sh')) harnessFiles.set(name, invocations(read(join(ROOT, dir, name))));
  }
}

/**
 * Every invocation line a workflow would execute, following harness indirection as far as it
 * actually goes (workflow -> a.sh -> b.sh -> spec) rather than exactly one level.
 *
 * Returns { files, lines }: the harness files reached, and every invocation line from the
 * workflow's own `run:` blocks plus those harnesses.
 */
function workflowCommands(name) {
  // Two kinds of line, deliberately: a WORKFLOW line may be `bash tests/ci/x.sh` (not a runner
  // invocation), while a HARNESS line must be a runner invocation. Folding both into one
  // `invocations()` call made every harnessed spec look unreferenced - the harness call was
  // dropped before its body was ever read.
  const own = commandLines(runBlocks(read(join(WORKFLOWS, name))));
  const reached = new Set();
  let frontier = own;
  // A harness is reached when a line names it in a CALL position (start, `bash`, `sh`, `.`, or a
  // path), not when it appears in an echo or a comment.
  const harnessCall = (line) =>
    [...harnessFiles.keys()].filter((harness) => {
      const escaped = harness.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[\\s;&|(])(?:\\.|bash|sh|source)?\\s*(?:\\S*/)?${escaped}(?=\\s|$)`).test(line);
    });
  for (let depth = 0; depth < 4 && frontier.length; depth += 1) {
    const next = [];
    for (const line of frontier) {
      for (const harness of harnessCall(line)) {
        if (reached.has(harness)) continue;
        reached.add(harness);
        next.push(...harnessFiles.get(harness));
      }
    }
    frontier = next;
  }
  return { files: [...reached], lines: own.concat([...reached].flatMap((h) => harnessFiles.get(h))) };
}

const workflows = readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml')).sort();
const commandsByWorkflow = new Map(workflows.map((name) => [name, workflowCommands(name)]));

/**
 * Whether an invocation line runs a spec. Matched on the file name as a word, so
 * `data-foundation.spec.ts` is not satisfied by `data-foundation-flows.spec.ts`.
 */
function lineRuns(line, spec) {
  const base = spec.split('/').pop();
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The name must START at a token boundary and must not CONTINUE into a longer file name.
  // Trailing context is deliberately any non-name character: a spec is followed by `\`, `)`,
  // `|`, a quote, or end of line depending on how the command was written, and enumerating
  // those spellings is how the first version dropped a spec that was plainly on the line.
  return new RegExp(`(^|[\\s'"/])${escaped}(?![\\w.-])`).test(line);
}

const coveredBy = new Map(specFiles.map((spec) => [spec, []]));
for (const [workflow, { lines }] of commandsByWorkflow) {
  for (const spec of specFiles) {
    if (lines.some((line) => RUNNER.test(line) && lineRuns(line, spec))) coveredBy.get(spec).push(workflow);
  }
}

/** The `paths:` of the event that runs the workflow, for the workflow-level input check. */
function triggerPaths(workflow) {
  const text = read(join(WORKFLOWS, workflow));
  const paths = [];
  // Both `push:` and `pull_request:` blocks; a path list ends at the next dedented key.
  for (const event of ['push', 'pull_request']) {
    const start = text.indexOf(`\n  ${event}:`);
    if (start < 0) continue;
    const rest = text.slice(start + 1);
    const end = rest.search(/\n  [a-z_]+:/);
    const block = end < 0 ? rest : rest.slice(0, end);
    // `paths:` must START a line: `branches: [main]` contains the substring and would otherwise
    // make the parser read a block that has no path list at all.
    const match = /^\s{2,}paths:\s*$/m.exec(block);
    if (!match) continue;
    const listStart = match.index;
    for (const line of block.slice(listStart).split('\n').slice(1)) {
      const m = /^\s*-\s*'?"?([^'"\n]+?)'?"?\s*$/.exec(line);
      if (m) paths.push({ event, pattern: m[1] });
      else if (/^\s*[a-z_]+:/.test(line) && !/^\s*-\s/.test(line)) break;
    }
  }
  return paths;
}

/**
 * Inputs a workflow depends on beyond the paths it filters on. These are declared by hand because
 * they cannot be derived from YAML: a job's command line names `tests/ui/x.spec.ts`, but nothing
 * in the YAML says that file `import`s `tests/ui/support/accounts.ts`.
 */
const IMPLICIT_INPUTS = {
  'g12-acceptance.yml': ['tests/ui/support/', 'tests/ui/playwright.config.ts', 'tests/ci/g12_acceptance_ci.sh', 'tests/ui/g12d-seed.mjs'],
  'staging-preview.yml': ['tests/ui/support/', 'tests/ui/playwright.config.ts', 'scripts/deploy-staging.sh', 'scripts/ci-ssh-setup.sh'],
  'ci.yml': ['tests/ci/check-tracked-png-budget.mjs', 'tests/ci/tracked-png-budget.json'],
};

function covered(pattern, path) {
  if (pattern.endsWith('/')) return path.startsWith(pattern) || path.includes(pattern);
  if (pattern.includes('*')) {
    const re = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '$');
    return re.test(path);
  }
  return path === pattern || path.startsWith(pattern);
}

const coverage = specFiles.map((spec) => {
  const by = coveredBy.get(spec);
  if (by.length > 0) {
    if (KNOWN_UNRUN.has(spec)) {
      return { spec, status: 'STALE_EXCUSE', workflows: by, note: 'listed as unrun but a workflow names it' };
    }
    return { spec, status: 'COVERED', workflows: by };
  }
  if (KNOWN_UNRUN.has(spec)) return { spec, status: 'EXPLICIT_SKIP', workflows: [], note: KNOWN_UNRUN.get(spec) };
  return { spec, status: 'NOT_REFERENCED', workflows: [] };
});

const inputGaps = [];
for (const workflow of workflows) {
  const paths = triggerPaths(workflow);
  if (paths.length === 0) continue; // triggered on every push/pull_request: nothing to miss
  const inputs = new Set();
  const { lines: wfLines } = commandsByWorkflow.get(workflow);
  for (const spec of specFiles) {
    if (wfLines.some((line) => RUNNER.test(line) && lineRuns(line, spec))) inputs.add('tests/ui/' + spec);
  }
  for (const extra of IMPLICIT_INPUTS[workflow] ?? []) inputs.add(extra);
  // Per EVENT, not "any event covers it". A workflow that runs a spec on pull_request but whose
  // `push` paths omit it will not run on main when that spec changes, and "some event covers it"
  // reported that as clean - the exact shape of the gap this check exists for.
  const events = [...new Set(paths.map((p) => p.event))];
  for (const input of inputs) {
    for (const event of events) {
      const eventPaths = paths.filter((p) => p.event === event);
      if (!eventPaths.some(({ pattern }) => covered(pattern, input))) {
        inputGaps.push({ workflow, input, event });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Signal-safety scan.
//
// A shell script that runs `kill -9 "${PID:-0}"` on an empty variable does not
// "kill nothing": `${X:-0}` expands to the STRING `0`, and pid `0` means the
// caller's own PROCESS GROUP. Measured: such a script never executes its next
// statement - it dies with SIGKILL (exit 137) and every background child dies
// with it.
//
// This is not hypothetical. Nine copies of that line in
// `tests/acceptance/pipeline_long_heartbeat_negatives.sh` cost eight CI runs on
// 2026-11-14. Each ran 55-60 minutes and ended with "The hosted runner lost
// communication with the server", so the job looked like a 60-minute timeout.
// On a GitHub runner the step shell's process group holds the runner's
// communication process, which is what "lost communication" was reporting.
//
// The scan is about the SHAPE, not that one file: any `${VAR:-FALLBACK}` whose
// expansion reaches `kill` or `wait` is flagged when the fallback is non-empty,
// because a fallback the caller did not verify is a pid the caller did not
// spawn. A bare literal `kill 0` is flagged too.
const SIGNAL_TARGET = /\b(kill|wait)\s+(?:-\S+\s+)*"?\$\{(\w+):-([^}]*)\}/g;
const LITERAL_GROUP = /\bkill\s+(?:-\S+\s+)*0\s*(?:$|[;&|])/;
const SIGNAL_SAFETY = [];

function scanSignalSafety(dir) {
  let entries;
  try { entries = readdirSync(join(ROOT, dir), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) { scanSignalSafety(rel); continue; }
    if (!entry.name.endsWith('.sh')) continue;
    const text = read(join(ROOT, rel));
    if (!text) continue;
    text.split('\n').forEach((line, i) => {
      // Comments are stripped, because this repository explains the defect in
      // prose and a gate that flags its own documentation gets switched off.
      const code = line.replace(/#.*$/, '');
      if (!code.trim()) return;
      SIGNAL_TARGET.lastIndex = 0;
      let m;
      while ((m = SIGNAL_TARGET.exec(code)) !== null) {
        const [, verb, name, fallback] = m;
        // `${X:-}` expands to nothing; `kill` then errors, which is loud and
        // harmless. Only a non-empty fallback can name a process that is not
        // this script's child.
        if (fallback === '') continue;
        SIGNAL_SAFETY.push({
          file: rel,
          line: i + 1,
          text: code.trim(),
          reason:
            fallback === '0'
              ? `\${${name}:-0} expands to 0, and \`${verb} 0\` signals the caller's whole process group`
              : /^-?\d+$/.test(fallback)
                ? `\${${name}:-${fallback}} can expand to pid ${fallback}, which is not this script's child`
                : `\${${name}:-${fallback}} is a pid the script never verified`,
        });
      }
      if (LITERAL_GROUP.test(code)) {
        SIGNAL_SAFETY.push({
          file: rel, line: i + 1, text: code.trim(),
          reason: '`kill 0` signals the caller\'s whole process group',
        });
      }
    });
  }
}
scanSignalSafety('tests/acceptance');
scanSignalSafety('tests/ci');
scanSignalSafety('scripts');

const asJson = process.argv.includes('--json');
const failing = coverage.filter((row) => row.status === 'NOT_REFERENCED' || row.status === 'STALE_EXCUSE');
if (asJson) {
  console.log(JSON.stringify({ coverage, inputGaps, signalSafety: SIGNAL_SAFETY }, null, 2));
} else {
  const label = { COVERED: 'ok  ', EXPLICIT_SKIP: 'skip', NOT_REFERENCED: 'FAIL', STALE_EXCUSE: 'FAIL' };
  for (const row of coverage) {
    console.log(
      `${label[row.status]} ${row.spec.padEnd(40)} ${row.status}` +
      (row.workflows.length ? ' <- ' + row.workflows.join(', ') : '') +
      (row.note ? '  (' + row.note + ')' : ''),
    );
  }
  console.log('');
  for (const gap of inputGaps) {
    console.log(`FAIL ${gap.workflow} runs ${gap.input} but its ${gap.event} paths do not include it`);
  }
  const coveredCount = coverage.filter((r) => r.status === 'COVERED').length;
  console.log('');
  console.log(`spec coverage: ${coveredCount} covered, ${coverage.length - coveredCount - failing.length} explicit-skip, ${failing.length} unreferenced`);
  console.log('');
  if (SIGNAL_SAFETY.length) {
    console.log(`signal safety: ${SIGNAL_SAFETY.length} place(s) can signal a pid the script did not spawn:`);
    for (const r of SIGNAL_SAFETY) {
      console.log(`FAIL ${r.file}:${r.line}  ${r.reason}`);
      console.log(`     ${r.text}`);
    }
  } else {
    console.log('signal safety: no unverified pid reaches kill or wait');
  }
}
// `process.exitCode`, not `process.exit()`: with --json the whole report goes to stdout, and an
// immediate exit truncates a piped write (the run hung instead of printing, which a CI job would
// read as a hung checker rather than a failing one).
process.exitCode =
  failing.length === 0 && inputGaps.length === 0 && SIGNAL_SAFETY.length === 0 ? 0 : 1;
