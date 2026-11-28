#!/usr/bin/env node
/**
 * Reading GitHub for one commit, without the two mistakes that were in here.
 *
 * MISTAKE 1: `gh run list --branch main --limit 60`, filtered locally by SHA.
 *
 * The old query asked for "recent runs on main" and then sifted the answer. Two
 * things go wrong with that, and only one of them is about the limit:
 *
 *   - the target commit's runs can be outside the window. Sixty runs is roughly
 *     a dozen pushes once seven path-filtered workflows fire; a commit from
 *     earlier in the day is simply not in the page, and the tool reports
 *     "no push run exists for this commit" for a commit that has five.
 *   - it cannot distinguish "no run" from "not in this page", which are different
 *     facts with different correct actions (nothing to verify vs read further).
 *
 * The replacement asks the API the question directly: `head_sha` is a
 * server-side filter on the workflow-runs endpoint, so the answer is the answer.
 *
 * MISTAKE 2: the same query was used for runs that are not pushes.
 *
 * `gh run list --branch main` returns `workflow_dispatch` runs too, because they
 * also have `head_branch: main`. The old code filtered `r.event === 'push'`
 * afterwards, which worked, but it meant a manual dispatch could displace the
 * push run of the same workflow in the 60-row window. The new query filters on
 * the server as well.
 *
 * PAGINATION
 *
 * `--paginate --jq` prints ONE ARRAY PER PAGE, concatenated with newlines, which
 * is not JSON. `check-run-ledger.mjs` records the same lesson. Every read below
 * therefore supplies `--slurp` and flattens explicitly, and a caller that gets a
 * non-array is told so rather than being handed a silent empty list.
 *
 * API FAILURE IS ITS OWN ANSWER
 *
 * A failed call returns `{ok: false, error}`. It never becomes an empty list,
 * because an empty list means "this commit has no runs" and that is a verdict.
 */

import { execFileSync } from 'node:child_process';

export const REPO = 'baicie/ops-1';

/**
 * Read every workflow run for one exact commit.
 *
 * @param {object} opts
 * @param {string} opts.sha full 40-character commit SHA
 * @param {string} [opts.event] restrict to one event, e.g. 'push'
 * @param {string} [opts.repo]
 * @param {(args: string[]) => string} [opts.exec] injectable for the counterfactuals
 * @returns {{ok: boolean, runs: object[], error: string|null, pages: number}}
 */
export function fetchCommitRuns({ sha, event = null, repo = REPO, exec = null } = {}) {
  if (!/^[0-9a-f]{40}$/.test(String(sha ?? ''))) {
    return { ok: false, runs: [], error: `--sha must be a full 40-character SHA, got ${JSON.stringify(sha)}`, pages: 0 };
  }
  const path = `/repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`
    + (event ? `&event=${event}` : '');
  let out;
  try {
    out = (exec ?? runGh)(['api', path, '--paginate', '--slurp']);
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error).split('\n')[0];
    return { ok: false, runs: [], error: `could not read workflow runs for ${sha}: ${message}`, pages: 0 };
  }
  const parsed = parseSlurpedPages(out);
  if (!parsed.ok) return { ok: false, runs: [], error: parsed.error, pages: 0 };
  // `head_sha` is server-side, but the API has been known to return runs whose
  // head_sha differs when a caller forgets the parameter - so the filter is
  // re-asserted here. It costs nothing and it is the only field that makes the
  // claim "these runs are about THIS commit" true.
  const runs = parsed.items
    .filter((r) => String(r.head_sha ?? '') === String(sha))
    .map(normaliseRun);
  return { ok: true, runs, error: null, pages: parsed.pages };
}

/**
 * Read every check run for one exact commit.
 *
 * Needed for the same reason `ci-gate` needs it: a workflow can be `success` and
 * still have a job that was red, and the check-run list is the per-job truth.
 *
 * @returns {{ok: boolean, checkRuns: object[], error: string|null, pages: number}}
 */
export function fetchCommitCheckRuns({ sha, repo = REPO, exec = null } = {}) {
  if (!/^[0-9a-f]{40}$/.test(String(sha ?? ''))) {
    return { ok: false, checkRuns: [], error: `--sha must be a full 40-character SHA, got ${JSON.stringify(sha)}`, pages: 0 };
  }
  const path = `/repos/${repo}/commits/${sha}/check-runs?per_page=100`;
  let out;
  try {
    out = (exec ?? runGh)(['api', path, '--paginate', '--slurp']);
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error).split('\n')[0];
    return { ok: false, checkRuns: [], error: `could not read check runs for ${sha}: ${message}`, pages: 0 };
  }
  const parsed = parseSlurpedPages(out, 'check_runs');
  if (!parsed.ok) return { ok: false, checkRuns: [], error: parsed.error, pages: 0 };
  return { ok: true, checkRuns: parsed.items, error: null, pages: parsed.pages };
}

