#!/usr/bin/env node
/**
 * Decide which commit a certification is about, and refuse when it is not clear.
 *
 * WHY THIS IS A SCRIPT AND NOT A SHELL BLOCK
 *
 * `release-certification.yml`'s `resolve` job decides the SHA that every later
 * step certifies. It had five branches and no test: the workflow exists, so the
 * chain was assumed verified. That is the same assumption `docs/ci/failure-analysis`
 * records as wrong - "the workflow exists" is not "the workflow is correct".
 *
 * The branches, each of which must refuse rather than proceed:
 *
 *   not 40 lowercase hex              -> REFUSED (a typo would certify nothing)
 *   not a commit in this repository   -> REFUSED
 *   not an ancestor of origin/main    -> REFUSED (a branch tip can be force-pushed
 *                                       away; certifying it certifies nothing)
 *   a tag that does not resolve       -> REFUSED
 *   a dispatch for a SHA that IS fine -> OK, ref `refs/heads/main`
 *
 * WHAT IT DOES NOT DO: it does not create tags, push, or deploy. It reads git and
 * prints two lines.
 *
 * Usage:
 *   node scripts/ci/resolve-certification-target.mjs --event push --tag-ref refs/tags/v1
 *   node scripts/ci/resolve-certification-target.mjs --event workflow_dispatch --sha <40hex>
 *   ... --json
 */
import { execFileSync } from 'node:child_process';

const HEX40 = /^[0-9a-f]{40}$/;

/** Run git, returning stdout or throwing with a one-line message. */
function git(args, cwd) {
  return execFileSync('git', args, { encoding: 'utf8', cwd }).trim();
}

/**
 * Resolve the target without touching the repository.
 *
 * `git` is injectable so the tests can drive every branch without building
 * repositories: the point is the DECISION, and a test that has to create a commit
 * graph to exercise "not an ancestor" measures git, not this function.
 *
 * @param {{event: string, tagRef?: string, sha?: string, baseRef?: string}} input
 * @param {{git: Function}} deps
 * @returns {{ok: true, sha: string, ref: string} | {ok: false, problems: string[]}}
 */
export function resolveTarget(input, deps) {
  const run = deps.git;
  const problems = [];
  let sha = '';
  let ref = '';

  if (input.event === 'push') {
    // A tag names a commit; certify what the tag points at, not HEAD.
    const tag = String(input.tagRef ?? '').replace(/^refs\/tags\//, '');
    if (!tag) return { ok: false, problems: ['a push event carries no tag ref to resolve'] };
    try {
      sha = run(['rev-parse', `refs/tags/${tag}^{commit}`]).trim();
    } catch (error) {
      return { ok: false, problems: [`tag ${tag} does not resolve to a commit: ${firstLine(error)}`] };
    }
    ref = `refs/tags/${tag}`;
  } else {
    sha = String(input.sha ?? '').trim();
    // The DISPATCH branch has no tag, so the ref it records is the branch the
    // commit must be on. It is not "whatever the caller said": a receipt whose
    // `subject.ref` is caller-chosen is a receipt that can claim any provenance.
    ref = input.baseRef ?? 'refs/heads/main';
  }

  if (!HEX40.test(sha)) {
    return { ok: false, problems: [`sha must be 40 lowercase hex characters, got ${JSON.stringify(sha)}`] };
  }
  try {
    run(['cat-file', '-e', `${sha}^{commit}`]);
  } catch (error) {
    problems.push(`${sha} is not a commit in this repository: ${firstLine(error)}`);
  }
  if (problems.length === 0) {
    try {
      run(['merge-base', '--is-ancestor', sha, 'origin/main']);
    } catch {
      // A non-zero exit means "not an ancestor". It is the refusal the header
      // describes, not a transport failure, and must not be conflated with one.
      problems.push(`${sha} is not an ancestor of origin/main; certification is about what shipped`);
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, sha, ref };
}

const firstLine = (error) => String(error?.message ?? error).split('\n')[0];

// ---------------------------------------------------------------------------

const RUN_AS_PROGRAM = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (RUN_AS_PROGRAM) {
  const argv = process.argv.slice(2);
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };
  const event = arg('event');
  if (!event) {
    process.stderr.write('usage: resolve-certification-target.mjs --event push|workflow_dispatch'
      + ' [--tag-ref refs/tags/v1] [--sha <40hex>] [--json]\n');
    process.exit(2);
  }
  // `--depth` on the CLI is the real git; the tests inject their own.
  const result = resolveTarget(
    { event, tagRef: arg('tag-ref') ?? undefined, sha: arg('sha') ?? undefined },
    { git: (args) => git(args, process.cwd()) },
  );
  if (!result.ok) {
    for (const p of result.problems) process.stderr.write(`REFUSED: ${p}\n`);
    process.exit(1);
  }
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    process.stdout.write(`sha=${result.sha}\nref=${result.ref}\n`);
  }
}
