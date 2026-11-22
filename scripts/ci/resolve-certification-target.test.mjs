#!/usr/bin/env node
/**
 * Every branch of "which commit is being certified".
 *
 * The workflow existed and was assumed correct. Each case below is a way it could
 * certify the wrong thing, or refuse for the wrong reason - and the refusals matter
 * as much as the acceptances, because a certifier that cannot be trusted to say NO
 * is not a certifier.
 *
 * Run: node --test scripts/ci/resolve-certification-target.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget } from './resolve-certification-target.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

/** A git stub. `known` are commits that exist; `ancestors` are on main. */
function fakeGit({ known = [SHA], ancestors = [SHA], tagTarget = {}, fail = {} } = {}) {
  return {
    git(args) {
      const [cmd, ...rest] = args;
      if (fail[cmd]) throw new Error(`${cmd} failed`);
      if (cmd === 'rev-parse') {
        const ref = rest[0];
        const tag = ref.replace(/^refs\/tags\//, '').replace(/\^\{commit\}$/, '');
        if (!(tag in tagTarget)) throw new Error(`unknown revision ${ref}`);
        return `${tagTarget[tag]}\n`;
      }
      if (cmd === 'cat-file') {
        const sha = rest[1].replace(/\^\{commit\}$/, '');
        if (!known.includes(sha)) throw new Error(`not a valid object name ${sha}`);
        return '';
      }
      if (cmd === 'merge-base') {
        // args are ['merge-base', '--is-ancestor', <sha>, 'origin/main'], so `rest`
        // is ['--is-ancestor', <sha>, 'origin/main'] and the sha is rest[1].
        const sha = rest[1];
        if (!ancestors.includes(sha)) throw new Error('exit 1');
        return '';
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
  };
}

test('a dispatch for a commit on main is accepted', () => {
  const r = resolveTarget({ event: 'workflow_dispatch', sha: SHA }, fakeGit());
  assert.deepEqual(r, { ok: true, sha: SHA, ref: 'refs/heads/main' });
});

test('a tag resolves to the commit it points at, not HEAD', () => {
  const r = resolveTarget({ event: 'push', tagRef: 'refs/tags/v1.2.3' },
    fakeGit({ tagTarget: { 'v1.2.3': SHA } }));
  assert.deepEqual(r, { ok: true, sha: SHA, ref: 'refs/tags/v1.2.3' });
});

test('a tag that does not resolve is refused', () => {
  const r = resolveTarget({ event: 'push', tagRef: 'refs/tags/nope' }, fakeGit({ tagTarget: {} }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /does not resolve/);
});

test('a malformed SHA is refused before any git call', () => {
  for (const bad of ['xyz', 'A'.repeat(40), SHA.slice(0, 39), `${SHA}f`, '']) {
    const r = resolveTarget({ event: 'workflow_dispatch', sha: bad }, fakeGit());
    assert.equal(r.ok, false, `${JSON.stringify(bad)} was accepted`);
    assert.match(r.problems.join(' '), /40 lowercase hex/);
  }
});

test('an UPPERCASE 40-hex is refused, because git would accept it and the receipt would not', () => {
  // `release-receipt.mjs` validates `^[0-9a-f]{40}$`. A certifier that accepted
  // uppercase would write a receipt its own verifier rejects.
  const r = resolveTarget({ event: 'workflow_dispatch', sha: 'A'.repeat(40) }, fakeGit());
  assert.equal(r.ok, false);
});

test('a commit that does not exist in the repository is refused', () => {
  const r = resolveTarget({ event: 'workflow_dispatch', sha: OTHER }, fakeGit({ known: [SHA] }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /not a commit in this repository/);
});

test('a commit that is NOT an ancestor of main is refused', () => {
  const r = resolveTarget({ event: 'workflow_dispatch', sha: OTHER },
    fakeGit({ known: [OTHER], ancestors: [] }));
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /not an ancestor of origin\/main/);
});

test('the refusal names what happens without it: a force-pushed branch tip', () => {
  const r = resolveTarget({ event: 'workflow_dispatch', sha: OTHER },
    fakeGit({ known: [OTHER], ancestors: [] }));
  assert.match(r.problems.join(' '), /what shipped/);
});

test('a push with no tag ref is refused rather than falling through', () => {
  const r = resolveTarget({ event: 'push', tagRef: '' }, fakeGit());
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /no tag ref/);
});

test('the dispatch ref is not caller-chosen', () => {
  // A receipt whose `subject.ref` came from the person certifying can claim any
  // provenance. The dispatch branch records the branch the commit must be on.
  const r = resolveTarget({ event: 'workflow_dispatch', sha: SHA }, fakeGit());
  assert.equal(r.ref, 'refs/heads/main');
});

test('an explicit baseRef is honoured, so a fork or a mirror can certify its own main', () => {
  const r = resolveTarget({ event: 'workflow_dispatch', sha: SHA, baseRef: 'refs/heads/release' }, fakeGit());
  assert.equal(r.ref, 'refs/heads/release');
});
