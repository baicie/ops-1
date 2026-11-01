import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import type { IncidentEvidence, IncidentView } from './types';
import {
  COLUMN_KEEP_RATIO,
  EVIDENCE_TRUST_CODES,
  INCIDENT_OPTIONAL_COLUMNS,
  RUN_COLLAPSE_THRESHOLD,
  collapseIncidentRuns,
  columnCapForWidth,
  evidenceAssurance,
  evidenceKindKey,
  evidencePanelState,
  evidenceTrustGlyph,
  evidenceTrustKey,
  evidenceTrustRank,
  evidenceTrustTone,
  incidentColumnPlan,
  incidentCountKnown,
  incidentFacts,
  incidentFailureKey,
  incidentListQuery,
  incidentListState,
  incidentRunKey,
  incidentSourceKey,
  isKnownEvidenceTrust,
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

  it('draws a refusal apart from a failure, because the remedy is not a retry', () => {
    // 403 names a grant the session lacks; a 500 names an answer that did not arrive. Folding
    // the two into "could not be read" would send a reader to retry a permission problem.
    expect(evidencePanelState(null, true, 403)).toBe('forbidden');
    expect(evidencePanelState(null, true, 500)).toBe('unavailable');
    expect(evidencePanelState(null, true, null)).toBe('unavailable');
    // A refusal is never drawn while rows are on screen: the rows are what the kernel already
    // answered, and replacing them with a wall would hide the evidence the verdict rests on.
    expect(evidencePanelState([evidence()], true, 403)).toBe('present');
    // A status alone is not a state: without a failure the panel is still loading.
    expect(evidencePanelState(null, false, 403)).toBe('loading');
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

  it('gives each trust level its own tone, and gives none of them the verified green', () => {
    // The three must stay distinguishable...
    const tones = EVIDENCE_TRUST_CODES.map((code) => evidenceTrustTone(code));
    expect(new Set(tones).size).toBe(EVIDENCE_TRUST_CODES.length);
    expect(evidenceTrustTone('NOPE')).toBe('unknown');

    // ...and none of them may be 'ok'. 'ok' is the shell's green tick (status-tone.ts), and on
    // this build `trust` is whatever the writer sent: insert_evidence validates the word against
    // the closed set and stores it, with no signature check behind SOURCE_ATTESTED. A green tick
    // would be the UI asserting a verification the kernel never performed.
    for (const code of EVIDENCE_TRUST_CODES) {
      expect(evidenceTrustTone(code), code + ' must not be painted as verified').not.toBe('ok');
    }
  });

  it('separates the three trust levels by shape as well as by tone', () => {
    // The audit requires shape before colour: greyscale, a colour deficiency and a dark-theme
    // washout all have to resolve these three, so the glyph carries the same fact a second time.
    const glyphs = EVIDENCE_TRUST_CODES.map((code) => evidenceTrustGlyph(code));
    expect(new Set(glyphs).size).toBe(EVIDENCE_TRUST_CODES.length);
    expect(evidenceTrustGlyph('NOPE')).toBe('unknown');
  });

  it('ranks the levels weakest-first and puts an unknown code below all of them', () => {
    expect(evidenceTrustRank('SOURCE_ATTESTED')).toBeGreaterThan(evidenceTrustRank('OPERATOR_ASSERTED'));
    expect(evidenceTrustRank('OPERATOR_ASSERTED')).toBeGreaterThan(evidenceTrustRank('UNVERIFIED'));
    // A value the contract does not define is not quietly folded into the weakest known level:
    // "we have never seen this word" ranks below "the writer claimed nothing".
    expect(evidenceTrustRank('NOPE')).toBeLessThan(evidenceTrustRank('UNVERIFIED'));
  });

  it('tells a code the contract defines from one it does not', () => {
    for (const code of EVIDENCE_TRUST_CODES) expect(isKnownEvidenceTrust(code)).toBe(true);
    expect(isKnownEvidenceTrust('SIGNED')).toBe(false);
    expect(isKnownEvidenceTrust(null)).toBe(false);
  });

  it('summarises an evidence set by its weakest row, and counts what the contract does not define', () => {
    const mixed = evidenceAssurance([
      evidence({ id: 'a', trust: 'SOURCE_ATTESTED' }),
      evidence({ id: 'b', trust: 'UNVERIFIED' }),
    ]);
    // The weakest row is what the set is worth: one unverified row means the set is not attested.
    expect(mixed.weakest).toBe('UNVERIFIED');
    expect(mixed.byCode.SOURCE_ATTESTED).toBe(1);
    expect(mixed.byCode.UNVERIFIED).toBe(1);
    expect(mixed.hasUnknown).toBe(false);

    // A value outside the closed set is REPORTED, not folded into a known level. This is the
    // defect the audit found elsewhere in the product (seven status codes landing on one
    // branch, so a success and a never-observed run drew identically): the page must be able
    // to say "this build cannot rank that word" instead of guessing which level it resembles.
    const unknown = evidenceAssurance([evidence({ trust: 'SIGNED_BY_ZABBIX' })]);
    expect(unknown.hasUnknown).toBe(true);
    expect(unknown.byCode.SIGNED_BY_ZABBIX).toBe(1);
    // An unrankable code is the floor of the set: the page cannot rank what it cannot read.
    expect(unknown.weakest).toBe('SIGNED_BY_ZABBIX');

    const none = evidenceAssurance([]);
    expect(none.weakest).toBeNull();
    expect(none.total).toBe(0);
  });

  it('truncates an owner id without inventing a name', () => {
    expect(shortOwner('22222222-2222-4222-8222-222222222222')).toBe('22222222');
    expect(shortOwner(null)).toBe('');
  });
});

describe('evidenceAssurance', () => {
  it('counts the whole set without promoting any row to verified', () => {
    const summary = evidenceAssurance([
      evidence({ id: 'a', trust: 'SOURCE_ATTESTED' }),
      evidence({ id: 'b', trust: 'OPERATOR_ASSERTED' }),
      evidence({ id: 'c', trust: 'UNVERIFIED' }),
    ]);
    expect(summary.total).toBe(3);
    // There is no "verified" bucket to report: on this build the kernel checks no signature,
    // so the summary counts declarations and nothing else.
    expect(Object.keys(summary.byCode).sort()).toEqual(['OPERATOR_ASSERTED', 'SOURCE_ATTESTED', 'UNVERIFIED']);
    expect(summary.hasUnknown).toBe(false);
  });

  it('counts each declared level separately and flags an out-of-set value', () => {
    const summary = evidenceAssurance([
      evidence({ id: 'a', trust: 'SOURCE_ATTESTED' }),
      evidence({ id: 'b', trust: 'SOURCE_ATTESTED' }),
      evidence({ id: 'c', trust: 'WHAT_IS_THIS' }),
    ]);
    expect(summary.byCode.SOURCE_ATTESTED).toBe(2);
    expect(summary.byCode.OPERATOR_ASSERTED).toBeUndefined();
    expect(summary.byCode.WHAT_IS_THIS).toBe(1);
    expect(summary.hasUnknown).toBe(true);
    // An unreadable code is the floor: the page cannot rank what it cannot read.
    expect(summary.weakest).toBe('WHAT_IS_THIS');
  });

  it('names the weakest level present, so the panel can lead with it', () => {
    expect(evidenceAssurance([
      evidence({ id: 'a', trust: 'SOURCE_ATTESTED' }),
      evidence({ id: 'b', trust: 'UNVERIFIED' }),
    ]).weakest).toBe('UNVERIFIED');
    expect(evidenceAssurance([evidence({ trust: 'SOURCE_ATTESTED' })]).weakest).toBe('SOURCE_ATTESTED');
    expect(evidenceAssurance([]).weakest).toBeNull();
  });
});

describe('incidentListState', () => {
  it('separates the five async states a reader must not confuse', () => {
    expect(incidentListState({ loading: true, rows: null, error: null, filtering: false })).toBe('loading');
    expect(incidentListState({ loading: false, rows: [], error: null, filtering: false })).toBe('empty');
    expect(incidentListState({ loading: false, rows: [], error: null, filtering: true })).toBe('filtered');
    expect(incidentListState({ loading: false, rows: [incident()], error: null, filtering: false })).toBe('ready');
    expect(incidentListState({ loading: false, rows: null, error: new Error('x'), filtering: false })).toBe('failed');
  });

  it('reads 403 as forbidden and 409 as conflict instead of one generic failure', () => {
    const forbidden = new ApiError(403, 'FORBIDDEN', 'no');
    const conflict = new ApiError(409, 'INCIDENT_WRITE_CONFLICT', 'no');
    expect(incidentListState({ loading: false, rows: null, error: forbidden, filtering: false })).toBe('forbidden');
    expect(incidentListState({ loading: false, rows: null, error: conflict, filtering: false })).toBe('conflict');
  });

  it('is stale, not failed, while rows the kernel already answered stay on screen', () => {
    const rows = [incident()];
    expect(incidentListState({ loading: false, rows, error: new Error('x'), filtering: false })).toBe('stale');
    expect(incidentListState({ loading: false, rows, error: new ApiError(403, 'FORBIDDEN', 'no'), filtering: false })).toBe('stale');
  });

  it('keeps loading visible over rows it has, so a refresh is not an empty page', () => {
    expect(incidentListState({ loading: true, rows: [incident()], error: null, filtering: false })).toBe('ready');
  });

  it('lets the toolbar print a count only when the list actually answered', () => {
    // The four answered states carry a fact the kernel asserted. The other four reach the
    // renderer holding zero rows because nothing was read, and "0 on this page" there is a
    // number the server never sent - indistinguishable, to a reader, from a real empty result.
    for (const state of ['ready', 'stale', 'empty', 'filtered'] as const) {
      expect(incidentCountKnown(state), state + ' answered, so a count is a fact').toBe(true);
    }
    for (const state of ['loading', 'forbidden', 'conflict', 'failed'] as const) {
      expect(incidentCountKnown(state), state + ' did not answer, so there is no count').toBe(false);
    }
  });
});

describe('collapseIncidentRuns', () => {
  const run = (id: string, over: Partial<IncidentView> = {}) => incident({
    id,
    title: 'api gateway 5xx',
    severity: 'MAJOR',
    status: 'OPEN',
    relatedEntity: 'api-gateway',
    ...over,
  });

  it('leaves two identical neighbours as two rows', () => {
    const groups = collapseIncidentRuns([run('a'), run('b')]);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.rows.length === 1)).toBe(true);
  });

  it('collapses a run once it reaches the threshold', () => {
    const groups = collapseIncidentRuns([run('a'), run('b'), run('c')]);
    expect(RUN_COLLAPSE_THRESHOLD).toBe(3);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.length).toBe(3);
    expect(groups[0].rows.map((member) => member.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the run leader and the span of the run, so no occurrence is invented', () => {
    const groups = collapseIncidentRuns([
      run('a', { startedAt: '2026-10-30T10:00:00Z' }),
      run('b', { startedAt: '2026-10-30T09:00:00Z' }),
      run('c', { startedAt: '2026-10-30T08:00:00Z' }),
    ]);
    expect(groups[0].head.id).toBe('a');
    expect(groups[0].firstAt).toBe('2026-10-30T08:00:00Z');
    expect(groups[0].lastAt).toBe('2026-10-30T10:00:00Z');
  });

  it('only collapses CONSECUTIVE rows: a different incident between them breaks the run', () => {
    const groups = collapseIncidentRuns([
      run('a'), run('b'), run('c'),
      run('x', { title: 'disk pressure' }),
      run('d'), run('e'), run('f'),
    ]);
    expect(groups.map((group) => group.rows.length)).toEqual([3, 1, 3]);
  });

  it('keys a run on what makes two reports the same failure, never on the id', () => {
    expect(incidentRunKey(run('a'))).toBe(incidentRunKey(run('b')));
    expect(incidentRunKey(run('a'))).not.toBe(incidentRunKey(run('a', { severity: 'CRITICAL' })));
    expect(incidentRunKey(run('a'))).not.toBe(incidentRunKey(run('a', { relatedEntity: 'other' })));
  });

  it('never collapses rows a verdict distinguishes', () => {
    const concluded = run('b', {
      status: 'CONCLUDED',
      humanVerdict: { incidentId: 'b', verdict: 'CONFIRMED', rationale: 'r', decidedBy: 'u', decidedAt: '2026-10-30T23:00:00Z' },
    });
    expect(collapseIncidentRuns([run('a'), concluded, run('c')]).map((group) => group.rows.length)).toEqual([1, 1, 1]);
  });
});

