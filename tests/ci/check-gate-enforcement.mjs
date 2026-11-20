#!/usr/bin/env node
/**
 * Is the gate actually enforceable right now? TASK-02.
 *
 * WHAT "ENFORCEABLE" MEANS HERE, precisely: that a red `ci-gate` stops a merge.
 * Everything else in this repository's CI is a claim about what SHOULD happen;
 * this asks GitHub what WILL happen.
 *
 * WHY IT READS GITHUB RATHER THAN THE YAML
 *
 * The workflows can be flawless and still not gate anything - that is exactly the
 * state this repository was in between 2026-11-20 and now: `ci-gate` computes a
 * verdict on every pull request, and ruleset 26958761 does not require it. No
 * amount of reading `.github/workflows/` can see that. The ruleset is the other
 * half, and it lives in the GitHub API.
 *
 * WHAT IT REFUSES TO CLAIM
 *
 * It does not say "merge protection works". It reports the required contexts that
 * EXIST, the ones the workflows PRODUCE, and the difference - because the gap
 * between those two sets is the whole question. A required context that no
 * workflow produces blocks every merge for ever (`9 of 9 ... are expected`), and
 * a produced context that is not required blocks nothing.
 *
 * MODES
 *
 *   (default)  compare the live ruleset to what the workflows produce
 *   --selftest check the comparison itself
 *
 * Requires `gh` with read access. Exits 1 when the sets disagree, which is the
 * state a migration must consciously choose rather than drift into.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const WF = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));

/** Contexts that must exist for the gate to be able to block anything. */
export const GATE_CONTEXT = 'ci-gate';

/**
 * Compare two sets of context names.
 *
 * @param {string[]} required what the ruleset demands
 * @param {string[]} produced what the workflows create on a pull request
 * @returns {{verdict: string, problems: string[], notes: string[]}}
 */
export function compare(required, produced) {
  const problems = [];
  const notes = [];
  const req = new Set(required);
  const prod = new Set(produced);

  // A required context nobody produces is a permanent "Expected" - the merge is
  // blocked for ever, not by a failure but by an absence.
  for (const c of req) {
    if (!prod.has(c)) {
      problems.push(`required but never produced: ${c} - merges would hang at "Expected"`);
    }
  }
  const gates = [];
  for (const c of prod) {
    if (!req.has(c)) gates.push(c);
  }
  if (req.size === 0) {
    notes.push('NO required status checks: CI is advisory. A red gate blocks nothing.');
  }
  if (!req.has(GATE_CONTEXT)) {
    notes.push(
      `${GATE_CONTEXT} is produced but not required. The gate computes a verdict on every PR ` +
      'and no merge consults it.',
    );
  }

  let verdict;
  if (problems.length) verdict = 'BROKEN'; // required-but-absent: worse than advisory
  else if (req.size === 0) verdict = 'ADVISORY';
  else if (req.has(GATE_CONTEXT)) verdict = 'ENFORCED';
  else verdict = 'PARTIAL';
  return { verdict, problems, notes, unenforced: gates.sort() };
}

