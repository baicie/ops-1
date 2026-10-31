import { describe, expect, it } from 'vitest';
import { translate } from '../i18n';
import type { JobView, NodeView, Publisher } from '../types';
import { ABSENT_STATE, verifiedWriteFailure, verifyAfterWrite } from './verify-after-write';
import {
  describeJobStatus,
  describeNodeState,
  describePublisherTrust,
  describeUserRole,
  describeUserState,
  jobCancelledLanded,
  nodeRevokedLanded,
  publisherTrustedLanded,
  userCreatedLanded,
  userStateLanded,
  type ManagedUserRow,
} from './verified-writes';

/**
 * The three write buttons this file is about, each proven by the re-read the button now performs:
 * a user stopped, a job cancelled, a node revoked. Every case below is a page that used to print
 * "done" on a 200 whatever the resource said afterwards - so each assertion is written against
 * the sentence an operator would read, not against the HTTP status.
 */
const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('en', key, params);

const user = (over: Partial<ManagedUserRow> = {}): ManagedUserRow => ({
  id: 'u-1',
  email: 'dev@opsweave.local',
  role: 'viewer',
  disabled: false,
  ...over,
});

const job = (status: string): JobView => ({
  jobId: 'j-1',
  pipelineId: 'nightly',
  pipelineRevision: 3,
  status,
  currentFence: 1,
  attempts: 1,
  maxAttempts: 3,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const node = (over: Partial<NodeView> = {}): NodeView => ({
  id: 'n-1',
  name: 'node-a',
  generation: 2,
  os: 'linux',
  arch: 'arm64',
  labels: {},
  capabilities: [],
  status: 'READY',
  enrolledAt: '2026-01-01T00:00:00Z',
  stale: false,
  instancesReady: 0,
  instancesTotal: 0,
  ...over,
});

const publisher = (over: Partial<Publisher> = {}): Publisher => ({
  publisherId: 'trusted-team',
  fingerprint: 'fp',
  trustState: 'TRUSTED',
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

const notFound = () => Object.assign(new Error('not found'), { status: 404 });

describe('disabling a user is proven by the user list', () => {
  it('reports success only when the re-read says the account is disabled', async () => {
    const result = await verifyAfterWrite<ManagedUserRow[]>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.resolve([user({ disabled: true })]),
      expected: (users) => userStateLanded(users, 'u-1', true),
      describe: (users) => describeUserState(users, 'u-1'),
    });

    expect(result.outcome).toBe('verified');
    expect(result.state).toBe('DISABLED');
    expect(verifiedWriteFailure(result, t)).toBeNull();
  });

  // The lie this replaces: PATCH /users/{id} answers 200, the toast says "User disabled", and
  // the account can still sign in - because the re-read still says disabled=false.
  it('reports failure with the actual state when the account is still active', async () => {
    const result = await verifyAfterWrite<ManagedUserRow[]>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.resolve([user({ disabled: false })]),
      expected: (users) => userStateLanded(users, 'u-1', true),
      describe: (users) => describeUserState(users, 'u-1'),
    });

    const failure = verifiedWriteFailure(result, t);
    expect(result.outcome).toBe('unchanged');
    expect(result.state).toBe('ACTIVE');
    expect(failure?.message).toBe('Submitted, but the state did not change (current: ACTIVE)');
    expect(failure?.message).not.toMatch(/disabled|enabled/i);
  });

  it('does not count a user that vanished from the list as disabled', async () => {
    const result = await verifyAfterWrite<ManagedUserRow[]>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.resolve([]),
      expected: (users) => userStateLanded(users, 'u-1', true),
      describe: (users) => describeUserState(users, 'u-1'),
    });

    expect(result.outcome).toBe('unchanged');
    expect(result.state).toBe(ABSENT_STATE);
  });

  it('reads the inverse verb the same way: re-enabling needs disabled=false', async () => {
    const landed = await verifyAfterWrite<ManagedUserRow[]>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.resolve([user({ disabled: false })]),
      expected: (users) => userStateLanded(users, 'u-1', false),
      describe: (users) => describeUserState(users, 'u-1'),
    });
    expect(landed.outcome).toBe('verified');
    expect(landed.state).toBe('ACTIVE');

    const stayed = await verifyAfterWrite<ManagedUserRow[]>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.resolve([user({ disabled: true })]),
      expected: (users) => userStateLanded(users, 'u-1', false),
      describe: (users) => describeUserState(users, 'u-1'),
    });
    expect(stayed.outcome).toBe('unchanged');
    expect(stayed.state).toBe('DISABLED');
  });
});