describe('incidentColumnPlan', () => {
  /** n rows that differ in every optional column, so nothing is degraded for lack of variety. */
  const varied = (n: number) => Array.from({ length: n }, (_, i) => incident({
    id: 'id-' + i,
    title: 'incident ' + i,
    severity: INCIDENT_OPTIONAL_COLUMNS.length && i % 2 ? 'CRITICAL' : 'MAJOR',
    status: i % 3 === 0 ? 'OPEN' : i % 3 === 1 ? 'INVESTIGATING' : 'CONCLUDED',
    owner: 'owner-' + i,
    startedAt: new Date(Date.UTC(2026, 9, 30, 0, i)).toISOString(),
    evidenceRefs: Array.from({ length: i % 4 }, (_, k) => 'e' + k),
  }));

  it('caps the table at the spec cap for the measured width, identity included', () => {
    expect(columnCapForWidth(1440)).toBe(5);
    expect(columnCapForWidth(1024)).toBe(5);
    expect(columnCapForWidth(800)).toBe(4);
    expect(columnCapForWidth(390)).toBe(3);
    expect(incidentColumnPlan(varied(12), 1440).visible.length).toBe(4);
    expect(incidentColumnPlan(varied(12), 800).visible.length).toBe(3);
  });

  it('demotes a column whose value never changes instead of spending a column on one fact', () => {
    const rows = varied(12).map((row) => ({ ...row, severity: 'MAJOR', status: 'OPEN' }));
    const plan = incidentColumnPlan(rows, 1440);
    expect(plan.ratios.severity).toBeLessThan(COLUMN_KEEP_RATIO);
    expect(plan.demoted).toContain('severity');
    expect(plan.demoted).toContain('status');
  });

  it('measures nothing below the spec row floor, and keeps the declared columns', () => {
    const plan = incidentColumnPlan(varied(4), 1440);
    expect(plan.ratios.severity).toBeNull();
    expect(plan.visible.length).toBe(4);
  });

  it('renders in the declared order however the ranking came out', () => {
    const plan = incidentColumnPlan(varied(12), 1440);
    const declared = INCIDENT_OPTIONAL_COLUMNS.filter((column) => plan.visible.includes(column));
    expect(plan.visible).toEqual(declared);
  });

  it('never loses a column: every optional column is either visible or demoted, exactly once', () => {
    for (const width of [1440, 1024, 800, 390]) {
      const plan = incidentColumnPlan(varied(12), width);
      expect([...plan.visible, ...plan.demoted].sort()).toEqual([...INCIDENT_OPTIONAL_COLUMNS].sort());
    }
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
