#!/usr/bin/env node
/**
 * Phase 8D TASK-40: a merged PR is not a verified main.
 *
 * THE GAP THIS CLOSES
 *
 * The brief's rule is 「PR 通过不等于 main 通过」 - a green pull request says
 * nothing about whether the commit that landed on `main` was itself verified.
 * They are separate executions of separate commits, and this repository has
 * already been bitten by treating the first as the second.
 *
 * Four of TASK-40's five requirements are already enforced by tools that exist:
 * the exact head SHA (`ci-gate` queries by commit), producer and attempt
 * validity (`check-run-ledger.mjs`), and "never call it green while a required
 * check is pending" (`await-delegated.mjs`). The fifth - "after merging, check
 * what `main` actually ran" - had no tool at all, so it was a sentence in a
 * document that someone had to remember.
 *
 * WHAT IT REPORTS, AND WHY EACH STATE IS SEPARATE
 *
 *   VERIFIED      every workflow that runs on push completed SUCCESS
 *   FAILED        a workflow concluded failure
 *   CANCELLED     a workflow was superseded by a newer push on the same ref
 *   MISSING       a workflow that runs on push has no run for this commit
 *   INCOMPLETE    a workflow has not finished
 *
 * CANCELLED IS NOT A FAILURE. `ci.yml` sets `cancel-in-progress: true` for
 * pushes, so merging twice in quick succession cancels the first commit's runs.
 * That is the documented policy, and calling it a failure would train a reader to
 * ignore this tool. But it is also NOT a pass: the cancelled commit's suites never
 * ran to completion, so nothing about that commit was verified - except that a
 * newer commit is what `main` points at now.
 *
 * The distinction that makes this tool worth having: a `main` whose runs are all
 * CANCELLED is *superseded*, not *verified*, and a `main` whose runs are FAILED is
 * broken. They need different actions and the tool never merges them.
 *
 * Usage:
 *   node tests/ci/verify-main.mjs --sha <commit>          # via gh
 *   node tests/ci/verify-main.mjs --from-json runlist.json
 *   node tests/ci/verify-main.mjs --sha <commit> --json
 *
 * Exit: 0 VERIFIED, 1 FAILED or INCOMPLETE, 2 nothing to read, 3 CANCELLED (which
 * is its own answer and must not be mistaken for either of the other two).
 *
 * PIPE UNDER `set -o pipefail` AND READ THE DOCUMENT, NOT THE STATUS.
 *
 * A wrapper that pipes this into a JSON reader gets the exit code above, so
 * `tool | python3 -c ...` returns 2 or 3 while the JSON is perfectly good. That is
 * intentional - a caller checking `if tool; then` must not read UNAVAILABLE as
 * success - but it makes `|` a trap. The test harness hits it, which is how this
 * paragraph was written. Either read the JSON and ignore the status, or capture to
 * a file first:
 *
 *     node verify-main.mjs --sha X --json > out.json || true
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = 'baicie/ops-1';
const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const AS_JSON = argv.includes('--json');

/**
 * The workflows that run on a push to `main`.
 *
 * Read from the YAML rather than hard-coded, so adding a workflow to `on: push`
 * cannot silently escape this check. A workflow that runs only on
 * `pull_request`, `schedule` or `workflow_dispatch` is not expected to appear.
 */
