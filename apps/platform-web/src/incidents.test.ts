import { describe, expect, it } from 'vitest';
import type { IncidentEvidence, IncidentView } from './types';
import {
  evidenceKindKey,
  evidencePanelState,
  evidenceTrustKey,
  evidenceTrustTone,
  incidentFacts,
  incidentFailureKey,
  incidentListQuery,
  incidentSourceKey,
  ownerFilterValue,
  shortOwner,
  toIsoInstant,
  toLocalInputValue,
  verdictPanelState,
} from './incidents';

/**
 * The incident slice's client rules, tested without a browser.
 *
 * These assertions exist because each one is a place the page could quietly tell a lie: a filter
 * sent as the word ALL (400 from the kernel), an empty evidence array standing in for a failed
 * request, a timeline entry made of a timestamp the kernel never sent, or a failure code rendered
 * as a server sentence instead of copy.
 */

function incident(overrides: Partial<IncidentView> = {}): IncidentView {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'api gateway 5xx',
    severity: 'MAJOR',
    status: 'OPEN',
    source: 'MANUAL',
    nativeId: null,
    relatedEntity: 'api-gateway',
    startedAt: '2026-10-30T22:15:00Z',
    updatedAt: '2026-10-30T22:15:00Z',
    owner: '22222222-2222-4222-8222-222222222222',
    evidenceRefs: [],
    humanVerdict: null,
    ...overrides,
  };
}

function evidence(overrides: Partial<IncidentEvidence> = {}): IncidentEvidence {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    incidentId: '11111111-1111-4111-8111-111111111111',
    kind: 'LOG_EXCERPT',
    source: 'operator:admin@opsweave.local',
    collectedAt: '2026-10-30T22:16:00Z',
    contentRef: 'sha256:abc',
    trust: 'OPERATOR_ASSERTED',
    ...overrides,
  };
}

describe('incidentListQuery', () => {
  it('omits an unset filter instead of sending the word ALL', () => {
    const query = incidentListQuery({ status: 'ALL', severity: 'ALL', owner: null, limit: 20 });
    expect(query).toBe('limit=20');
    expect(query).not.toContain('ALL');
  });

  it('carries the three filters and the cursor the kernel names', () => {
    const query = incidentListQuery({ status: 'OPEN', severity: 'MAJOR', owner: 'abc', cursor: 'c1', limit: 50 });
    const params = new URLSearchParams(query);
    expect(params.get('status')).toBe('OPEN');
    expect(params.get('severity')).toBe('MAJOR');
    expect(params.get('owner')).toBe('abc');
    expect(params.get('cursor')).toBe('c1');
    expect(params.get('limit')).toBe('50');
  });

  it('defaults the page size to 20 and treats blank filter values as absent', () => {
    const params = new URLSearchParams(incidentListQuery({ status: '   ', severity: '', owner: null }));
    expect(params.get('status')).toBeNull();
    expect(params.get('severity')).toBeNull();
    expect(params.get('owner')).toBeNull();
    expect(params.get('limit')).toBe('20');
  });
});

describe('ownerFilterValue', () => {
  it('turns the "only mine" label into the signed-in id', () => {
    expect(ownerFilterValue('ME', 'user-1')).toBe('user-1');
  });

  it('sends nothing for "all owners", including when the session id is not known yet', () => {
    expect(ownerFilterValue('ALL', 'user-1')).toBeNull();
    expect(ownerFilterValue('ME', null)).toBeNull();
  });

  it('passes a named owner through unchanged', () => {
    expect(ownerFilterValue('user-9', 'user-1')).toBe('user-9');
  });
});

describe('incidentFailureKey', () => {
  it('has copy for every code the incident endpoints send', () => {
    for (const code of [
      'FORBIDDEN',
      'INVALID_REQUEST',
      'CSRF_FAILED',
      'INCIDENT_NOT_FOUND',
      'INCIDENT_EVIDENCE_REQUIRED',
      'INCIDENT_ALREADY_CONCLUDED',
      'INCIDENT_CLOSED',
      'INCIDENT_STATE_CONFLICT',
      'INCIDENT_VERDICT_NOT_FOUND',
      'INCIDENT_WRITE_CONFLICT',
    ]) {
      expect(incidentFailureKey(code), code).toMatch(/^incidents\.error\./);
    }
  });

  it('answers null for a code it has no sentence for, so the caller can show the code instead', () => {
    expect(incidentFailureKey('SOMETHING_NEW')).toBeNull();
    expect(incidentFailureKey(null)).toBeNull();
  });
});

