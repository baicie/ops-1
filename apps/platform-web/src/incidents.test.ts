import { describe, expect, it } from 'vitest';
import type { IncidentEvidence, IncidentVerdict, IncidentView } from './types';
import {
  CLAIMABLE_TRUST_CODES,
  EVIDENCE_TRUST_CODES,
  classifyFailure,
  clearsSensitiveView,
  detailPhase,
  detailReducer,
  emptyDetail,
  evidenceContentStatusKey,
  evidenceContentStatusTone,
  contentPanelMode,
  contentFailurePhase,
  contentPhaseKeys,
  sha256Hex,
  digestVerdict,
  digestVerdictKey,
  digestVerdictTone,
  evidenceExportFileName,
  evidenceKindKey,
  evidencePanelState,
  evidenceTrustKey,
  evidenceTrustTone,
  incidentFacts,
  incidentFailureKey,
  incidentListQuery,
  incidentSourceKey,
  ownerFilterValue,
  partitionEvidence,
  projectDetail,
  shortOwner,
  toIsoInstant,
  toLocalInputValue,
  trustMismatch,
  verdictPanelState,
  verdictSnapshotState,
  verificationMethodKey,
} from './incidents';

/**
 * The incident slice's client rules, tested without a browser.
 *
 * These assertions exist because each one is a place the page could quietly tell a lie: a filter
 * sent as the word ALL (400 from the kernel), an empty evidence array standing in for a failed
 * request, a timeline entry made of a timestamp the kernel never sent, a previous incident still
 * on screen under a new id, or evidence appended after signing rendered as if the signer weighed
 * it.
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

const OTHER_INCIDENT_ID = '44444444-4444-4444-8444-444444444444';
const ROUTE_ID = '11111111-1111-4111-8111-111111111111';

/** A second incident, so a "the route changed" test cannot pass by accident. */
function otherIncident(): IncidentView {
  return incident({ id: OTHER_INCIDENT_ID, title: 'disk full on web-01' });
}

function verdict(overrides: Partial<IncidentVerdict> = {}): IncidentVerdict {
  return {
    incidentId: ROUTE_ID,
    verdict: 'CONFIRMED',
    rationale: 'cpu saturation matches the reported window',
    decidedBy: '22222222-2222-4222-8222-222222222222',
    decidedAt: '2026-10-30T23:00:00Z',
    consideredEvidenceCount: 2,
    consideredEvidenceDigest: 'a'.repeat(64),
    snapshotKind: 'RECORDED',
    ...overrides,
  };
}

function evidence(overrides: Partial<IncidentEvidence> = {}): IncidentEvidence {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    incidentId: ROUTE_ID,
    kind: 'LOG_EXCERPT',
    source: 'operator:admin@opsweave.local',
    collectedAt: '2026-10-30T22:16:00Z',
    contentRef: 'sha256:abc',
    contentStatus: 'LEGACY_REFERENCE',
    contentType: null,
    contentBytes: null,
    contentSha256: null,
    contentCapturedAt: null,
    contentRetentionExpiresAt: null,
    claimedTrust: 'OPERATOR_ASSERTED',
    verifiedTrust: 'OPERATOR_ASSERTED',
    verificationMethod: 'OPERATOR_IDENTITY',
    verifiedAt: '2026-10-30T22:16:00Z',
    verifierIdentity: null,
    submittedBy: '22222222-2222-4222-8222-222222222222',
    verificationNote: null,
    createdAt: '2026-10-30T22:16:00Z',
    afterVerdict: false,
    ...overrides,
  };
}

