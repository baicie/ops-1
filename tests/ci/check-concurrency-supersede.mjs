#!/usr/bin/env node
/**
 * Which runs can cancel which, proven by evaluating the group expression and
 * simulating GitHub's documented semantics - not by matching substrings.
 *
 * THE DEFECT THIS REPLACES
 *
 * The previous guard asserted that `cancel-in-progress` mentions the words
 * `pull_request` and `push`. That is satisfied by:
 *
 *     group: ${{ github.workflow }}-${{ github.ref }}
 *     cancel-in-progress: ${{ github.event_name == 'pull_request' || github.event_name == 'push' }}
 *
 * which is what this repository shipped in #170 - and it is wrong twice:
 *
 *   1. `cancel-in-progress` is evaluated by the INCOMING run. A push whose
 *      expression is `true` cancels a `workflow_dispatch` that is already
 *      running in the same group, because the group does not distinguish them.
 *      The guard passed it: no substring in that expression cancels a manual
 *      run, yet the GROUP put them together and the arriving run decides.
 *
 *   2. Even with `cancel-in-progress: false`, GitHub's default `queue: single`
 *      displaces an already-pending run: "any existing pending job or workflow
 *      run in the same concurrency group is canceled" and the newcomer takes
 *      its place (docs.github.com, Using concurrency). So a manual run waiting
 *      behind a push is lost when a second push arrives, whatever the flag says.
 *
 * Both dissolve when the GROUP differs by event class: a protected run
 * (`workflow_dispatch`, `schedule`) gets a group keyed on its own `run_id`, so
 * no automatic run can ever share a group with it.
 *
 * WHAT THIS CHECKS
 *
 * It evaluates the workflow's real `group` and `cancel-in-progress` expressions
 * against synthetic events (a tiny evaluator over the two constructs that appear:
 * `&&` / `||` / `format()` / `github.*`), then simulates arrivals and asserts
 * which runs survive. Substring matching cannot express "A cancels B".
 *
 * Run with --selftest for the evaluator and the semantic model.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WF = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));

// ---------------------------------------------------------------------------
// A deliberately small evaluator for the subset of the expression language these
// concurrency blocks use. It is not a general GitHub Expressions interpreter:
// if a workflow grows a construct it does not know, `evaluate` throws and the
// guard FAILS CLOSED rather than silently treating an unknown expression as
// "no conflict". That is the behaviour a guard needs - an unparseable rule is a
// rule nobody has checked.
// ---------------------------------------------------------------------------

/** Parse `a && b || c` into a right-associative chain, honouring parentheses. */
function parseExpr(src) {
  const s = src.trim();
  if (s.startsWith('(') && s.endsWith(')') && balanced(s.slice(1, -1))) {
    return parseExpr(s.slice(1, -1));
  }
  const orAt = topLevelIndex(s, '||');
  if (orAt !== -1) return { op: '||', left: parseExpr(s.slice(0, orAt)), right: parseExpr(s.slice(orAt + 2)) };
  const andAt = topLevelIndex(s, '&&');
  if (andAt !== -1) return { op: '&&', left: parseExpr(s.slice(0, andAt)), right: parseExpr(s.slice(andAt + 2)) };
  return { op: 'atom', src: s };
}

function balanced(s) {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth < 0) return false; }
  }
  return depth === 0;
}

function topLevelIndex(s, token) {
  let depth = 0;
  for (let i = 0; i < s.length - 1; i += 1) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') depth -= 1;
    else if (depth === 0 && s.startsWith(token, i)) return i;
  }
  return -1;
}

/** Split `format('a-{0}', x)` arguments at top-level commas. */
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '(') depth += 1;
    else if (s[i] === ')') depth -= 1;
    else if (s[i] === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map((a) => a.trim()).filter(Boolean);
}