export function pushWorkflows(workflowsDir = join(HERE, '../../.github/workflows')) {
  const unfiltered = [];
  const filtered = [];
  for (const f of readdirSync(workflowsDir)) {
    if (!f.endsWith('.yml')) continue;
    const src = readFileSync(join(workflowsDir, f), 'utf8');
    const m = src.match(/^on:\s*\n((?:[ \t]+.*\n|\s*\n)+)/m);
    const block = m ? m[1] : '';
    if (!/^\s{2}push:/m.test(block) && !/^on:\s*\[[^\]]*\bpush\b/m.test(src)) continue;
    // A push trigger with `paths:` may legitimately not run for a commit that did
    // not touch those paths. A push trigger WITHOUT `paths:` must run for every
    // push, and its absence is a real gap. The first version of this function
    // treated both the same way and reported six workflows as missing on a commit
    // that had simply not touched their paths - a false alarm that would have
    // taught a reader to ignore the tool.
    const rawPush = (block.match(/^  push:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m) ?? [, ''])[1];
    // COMMENTS ARE NOT CONFIGURATION. `platform-linux-acceptance.yml` opens its
    // `push:` block with "NO `paths:` filter, deliberately" - and a plain
    // `.includes('paths:')` read that sentence as a filter, filing a workflow that
    // must run on every push under "may legitimately not run". The same mistake as
    // a character class that matches everything, one level up: a substring match
    // on prose.
    const pushBlock = rawPush
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    // A `push:` trigger can carry `branches:`, `tags:` or `paths:`. Only a push
    // that fires for a BRANCH PUSH belongs in this check.
    //
    // `release-certification.yml` is the case that proved it: its `push` block is
    // `tags: ['v*']`, so it never runs for a commit landing on main - and the first
    // version of this function reported it as "no run on this commit, and its push
    // trigger has no paths filter", which is a demand the workflow never agreed to.
    // `branches:` that excludes main is the same shape.
    if (/^\s{4}tags:/m.test(pushBlock)) continue;
    const branches = pushBlock.match(/^\s{4}branches:\s*\n((?:\s{6}.*\n)+)/m);
    if (branches && !/^\s{6}-\s*['"]?main['"]?\s*$/m.test(branches[1]) && !/^\s{6}-\s*['"]?\*['"]?\s*$/m.test(branches[1])) {
      continue;
    }
    (pushBlock.includes('paths:') ? filtered : unfiltered).push(f);
  }
  return { unfiltered: unfiltered.sort(), filtered: filtered.sort() };
}

/**
 * Classify one commit's push runs.
 *
 * @param {Array<{name: string, status: string, conclusion: string|null, workflow: string}>} runs
 * @param {string[]} expected  workflows that run on push, by filename
 * @returns {{state: string, reason: string, byWorkflow: object}}
 */
export function classifyMainRuns(runs, expected) {
  const { unfiltered = expected, filtered = [] } = Array.isArray(expected) ? { unfiltered: expected, filtered: [] } : expected;
  const by = {};
  for (const r of runs) {
    const key = r.workflow ?? r.name;
    // A re-run creates a NEW run for the same workflow; the latest answer wins,
    // which is the same rule the gate uses for check runs.
    if (!by[key] || (r.createdAt ?? '') >= (by[key].createdAt ?? '')) by[key] = r;
  }

  const failed = [];
  const cancelled = [];
  const pending = [];
  const succeeded = [];
  const notTriggered = [];
  // Only the UNFILTERED set is required to appear. A path-filtered workflow that
  // did not run for a commit that touched nothing it watches is correct, and is
  // recorded as not-triggered rather than missing.
  for (const wf of unfiltered) {
    const r = by[wf];
    if (!r) { pending.push(`${wf}: no run on this commit, and its push trigger has no paths filter`); continue; }
    if (r.conclusion === 'success') succeeded.push(wf);
    else if (r.conclusion === 'failure' || r.conclusion === 'timed_out') failed.push(`${wf}: ${r.conclusion}`);
    else if (r.conclusion === 'cancelled') cancelled.push(wf);
    else if (r.status !== 'completed') pending.push(`${wf}: ${r.status}`);
    else pending.push(`${wf}: completed with conclusion ${r.conclusion}`);
  }

  for (const wf of filtered) {
    if (!by[wf]) notTriggered.push(wf);
  }

  // PRECEDENCE: a failure is a failure. A cancelled run is only reported as
  // CANCELLED when nothing actually failed, because "superseded" describes a
  // commit that was replaced, and a commit with a red suite was not.
  let state; let reason;
  if (failed.length) {
    state = 'FAILED';
    reason = `${failed.length} workflow(s) failed on this commit: ${failed.join(', ')}`;
  } else if (pending.length) {
    state = 'INCOMPLETE';
    reason = `${pending.length} workflow(s) have no answer yet: ${pending.join(', ')}`;
  } else if (cancelled.length) {
    state = 'CANCELLED';
    reason = `${cancelled.length} workflow(s) were superseded by a newer push `
      + `(${cancelled.join(', ')}); this commit's suites never completed, so nothing about it was verified`;
  } else {
    state = 'VERIFIED';
    reason = `all ${succeeded.length} workflow(s) that run on push completed success`;
  }

  return {
    state, reason,
    byWorkflow: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, {
      status: v.status, conclusion: v.conclusion, runId: v.runId ?? null, attempt: v.attempt ?? null,
    }])),
    succeeded, failed, cancelled, pending,
    notTriggered,
    // A workflow that watches paths this commit did not touch. Listed so a reader
    // can see the difference between "did not run" and "not supposed to run".
    notTriggeredNote: notTriggered.length
      ? `path-filtered and not applicable to this commit: ${notTriggered.join(', ')}`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const FROM_JSON = arg('--from-json');