/** The shape of a thrown ApiError, as the reducer sees it. */
function apiFailure(status: number, code: string) {
  return Object.assign(new Error(code), { status, code });
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
      'EVIDENCE_TRUST_NOT_SELF_ASSERTABLE',
      'EVIDENCE_ATTESTATION_INVALID',
      'EVIDENCE_ATTESTATION_STALE',
      'EVIDENCE_ADAPTER_UNKNOWN',
    ]) {
      expect(incidentFailureKey(code), code).toMatch(/^incidents\.error\./);
    }
  });

  it('answers null for a code it has no sentence for, so the caller can show the code instead', () => {
    expect(incidentFailureKey('SOMETHING_NEW')).toBeNull();
    expect(incidentFailureKey(null)).toBeNull();
  });

  it('keeps the trust refusals apart: an invalid signature and a stale one are different mistakes', () => {
    const keys = ['EVIDENCE_TRUST_NOT_SELF_ASSERTABLE', 'EVIDENCE_ATTESTATION_INVALID', 'EVIDENCE_ATTESTATION_STALE', 'EVIDENCE_ADAPTER_UNKNOWN']
      .map((code) => incidentFailureKey(code));
    expect(new Set(keys).size).toBe(4);
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
      humanVerdict: verdict(),
    }))).toBe('recorded');
  });

  it('treats a closed incident as sealed rather than offering a write that would 409', () => {
    expect(verdictPanelState(incident({ status: 'CLOSED' }))).toBe('sealed');
  });
});