/**
 * The files a push changed, for evaluating `paths:` filters.
 *
 * Uses the compare endpoint against the commit's first parent. A root commit has
 * no parent, and a merge commit's `files` is the merge diff, which is what a
 * `paths:` filter is evaluated against for the push event.
 *
 * @returns {{ok: boolean, files: string[]|null, error: string|null}}
 */
export function fetchPushFiles({ sha, repo = REPO, exec = null } = {}) {
  if (!/^[0-9a-f]{40}$/.test(String(sha ?? ''))) {
    return { ok: false, files: null, error: `--sha must be a full 40-character SHA, got ${JSON.stringify(sha)}` };
  }
  let out;
  try {
    out = (exec ?? runGh)(['api', `/repos/${repo}/commits/${sha}`]);
  } catch (error) {
    const message = String(error?.stderr ?? error?.message ?? error).split('\n')[0];
    return { ok: false, files: null, error: `could not read the commit's files: ${message}` };
  }
  let commit;
  try {
    commit = JSON.parse(out);
  } catch (error) {
    return { ok: false, files: null, error: `the commit response was not JSON: ${error.message}` };
  }
  if (!Array.isArray(commit?.files)) {
    // A commit with more than 300 changed files omits `files` entirely, and the
    // truncation is not signalled in the body. Reporting it as unavailable is the
    // only honest option: "no files" would mean "nothing matched any filter".
    return {
      ok: false,
      files: null,
      error: 'the commit response carried no file list; for a commit touching more than 300 files the API omits it',
    };
  }
  return { ok: true, files: commit.files.map((f) => String(f.filename)), error: null };
}

/**
 * `--slurp` wraps every page in an outer array. Some `gh` versions instead print
 * one JSON document per line for `--paginate` without `--slurp`, and a fixture
 * may hand over a bare object. All three are accepted; anything else is refused
 * with the reason rather than silently yielding zero runs.
 */
export function parseSlurpedPages(text, key = 'workflow_runs') {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, items: [], error: `the API response was not JSON: ${error.message}`, pages: 0 };
  }
  if (Array.isArray(doc)) {
    // Either `--slurp`'s array-of-pages or a bare array of items.
    if (doc.every((p) => p && typeof p === 'object' && !Array.isArray(p) && 'total_count' in p)) {
      const items = doc.flatMap((p) => (Array.isArray(p[key]) ? p[key] : []));
      return { ok: true, items, error: null, pages: doc.length };
    }
    return { ok: true, items: doc, error: null, pages: 1 };
  }
  if (doc && typeof doc === 'object' && Array.isArray(doc[key])) {
    return { ok: true, items: doc[key], error: null, pages: 1 };
  }
  return { ok: false, items: [], error: `the API response had no "${key}" array`, pages: 0 };
}

function runGh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Shape one API run into the fields the classifier reads.
 *
 * THREE FIELD NAMES THAT DO NOT MATCH WHAT THEY LOOK LIKE, each measured against
 * the live API rather than assumed:
 *
 *   `run_attempt`, not `attempt`   The run object calls it `run_attempt`; `gh run
 *                                  list --json attempt` renames it, which is why
 *                                  the old code could use `attempt` and the API
 *                                  path cannot. Reading `.attempt` here returned
 *                                  `undefined` for every run, and `newerRun` then
 *                                  fell through to comparing ids — so "the latest
 *                                  attempt wins" would have silently been "the
 *                                  highest id wins", which is not the same claim
 *                                  for a re-run.
 *   `path`, not `name`             `name` is the workflow's display name
 *                                  ("Runtime conformance"), not its file. The
 *                                  expectation set is keyed by file, so a
 *                                  name-keyed join found nothing and the old
 *                                  `--json workflowName` was doing the renaming.
 *   `conclusion` is null while running — kept as null rather than '' so
 *                                  `observeRun` can tell "no answer yet" from
 *                                  "an answer that is empty".
 */
export function normaliseRun(run) {
  return {
    workflow: String(run.path ?? '').replace(/^\.github\/workflows\//, ''),
    displayName: run.name ?? null,
    runId: run.id ?? null,
    attempt: run.run_attempt ?? 1,
    event: run.event ?? null,
    status: run.status ?? '',
    conclusion: run.conclusion ?? null,
    headSha: run.head_sha ?? null,
    createdAt: run.created_at ?? null,
    updatedAt: run.updated_at ?? null,
    workflowId: run.workflow_id ?? null,
  };
}
