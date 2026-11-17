#!/usr/bin/env node
/**
 * The ledger: every check run on one commit, attributed to the workflow that
 * produced it.
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * `ci-gate` used to read the check-run API inline, in a shell block, with a
 * `--jq` filter that threw away the only field that says WHICH workflow a check
 * came from. Two consequences, both real:
 *
 *   1. NAME COLLISIONS WERE UNSOLVABLE. The gate is keyed by check name, and a
 *      check name is a job's `name:` or its id - neither of which GitHub requires
 *      to be unique across workflows. `acceptance` is produced by
 *      `g12-acceptance.yml`. If a second workflow ever names a job `acceptance`,
 *      the old `group_by(.name) | map(last)` would pick whichever started latest
 *      and call it the answer. That is silently wrong in both directions: a green
 *      impostor can mask a red required check, and a red impostor can block a
 *      green one.
 *
 *   2. A FAILED API CALL LOOKED LIKE AN EMPTY COMMIT. The old pipeline ended in
 *      `2>/dev/null || echo '{}'`. Any transport error - and this session has
 *      measured TLS handshake timeouts against api.github.com - became "no checks
 *      exist", which the gate then reported as `delegated-absent` for every
 *      suite. That fails closed by ACCIDENT: it is red for a reason that has
 *      nothing to do with the commit, which trains the reader to ignore it, and
 *      it is indistinguishable from the real defect the lookup exists to catch.
 *      An API failure is its own answer and must be reported as one.
 *
 * ATTRIBUTION
 *
 * A check run carries `check_suite.id`; a workflow run carries the same value as
 * `check_suite_id`. Joining them names the workflow file. This is what makes
 * "the check named `acceptance`" mean "the check named `acceptance` THAT
 * `g12-acceptance.yml` PRODUCED", which is the only statement worth auditing.
 *
 * PAGINATION
 *
 * `gh api --paginate --jq <filter>` prints one array PER PAGE, concatenated with
 * newlines - not one array. That is not valid JSON. It went unnoticed because a
 * commit here has 23 check runs and `per_page=100` yields a single page; the
 * moment a commit crosses 100 (a PR that touches many workflows, or a matrix that
 * grows) the gate would feed `JSON.parse` a multi-document stream and die with a
 * syntax error instead of a verdict. The fetch below therefore uses
 * `--paginate --slurp` shaped by the caller, or reads pages itself - never
 * `--paginate` with a per-page transform that the caller then parses as one value.
 *
 * Usage (as a library; `ci-gate.mjs` imports it):
 *   import { attributeChecks } from './check-run-ledger.mjs';
 *   const ledger = attributeChecks(checkRuns, workflowRuns);
 */

/** Check statuses that mean "a result does not exist yet". */
export const UNFINISHED_STATUS = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

/** Conclusions that mean "this check did not pass", sorted for stable output. */
export const RED_CONCLUSIONS = new Set([
  'failure', 'timed_out', 'cancelled', 'action_required', 'stale', 'startup_failure',
]);

/**
 * Normalise one check run to the facts the gate needs.
 *
 * `conclusion` is null while a run is unfinished, and `status` is the only thing
 * that carries information then - so the "state" of a check is the conclusion if
 * there is one, else the status. This mirrors what the old inline jq did, but
 * keeps `check_suite.id` and the workflow path alongside it.
 */
export function normaliseCheckRun(run) {
  const status = String(run?.status ?? 'unknown');
  const conclusion = run?.conclusion == null ? null : String(run.conclusion);
  return {
    name: String(run?.name ?? ''),
    status,
    conclusion,
    state: conclusion ?? status,
    suiteId: run?.check_suite?.id == null ? null : String(run.check_suite.id),
    startedAt: run?.started_at ?? null,
    completedAt: run?.completed_at ?? null,
    runId: run?.id == null ? null : String(run.id),
    app: run?.app?.slug ?? null,
  };
}

/**
 * Build the ledger: check name -> every run with that name, each attributed to a
 * workflow path when one can be found.
 *
 * Deliberately returns a LIST per name rather than collapsing to "the latest".
 * Collapsing is a decision, and a decision made before you know whether the
 * duplicates agree is how a green impostor gets through. The caller sees the
 * ambiguity and has to resolve it.
 *
 * @param {object[]} checkRuns raw `check_runs` entries from the API
 * @param {object[]} workflowRuns raw `workflow_runs` entries, same commit
 * @returns {{byName: Record<string, object[]>, unattributed: string[],
 *            duplicates: string[], suites: Record<string, string>}}
 */