function evaluateNode(node, ctx) {
  if (node.op !== 'atom') {
    const left = evaluateNode(node.left, ctx);
    if (node.op === '&&') return left ? evaluateNode(node.right, ctx) : left;
    return left ? left : evaluateNode(node.right, ctx);
  }
  const src = node.src.trim();
  // `a == b` / `a != b`, the only comparison these expressions use. Handled
  // before the atom table so `github.event_name == 'push'` never reaches the
  // "unknown atom" throw.
  const cmp = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(src);
  if (cmp && !/^'/.test(src)) {
    const left = evaluateNode(parseExpr(cmp[1]), ctx);
    const right = evaluateNode(parseExpr(cmp[3]), ctx);
    return cmp[2] === '==' ? left === right : left !== right;
  }
  const lit = /^'([^']*)'$/.exec(src);
  if (lit) return lit[1];
  if (src === 'true') return true;
  if (src === 'false') return false;
  if (/^\d+$/.test(src)) return Number(src);
  const gh = /^github\.([A-Za-z_.]+)$/.exec(src);
  if (gh) {
    const value = gh[1].split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), ctx.github);
    if (value === undefined) throw new Error(`unknown github context: github.${gh[1]}`);
    return value;
  }
  // `inputs.<name>`. Only the `workflow_dispatch` trigger has it, and a group
  // that reads it is keying on a caller-supplied value — which is what
  // `main-verification.yml` does so a dispatch verifies the commit it names.
  const inp = /^inputs\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(src);
  if (inp) {
    const value = ctx.inputs?.[inp[1]];
    if (value === undefined) throw new Error(`unknown input: inputs.${inp[1]}`);
    return value;
  }
  const fmt = /^format\(([\s\S]*)\)$/.exec(src);
  if (fmt) {
    const args = splitArgs(fmt[1]).map((a) => evaluateNode(parseExpr(a), ctx));
    const template = String(args[0]);
    return template.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i) + 1]));
  }
  throw new Error(`cannot evaluate expression atom: ${src}`);
}

/**
 * Evaluate a string that may contain SEVERAL `${{ ... }}` segments, which is the
 * normal shape of a `group:` line:
 *
 *     ${{ github.workflow }}-${{ cond && format(...) || format(...) }}
 *
 * The first version matched the whole line as a single expression and blew up on
 * the literal `-` between the two segments. Interpolation, not whole-string
 * matching, is what GitHub does - so it is what this does.
 */