describe('creating a user is proven by the account appearing with the requested role', () => {
  it('reports success when the list carries the address with that role', async () => {
    const result = await verifyAfterWrite<ManagedUserRow[]>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.resolve([user({ email: 'NEW@opsweave.local', role: 'operator' })]),
      expected: (users) => userCreatedLanded(users, 'new@opsweave.local', 'operator'),
      describe: (users) => describeUserRole(users, 'new@opsweave.local'),
    });
    expect(result.outcome).toBe('verified');
    expect(result.state).toBe('operator');
  });

  it('reports failure with the role that is actually stored', async () => {
    const result = await verifyAfterWrite<ManagedUserRow[]>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.resolve([user({ email: 'new@opsweave.local', role: 'admin' })]),
      expected: (users) => userCreatedLanded(users, 'new@opsweave.local', 'operator'),
      describe: (users) => describeUserRole(users, 'new@opsweave.local'),
    });
    expect(result.outcome).toBe('unchanged');
    expect(result.state).toBe('admin');
    expect(verifiedWriteFailure(result, t)?.message).toContain('current: admin');
  });
});

describe('cancelling a job is proven by the job route reporting CANCELLED', () => {
  it('reports success only when the re-read status is CANCELLED', async () => {
    const result = await verifyAfterWrite<JobView>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.resolve(job('CANCELLED')),
      expected: jobCancelledLanded,
      describe: describeJobStatus,
    });
    expect(result.outcome).toBe('verified');
    expect(result.state).toBe('CANCELLED');
  });

  it('reports failure with RUNNING when the Kernel accepted the cancel and the run went on', async () => {
    const result = await verifyAfterWrite<JobView>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.resolve(job('RUNNING')),
      expected: jobCancelledLanded,
      describe: describeJobStatus,
    });
    expect(result.outcome).toBe('unchanged');
    expect(result.state).toBe('RUNNING');
    expect(verifiedWriteFailure(result, t)?.message).toBe('Submitted, but the state did not change (current: RUNNING)');
  });

  it('does not treat a missing status as cancelled', () => {
    expect(jobCancelledLanded(job(''))).toBe(false);
    expect(describeJobStatus(job(''))).toBe(ABSENT_STATE);
  });
});

describe('revoking a node is proven by the node route, and a 404 is the same fact', () => {
  it('reports success when the re-read shows revoked_at', async () => {
    const result = await verifyAfterWrite<NodeView>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.resolve(node({ revokedAt: '2026-01-02T00:00:00Z', status: 'UNREACHABLE' })),
      expected: nodeRevokedLanded,
      describe: describeNodeState,
      absentIsExpected: true,
    });
    expect(result.outcome).toBe('verified');
    expect(result.state).toBe('REVOKED');
  });

  it('reports success when the node is gone: absence is the revoked state, 404 included', async () => {
    const result = await verifyAfterWrite<NodeView>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.reject(notFound()),
      expected: nodeRevokedLanded,
      describe: describeNodeState,
      absentIsExpected: true,
    });
    expect(result.outcome).toBe('verified');
    expect(result.state).toBe('NOT_FOUND');
  });

  it('reports failure with the state that is still there when the node kept serving', async () => {
    const result = await verifyAfterWrite<NodeView>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.resolve(node({ status: 'READY', revokedAt: null })),
      expected: nodeRevokedLanded,
      describe: describeNodeState,
      absentIsExpected: true,
    });
    expect(result.outcome).toBe('unchanged');
    expect(result.state).toBe('READY');
    expect(verifiedWriteFailure(result, t)?.message).toBe('Submitted, but the state did not change (current: READY)');
  });

  it('keeps a 404 unconfirmed when the verb did not promise an absence', async () => {
    const result = await verifyAfterWrite<NodeView>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.reject(notFound()),
      expected: nodeRevokedLanded,
      describe: describeNodeState,
    });
    expect(result.outcome).toBe('readback-failed');
  });
});

describe('trusting a publisher is proven by the publisher list', () => {
  it('reports success when the key is listed as TRUSTED', async () => {
    const result = await verifyAfterWrite<Publisher[]>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.resolve([publisher()]),
      expected: (list) => publisherTrustedLanded(list, 'trusted-team'),
      describe: (list) => describePublisherTrust(list, 'trusted-team'),
    });
    expect(result.outcome).toBe('verified');
    expect(result.state).toBe('TRUSTED');
  });

  it('reports failure with the trust state the list really carries', async () => {
    const result = await verifyAfterWrite<Publisher[]>({
      write: () => Promise.resolve({ ok: true }),
      read: () => Promise.resolve([publisher({ trustState: 'REVOKED' })]),
      expected: (list) => publisherTrustedLanded(list, 'trusted-team'),
      describe: (list) => describePublisherTrust(list, 'trusted-team'),
    });
    expect(result.outcome).toBe('unchanged');
    expect(result.state).toBe('REVOKED');
  });
});
