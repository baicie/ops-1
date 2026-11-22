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

// --- an ambiguous match is a CLASS, not a footnote ---------------------------
//
// The first version computed `ambiguous` and left `class` as 'A'. A row could say
// `ambiguous: true` while being counted in the A total - "asserted by a spec, do
// not delete" - and the A total is exactly what a reader consults before deleting.
//
// Measured: `docs/assets/0.0.4/ui-redesign/mobile-studio.png` was class A on a
// basename match, while `tests/ui/studio.spec.ts` writes
// `artifacts/ui/studio/mobile-studio.png` - a different directory. Nothing
// referenced the doc copy.

test('a basename match shared by two files is UNKNOWN, not A', () => {
  const pngs = ['artifacts/ui/studio/x.png', 'docs/assets/0.0.4/x.png'];
  const refs = {
    assertion: new Map(),
    evidence: new Map(),
    bareAssertion: new Map([['x.png', ['tests/ui/studio.spec.ts']]]),
    bareEvidence: new Map(),
  };
  const rows = classify(pngs, refs);
  for (const r of rows) {
    assert.equal(r.ambiguous, true, `${r.path} should be flagged`);
    assert.equal(r.class, 'UNKNOWN',
      `${r.path} is ambiguous but was counted as ${r.class}; the A total is what a `
      + 'reader consults before deleting');
  }
});

test('a basename match that is UNIQUE is a real match, and may be A', () => {
  const pngs = ['artifacts/ui/studio/only.png'];
  const refs = {
    assertion: new Map(), evidence: new Map(),
    bareAssertion: new Map([['only.png', ['tests/ui/s.spec.ts']]]),
    bareEvidence: new Map(),
  };
  const [row] = classify(pngs, refs);
  assert.equal(row.ambiguous, false);
  assert.equal(row.class, 'A', 'a name only one file has is evidence, not a guess');
});

test('a PATH match is never ambiguous, even when the basename is shared', () => {
  // The defect the path rule exists for: a document that writes the directory is
  // unambiguous about which file it means.
  const pngs = ['a/x.png', 'b/x.png'];
  const refs = {
    assertion: new Map([['a/x.png', ['tests/a.spec.ts']]]),
    evidence: new Map(),
    bareAssertion: new Map(), bareEvidence: new Map(),
  };
  const rows = classify(pngs, refs);
  const a = rows.find((r) => r.path === 'a/x.png');
  assert.equal(a.class, 'A');
  assert.equal(a.ambiguous, false);
});

test('UNKNOWN rows are neither A nor B nor C, so the totals must add up', () => {
  // A class the summary has no column for makes the table stop adding up, which is
  // the first thing a reader stops trusting.
  const pngs = ['a/dup.png', 'b/dup.png', 'c/.keep'];
  const refs = {
    assertion: new Map(), evidence: new Map(),
    bareAssertion: new Map([['dup.png', ['tests/s.spec.ts']]]),
    bareEvidence: new Map(),
  };
  const rows = classify(pngs.filter((p) => p.endsWith('.png')), refs);
  const byClass = {};
  for (const r of rows) byClass[r.class] = (byClass[r.class] ?? 0) + 1;
  assert.equal(Object.values(byClass).reduce((a, b) => a + b, 0), rows.length,
    'every row belongs to exactly one class');
  assert.ok(!('A' in byClass), `no ambiguous row may be A: ${JSON.stringify(byClass)}`);
});