export function evaluate(expr, ctx) {
  const src = expr.trim();
  if (!src.includes('${{')) {
    if (/^(true|false)$/i.test(src)) return src.toLowerCase() === 'true';
    return src;
  }
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('${{', i);
    if (open === -1) { out += src.slice(i); break; }
    out += src.slice(i, open);
    const close = src.indexOf('}}', open + 3);
    if (close === -1) throw new Error(`unterminated expression in: ${src}`);
    const value = evaluateNode(parseExpr(src.slice(open + 3, close)), ctx);
    out += typeof value === 'boolean' ? String(value) : String(value);
    i = close + 2;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The semantics, from GitHub's documentation.
// ---------------------------------------------------------------------------
//
// `cancel-in-progress` is read from the INCOMING run. A currently running run in
// the same group is cancelled only when the newcomer's flag is true.
//
// Independently of that flag, and always: "any existing pending job or workflow
// run in the same concurrency group is canceled" so the newcomer can take the
// pending slot (default `queue: single`). Modelling this is the whole point -
// the old guard could not see it, and it is what loses a queued manual run.
export function simulate(arrivals) {
  // Each group holds at most one RUNNING and one PENDING run.
  const groups = new Map();
  // A run is "cancelled" if it was running and an arrival with
  // cancel-in-progress displaced it, or if it was pending and a third arrival
  // took its slot. Both are terminal.
  const cancelled = new Set();

  for (const run of arrivals) {
    const slot = groups.get(run.group) ?? { running: null, pending: null };

    if (slot.running && run.cancelInProgress) {
      cancelled.add(slot.running);
      slot.running = null;
    }
    if (slot.pending) {
      // Unconditional per the docs: a newcomer takes the pending slot.
      cancelled.add(slot.pending);
      slot.pending = null;
    }

    if (slot.running) {
      slot.pending = run.id;
    } else {
      slot.running = run.id;
    }
    groups.set(run.group, slot);
  }

  // Everything that was never cancelled did run (or will run after its blocker
  // finishes): the running one, and whatever is still pending at the end.
  const survivors = [];
  for (const slot of groups.values()) {
    if (slot.running) survivors.push(slot.running);
    if (slot.pending) survivors.push(slot.pending);
  }
  return { cancelled, survivors };
}

// ---------------------------------------------------------------------------
// Per-workflow concurrency block extraction.
// ---------------------------------------------------------------------------

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

export function parseConcurrency(text) {
  const block = concurrencyOf(text);
  if (block === null) return null;
  const group = /^\s+group:\s*(.+)$/m.exec(block)?.[1]?.trim();
  const cip = /^\s+cancel-in-progress:\s*(.+)$/m.exec(block)?.[1]?.trim();
  return { group, cancelInProgress: cip, raw: block };
}

/** Build the evaluation context for a synthetic event. */
export function ctxFor(workflow, { event, ref, runId }) {
  return { github: { workflow, ref, event_name: event, run_id: runId } };
}

/**
 * The cancellation matrix every suite workflow must satisfy.
 *
 * Each case is `[label, arrivals, mustSurvive]`. Arrivals are event names; ids
 * and run ids are synthesised so a `workflow_dispatch` and a `push` never share
 * one by accident.
 */
export function matrixFor(workflow, conc) {
  const ev = (event, n, ref = 'refs/heads/main') => ({
    id: `${event}#${n}`,
    event,
    ref,
    group: evaluate(conc.group, ctxFor(workflow, { event, ref, runId: 1000 + n })),
    cancelInProgress: evaluate(conc.cancelInProgress, ctxFor(workflow, { event, ref, runId: 1000 + n })),
  });
  return [
    ['push A -> push B: the older push is superseded', [ev('push', 1), ev('push', 2)], ['push#2']],
    ['pr A -> pr B: the older commit is superseded',
      [ev('pull_request', 1, 'refs/pull/9/merge'), ev('pull_request', 2, 'refs/pull/9/merge')], ['pull_request#2']],
    ['dispatch A -> push B: the manual run survives', [ev('workflow_dispatch', 1), ev('push', 2)],
      ['workflow_dispatch#1', 'push#2']],
    ['push A -> dispatch B: neither cancels the other', [ev('push', 1), ev('workflow_dispatch', 2)],
      ['push#1', 'workflow_dispatch#2']],
    ['schedule A -> push B: the nightly survives', [ev('schedule', 1), ev('push', 2)],
      ['schedule#1', 'push#2']],
    ['two manual runs behind a push: neither manual run is displaced',
      [ev('push', 1), ev('workflow_dispatch', 2), ev('workflow_dispatch', 3)],
      ['push#1', 'workflow_dispatch#2', 'workflow_dispatch#3']],
    ['two different refs: the pushes do not touch each other',
      [ev('push', 1, 'refs/heads/a'), ev('push', 2, 'refs/heads/b')], ['push#1', 'push#2']],
  ];
}

export function inspect(name, text) {
  const conc = parseConcurrency(text);
  if (conc === null) return [`${name}: no concurrency: block; a superseded push runs to completion`];
  if (!conc.group) return [`${name}: concurrency has no group`];
  if (!conc.cancelInProgress) return [`${name}: concurrency has no cancel-in-progress`];

  const problems = [];
  for (const [label, arrivals, mustSurvive] of matrixFor(name, conc)) {
    let result;
    try {
      result = simulate(arrivals);
    } catch (error) {
      problems.push(`${name}: ${label}: cannot evaluate the group/cancel expression (${error.message})`);
      continue;
    }
    for (const id of mustSurvive) {
      if (!result.survivors.includes(id)) {
        problems.push(`${name}: ${label}: ${id} was cancelled - ${result.cancelled.has(id) ? 'cancelled by an arrival' : 'did not run'}`);
      }
    }
    // And the superseded ones must actually be gone, or "supersession" is a claim
    // nothing enforces.
    const shouldDie = arrivals.map((a) => a.id).filter((id) => !mustSurvive.includes(id));
    for (const id of shouldDie) {
      if (result.survivors.includes(id)) {
        problems.push(`${name}: ${label}: ${id} survived but should have been superseded`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------

const GOOD = `name: x
on: [push, pull_request, workflow_dispatch]
concurrency:
  group: \${{ github.workflow }}-\${{ (github.event_name == 'workflow_dispatch' || github.event_name == 'schedule') && format('protected-{0}', github.run_id) || format('auto-{0}', github.ref) }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' || github.event_name == 'push' }}
jobs: {}
`;

const REF_ONLY = `name: x
concurrency:
  group: x-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' || github.event_name == 'push' }}
jobs: {}
`;

function selftest() {
  const cases = [
    ['the evaluator resolves a ternary chain',
      () => evaluate("${{ (github.event_name == 'workflow_dispatch') && format('p-{0}', github.run_id) || format('a-{0}', github.ref) }}",
        ctxFor('w', { event: 'workflow_dispatch', ref: 'r', runId: 7 })) === 'p-7',
      'dispatch must land in its own protected bucket'],
    ['the evaluator resolves the automatic branch',
      () => evaluate("${{ (github.event_name == 'workflow_dispatch') && format('p-{0}', github.run_id) || format('a-{0}', github.ref) }}",
        ctxFor('w', { event: 'push', ref: 'r', runId: 7 })) === 'a-r',
      'a push must land in the ref bucket'],
    ['an unknown atom fails closed',
      () => { try { evaluate('${{ nonsense(1) }}', ctxFor('w', { event: 'push', ref: 'r', runId: 1 })); return false; } catch { return true; } },
      'an unparseable expression must not be treated as "no conflict"'],
    ['the ref-only group FAILS the matrix',
      () => inspect('ref-only.yml', REF_ONLY).some((p) => /workflow_dispatch#1 was cancelled/.test(p)),
      'the shipped-#170 shape must be rejected: a push cancels a running manual run'],
    ['the isolated group PASSES the matrix',
      () => inspect('good.yml', GOOD).length === 0,
      'run_id isolation must satisfy every case'],
    ['a bare true is rejected on a ref-only group',
      () => inspect('t.yml', REF_ONLY.replace(/cancel-in-progress:.*/, 'cancel-in-progress: true')).length > 0,
      'cancel-in-progress: true with one group cancels manual runs'],
  ];
  let bad = 0;
  for (const [label, fn, why] of cases) {
    let ok = false;
    try { ok = fn(); } catch (e) { ok = false; }
    if (!ok) bad += 1;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` - ${why}`}\n`);
  }
  process.stdout.write(`concurrency matrix selftest: ${cases.length - bad}/${cases.length}\n`);
  return bad === 0;
}

if (process.argv[2] === '--selftest') {
  process.exit(selftest() ? 0 : 1);
}

const files = readdirSync(WF).filter((n) => n.endsWith('.yml')).sort();
let errors = 0;
for (const file of files) {
  // `staging-preview.yml` is excluded from the generic matrix: it is a deployment
  // workflow with its own transaction lock and a different contract, checked
  // separately (see docs/ci/staging-concurrency.md).
  if (file === 'staging-preview.yml') continue;

  // `release-certification.yml` is the OPPOSITE requirement, and it is the only
  // file where superseding is wrong (ADR-029).
  //
  // Its automatic trigger is `push` on tags, not branches: each tag names a
  // different commit, and each certification is evidence about that commit. Two
  // certifications of one SHA must both survive, because the second is a second
  // record rather than a correction of the first.
  //
  // So the expectation is inverted - two pushes must BOTH survive - and it is
  // checked explicitly rather than left as an unregistered exception. A workflow
  // that quietly opts out of the matrix is how the matrix stops meaning anything.
  if (file === 'release-certification.yml' || file === 'main-verification.yml') {
    const conc = parseConcurrency(readFileSync(WF + file, 'utf8'));
    const problems = [];
    if (!conc) problems.push(`${file}: no concurrency: block`);
    else {
      // `main-verification.yml` keys on the COMMIT, so two DIFFERENT commits never
      // share a group. The matrix below models one `main` ref and cannot see
      // `github.sha`, so for it the meaningful property is the same one
      // certification has: one push must not displace another commit's evidence.
      // Two pushes to one ref are two commits, and each was a real push to main
      // whose verification is its own record.
      let a, b;
      // `github.sha` and `inputs.*` are modelled here because a per-commit group
      // needs them; `ctxFor` builds the subset the suite workflows use, and
      // widening it would change what their cases assert.
      const pushCtx = (n, sha) => ({
        github: { workflow: file, ref: 'refs/heads/main', event_name: 'push', run_id: 1000 + n, sha },
        inputs: { sha },
      });
      try {
        a = evaluate(conc.group, pushCtx(1, 'a'.repeat(40)));
        b = evaluate(conc.group, pushCtx(2, 'b'.repeat(40)));
        // A workflow_dispatch for an OLD commit must not displace that commit's
        // push verification either: the dispatch is a re-ask of the same question.
        const dispatch = evaluate(conc.group, {
          github: { workflow: file, ref: 'refs/heads/main', event_name: 'workflow_dispatch', run_id: 3000, sha: 'b'.repeat(40) },
          inputs: { sha: 'b'.repeat(40) },
        });
        if (a === b) {
          problems.push(`${file}: two different commits share group "${a}"; verification is per-commit evidence and must not be displaced`);
        }
        if (dispatch !== b) {
          // Only `main-verification.yml` keys on the commit; certification keys
          // on `run_id`, where a dispatch is deliberately a separate record.
          if (file === 'main-verification.yml') {
            problems.push(`${file}: a workflow_dispatch for commit ${'b'.repeat(7)} lands in group "${dispatch}" rather than "${b}"; a re-ask of the same commit must not displace its push verification`);
          }
        }
      } catch (error) {
        problems.push(`${file}: cannot evaluate the group (${error.message})`);
      }
  // The property the brief names: the observer must never cancel a run that
  // would otherwise produce evidence. `cancelInProgress` is the RAW STRING
  // (`'false'`), which is truthy — so it is evaluated, not tested for truthiness.
  // The same bug was latent in the release-certification branch above, where no
  // assertion read the field.
  let cip;
  try {
    cip = evaluate(conc.cancelInProgress, pushCtx(1, 'a'.repeat(40)));
  } catch (error) {
    problems.push(`${file}: cannot evaluate cancel-in-progress (${error.message})`);
  }
  if (cip === true) {
    problems.push(`${file}: cancel-in-progress is true; a cancelled observer reports nothing about its commit`);
  }
    }
    for (const p of problems) { errors += 1; process.stdout.write(`ERROR ${p}\n`); }
    continue;
  }
  for (const p of inspect(file, readFileSync(WF + file, 'utf8'))) {
    errors += 1;
    process.stdout.write(`ERROR ${p}\n`);
  }
}
process.stdout.write(`concurrency matrix: ${errors} error(s) across ${files.length - 1} suite workflow(s)\n`);
process.exit(errors === 0 ? 0 : 1);
