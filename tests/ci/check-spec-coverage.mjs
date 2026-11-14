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
 * Every shell test under tests/, treated the same way as a spec.
 *
 * The checker used to look only at `*.spec.ts`, so a shell acceptance script
 * could be written, committed and never executed by anything. That is not a
 * hypothetical: `tests/ci/p001_execstoppost_ownership.sh` carries 34 assertions
 * for a P0 container-ownership fix and **no workflow ran it** until
 * `platform-linux-acceptance.yml` was given the step.
 *
 * The same three verdicts apply. `KNOWN_UNRUN_SHELL` is the only way to silence
 * one, and it wants a reason and a better home.
 */
const SHELL_TEST_DIRS = [join(ROOT, 'tests', 'acceptance'), join(ROOT, 'tests', 'ci')];
function listShell(dir) {
  let out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory()) continue;
    if (!name.endsWith('.sh')) continue;
    // `_`-prefixed and `demo_` files are libraries sourced by other scripts, and
    // `start_`/`build-` files are fixtures. They are not tests and cannot be
    // "run" on their own.
    if (/^(_|demo_|start_)/.test(name)) continue;
    out.push(join(dir, name));
  }
  return out;
}
const shellTests = SHELL_TEST_DIRS.flatMap(listShell).sort();

/**
 * Whether a command line EXECUTES a shell test.
 *
 * `bash path/x.sh`, `sh path/x.sh`, `./path/x.sh`, or the bare path when it is
 * the whole command. A `paths:` filter entry, a `name:`, or a comment naming the
 * same file must not count - the same distinction `lineRuns` makes for specs,
 * which the checker's own history says is easy to get wrong.
 */