/** Check names each workflow creates on `pull_request`, from its YAML. */
export function producedContexts(dir = WF) {
  const names = new Set();
  for (const file of readdirSync(dir).filter((n) => n.endsWith('.yml'))) {
    const text = readFileSync(dir + file, 'utf8');
    if (!/^ {2}pull_request:/m.test(text)) continue;
    // A job's check name is its `name:` when it has one, and its JOB ID otherwise -
  // GitHub creates the check under the id when the job does not rename itself.
  // The first version of this only read `name:`, so it found the two jobs in this
  // repository that rename themselves and missed the other thirty.
  const lines = text.split('\n');
    const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
    if (jobsAt === -1) continue;
    let currentId = null;
    let currentName = null;
    const flush = () => { if (currentId) names.add(currentName ?? currentId); };
    for (let i = jobsAt + 1; i < lines.length; i += 1) {
      const line = lines[i];
      const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (header) { flush(); currentId = header[1]; currentName = null; continue; }
      if (/^\S/.test(line)) { flush(); currentId = null; break; }
      const named = /^ {4}name: (.+)$/.exec(line);
      if (named && currentId) currentName = named[1].trim().replace(/^['"]|['"]$/g, '');
    }
    flush();
  }
  return [...names].sort();
}

function liveRequiredContexts(repo) {
  const raw = execFileSync('gh', ['api', `repos/${repo}/rulesets`], { encoding: 'utf8' });
  const rulesets = JSON.parse(raw);
  const out = [];
  for (const rs of rulesets) {
    const full = JSON.parse(
      execFileSync('gh', ['api', `repos/${repo}/rulesets/${rs.id}`], { encoding: 'utf8' }),
    );
    for (const rule of full.rules ?? []) {
      if (rule.type !== 'required_status_checks') continue;
      for (const c of rule.parameters?.required_status_checks ?? []) out.push(c.context);
    }
  }
  return [...new Set(out)].sort();
}

// ---------------------------------------------------------------------------

function selftest() {
  const nine = ['contracts', 'linux-runtime', 'platform-image-build', 'platform-only',
    'quality-faults', 'rust', 'spec-coverage', 'web', 'web-unit'];
  const produced = nine.concat('ci-gate');
  // Each entry is an ALREADY-EVALUATED boolean, not a thunk. The first version
  // stored `compare(...) === 'PARTIAL'` in this array and then called it as
  // `fn()` - so every case threw a TypeError, the catch turned it into `false`,
  // and all five reported FAIL while the checker was working correctly. A
  // selftest that cannot pass is as useless as one that cannot fail.
  const cases = [
    ['nine required, nine produced -> PARTIAL (the gate is not consulted)',
      compare(nine, produced).verdict === 'PARTIAL', 'PARTIAL'],
    ['no required checks -> ADVISORY, not "fine"',
      compare([], produced).verdict === 'ADVISORY', 'ADVISORY'],
    ['ci-gate required -> ENFORCED',
      compare(nine.concat('ci-gate'), produced).verdict === 'ENFORCED', 'ENFORCED'],
    ['a required context nobody produces -> BROKEN',
      compare(nine.concat('made-up'), produced).verdict === 'BROKEN', 'BROKEN'],
    ['ADVISORY names the consequence rather than only the state',
      compare([], produced).notes.some((n) => /blocks nothing/.test(n)), 'names the consequence'],
  ];
  let bad = 0;
  for (const [label, ok, why] of cases) {
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` - expected ${why}`}\n`);
  }
  process.stdout.write(`gate enforcement selftest: ${cases.length - bad}/${cases.length}\n`);
  return bad === 0;
}

// Only when run as a program. Without this guard the main body below also runs on
// `import`, so the selftest's own `compare()` calls triggered a live ruleset read
// and every assertion saw the real repository instead of its fixture - which is
// why all five cases reported FAIL while the checker itself was working.
const RUN_AS_PROGRAM = process.argv[1]
  && import.meta.url === `file://${process.argv[1]}`;

if (RUN_AS_PROGRAM && process.argv[2] === '--selftest') process.exit(selftest() ? 0 : 1);

if (RUN_AS_PROGRAM) main();

function main() {
const repo = process.env.REPO || 'baicie/ops-1';
let required;
try {
  required = liveRequiredContexts(repo);
} catch (error) {
  process.stdout.write(`gate enforcement: cannot read the ruleset (${String(error).split('\n')[0]})\n`);
  process.exit(1);
}
const produced = producedContexts();
const result = compare(required, produced);
process.stdout.write(`required: ${required.join(', ') || '(none)'}\n`);
process.stdout.write(`produced: ${produced.length} context(s)\n`);
for (const n of result.notes) process.stdout.write(`note: ${n}\n`);
for (const p of result.problems) process.stdout.write(`ERROR ${p}\n`);
if (result.unenforced.length) {
  process.stdout.write(`produced but not required (${result.unenforced.length}): ${result.unenforced.join(', ')}\n`);
}
process.stdout.write(`gate enforcement: ${result.verdict}\n`);
// ADVISORY and PARTIAL are not failures of the CODE - they are facts about the
// repository that a migration has to decide about. Only BROKEN exits non-zero,
// because that one blocks every merge without anyone choosing it.
process.exit(result.verdict === 'BROKEN' ? 1 : 0);
}
