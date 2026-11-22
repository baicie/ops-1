#!/usr/bin/env node
/**
 * The PNG classifier, tested against the mistake it was rewritten for.
 *
 * The first version keyed every citation on the BASENAME. Eight tracked files
 * are named `job-detail.png`, so one document citing
 * `../assets/0.0.4/hardening/job-detail.png` made all eight look cited.
 *
 * These cases pin the two rules that replaced it:
 *   - a path match beats a bare-name match;
 *   - a bare-name match on a SHARED basename is flagged as a guess, because
 *     "is anything using this?" must not be answered by one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './classify-visual-assets.mjs';

const EMPTY = () => ({
  evidence: new Map(), assertion: new Map(),
  bareEvidence: new Map(), bareAssertion: new Map(),
});

test('a path citation classifies the file it names and no sibling', () => {
  const refs = EMPTY();
  refs.evidence.set('hardening/job-detail.png', ['docs/a.md']);
  const rows = classify(
    ['docs/assets/0.0.4/hardening/job-detail.png', 'docs/assets/0.0.4/ui-redesign/job-detail.png'],
    refs,
  );
  assert.equal(rows[0].class, 'B');
  assert.equal(rows[0].match, 'path');
  assert.equal(rows[1].class, 'C', 'a same-named sibling must not inherit the citation');
});

test('a bare-name match on a unique basename is accepted', () => {
  const refs = EMPTY();
  refs.bareAssertion.set('only-one.png', ['tests/x.spec.ts']);
  const rows = classify(['artifacts/ui/only-one.png'], refs);
  assert.equal(rows[0].class, 'A');
  assert.equal(rows[0].ambiguous, false, 'a unique name is evidence, not a guess');
});

test('a bare-name match on a SHARED basename is flagged ambiguous', () => {
  const refs = EMPTY();
  refs.bareAssertion.set('job-history.png', ['tests/x.spec.ts']);
  const rows = classify(
    ['artifacts/ui/studio/job-history.png', 'docs/assets/0.0.4/job-history.png'],
    refs,
  );
  assert.equal(rows[0].ambiguous, true, 'the spec may be writing either one');
  assert.equal(rows[1].ambiguous, true);
});

test('a path match is never ambiguous, however many share the name', () => {
  const refs = EMPTY();
  refs.evidence.set('studio/job-history.png', ['docs/a.md']);
  const rows = classify(
    ['artifacts/ui/studio/job-history.png', 'docs/assets/0.0.4/job-history.png'],
    refs,
  );
  assert.equal(rows[0].class, 'B');
  assert.equal(rows[0].ambiguous, false);
  assert.equal(rows[1].class, 'C');
});

test('the longest path suffix wins', () => {
  const refs = EMPTY();
  // A document naming the full path and another naming only two segments.
  refs.evidence.set('a/b/c.png', ['docs/deep.md']);
  refs.evidence.set('b/c.png', ['docs/shallow.md']);
  const rows = classify(['a/b/c.png'], refs);
  assert.deepEqual(rows[0].citedBy, ['docs/deep.md'],
    'the more specific key must win, not the first one inserted');
});

test('nothing cited is class C', () => {
  const rows = classify(['artifacts/ui/x.png'], EMPTY());
  assert.equal(rows[0].class, 'C');
  assert.equal(rows[0].match, 'none');
});