export function attributeChecks(checkRuns, workflowRuns = []) {
  const suiteToWorkflow = {};
  for (const wf of workflowRuns ?? []) {
    if (wf?.check_suite_id == null) continue;
    const path = String(wf.path ?? wf.name ?? '');
    if (!path) continue;
    suiteToWorkflow[String(wf.check_suite_id)] = path.replace(/^\.github\/workflows\//, '');
  }

  const byName = {};
  const unattributed = [];
  for (const raw of checkRuns ?? []) {
    const run = normaliseCheckRun(raw);
    if (!run.name) continue;
    const workflow = run.suiteId == null ? null : (suiteToWorkflow[run.suiteId] ?? null);
    const entry = { ...run, workflow };
    (byName[run.name] ??= []).push(entry);
    if (workflow == null) unattributed.push(run.name);
  }

  // Names that appear more than once. Not itself an error - a re-run produces a
  // second check run - but the gate must know which ones need disambiguation.
  const duplicates = Object.entries(byName)
    .filter(([, runs]) => new Set(runs.map((r) => r.suiteId)).size > 1)
    .map(([name]) => name);

  return { byName, unattributed: [...new Set(unattributed)].sort(), duplicates: duplicates.sort(), suites: suiteToWorkflow };
}

/**
 * The answer for one check name, optionally restricted to one workflow.
 *
 * RULES, and each one is a counterfactual in `check-run-ledger.test.mjs`:
 *
 *   no runs at all            -> 'absent'    (the workflow did not run)
 *   every run unfinished      -> 'pending'
 *   any run red               -> 'failed'    (a red attempt is an answer; a
 *                                             later green re-run clears it only
 *                                             by making "the latest" green)
 *   every run success         -> 'success'
 *   mixed success/skipped     -> 'skipped'
 *
 * When several runs share a name, "the latest completed attempt" decides - that
 * is what a re-run means - but a name claimed by MORE THAN ONE WORKFLOW is a
 * different thing and is reported as `ambiguous` rather than guessed. The caller
 * passes `workflow` when the suite names one; without it, ambiguity is surfaced.
 *
 * @param {Record<string, object[]>} byName from `attributeChecks`
 * @param {string} name check name
 * @param {{workflow?: string|null}} [opts]
 * @returns {{state: string, runs: object[], reason?: string}}
 */
export function checkState(byName, name, opts = {}) {
  const wanted = opts.workflow ? opts.workflow.replace(/^\.github\/workflows\//, '') : null;
  let runs = byName[name] ?? [];

  if (wanted) {
    runs = runs.filter((r) => r.workflow === wanted);
    if (runs.length === 0) {
      const elsewhere = (byName[name] ?? []);
      if (elsewhere.length > 0) {
        // The name exists, but not from the workflow that owns the suite. This is
        // exactly the impostor case: reporting `success` here would credit the
        // wrong workflow.
        return {
          state: 'impostor',
          runs: elsewhere,
          reason: `check named "${name}" exists on this commit but was produced by ${[...new Set(elsewhere.map((r) => r.workflow ?? 'an unattributable source'))].join(', ')}, not ${wanted}`,
        };
      }
      return { state: 'absent', runs: [], reason: `no check named "${name}" from ${wanted} on this commit` };
    }
  }

  if (runs.length === 0) return { state: 'absent', runs: [], reason: `no check named "${name}" on this commit` };

  const workflows = [...new Set(runs.map((r) => r.workflow ?? null))];
  if (!wanted && workflows.length > 1) {
    return {
      state: 'ambiguous',
      runs,
      reason: `check named "${name}" was produced by ${workflows.length} workflows (${workflows.map((w) => w ?? 'unknown').join(', ')}); the gate cannot attribute it`,
    };
  }

  const completed = runs.filter((r) => !UNFINISHED_STATUS.has(r.state));
  if (completed.length === 0) {
    return { state: 'pending', runs, reason: `check named "${name}" is ${[...new Set(runs.map((r) => r.state))].join('/')}` };
  }

  // Latest completed attempt decides. `started_at` may be null on an old run;
  // fall back to the run id, which is monotonic per repository.
  const latest = completed.reduce((a, b) => {
    const ta = Date.parse(a.startedAt ?? '') || Number(a.runId) || 0;
    const tb = Date.parse(b.startedAt ?? '') || Number(b.runId) || 0;
    return tb >= ta ? b : a;
  });

  if (latest.state === 'success') return { state: 'success', runs, reason: `check named "${name}" succeeded` };
  if (latest.state === 'skipped') return { state: 'skipped', runs, reason: `check named "${name}" was skipped` };
  if (RED_CONCLUSIONS.has(latest.state) || latest.state === 'neutral') {
    return { state: 'failed', runs, reason: `check named "${name}" is ${latest.state}` };
  }
  return { state: latest.state, runs, reason: `check named "${name}" is ${latest.state}` };
}