const SHA = arg('--sha');
// Guarded so the exports above can be imported by a test. Without this, importing
// the module ran the CLI, printed usage and called process.exit(2) - which is what
// happened the first time the test tried to check `pushWorkflows()`.
const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (IS_MAIN) main();
function main() {
if (!FROM_JSON && !SHA) {
  process.stderr.write('usage: verify-main.mjs --sha <commit> | --from-json <runlist.json> [--json]\n');
  process.exit(2);
}

let runs; let source; let subject = null;
if (FROM_JSON) {
  const f = JSON.parse(readFileSync(FROM_JSON, 'utf8'));
  runs = Array.isArray(f) ? f : (f.runs ?? f.workflow_runs ?? []);
  source = `fixture:${FROM_JSON}`;
  subject = f.sha ?? null;
} else {
  try {
    const out = execFileSync('gh', [
      'run', 'list', '--repo', REPO, '--branch', 'main', '--limit', '60',
      '--json', 'databaseId,name,workflowName,headSha,status,conclusion,event,attempt,createdAt',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    const all = JSON.parse(out);
    // Prefix match, not equality: a caller passing a short SHA is asking about the
    // same commit, and refusing it produced "no push run exists for this commit"
    // for a commit that had five. The guard is a minimum length so an empty or
    // one-character argument cannot match everything.
    if (String(SHA).length < 7) {
      process.stderr.write(`--sha must be at least 7 characters, got ${JSON.stringify(SHA)}\n`);
      process.exit(2);
    }
    runs = all
      .filter((r) => String(r.headSha).startsWith(SHA) && r.event === 'push')
      .map((r) => ({ ...r, workflow: `${r.workflowName}.yml`, runId: r.databaseId }));
    source = `gh:${SHA}`;
    subject = SHA;
  } catch (e) {
    process.stderr.write(`could not read main's runs for ${SHA}: ${String(e.stderr ?? e.message).split('\n')[0]}\n`);
    process.exit(2);
  }
}

if (!runs.length) {
  const nothing = {
    sha: subject,
    source,
    state: 'UNAVAILABLE',
    reason: `no push run exists for this commit; either it is not on main, or main has not started its workflows`,
    byWorkflow: {},
  };
  if (AS_JSON) process.stdout.write(`${JSON.stringify(nothing, null, 2)}\n`);
  else process.stderr.write(`UNAVAILABLE: ${nothing.reason}\n`);
  process.exit(2);
}

const expected = pushWorkflows();
const result = {
  sha: subject,
  source,
  expectedWorkflows: expected.unfiltered,
  pathFilteredWorkflows: expected.filtered,
  ...classifyMainRuns(runs, expected),
  // Said plainly, because the whole point of the tool is that this is a DIFFERENT
  // question from "did the PR pass".
  note: 'This describes the PUSH runs for this commit. A green pull request on the '
    + 'same content is a different execution and does not substitute for it.',
};

if (AS_JSON) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  const o = [];
  o.push(`${result.state}  ${subject}`);
  o.push(`  ${result.reason}`);
  o.push(`  verified: ${result.succeeded.join(', ') || '(none)'}`);
  if (result.failed.length) o.push(`  FAILED:   ${result.failed.join(', ')}`);
  if (result.cancelled.length) o.push(`  CANCELLED:${result.cancelled.join(', ')}`);
  if (result.pending.length) o.push(`  pending:  ${result.pending.join(', ')}`);
  if (result.notTriggeredNote) o.push(`  ${result.notTriggeredNote}`);
  o.push('');
  o.push(`  ${result.note}`);
  process.stdout.write(`${o.join('\n')}\n`);
}

process.exit({ VERIFIED: 0, INCOMPLETE: 1, FAILED: 1, CANCELLED: 3 }[result.state] ?? 1);
}