function shellInvokes(line, spec) {
  const base = spec.split('/').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const trimmed = line.trim();
  if (trimmed.startsWith('#')) return false;
  // Must be preceded by an interpreter, a path separator, or start-of-token.
  const re = new RegExp(`(^|[\\s'"])(bash|sh|\\./)?[^\\s'"]*/?${base}(?![\\w.-])`);
  const m = re.exec(trimmed);
  if (!m) return false;
  // Reject a line that merely lists the path inside a YAML `paths:` filter.
  if (/^\s*-\s*['"]?(tests|scripts)\//.test(trimmed)) return false;
  return true;
}

const KNOWN_UNRUN_SHELL = new Map([
  // Every entry was opened and read. A reason here says the script is kept
  // deliberately and why it cannot run in this repository's CI today; it is not
  // a way to silence a red check.
  //
  // Group A - needs a live platform the script starts and tears down itself, and
  // a job that can give it one end to end. `plugin-lifecycle.yml` already runs
  // the TypeScript lifecycle for ~20 minutes; adding eight more full-platform
  // boots there would exceed the job timeout, so these stay manual until a
  // separate job exists.
  ['auth_limits.sh', 'needs a running platform (auth_limits starts its own); no job boots one for it'],
  ['d5_workspace_scope.sh', 'needs a running platform with data plugins; manual'],
  ['endpoint_policy.sh', 'needs a running platform; manual'],
  ['incident_slice_api.sh', 'needs a running platform with the incident slice seeded; manual'],
  ['kernel_restart.sh', 'needs a running platform it restarts itself; manual'],
  ['permission_matrix.sh', 'needs three live sessions (admin/operator/viewer); manual'],
  ['publisher_revocation.sh', 'needs a running platform with a signed publisher; manual'],
  ['p001c123_reinit_recovery.sh', 'needs a running platform and a fresh enrolment token; manual'],
  ['p001c124_migration_identity.sh', 'needs a running platform and a fresh enrolment token; manual'],

  // Group B - needs Docker and a daemon no other workload shares.
  ['node_lease.sh', 'destructive to the local demo state; needs its own daemon'],
  ['node_quarantine.sh', 'destructive to the local demo state; needs its own daemon'],
  ['node_revocation.sh', 'destructive to the local demo state; needs its own daemon'],
  ['two_node_failover.sh', 'needs two Nodes and a daemon it can partition; manual'],
  ['p001c121_demo_safety.sh', 'destructive to the local demo state by design; manual'],
  ['p001c121_data_foundation_scope.sh', 'refuses to run when any OpsWeave container exists; needs a dedicated daemon'],
  ['p001c_isolation_guard.sh', 'plants a foreign container and attacks the harness; needs a dedicated daemon'],

  // Group C - needs a database or a live platform, but not a Docker daemon.
  ['container_security.sh', 'inspects containers the platform created; needs a running platform'],
  ['storage_migration_ledger.sh', 'needs a PostgreSQL database it migrates; manual'],
  ['p001c122_clone_node_identity.sh', 'needs a running platform and a fresh enrolment token; manual'],
  ['p001c_rollback_states.sh', 'asserts the rollback state machine against a live platform; manual'],
]);

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

// Harness index, keyed by REPO-RELATIVE path.
//
// It used to be keyed by basename (`harnessFiles.set(name, …)`). That is correct
// only while no two harnesses share a name - and nothing enforces that, because
// the moment somebody adds `tests/ci/foo.sh` next to `tests/acceptance/foo.sh`,
// one entry silently replaces the other and a spec invoked only by the
// overwritten one starts reading as covered. Measured as a latent defect: there
// are no duplicate basenames today, so no behaviour changes, but the checker
// would have reported coverage it had not established rather than failing.
//
// With relative paths the question "does this line run that harness" is exact:
// the line must name the path, or name the basename AND be unambiguous.
const harnessFiles = new Map(); // repo-relative path -> invocation lines
const harnessByBase = new Map(); // basename -> [relative paths]
for (const dir of ['tests/ci', 'tests/acceptance']) {
  let names = [];
  try { names = readdirSync(join(ROOT, dir)); } catch { continue; }
  for (const name of names) {
    if (!name.endsWith('.sh')) continue;
    const rel = `${dir}/${name}`;
    harnessFiles.set(rel, invocations(read(join(ROOT, dir, name))));
    if (!harnessByBase.has(name)) harnessByBase.set(name, []);
    harnessByBase.get(name).push(rel);
  }
}
// A duplicate basename would make bare-name matching ambiguous, so say it out
// loud instead of resolving it silently in someone's favour.
const ambiguousHarnessNames = [...harnessByBase.entries()]
  .filter(([, paths]) => paths.length > 1)
  .map(([name, paths]) => ({ name, paths }));

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
  const queued = new Set();
  let frontier = own;

  // Which harnesses a line calls.
  //
  // A full path in the line wins outright (`tests/ci/foo.sh`). A bare basename is
  // accepted only when exactly one harness has that name; when two do, the line
  // is ambiguous and names NEITHER, because guessing is how a spec reads as
  // covered by a harness nobody ran.
  const harnessCall = (line) => {
    const found = [];
    for (const [rel, ] of harnessFiles) {
      const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const base = rel.split('/').pop();
      const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const callPrefix = '(^|[\\s;&|(])(?:\\.|bash|sh|source)?\\s*';
      // Full relative path, or any path ending in it (`$ROOT/tests/ci/x.sh`).
      const byPath = new RegExp(`${callPrefix}(?:\\S*/)?${escaped}(?=\\s|$)`).test(line);
      let byBase = false;
      if (!byPath && (harnessByBase.get(base) || []).length === 1) {
        byBase = new RegExp(`${callPrefix}(?:\\S*/)?${escapedBase}(?=\\s|$)`).test(line);
      }
      if (byPath || byBase) found.push(rel);
    }
    return found;
  };

  // Traversal is bounded by the VISITED set, not by a depth counter. A fixed
  // depth of 4 silently stopped looking after four levels of harness -> harness
  // -> harness, and the failure mode was the worst kind: the deeper specs simply
  // read as unreferenced, or - worse, once an excuse list existed - as excused.
  // `reached` doubles as the cycle guard, so a harness that sources itself
  // terminates instead of recursing.
  let deferred = [];
  for (const line of frontier) {
    for (const harness of harnessCall(line)) {
      if (reached.has(harness) || queued.has(harness)) continue;
      queued.add(harness);
      deferred.push(harness);
    }
  }
  while (deferred.length) {
    const harness = deferred.shift();
    reached.add(harness);
    for (const line of harnessFiles.get(harness)) {
      for (const nested of harnessCall(line)) {
        if (reached.has(nested) || queued.has(nested)) continue;
        queued.add(nested);
        deferred.push(nested);
      }
    }
  }
  return {
    files: [...reached],
    lines: own.concat([...reached].flatMap((h) => harnessFiles.get(h))),
  };
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

/**
 * Whether a HARNESS BODY line actually executes another script.
 *
 * `lineRuns` alone answers "is this name on the line", which is the right
 * question for a workflow `run:` block (the whole block is a shell script) and
 * the wrong one for a harness body, where most lines are not statements at all.
 * Measured: replacing a real call in `data_foundation_ci.sh` with
 *
 *     echo "would run tests/acceptance/data_authz.sh"
 *
 * left the checker reporting `data_authz.sh COVERED` and exiting 0. The script
 * was covered by an echo. Comments were already stripped; `echo`, `printf`,
 * `note …` and similar were not.
 *
 * So: strip comments and quoted strings that are pure display, then require the
 * name to appear in a command position - at the start of a statement, after a
 * `;`/`&&`/`||`/`|`, or after an interpreter - rather than anywhere on the line.
 */
const DISPLAY_ONLY = /^\s*(echo|printf|note|log|say|warn|info|debug|:)(\s|$)/;
function harnessLineRuns(line, spec) {
  const base = spec.split('/').pop();
  const code = line.replace(/^\s*#.*$/, '').replace(/\s+#.*$/, '').trim();
  if (!code) return false;
  // A statement that only PRINTS the name is not running it. This is the check
  // that matters: the mutation that motivated it was
  // `echo "would run tests/acceptance/data_authz.sh"`, which the previous
  // "name appears anywhere on the line" rule accepted as coverage.
  if (DISPLAY_ONLY.test(code)) return false;

  // Split the line into the individual simple commands it contains, then ask
  // whether one of them INVOKES the script. Written as a split rather than one
  // large regular expression because the regex version kept mis-parsing its own
  // alternation - a `\.` in the `bash|sh|source|.` branch matched the dot in a
  // path, so every line read as "not a command" and 33 covered scripts were
  // reported as gaps.
  // Peel the OUTER layer before splitting. A line like
  //
  //     if ! RUN_ID="$(tests/ci/p001c_up.sh 2>"$UP_LOG" | sed … | tail -1)"; then
  //
  // contains pipes INSIDE the command substitution, so splitting first cut the
  // invocation into `RUN_ID="$(tests/ci/p001c_up.sh 2>"$UP_LOG"` and three
  // fragments, and none of them looked like a command. The capture assignment is
  // stripped first, which leaves the substituted command as its own segment.
  const prepared = code
    .replace(/^(?:if|then|else|elif|while|until|do|time|!)\s+/, '')
    .replace(/^(?:if|then|else|elif|while|until|do|time|!)\s+/, '')
    .replace(/^[A-Za-z_][A-Za-z0-9_]*="?\$\(\s*/, '')
    .replace(/^[A-Za-z_][A-Za-z0-9_]*=\$\(\s*/, '');

  const commands = prepared
    .split(/;|&&|\|\||\|/)
    .map((c) => c.trim())
    .filter(Boolean);

  const isInvocation = (cmd) => {
    // Strip statement keywords and `!`, then leading VAR=value assignments.
    let rest = cmd;
    let before;
    do {
      before = rest;
      rest = rest
        .replace(/^(?:if|then|else|elif|while|until|do|time|!)\s+/, '')
        .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, '')
        // `RUN_ID="$(tests/ci/p001c_up.sh …)"` - a command substitution whose
        // output is captured. This is how the p001c harnesses start the
        // platform, and without this branch the file read as uncovered.
        .replace(/^[A-Za-z_][A-Za-z0-9_]*="?\$\(\s*/, '')
        .replace(/^[A-Za-z_][A-Za-z0-9_]*=\$\(\s*/, '');
    } while (rest !== before);
    rest = rest.trim();

    // `bash path`, `sh path`, `source path`, `. path`
    const viaInterpreter = rest.match(/^(?:bash|sh|source|\.)\s+(\S+)/);
    const subject = viaInterpreter ? viaInterpreter[1] : rest.split(/\s+/)[0];
    if (!subject) return false;
    // The script is the command word. A bare basename is accepted only when no
    // other harness shares it; otherwise the command word must end with the
    // whole relative path, so `tests/ci/dup/data_authz.sh` does NOT count as
    // running `tests/acceptance/data_authz.sh`. Measured: with a plain basename
    // comparison, planting a same-named file in another directory made the real
    // one read as covered while the call named the copy.
    const scriptWord = subject.replace(/["']/g, '');
    const uniqueBase = (harnessByBase.get(base) || []).length <= 1;
    if (scriptWord === spec || scriptWord.endsWith('/' + spec)) return true;
    if (uniqueBase && (scriptWord === base || scriptWord.endsWith('/' + base))) return true;

    // A path passed as an ARGUMENT to a documented runner, which then executes it:
    //     run_acceptance ai-investigator  tests/acceptance/g12_ai_investigator.sh
    //     tests/ci/run_step.sh data_authz 180 -- tests/acceptance/data_authz.sh
    const RUNNER_WITH_PATH_ARG = /(?:^|\/)(?:run_acceptance|run_step\.sh)$/;
    if (RUNNER_WITH_PATH_ARG.test(scriptWord)) {
      return rest.split(/\s+/).some((tok) => {
        const t = tok.replace(/["']/g, '');
        return t === base || t.endsWith('/' + base);
      });
    }
    return false;
  };
  return commands.some(isInvocation);
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

// ---- collection-time safety -------------------------------------------------
//
// A spec that reads a file at MODULE SCOPE crashes Playwright's collection phase
// when that file is absent, and the run reports `Total: 0 tests in 0 files`.
// Measured on this tree: nine specs do exactly that, and
// `pnpm --filter @opsweave/ui-tests exec playwright test` with no file argument
// collects nothing at all while exiting 1.
//
// That is worse than a failing test. A job that runs `playwright test <file>`
// is unaffected, but any job that relies on collecting the directory sees an
// empty suite - and an empty suite is not a passing one.
//
// The check is deliberately narrow: `readFileSync`/`readFileSync`-like calls on
// a line that is NOT inside a function body. Guarding with `existsSync` is
// allowed; moving the read into `test.beforeAll` is preferred.
const collectionRisks = [];
for (const spec of specFiles) {
  let body;
  try { body = readFileSync(join(UI, spec), 'utf8'); } catch { continue; }
  const lines = body.split('\n');
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    // Only TOP-LEVEL statements can run at collection time. A read inside any
    // function body (a test, a helper, beforeAll) is deferred and safe.
    const topLevel = depth === 0;
    // The shape of the statement does not matter; only WHERE it runs matters.
    // The previous rule required the line to start with `const|let|var`, so it
    // missed the three forms below and reported 5 risks where there are 7:
    //
    //     JSON.parse(readFileSync(CATALOG_DIR + locale + '.json', 'utf8'))
    //     fs.readFileSync(
    //       path.resolve(...),
    //
    // A trailing call and a call broken across lines are read at import time
    // exactly like an assignment, and they fail collection exactly the same way.
    // `import` lines are excluded because they are not reads, and comment lines
    // because they are not code.
    const isImport = /^\s*import\s/.test(line);
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
    if (topLevel && !isImport && !isComment && /(?:readFileSync|\breadFile)\s*\(/.test(line)) {
      // Where the read points decides whether it can break collection.
      //
      // A read of a file that ships IN THE REPOSITORY (an i18n catalog, a
      // committed fixture) cannot fail for a checkout that built the package -
      // so it is reported, but it is not the same hazard as a read of a path
      // that only exists after some earlier step wrote it. Treating both alike
      // reported 8 specs when 5 can actually break a bare `playwright test`,
      // and a warning list that is two-thirds noise is a list nobody reads.
      //
      // The test is on the SUBJECT of the read, which for the multi-line form
      // above sits on the following line, so look at a small window.
      const window = lines.slice(i, Math.min(i + 3, lines.length)).join(' ');
      const readsTempOrEnvPath =
        /\/tmp\//.test(window)
        || /process\.env\.[A-Z0-9_]+\s*\|\|/.test(window)
        || /OPSWEAVE_[A-Z0-9_]*(TAG|SEED|OUT|DIR|FILE|PATH)/.test(window);
      // A read whose result is guarded by existsSync in this file is reported
      // separately: it degrades a missing fixture instead of crashing.
      const guarded = /existsSync/.test(body);
      collectionRisks.push({
        spec,
        line: i + 1,
        text: trimmed.slice(0, 90),
        guarded,
        // Only this combination can stop a collection run.
        canBreakCollection: readsTempOrEnvPath && !guarded,
      });
    }
    depth += opens - closes;
    if (depth < 0) depth = 0;
  }
}

// ---- shell tests -----------------------------------------------------------
//
// Same question for `.sh`: does any workflow invoke this file, directly or
// through a harness that names it?
// Reachability from the workflows into the shell-test graph.
//
// The previous version asked exactly two questions per script: "does a workflow
// line run it" and "does any OTHER script run it, and does a workflow run that
// other script". That is one level of nesting. It happened to be enough for the
// tree it was written on, and it was wrong in both directions once anything
// nested deeper: measured, a chain harness -> h1 -> h2 -> … -> data_authz.sh
// reported every intermediate script AND the target as NOT_REFERENCED, because
// only the first hop was ever followed.
//
// This walks the graph from each workflow's own command lines until nothing new
// is reached, which is what "is this script executed by CI" actually means. The
// visited set makes cycles terminate.
const shellReachedBy = new Map(shellTests.map((f) => [f.replace(ROOT + '/', ''), new Set()]));
const shellTestSet = new Set(shellTests.map((f) => f.replace(ROOT + '/', '')));
const shellBodyCache = new Map();
function shellBody(rel) {
  if (!shellBodyCache.has(rel)) {
    let body = '';
    try { body = readFileSync(join(ROOT, rel), 'utf8'); } catch { /* unreadable: no outgoing edges */ }
    shellBodyCache.set(rel, body);
  }
  return shellBodyCache.get(rel);
}
// Which shell tests a line invokes, whether the line is a workflow `run:` line or
// a harness body line. `shellInvokes` is the workflow-line matcher (kept for its
// paths-filter rejection); `harnessLineRuns` is the body matcher.
function shellEdges(line, isWorkflowLine) {
  const out = [];
  for (const rel of shellTestSet) {
    const hit = isWorkflowLine
      ? shellInvokes(line, rel)
      : harnessLineRuns(line, rel);
    if (hit) out.push(rel);
  }
  return out;
}

for (const [workflow, { lines }] of commandsByWorkflow) {
  const seen = new Set();
  const queue = [];
  for (const line of lines) {
    for (const rel of shellEdges(line, true)) {
      if (!seen.has(rel)) { seen.add(rel); queue.push(rel); }
    }
  }
  while (queue.length) {
    const rel = queue.shift();
    shellReachedBy.get(rel).add(workflow);
    const body = shellBody(rel);
    if (!body) continue;
    for (const line of body.split('\n')) {
      for (const nested of shellEdges(line, false)) {
        if (!seen.has(nested)) { seen.add(nested); queue.push(nested); }
      }
    }
  }
}

const shellCoverage = shellTests.map((full) => {
  const rel = full.replace(ROOT + '/', '');
  const base = rel.split('/').pop();
  const by = [...(shellReachedBy.get(rel) || [])];
  if (by.length > 0) return { spec: rel, status: 'COVERED', workflows: by };
  if (KNOWN_UNRUN_SHELL.has(base)) return { spec: rel, status: 'EXPLICIT_SKIP', workflows: [], note: KNOWN_UNRUN_SHELL.get(base) };
  return { spec: rel, status: 'NOT_REFERENCED', workflows: [] };
});
const shellFailing = shellCoverage.filter((row) => row.status === 'NOT_REFERENCED');

const asJson = process.argv.includes('--json');
const failing = coverage.filter((row) => row.status === 'NOT_REFERENCED' || row.status === 'STALE_EXCUSE');
if (asJson) {
  console.log(JSON.stringify({ coverage, shellCoverage, inputGaps }, null, 2));
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
  const shellCovered = shellCoverage.filter((r) => r.status === 'COVERED').length;
  const shellLabel = { COVERED: 'ok  ', EXPLICIT_SKIP: 'skip', NOT_REFERENCED: 'FAIL' };
  for (const row of shellCoverage.filter((r) => r.status !== 'COVERED')) {
    console.log(`${shellLabel[row.status]} ${row.spec.padEnd(48)} ${row.status}${row.note ? '  (' + row.note + ')' : ''}`);
  }
  console.log(
    `shell coverage: ${shellCovered} covered, ${shellCoverage.length - shellCovered - shellFailing.length} explicit-skip, ${shellFailing.length} unreferenced`,
  );
  console.log('');
  // Two lists, because they are two different claims. `canBreakCollection` is
  // the one that matters: those reads point at a path that only exists after an
  // earlier step produced it, and a bare `playwright test` collects zero tests
  // when it is missing (measured: `Total: 0 tests in 0 files`, exit 1).
  const unguarded = collectionRisks.filter((r) => r.canBreakCollection);
  const repoReads = collectionRisks.filter((r) => !r.canBreakCollection);
  if (unguarded.length) {
    console.log(
      `collection risk: ${unguarded.length} spec(s) read a file in a top-level statement with no \`existsSync\` guard,` +
      ' so a bare `playwright test` collects nothing:',
    );
    for (const r of unguarded) console.log(`  ${r.spec}:${r.line}  ${r.text}`);
  } else {
    console.log('collection risk: none unguarded');
  }
  if (repoReads.length) {
    console.log(
      `collection note: ${repoReads.length} spec(s) read a repository file at module scope.`
      + ' Those files ship with the checkout, so they cannot break collection; listed for completeness:',
    );
    for (const r of repoReads) console.log(`  ${r.spec}:${r.line}  ${r.text}`);
  }
  if (ambiguousHarnessNames.length) {
    console.log('');
    console.log(
      `ambiguous harness names: ${ambiguousHarnessNames.length} basename(s) used by more than one script.`
      + ' A bare-name call to one of these names NOBODY, so coverage must be spelled with the path:',
    );
    for (const { name, paths } of ambiguousHarnessNames) {
      console.log(`  ${name}: ${paths.join(', ')}`);
    }
  }
}
// `process.exitCode`, not `process.exit()`: with --json the whole report goes to stdout, and an
// immediate exit truncates a piped write (the run hung instead of printing, which a CI job would
// read as a hung checker rather than a failing one).
process.exitCode = failing.length === 0 && shellFailing.length === 0 && inputGaps.length === 0 ? 0 : 1;