describe('incidentFacts', () => {
  it('builds the timeline from returned timestamps only, newest first', () => {
    const facts = incidentFacts(
      incident({ humanVerdict: verdict() }),
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

/* ── G12 A1: the claim is not the verdict ───────────────────────────────────────────── */

describe('claim versus verification', () => {
  it('never lets the form offer the value the kernel reserves for itself', () => {
    expect(CLAIMABLE_TRUST_CODES).not.toContain('SOURCE_ATTESTED');
    // The read set still contains it: hiding the write option is not the same as
    // pretending the value does not exist.
    expect(EVIDENCE_TRUST_CODES).toContain('SOURCE_ATTESTED');
    expect(EVIDENCE_TRUST_CODES.length).toBe(CLAIMABLE_TRUST_CODES.length + 1);
  });

  it('reports a disagreement between the claim and the verdict', () => {
    expect(trustMismatch({ claimedTrust: 'SOURCE_ATTESTED', verifiedTrust: 'UNVERIFIED' })).toBe(true);
    expect(trustMismatch({ claimedTrust: 'UNVERIFIED', verifiedTrust: 'OPERATOR_ASSERTED' })).toBe(true);
    expect(trustMismatch({ claimedTrust: 'OPERATOR_ASSERTED', verifiedTrust: 'OPERATOR_ASSERTED' })).toBe(false);
    expect(trustMismatch({ claimedTrust: 'source_attested', verifiedTrust: 'SOURCE_ATTESTED' })).toBe(false);
  });

  it('names the verification method, and names an unknown one honestly', () => {
    expect(verificationMethodKey('NONE')).toBe('incidents.verificationMethod.none');
    expect(verificationMethodKey('OPERATOR_IDENTITY')).toBe('incidents.verificationMethod.operatorIdentity');
    expect(verificationMethodKey('SOURCE_ADAPTER')).toBe('incidents.verificationMethod.sourceAdapter');
    expect(verificationMethodKey('TRUST_ME')).toBe('incidents.verificationMethod.unknown');
  });
});

/* ── G12 A2: route identity, refresh, ordering, and answer codes ─────────────────────── */

describe('classifyFailure and the clear rule', () => {
  it('reads status and code off a thrown error and survives a non-error', () => {
    expect(classifyFailure(apiFailure(403, 'FORBIDDEN'))).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(classifyFailure('boom')).toEqual({ status: null, code: null });
    expect(classifyFailure(null)).toEqual({ status: null, code: null });
  });

  it('clears the view on an answer and keeps it on an absence of an answer', () => {
    for (const status of [401, 403, 404]) {
      expect(clearsSensitiveView({ status, code: null }), String(status)).toBe(true);
    }
    for (const status of [500, 502, 503, 504, null]) {
      expect(clearsSensitiveView({ status, code: null }), String(status)).toBe(false);
    }
  });
});

describe('detailReducer: route identity is not a refresh', () => {
  function loaded(): ReturnType<typeof detailReducer> {
    let state = emptyDetail(ROUTE_ID);
    state = detailReducer(state, { type: 'incident', routeId: ROUTE_ID, incident: incident(), observedAt: '2026-10-30T22:20:00Z' });
    state = detailReducer(state, { type: 'evidence', routeId: ROUTE_ID, evidence: [evidence()] });
    return state;
  }

  it('clears everything when the route id changes', () => {
    const next = detailReducer(loaded(), { type: 'route', routeId: OTHER_INCIDENT_ID });
    expect(next.routeId).toBe(OTHER_INCIDENT_ID);
    expect(next.incident).toBeNull();
    expect(next.evidence).toBeNull();
    expect(next.observedAt).toBeNull();
    expect(detailPhase(next)).toBe('loading');
  });

  it('keeps the data when the id did not change', () => {
    const state = loaded();
    expect(detailReducer(state, { type: 'route', routeId: ROUTE_ID })).toBe(state);
    const refreshing = detailReducer(state, { type: 'refresh' });
    expect(refreshing.refreshing).toBe(true);
    expect(refreshing.incident?.id).toBe(ROUTE_ID);
    expect(refreshing.evidence?.length).toBe(1);
  });

  it('drops an answer that belongs to the previous route instead of applying it', () => {
    const onB = detailReducer(loaded(), { type: 'route', routeId: OTHER_INCIDENT_ID });
    // A slow answer for A arrives now. It is compared against the snapshot's own
    // route id and discarded; no timer is involved.
    const leaked = detailReducer(onB, { type: 'incident', routeId: ROUTE_ID, incident: incident(), observedAt: '2026-10-30T22:25:00Z' });
    expect(leaked).toBe(onB);
    expect(leaked.incident).toBeNull();
    const leakedEvidence = detailReducer(onB, { type: 'evidence', routeId: ROUTE_ID, evidence: [evidence()] });
    expect(leakedEvidence).toBe(onB);
  });

  it('drops a late failure for the previous route too', () => {
    const onB = detailReducer(loaded(), { type: 'route', routeId: OTHER_INCIDENT_ID });
    const leaked = detailReducer(onB, { type: 'incident-failed', routeId: ROUTE_ID, cause: apiFailure(404, 'INCIDENT_NOT_FOUND') });
    expect(leaked).toBe(onB);
  });

  it('clears the view on 401, 403 and 404 rather than leaving the old record on screen', () => {
    for (const [status, phase] of [[401, 'denied'], [403, 'denied'], [404, 'not-found']] as const) {
      const cleared = detailReducer(loaded(), { type: 'incident-failed', routeId: ROUTE_ID, cause: apiFailure(status, 'X') });
      expect(cleared.incident, String(status)).toBeNull();
      expect(cleared.evidence, String(status)).toBeNull();
      expect(detailPhase(cleared)).toBe(phase);
    }
  });

  it('keeps the record, and its read time, when a same-id refresh fails on the network', () => {
    const failed = detailReducer(loaded(), { type: 'incident-failed', routeId: ROUTE_ID, cause: apiFailure(503, 'UNAVAILABLE') });
    expect(failed.incident?.id).toBe(ROUTE_ID);
    expect(failed.evidence?.length).toBe(1);
    expect(failed.observedAt).toBe('2026-10-30T22:20:00Z');
    expect(detailPhase(failed)).toBe('ready');
    expect(failed.incidentError).toBeTruthy();
  });

  it('clears a denied evidence list without taking the incident with it', () => {
    const denied = detailReducer(loaded(), { type: 'evidence-failed', routeId: ROUTE_ID, cause: apiFailure(403, 'FORBIDDEN') });
    expect(denied.evidence).toBeNull();
    expect(denied.incident?.id).toBe(ROUTE_ID);
    expect(evidencePanelState(denied.evidence, Boolean(denied.evidenceError))).toBe('unavailable');
  });
});

describe('projectDetail is the last line of defence', () => {
  it('refuses to render a snapshot under a different route id', () => {
    let state = emptyDetail(ROUTE_ID);
    state = detailReducer(state, { type: 'incident', routeId: ROUTE_ID, incident: incident(), observedAt: '2026-10-30T22:20:00Z' });
    const projected = projectDetail(state, OTHER_INCIDENT_ID);
    expect(projected.routeId).toBe(OTHER_INCIDENT_ID);
    expect(projected.incident).toBeNull();
    expect(detailPhase(projected)).toBe('loading');
    // And the identity case passes the snapshot straight through.
    expect(projectDetail(state, ROUTE_ID)).toBe(state);
  });
});

/* ── G12 A3: considered at signing versus appended after ─────────────────────────────── */

describe('partitionEvidence', () => {
  const consideredOne = evidence({ id: '33333333-3333-4333-8333-333333333331', afterVerdict: false });
  const consideredTwo = evidence({ id: '33333333-3333-4333-8333-333333333332', afterVerdict: false });
  const appended = evidence({ id: '33333333-3333-4333-8333-33333333333a', afterVerdict: true });

  it('treats every row as ordinary evidence while no verdict exists', () => {
    const split = partitionEvidence([consideredOne, appended], null);
    expect(split.considered.length).toBe(2);
    expect(split.afterVerdict).toEqual([]);
  });

  it('separates what was signed from what was appended afterwards', () => {
    const split = partitionEvidence([consideredOne, consideredTwo, appended], verdict());
    expect(split.considered.map((row) => row.id)).toEqual([consideredOne.id, consideredTwo.id]);
    expect(split.afterVerdict.map((row) => row.id)).toEqual([appended.id]);
  });

  it('never moves a row across the line because of its timestamp', () => {
    // An appended row can carry an older collectedAt than the verdict: the flag is
    // the kernel's, and this module does not re-derive it.
    const oldButLate = evidence({ id: '33333333-3333-4333-8333-33333333333b', collectedAt: '2026-10-01T00:00:00Z', afterVerdict: true });
    const split = partitionEvidence([oldButLate, consideredOne], verdict());
    expect(split.afterVerdict.map((row) => row.id)).toEqual([oldButLate.id]);
  });
});

describe('verdictSnapshotState', () => {
  it('treats a recorded set as a record and an unrecorded one as unknown', () => {
    expect(verdictSnapshotState(verdict())).toBe('recorded');
    expect(verdictSnapshotState(verdict({ snapshotKind: 'PRE_MIGRATION_UNRECORDED', consideredEvidenceCount: 0, consideredEvidenceDigest: null }))).toBe('unknown');
  });

  it('does not treat an unrecognised kind as a record', () => {
    expect(verdictSnapshotState(verdict({ snapshotKind: 'SOMETHING_ELSE' }))).toBe('unknown');
  });
});

describe('G12 B content helpers', () => {
  it('says where the bytes are, and never paints stored bytes as trusted', () => {
    expect(evidenceContentStatusKey('STORED')).toBe('incidents.content.status.stored');
    expect(evidenceContentStatusKey('LEGACY_REFERENCE')).toBe('incidents.content.status.legacy');
    // An unknown code degrades to the weaker claim, not the stronger one.
    expect(evidenceContentStatusKey('SOMETHING_ELSE')).toBe('incidents.content.status.legacy');
    // STORED is informative, never the success tone: holding bytes proves the content did not
    // change, not that the source was honest (ADR-G12-002 §1.6).
    expect(evidenceContentStatusTone('STORED')).toBe('info');
    expect(evidenceContentStatusTone('LEGACY_REFERENCE')).toBe('warn');
  });

  it('decides whether there is anything to fetch', () => {
    expect(contentPanelMode('STORED')).toBe('stored');
    expect(contentPanelMode('LEGACY_REFERENCE')).toBe('legacy');
    expect(contentPanelMode(null)).toBe('legacy');
  });

  it('keeps the four content failures apart', () => {
    expect(contentFailurePhase({ status: 404, code: 'EVIDENCE_CONTENT_NOT_STORED' })).toBe('unavailable');
    expect(contentFailurePhase({ status: 410, code: 'EVIDENCE_CONTENT_EXPIRED' })).toBe('expired');
    expect(contentFailurePhase({ status: 500, code: 'EVIDENCE_CONTENT_INTEGRITY_FAILED' })).toBe('integrity');
    expect(contentFailurePhase({ status: 404, code: 'INCIDENT_NOT_FOUND' })).toBe('denied');
    expect(contentFailurePhase({ status: 401, code: 'UNAUTHENTICATED' })).toBe('denied');
    expect(contentFailurePhase({ status: 403, code: 'FORBIDDEN' })).toBe('denied');
    expect(contentFailurePhase({ status: 503, code: 'UNAVAILABLE' })).toBe('failed');
    expect(contentFailurePhase(null)).toBeNull();
    // Every terminal phase has copy. A phase without a key would render an empty panel.
    for (const phase of ['expired', 'unavailable', 'integrity', 'denied', 'failed'] as const) {
      expect(contentPhaseKeys(phase)).not.toBeNull();
    }
    expect(contentPhaseKeys('ready')).toBeNull();
  });

  it('recomputes sha256 over the text it is about to show', async () => {
    // The golden vector is the empty-string digest plus a known string, so a wrong encoding
    // (utf-16, latin1) or a wrong hash function fails here rather than in a browser.
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('compares digests without pretending to have checked one it could not compute', () => {
    const digest = 'a'.repeat(64);
    expect(digestVerdict(digest, digest.toUpperCase())).toBe('match');
    expect(digestVerdict(digest, 'b'.repeat(64))).toBe('mismatch');
    // No WebCrypto, or a kernel response with no digest header: not a pass.
    expect(digestVerdict(null, digest)).toBe('unknown');
    expect(digestVerdict(digest, null)).toBe('unknown');
    expect(digestVerdictTone('match')).toBe('ok');
    expect(digestVerdictTone('mismatch')).toBe('danger');
    expect(digestVerdictTone('unknown')).toBe('warn');
    expect(digestVerdictKey('mismatch')).toBe('incidents.content.digest.mismatch');
  });

  it('names an export after the row and its stored type', () => {
    expect(evidenceExportFileName({ id: '33333333-3333-4333-8333-333333333333', contentType: 'text/plain' })).toBe('evidence-33333333.txt');
    expect(evidenceExportFileName({ id: '33333333-3333-4333-8333-333333333333', contentType: 'application/json' })).toBe('evidence-33333333.json');
    // A legacy row has no stored type, so the default is the safe one.
    expect(evidenceExportFileName({ id: '33333333-3333-4333-8333-333333333333', contentType: null })).toBe('evidence-33333333.txt');
  });

  it('reads a stored row as stored and a legacy row as legacy', () => {
    const legacy = evidence();
    expect(legacy.contentStatus).toBe('LEGACY_REFERENCE');
    const stored = evidence({ contentStatus: 'STORED', contentType: 'text/plain', contentBytes: 12, contentSha256: 'c'.repeat(64), contentCapturedAt: '2026-10-30T22:17:00Z', contentRetentionExpiresAt: '2027-10-30T22:17:00Z' });
    expect(contentPanelMode(stored.contentStatus)).toBe('stored');
    // The digest shown is the kernel's, and the retention horizon is a stored fact.
    expect(stored.contentSha256).toBe('c'.repeat(64));
    expect(stored.contentRetentionExpiresAt).toBe('2027-10-30T22:17:00Z');
  });
});
