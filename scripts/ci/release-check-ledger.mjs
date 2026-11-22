#!/usr/bin/env node
/**
 * Wait for a commit's checks and print a LEDGER, not a de-duplicated name list.
 *
 * WHAT THE WORKFLOW DID BEFORE THIS FILE EXISTED
 *
 *   gh api .../check-runs?per_page=100 \
 *     --jq '[.check_runs[] | {name, s: (.conclusion // .status)}] | unique_by(.name)'
 *
 * Measured against that filter, four inputs:
 *
 *   old success, NEW failure        -> rust=success    <- the failure is dropped
 *   new failure FIRST               -> rust=failure    <- same data, other order
 *   old success, NEW in_progress    -> rust=success    <- certifying during a re-run
 *   old in_progress, NEW success    -> rust=in_progress
 *
 * `unique_by` keeps the LAST occurrence in ARRAY ORDER and the name. GitHub does
 * not promise an order, so this is not "latest attempt wins" - it is "whichever
 * the API happened to put last". Two of the four are wrong in the direction that
 * matters: a red required suite reported green, and a re-run in flight treated as
 * settled.
 *
 * It also threw away `check_suite.id`, the only field that says WHICH workflow
 * produced a check, so a check named `rust` from any app would be credited to the
 * one this repository means.
 *
 * WHAT THIS DOES INSTEAD
 *
 * Reads the check runs AND the workflow runs for the commit, joins them through
 * `check_suite_id`, and asks `checkState` - the same function `ci-gate` uses, so
 * the certification and the merge gate cannot disagree about which attempt is the
 * answer. Then prints one line per name in a stable, sorted form.
 *
 * Output (stdout), one per line:   <name>=<state>[  (<reason>)]
 * Exit codes: 0 every check has a settled result; 1 something is still running;
 *             2 the API could not be read, or returned nothing.
 *
 * `--json` prints the whole ledger for a caller that wants to reason about it.
 */
import { execFileSync } from 'node:child_process';
import { attributeChecks, checkState, UNFINISHED_STATUS } from '../../tests/ci/check-run-ledger.mjs';

function ghApi(repo, path) {
  return JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${path}`, '--paginate', '--slurp'],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }))
    // `--paginate --slurp` yields an array of pages; flatten to one list.
    .flat();
}

/**
 * Build the ledger for one commit.
 *
 * @param {string} repo  "owner/name"
 * @param {string} sha   40-hex
 * @returns {{entries: {name: string, state: string, reason?: string, workflow: string|null}[],
 *            pending: string[], unattributed: string[], duplicates: string[], empty: boolean}}
 */
export function summariseChecks(checkRuns, workflowRuns = []) {
  const ledger = attributeChecks(checkRuns, workflowRuns);
  const entries = {};
  const pending = [];
  for (const name of Object.keys(ledger.byName).sort()) {
    const st = checkState(ledger.byName, name, {});
    entries[name] = { state: st.state, reason: st.reason, workflow: ledger.byName[name][0]?.workflow ?? null };
    // `pending` means "a result does not exist yet". `checkState` returns the word
    // `pending` for a re-run in flight; it returns the raw status for a first
    // attempt that has not finished. Both must wait.
    if (st.state === 'pending' || UNFINISHED_STATUS.has(st.state)) pending.push(name);
  }
  return {
    entries,
    pending,
    unattributed: ledger.unattributed,
    duplicates: ledger.duplicates,
    // `empty` distinguishes "the API returned no check runs" from "some were read
    // but none had a name". The caller refuses to certify on it.
    empty: (checkRuns ?? []).length === 0,
  };
}

/** Build the ledger for one commit, reading both endpoints. */
export function readLedger(repo, sha) {
  const checkRuns = ghApi(repo, `commits/${sha}/check-runs?per_page=100`);
  // The workflow-runs endpoint is what names the producer. Without it every check
  // is unattributable and `checkState` cannot tell this repository's `rust` from
  // an impostor's.
  const workflowRuns = ghApi(repo, `actions/runs?head_sha=${sha}&per_page=100`);
  // The API wraps each in an object; `--slurp` gives us pages of those wrappers.
  const checks = checkRuns.flatMap((page) => page.check_runs ?? []);
  const workflows = workflowRuns.flatMap((page) => page.workflow_runs ?? []);
  return summariseChecks(checks, workflows);
}

// ---------------------------------------------------------------------------

const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (RUN_AS_PROGRAM) {
  const argv = process.argv.slice(2);
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };
  const repo = arg('repo');
  const sha = arg('sha');
  const budget = Number(arg('budget-seconds') ?? 2400);
  const poll = Number(arg('poll-seconds') ?? 30);
  if (!repo || !sha) {
    process.stderr.write('usage: release-check-ledger.mjs --repo o/r --sha <40hex>'
      + ' [--budget-seconds N] [--poll-seconds N] [--json]\n');
    process.exit(2);
  }

  const started = Date.now();
  for (;;) {
    let ledger;
    try {
      ledger = readLedger(repo, sha);
    } catch (error) {
      // An unreadable API is its own answer. `2>/dev/null || echo ""` in the old
      // shell turned this into "no checks", which reads as a commit with nothing
      // to certify rather than a failed read.
      process.stderr.write(`cannot read the check-run API for ${sha}: ${String(error.message).split('\n')[0]}\n`);
      process.exit(2);
    }
    if (ledger.empty) {
      process.stderr.write(`the check-run API returned nothing for ${sha}; refusing to certify blind\n`);
      process.exit(2);
    }
    if (ledger.pending.length === 0) {
      if (argv.includes('--json')) {
        process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
      } else {
        for (const [name, e] of Object.entries(ledger.entries)) {
          process.stdout.write(`${name}=${e.state}${e.reason ? `  (${e.reason})` : ''}\n`);
        }
      }
      process.exit(0);
    }
    if (Date.now() - started >= budget * 1000) {
      process.stderr.write(`${ledger.pending.length} check(s) still unfinished after ${budget}s:`
        + ` ${ledger.pending.join(', ')}; UNKNOWN is not CERTIFIED\n`);
      process.exit(1);
    }
    process.stderr.write(`waiting: ${ledger.pending.length} unfinished (${ledger.pending.join(', ')})\n`);
    execFileSync('sleep', [String(poll)]);
  }
}
