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
  ['observability-surface.spec.ts', 'Observability console capture suite; the surface has no CI seed in this repository yet.'],
  ['permission-consistency.spec.ts', 'Cross-surface permission capture; superseded by dual-surface + g12-create-gate for the create path.'],
  ['sources-audit.spec.ts', 'Sources surface capture; same as observability - no seed in CI.'],
  ['g12d-probe.spec.ts', 'A probe used while building the D workspace spec; asserts nothing.'],
  ['g11-viewer-write-entries.spec.ts', 'ADR section 4.5 guard; needs its own record fixture and is run by hand with g11-incident-slice.'],
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

/** Every spec file in tests/ui, by basename. */
const specFiles = readdirSync(UI).filter((name) => name.endsWith('.spec.ts')).sort();

/**
 * Command lines that would run a spec: every `run:` block, plus the text of every harness a
 * run block calls. A spec named only in a comment does not count - which is the point, since a
 * commented-out line is exactly how g11-incident-slice.spec.ts looked before #24.
 */
function commandText(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))   // comments, whole-line
    .map((line) => line.replace(/\s+#.*$/, '')) // and trailing
    .join('\n');
}

const harnessFiles = new Map(); // basename -> command text of that .sh
for (const dir of ['tests/ci', 'tests/acceptance']) {
  let names = [];
  try { names = readdirSync(join(ROOT, dir)); } catch { continue; }
  for (const name of names) {
    if (name.endsWith('.sh')) harnessFiles.set(name, commandText(read(join(ROOT, dir, name))));
  }
}

/** Where a workflow's own `run:` text plus the harnesses it invokes would execute a spec. */
function workflowCommands(name) {
  const text = commandText(read(join(WORKFLOWS, name)));
  const parts = [text];
  for (const [harness, body] of harnessFiles) {
    // The workflow invokes the harness by name; include the harness's own text then.
    if (new RegExp(`(^|[\\s/])${harness.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(text)) {
      parts.push(body);
    }
  }
  return parts.join('\n');
}

const workflows = readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml')).sort();
const commandsByWorkflow = new Map(workflows.map((name) => [name, workflowCommands(name)]));

const coveredBy = new Map(specFiles.map((spec) => [spec, []]));
for (const [workflow, commands] of commandsByWorkflow) {
  for (const spec of specFiles) {
    if (commands.includes(spec)) coveredBy.get(spec).push(workflow);
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
  for (const spec of specFiles) {
    if (commandsByWorkflow.get(workflow).includes(spec)) inputs.add('tests/ui/' + spec);
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

const asJson = process.argv.includes('--json');
const failing = coverage.filter((row) => row.status === 'NOT_REFERENCED' || row.status === 'STALE_EXCUSE');
if (asJson) {
  console.log(JSON.stringify({ coverage, inputGaps }, null, 2));
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
}
// `process.exitCode`, not `process.exit()`: with --json the whole report goes to stdout, and an
// immediate exit truncates a piped write (the run hung instead of printing, which a CI job would
// read as a hung checker rather than a failing one).
process.exitCode = failing.length === 0 && inputGaps.length === 0 ? 0 : 1;
