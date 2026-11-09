import { describe, expect, it } from 'vitest';
import {
  claimActions,
  claimFailureKey,
  claimFailureNeedsRefresh,
  claimPayload,
  claimQueueState,
  type ClaimableIncident,
} from './incident-claims';

const row: ClaimableIncident = {
  id: 'incident-1',
  title: 'automation failure',
  severity: 'MAJOR',
  status: 'OPEN',
  nativeId: 'native-1',
  workspaceId: 'workspace-1',
  startedAt: '2026-11-08T00:00:00Z',
  updatedAt: '2026-11-08T00:00:00Z',
  revision: 1,
};

describe('claim queue state', () => {
  it('keeps a failed read apart from an answered empty queue', () => {
    expect(claimQueueState({ items: null, error: new Error('boom'), loading: false, status: null })).toBe('failed');
    expect(claimQueueState({ items: [], error: null, loading: false, status: null })).toBe('empty');
  });

  it('reports a 403 as a permission wall, not a retryable failure', () => {
    expect(claimQueueState({ items: null, error: new Error('no'), loading: false, status: 403 })).toBe('forbidden');
    expect(claimQueueState({ items: null, error: new Error('no'), loading: false, status: 500 })).toBe('failed');
  });

  it('never draws an unanswered read as empty', () => {
    expect(claimQueueState({ items: null, error: null, loading: true, status: null })).toBe('loading');
    expect(claimQueueState({ items: null, error: null, loading: false, status: null })).toBe('loading');
    expect(claimQueueState({ items: [row], error: null, loading: false, status: null })).toBe('ready');
  });
});

describe('claim failures are decided by the stable code', () => {
  it('maps the conflict family to one refresh sentence', () => {
    for (const code of ['INCIDENT_CLAIM_TAKEN', 'INCIDENT_CLAIM_CONFLICT']) {
      expect(claimFailureKey(code)).toBe('incidents.claim.conflict');
      expect(claimFailureNeedsRefresh(code)).toBe(true);
    }
  });

  it('maps lifecycle refusals to unavailable and asks for a refresh', () => {
    for (const code of ['INCIDENT_CLAIM_NOT_AVAILABLE', 'INCIDENT_RELEASE_NOT_AVAILABLE']) {
      expect(claimFailureKey(code)).toBe('incidents.claim.unavailable');
    }
    expect(claimFailureNeedsRefresh('INCIDENT_RELEASE_NOT_AVAILABLE')).toBe(false);
  });

  it('never invents copy for an unknown code', () => {
    expect(claimFailureKey(null)).toBeNull();
    expect(claimFailureKey('SOMETHING_NEW')).toBeNull();
    expect(claimFailureNeedsRefresh('SOMETHING_NEW')).toBe(false);
  });
});

describe('claim and release affordances', () => {
  const base = {
    claimable: true,
    origin: 'AUTOMATION',
    owner: '00000000-0000-4000-8000-0000000000a1',
    userId: 'operator-1',
    role: 'operator',
    status: 'OPEN',
  };

  it('offers a claim for a live unclaimed row to an operator', () => {
    expect(claimActions(base)).toEqual({ canClaim: true, canRelease: false });
  });

  it('refuses the affordance to a viewer and to a dead row', () => {
    expect(claimActions({ ...base, role: 'viewer' }).canClaim).toBe(false);
    expect(claimActions({ ...base, status: 'CONCLUDED' }).canClaim).toBe(false);
    expect(claimActions({ ...base, status: 'CLOSED' }).canClaim).toBe(false);
    expect(claimActions({ ...base, claimable: false }).canClaim).toBe(false);
  });

  it('offers release only to the owning operator of a live automation incident', () => {
    expect(claimActions({ ...base, claimable: false, owner: 'operator-1' })).toEqual({ canClaim: false, canRelease: true });
    expect(claimActions({ ...base, owner: 'operator-1', role: 'admin' }).canRelease).toBe(true);
    expect(claimActions({ ...base, owner: 'operator-1', origin: 'USER' }).canRelease).toBe(false);
    expect(claimActions({ ...base, owner: 'operator-1', status: 'CONCLUDED' }).canRelease).toBe(false);
    expect(claimActions({ ...base, owner: 'operator-2' }).canRelease).toBe(false);
  });

  it('sends the revision the operator saw, and nothing else', () => {
    expect(claimPayload(7)).toEqual({ expectedRevision: 7 });
  });
});
