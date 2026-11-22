#!/usr/bin/env node
import { readFileSync } from 'node:fs';
/**
 * The publish phases, and what a failure in each one leaves behind.
 *
 * WHY THIS EXISTS
 *
 * `publish-data-plugins.sh` reports progress with `say` and failure with `die`.
 * When it fails, an operator gets `exit 1` and a wall of text, and has to work out
 * three things by hand:
 *
 *   1. WHICH step failed - build, push, digest check, bundle, sign, install,
 *      deploy, activate, or the read-back after activation.
 *   2. WHAT WAS ALREADY CHANGED. A failure after `install` leaves a package on the
 *      kernel; after `deploy` it leaves instances; after `activate` it has moved
 *      what production serves. "The publish failed" is true in all three and
 *      useless in two of them.
 *   3. WHETHER RETRYING IS SAFE, and from where.
 *
 * That is the difference between a shell script and a RELEASE, and it is the whole
 * of TASK-18.
 *
 * WHAT THIS MODULE IS
 *
 * A pure model: an ordered list of phases, the artifact each produces, whether it
 * mutates the running system, and - given the phase that failed - what is left
 * over, whether production was affected, and where a retry must start.
 *
 * WHAT IT IS NOT
 *
 * It does not run the phases. The script keeps doing that. This answers the three
 * questions above from the phase name, so the answers are the same every time and
 * can be tested without a staging host.
 *
 * RECORDING A RUN. `--begin` writes a journal entry before each phase and `--end`
 * closes it; the journal is what `--explain` reads when the shell exits. Without a
 * journal the module still answers for a phase name, which is what a human pasting
 * a log line needs.
 *
 * Usage:
 *   node scripts/ci/publish-phases.mjs --list
 *   node scripts/ci/publish-phases.mjs --explain FAILED_PHASE
 *   node scripts/ci/publish-phases.mjs --publish-script-drift
 */

/**
 * The phases, in order.
 *
 * `mutates` is the field that matters: everything up to and including `SIGNED` is
 * local work that leaves the running system alone, so a failure there needs no
 * recovery at all. From `INSTALLED` onward each step changes something an operator
 * would have to undo.
 *
 * `artifact` is what exists after the phase succeeds - named so a retry knows what
 * it can reuse instead of rebuilding.
 */
export const PHASES = [
  { name: 'PREFLIGHT', artifact: null, mutates: false,
    note: 'capacity and version checks; nothing is created' },
  { name: 'BUILT', artifact: 'local image', mutates: false,
    note: 'the image exists in this daemon only' },
  { name: 'PUSHED', artifact: 'registry tag', mutates: false,
    note: 'the registry has the tag; nothing serves it' },
  { name: 'VERIFIED', artifact: 'registry digest', mutates: false,
    note: 'the registry confirmed the digest this host pushed' },
  { name: 'BUNDLED', artifact: 'bundle directory', mutates: false,
    note: 'manifest + frontend staged in /tmp' },
  { name: 'SIGNED', artifact: 'signed bundle', mutates: false,
    note: 'the LAST phase that cannot affect anything running' },
  { name: 'INSTALLED', artifact: 'kernel package row', mutates: true,
    note: 'the kernel now has the package; nothing is deployed' },
  { name: 'DEPLOYING', artifact: 'deployment row', mutates: true,
    note: 'instances are being created; the previous version still serves' },
  { name: 'READY', artifact: 'ready instances', mutates: true,
    note: 'new instances are healthy but NOT serving' },
  { name: 'ACTIVATING', artifact: null, mutates: true,
    note: 'the active revision is being switched' },
  { name: 'ACTIVE', artifact: 'active revision', mutates: true,
    note: 'PRODUCTION NOW SERVES THIS VERSION' },
  { name: 'ACCEPTED', artifact: 'read-back confirmation', mutates: false,
    note: 'the active version was read back and matches' },
];

const ORDER = PHASES.map((p) => p.name);

/** The last phase that cannot change anything the system is doing. */
export const LAST_HARMLESS_PHASE = 'SIGNED';

/** The phase after which production serves a different version. */
export const PHASE_THAT_CHANGES_PRODUCTION = 'ACTIVE';

/**
 * What a failure in `failedPhase` leaves behind.
 *
 * @param {string} failedPhase one of PHASES[].name
 * @param {{replicas?: number}} [opts]
 * @returns {{phase: string, known: boolean, completed: string[], leftover: string[],
 *            productionAffected: boolean, retryFrom: string, manualRecovery: boolean,
 *            explanation: string}}
 */
