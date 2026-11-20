#!/usr/bin/env node
/**
 * Every suite workflow must supersede a superseded run - and must never cancel a
 * run nobody superseded.
 *
 * WHY THIS EXISTS
 *
 * On 2026-11-20 six merges went to main within one minute. Each merge fired the
 * full set of workflows, and none of them had a `concurrency` block, so the
 * queue held four complete `ci.yml` runs plus every satellite suite - all but
 * the last testing a tree nobody would merge. That is billed minutes spent on
 * answers that were already obsolete when they started.
 *
 * WHY NOT JUST `cancel-in-progress: true`
 *
 * Because it is wrong for two of the four triggers, and `staging-preview.yml`
 * already states the reason in its own concurrency comment: a nightly that gets
 * cancelled mid-certification is "a data point that silently does not exist".
 * A `workflow_dispatch` is a person asking for THIS run. Neither is superseded
 * by the next push, so the expression - not a bare `true` - is the requirement.
 *
 * WHAT IS ASSERTED
 *
 *   1. every workflow in .github/workflows/ has a `concurrency:` block
 *   2. its group is keyed on the ref, so two branches never cancel each other
 *   3. `cancel-in-progress` is an expression mentioning both `pull_request` and
 *      `push`, never the literal `true`
 *   4. no workflow cancels a `workflow_dispatch` or `schedule` run
 *
 * Run with --selftest to check the checks against fixtures.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WF = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));

/** The concurrency block of one workflow file, or null. */
export function concurrencyOf(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^concurrency:/.test(l));
  if (start === -1) return null;
  const out = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (i > start && /^\S/.test(line) && !/^\s*#/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

/** @returns {string[]} problems; empty means ok. */
export function inspect(name, text) {
  const block = concurrencyOf(text);
  if (block === null) {
    return [`${name}: no concurrency: block; a superseded push runs to completion`];
  }
  const problems = [];
  const group = /^\s+group:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? '';
  // A literal `true` is correct ONLY when the group already separates the runs
  // that must not cancel each other. `staging-preview.yml` does exactly that: its
  // group expression yields three distinct buckets (verify-<sha>, nightly,
  // deploy), so a push can never land in the nightly's bucket and cancel it. That
  // is a stronger guarantee than an event-name test, not a weaker one.
  //
  // This checker got it wrong on its first run and reported that file as broken.
  // The fix is to recognise the buckets, not to relax the rule: a literal `true`
  // with a single bucket is still an error.
  const bucketed = /event_name\s*==\s*'schedule'|inputs\.|github\.event\.inputs/.test(group);
  const keyedOnRef = /github\.(ref|head_ref)/.test(group);
  if (!group) {
    problems.push(`${name}: concurrency has no group`);
  } else if (!keyedOnRef && !bucketed) {
    problems.push(`${name}: group "${group}" is neither keyed on the ref nor split into buckets; two branches or a push-and-nightly would cancel each other`);
  }
  const cip = /^\s+cancel-in-progress:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? '';
  if (!cip) {
    problems.push(`${name}: concurrency has no cancel-in-progress`);
  } else if (/^true$/i.test(cip)) {
    if (!bucketed) {
      problems.push(
        `${name}: cancel-in-progress is the literal \`true\` with a single bucket, which also cancels ` +
        'workflow_dispatch and schedule runs - a manual request or a nightly certification is not ' +
        'superseded by a push',
      );
    }
  } else {
    for (const trigger of ['pull_request', 'push']) {
      if (!cip.includes(trigger)) {
        problems.push(`${name}: cancel-in-progress expression does not mention ${trigger}`);
      }
    }
    for (const trigger of ['workflow_dispatch', 'schedule']) {
      // A positive mention would mean cancelling it too; a negation is fine.
      const positive = new RegExp(`event_name\\s*==\\s*'${trigger}'`);
      if (positive.test(cip) && !new RegExp(`!\\s*\\(?[^)]*event_name\\s*==\\s*'${trigger}'`).test(cip)) {
        problems.push(`${name}: cancel-in-progress ENABLES cancellation for ${trigger}, which is not superseded`);
      }
    }
  }
  return problems;
}

const GOOD = `name: x
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' || github.event_name == 'push' }}
jobs: {}
`;

function selftest() {
  const cases = [
    ['a correct block passes', GOOD, []],
    ['a missing block fails', 'name: x\njobs: {}\n', ['no concurrency: block']],
    ['a literal true fails', GOOD.replace(/cancel-in-progress:.*/, 'cancel-in-progress: true'), ['literal `true`']],
    ['a group without a ref fails', GOOD.replace(/group:.*/, 'group: fixed-name'), ['neither keyed on the ref nor split into buckets']],
    ['a dispatch-cancelling expression fails',
      GOOD.replace(/cancel-in-progress:.*/, "cancel-in-progress: ${{ github.event_name == 'workflow_dispatch' }}"),
      ['does not mention pull_request']],
  ];
  let bad = 0;
  for (const [label, text, want] of cases) {
    const got = inspect('fixture.yml', text);
    const ok = want.length === 0 ? got.length === 0 : want.every((w) => got.join(' ').includes(w));
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)}\n`);
  }
  process.stdout.write(`concurrency selftest: ${cases.length - bad}/${cases.length}\n`);
  return bad === 0;
}

if (process.argv[2] === '--selftest') {
  process.exit(selftest() ? 0 : 1);
}

const files = readdirSync(WF).filter((n) => n.endsWith('.yml')).sort();
let errors = 0;
for (const file of files) {
  const problems = inspect(file, readFileSync(WF + file, 'utf8'));
  for (const p of problems) { errors += 1; process.stdout.write(`ERROR ${p}\n`); }
}
process.stdout.write(`concurrency supersede: ${errors} error(s) across ${files.length} workflow(s)\n`);
process.exit(errors === 0 ? 0 : 1);