describe('evidencePanelState', () => {
  it('separates an empty list from a failed request from a pending one', () => {
    expect(evidencePanelState(null, false)).toBe('loading');
    expect(evidencePanelState([], false)).toBe('missing');
    expect(evidencePanelState(null, true)).toBe('unavailable');
    expect(evidencePanelState([evidence()], false)).toBe('present');
  });

  it('keeps the rows it already has when a later read fails', () => {
    expect(evidencePanelState([evidence()], true)).toBe('present');
  });
});

describe('verdictPanelState', () => {
  it('opens the form only while nothing is recorded', () => {
    expect(verdictPanelState(incident())).toBe('open');
  });

  it('shows the record instead of the form once a verdict exists', () => {
    expect(verdictPanelState(incident({
      status: 'CONCLUDED',
      humanVerdict: { incidentId: 'i', verdict: 'CONFIRMED', rationale: 'because', decidedBy: 'u', decidedAt: '2026-10-30T23:00:00Z' },
    }))).toBe('recorded');
  });

  it('treats a closed incident as sealed rather than offering a write that would 409', () => {
    expect(verdictPanelState(incident({ status: 'CLOSED' }))).toBe('sealed');
  });
});

describe('incidentFacts', () => {
  it('builds the timeline from returned timestamps only, newest first', () => {
    const facts = incidentFacts(
      incident({
        humanVerdict: { incidentId: 'i', verdict: 'CONFIRMED', rationale: 'r', decidedBy: 'u', decidedAt: '2026-10-30T23:00:00Z' },
      }),
      [evidence()],
    );
    expect(facts.map((fact) => fact.kind)).toEqual(['verdict', 'evidence', 'started']);
  });

  it('sorts an unreadable timestamp last and marks it unreadable instead of dating it', () => {
    const facts = incidentFacts(incident(), [evidence({ collectedAt: 'not-a-time' })]);
    expect(facts.map((fact) => fact.kind)).toEqual(['started', 'evidence']);
    expect(facts[1].atValid).toBe(false);
    expect(facts[1].at).toBe('not-a-time');
  });

  it('has nothing beyond the start when there is no evidence and no verdict', () => {
    expect(incidentFacts(incident(), []).map((fact) => fact.kind)).toEqual(['started']);
  });
});

describe('local vocabulary', () => {
  it('maps every closed-set code to catalog copy and never returns the code itself', () => {
    expect(evidenceKindKey('METRIC_SNAPSHOT')).toBe('incidents.evidenceKind.metricSnapshot');
    expect(evidenceKindKey('NOPE')).toBe('incidents.evidenceKind.unknown');
    expect(evidenceTrustKey('SOURCE_ATTESTED')).toBe('incidents.trust.sourceAttested');
    expect(evidenceTrustKey('NOPE')).toBe('incidents.trust.unknown');
    expect(incidentSourceKey('MANUAL')).toBe('incidents.source.manual');
    expect(incidentSourceKey('API')).toBe('incidents.source.api');
    expect(incidentSourceKey('ZABBIX')).toBe('incidents.source.unknown');
  });

  it('gives attested evidence a different tone from an unverified note', () => {
    expect(evidenceTrustTone('SOURCE_ATTESTED')).toBe('ok');
    expect(evidenceTrustTone('OPERATOR_ASSERTED')).toBe('info');
    expect(evidenceTrustTone('UNVERIFIED')).toBe('warn');
    expect(evidenceTrustTone('NOPE')).toBe('unknown');
  });

  it('truncates an owner id without inventing a name', () => {
    expect(shortOwner('22222222-2222-4222-8222-222222222222')).toBe('22222222');
    expect(shortOwner(null)).toBe('');
  });
});

describe('instant conversion', () => {
  it('round-trips a local datetime-local value through the kernel shape', () => {
    const local = toLocalInputValue(new Date('2026-10-30T22:15:00Z'));
    const iso = toIsoInstant(local);
    expect(iso).not.toBeNull();
    expect(new Date(iso as string).getTime()).toBe(new Date(local).getTime());
  });

  it('refuses a value the kernel could not parse', () => {
    expect(toIsoInstant('')).toBeNull();
    expect(toIsoInstant('not-a-time')).toBeNull();
  });
});