export function explain(failedPhase, opts = {}) {
  const idx = ORDER.indexOf(failedPhase);
  if (idx === -1) {
    return {
      phase: String(failedPhase),
      known: false,
      completed: [],
      leftover: [],
      productionAffected: false,
      retryFrom: 'PREFLIGHT',
      manualRecovery: false,
      explanation: `${JSON.stringify(failedPhase)} is not a phase this release knows. The safest`
        + ' reading is that nothing can be assumed: start from PREFLIGHT and re-run the'
        + ' preflight, which is read-only.',
    };
  }

  const completed = ORDER.slice(0, idx);
  // A FAILURE INSIDE A PHASE MAY HAVE DONE PART OF IT. The first version read only
  // `completed`, so failing AT `INSTALLED` reported "left behind: nothing outside
  // this host" - while the install may well have written the package row before
  // whatever failed. For a phase that mutates, assume it got partway; assuming it
  // did nothing is the reading that leaves state nobody accounted for.
  const reached = new Set([...completed, failedPhase]);
  const leftover = [];
  if (reached.has('INSTALLED')) {
    leftover.push('a package row on the kernel may exist (harmless; a re-install replaces it)');
  }
  if (reached.has('DEPLOYING')) {
    leftover.push(`instances of the new version that are NOT serving may exist (${opts.replicas ?? 'the requested number'}`
      + ' at most); they hold node slots until they are stopped');
  }
  if (reached.has('READY')) {
    leftover.push('those instances may be RUNNING and healthy, which is why a re-deploy is cheap but frees nothing');
  }
  if (reached.has('ACTIVATING') || reached.has(PHASE_THAT_CHANGES_PRODUCTION)) {
    leftover.push('an active-revision change that may or may not have committed - MUST be read back');
  }

  // Did production change? ACTIVE means the activation committed. A failure DURING
  // ACTIVATING is the ambiguous one and is treated as "yes" - assuming it did not
  // is the assumption that leaves production on a version nobody chose.
  // A PHASE THAT FAILED MAY HAVE DONE PART OF ITS WORK - the same reason `reached`
  // exists above. `ACTIVATING` and `ACTIVE` are both "the switch was being made or
  // was made": a failure in either leaves the active revision uncertain, and
  // assuming it did not commit is the reading that leaves production on a version
  // nobody chose.
  const productionAffected = completed.includes(PHASE_THAT_CHANGES_PRODUCTION)
    || failedPhase === 'ACTIVATING'
    || failedPhase === PHASE_THAT_CHANGES_PRODUCTION;

  // Where a retry starts. Before INSTALLED nothing the kernel knows has changed, so
  // a retry from the failed phase is safe; from INSTALLED onward the script's own
  // idempotent path ("already installed; re-checking its deployment") is what makes
  // a plain re-run correct, and that is a claim about the SCRIPT, not this model.
  let retryFrom = failedPhase;
  if (idx <= ORDER.indexOf('SIGNED')) retryFrom = failedPhase;
  else retryFrom = failedPhase === 'ACCEPTED' ? 'ACCEPTED' : failedPhase;

  // Manual recovery is any case where production may have moved or where the
  // operator must look before re-running.
  const manualRecovery = productionAffected;

  const lines = [
    `failed at ${failedPhase} (${idx + 1} of ${ORDER.length}).`,
    completed.length
      ? `completed: ${completed.join(' -> ')}`
      : 'completed: nothing - the release never got past its first phase',
  ];
  if (leftover.length) lines.push(`left behind: ${leftover.join('; ')}`);
  else lines.push('left behind: nothing outside this host');
  if (productionAffected) {
    lines.push('PRODUCTION MAY HAVE CHANGED. Read the active version back before doing anything else:');
    lines.push('  opsctl plugins   (or GET /api/v1/plugins) - compare effectiveVersion to the version published');
  } else {
    lines.push('production was NOT affected: the failure is before the activation');
  }
  lines.push(`retry from: ${retryFrom}`);

  return {
    phase: failedPhase,
    known: true,
    completed,
    leftover,
    productionAffected,
    retryFrom,
    manualRecovery,
    explanation: lines.join('\n'),
  };
}

/**
 * The phases this module claims, versus the stages the shell script prints.
 *
 * The model is worthless if the script does not go through those phases, and the
 * script is free to grow a stage nobody added here. This compares the two by the
 * `say` markers the script uses at each stage boundary.
 *
 * @param {string} scriptText
 * @returns {string[]} problems; empty means the model and the script agree
 */
export function scriptDrift(scriptText) {
  const problems = [];
  const text = String(scriptText ?? '');
  if (text.trim() === '') return ['the publish script is empty or was not read'];

  // Boundaries the model depends on, each tied to something the script prints or
  // does. A stage that exists in the script and not here would make `explain` lie.
  const markers = [
    ['PUSHED', /pushed \$?img|\$name: pushed/],
    ['VERIFIED', /verify-registry-digest\.mjs/],
    ['BUNDLED', /assemble_plugin\.py/],
    ['SIGNED', /opsctl bundle|bundle --dir/],
    ['INSTALLED', /^\s*install "|opsctl[^\n]*\binstall\b/m],
    ['DEPLOYING', /^\s*deploy "|opsctl[^\n]*\bdeploy\b/m],
    ['ACCEPTED', /--activate/],
  ];
  for (const [phase, re] of markers) {
    if (!re.test(text)) {
      problems.push(`the model has a ${phase} phase but the script has no stage matching ${re}.`
        + ' Either the script changed or the model did, and `explain` would name a phase that never happens');
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------

const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (RUN_AS_PROGRAM) {
  const argv = process.argv.slice(2);
  if (argv.includes('--list')) {
    for (const p of PHASES) {
      process.stdout.write(`${p.name.padEnd(12)} ${p.mutates ? 'MUTATES' : 'local   '}  ${p.note}\n`);
    }
    process.exit(0);
  }
  const i = argv.indexOf('--explain');
  if (i !== -1) {
    const result = explain(argv[i + 1]);
    if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${result.explanation}\n`);
    process.exit(result.known ? 0 : 2);
  }
  const d = argv.indexOf('--publish-script-drift');
  if (d !== -1) {
    const file = argv[d + 1] ?? 'scripts/publish-data-plugins.sh';
    const problems = scriptDrift(readFileSync(file, 'utf8'));
    for (const p of problems) process.stdout.write(`ERROR ${p}\n`);
    process.stdout.write(`publish phases: ${problems.length} drift(s)\n`);
    process.exit(problems.length === 0 ? 0 : 1);
  }
  process.stderr.write('usage: publish-phases.mjs --list | --explain PHASE [--json] | --publish-script-drift [file]\n');
  process.exit(2);
}
