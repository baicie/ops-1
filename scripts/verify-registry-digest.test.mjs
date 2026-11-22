#!/usr/bin/env node
/**
 * The registry-digest check, driven through a FAKE registry.
 *
 * `scripts/verify-registry-digest.mjs` existed and nothing called it. Wiring it
 * into `publish-data-plugins.sh` is only worth something if the check actually
 * refuses, so these cases exercise `registryDigest` against a stub `fetch` rather
 * than against a real registry: the decision is what matters, and a test that needs
 * Docker measures Docker.
 *
 * The end-to-end run against a real `registry:2` WAS done by hand (build, push,
 * verify, then verify a wrong digest, a missing tag and an unreachable host) and
 * all four behaved as below. This file is what keeps it true without Docker.
 *
 * Run: node --test scripts/verify-registry-digest.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registryDigest, decide } from './verify-registry-digest.mjs';

/** A `fetch` that answers one status and one header set. */
const fetchReturning = (status, headers = {}) => () => Promise.resolve({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

test('a GET with the manifest Accept header is used, not HEAD', async () => {
  let seen = null;
  await registryDigest({
    registry: 'r:5000', repository: 'o/p', tag: 'v1',
    fetchImpl: (url, init) => { seen = { url, init }; return fetchReturning(200, { 'docker-content-digest': 'sha256:a' })(); },
  });
  assert.equal(seen.init.method, 'GET',
    'a HEAD returns 200 with no Docker-Content-Digest header - measured against registry:2');
  assert.match(seen.init.accept ?? seen.init.headers.accept, /manifest/);
  assert.match(seen.url, /\/v2\/o\/p\/manifests\/v1$/);
});

test('a 404 means the tag does not exist, and is null rather than an error', async () => {
  const d = await registryDigest({
    registry: 'r:5000', repository: 'o/p', tag: 'gone',
    fetchImpl: fetchReturning(404),
  });
  assert.equal(d, null, 'absence must be its own answer, distinguishable from a mismatch');
});

test('a 500 is an ERROR, not "no such tag"', async () => {
  // The distinction matters: a registry fault reported as "the push did not
  // happen" sends an operator to re-push a tag that is already there.
  await assert.rejects(
    () => registryDigest({ registry: 'r:5000', repository: 'o/p', tag: 'v1', fetchImpl: fetchReturning(500) }),
    /answered 500/,
  );
});

test('a 200 without Docker-Content-Digest is an ERROR', async () => {
  await assert.rejects(
    () => registryDigest({ registry: 'r:5000', repository: 'o/p', tag: 'v1', fetchImpl: fetchReturning(200, {}) }),
    /without a Docker-Content-Digest/,
  );
});

test('agreeing digests VERIFY', () => {
  assert.equal(decide({ expected: 'sha256:a', remote: 'sha256:a', local: 'sha256:a' }).verdict, 'VERIFIED');
});

test('a tag pointing at different bytes is REFUSED', () => {
  const r = decide({ expected: 'sha256:a', remote: 'sha256:b', local: 'sha256:a' });
  assert.equal(r.verdict, 'REFUSED');
  assert.match(r.problems.join(' '), /points at different bytes/);
});

test('the MEASURED staging defect: the tag resolves elsewhere', () => {
  // local RepoDigest sha256:d9e853e8, registry Docker-Content-Digest
  // sha256:45e09956, and GET /v2/.../manifests/sha256:d9e853e8 returned 404. The
  // bundle would have embedded a digest that fetches nothing.
  const r = decide({ expected: 'sha256:d9e853e8', remote: 'sha256:45e09956', local: 'sha256:d9e853e8' });
  assert.equal(r.verdict, 'REFUSED');
  assert.match(r.problems.join(' '), /points at different bytes/);
});

test('a local digest that disagrees with what was asked for is reported SEPARATELY', () => {
  // Two different failures, two different messages. Here the registry agrees with
  // the expectation but the DAEMON has a different record - a partial push, or a
  // daemon that never pushed this tag at all. Collapsing the two would send an
  // operator to the registry for a host problem.
  const r = decide({ expected: 'sha256:a', remote: 'sha256:a', local: 'sha256:c' });
  assert.equal(r.verdict, 'REFUSED');
  assert.match(r.problems.join(' '), /never pushed/);
  assert.doesNotMatch(r.problems.join(' '), /points at different bytes/);
});

test('no expected digest is REFUSED: verifying nothing is not verifying', () => {
  assert.equal(decide({ expected: null, remote: 'sha256:a', local: null }).verdict, 'REFUSED');
});

test('an absent tag is REFUSED even when local agrees with expected', () => {
  const r = decide({ expected: 'sha256:a', remote: null, local: 'sha256:a' });
  assert.equal(r.verdict, 'REFUSED');
  assert.match(r.problems.join(' '), /does not exist/);
});
