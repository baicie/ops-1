import { describe, expect, it } from 'vitest';
import en from './i18n/catalogs/en.json';
import {
  TOOL_NAMES,
  VERDICT_SAFETY_KEY,
  adapterBadgeKey,
  canCancel,
  canReview,
  citationsOf,
  confidenceKey,
  gapCodeKey,
  invocationErrorKey,
  isSynthetic,
  outcomeKey,
  stanceKey,
  statusKey,
  stopReasonKey,
  toolKey,
  type InvestigationHypothesis,
  type InvestigationRun,
} from './investigations';

/**
 * The investigation panel's contract with the kernel, asserted where it can be asserted
 * cheaply: every closed code maps to a message key that actually exists, the synthetic
 * marker cannot be inferred from a label, and no action is offered that the server would
 * refuse.
 *
 * What is NOT here: that a review cannot become a verdict. That is a property of the kernel
 * (investigation_human_reviews has its own vocabulary and no writer of incident_verdicts),
 * and it is measured over real HTTP in tests/acceptance/g12_ai_investigator.sh, section S6.
 * Asserting it in a unit test would prove the mock.
 */

function run(overrides: Partial<InvestigationRun> = {}): InvestigationRun {
  return {
    runId: '00000000-0000-4000-8000-000000000001',
    incidentId: '00000000-0000-4000-8000-000000000002',
    status: 'SUCCEEDED',
    stale: false,
    adapter: 'TEST_FIXTURE',
    adapterLabel: 'TEST_FIXTURE - deterministic test adapter output',
    adapterProviderId: 'test-fixture-v1',
    adapterModelId: null,
    synthetic: true,
    hypothesisKind: 'AI_HYPOTHESIS',
    isHumanVerdict: false,
    idempotencyKey: 'a-key-for-a-test-0001',
    idempotentReplay: false,
    requestedBy: '00000000-0000-4000-8000-000000000003',
    scopeUserId: '00000000-0000-4000-8000-000000000003',
    budget: {
      maxSteps: 8,
      maxToolCalls: 12,
      toolTimeoutMs: 2000,
      maxRetries: 1,
      tokenBudget: 20000,
      deadlineSeconds: 30,
    },
    usage: {
      steps: 3,
      toolCalls: 2,
      retries: 0,
      hypotheses: 1,
      promptTokens: 120,
      completionTokens: 60,
      totalTokens: 180,
      costMicros: 0,
      costBasis: 'TEST_FIXTURE_NO_COST',
    },
    stopReason: 'FINAL_ANSWER',
    detail: null,
    cancelRequestedAt: null,
    cancelRequestedBy: null,
    startedAt: '2026-10-31T08:00:00Z',
    finishedAt: '2026-10-31T08:00:01Z',
    deadlineAt: '2026-10-31T08:00:30Z',
    hypotheses: [],
    toolInvocations: [],
    review: null,
    ...overrides,
  };
}

function keyExists(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(en, key);
}

describe('the closed vocabularies map onto real message keys', () => {
  it('covers every status the kernel can return', () => {
    for (const status of [
      'RUNNING',
      'SUCCEEDED',
      'PARTIAL',
      'FAILED',
      'CANCELLED',
      'EXPIRED',
      'BUDGET_EXHAUSTED',
    ]) {
      expect(keyExists(statusKey(status))).toBe(true);
    }
  });

  it('covers every stop reason, and says so when there is none', () => {
    for (const reason of [
      'FINAL_ANSWER',
      'STEP_BUDGET',
      'TOOL_CALL_BUDGET',
      'TOKEN_BUDGET',
      'DEADLINE',
      'CANCELLED',
      'PROVIDER_ERROR',
      'INTERNAL_ERROR',
      'REFUSED',
    ]) {
      expect(keyExists(stopReasonKey(reason))).toBe(true);
    }
    expect(keyExists(stopReasonKey(null))).toBe(true);
  });

  it('covers every gap code the kernel documents', () => {
    for (const code of [
      'NO_EVIDENCE_ROWS',
      'EVIDENCE_PREDATES_INCIDENT',
      'EVIDENCE_UNVERIFIED',
      'TOOL_REFUSED',
      'TOOL_FAILED',
      'TOOL_TIMED_OUT',
      'SOURCE_UNAVAILABLE',
      'BUDGET_EXHAUSTED',
    ]) {
      expect(keyExists(gapCodeKey(code))).toBe(true);
    }
    expect(keyExists(gapCodeKey('SOMETHING_NEW'))).toBe(true);
  });

  it('covers exactly the five tools', () => {
    expect(TOOL_NAMES).toHaveLength(5);
    for (const tool of TOOL_NAMES) expect(keyExists(toolKey(tool))).toBe(true);
    // A tool the investigator invents has no message key of its own: it renders as unknown
    // rather than as a plausible name.
    expect(toolKey('run_shell')).toBe('investigations.tool.unknown');
    expect(toolKey('sql')).toBe('investigations.tool.unknown');
  });

  it('covers every invocation outcome', () => {
    for (const outcome of ['OK', 'REFUSED', 'ERROR', 'TIMEOUT', 'BUDGET_EXHAUSTED']) {
      expect(keyExists(outcomeKey(outcome))).toBe(true);
    }
  });

  it('maps a refusal code to a message key and never to a server sentence', () => {
    expect(invocationErrorKey('INCIDENT_NOT_FOUND')).toBe('investigations.error.incidentNotFound');
    expect(keyExists(invocationErrorKey('INCIDENT_NOT_FOUND'))).toBe(true);
    expect(keyExists(invocationErrorKey('SOURCE_UNAVAILABLE'))).toBe(true);
    expect(keyExists(invocationErrorKey(null))).toBe(true);
    expect(keyExists(invocationErrorKey('A_CODE_FROM_A_FUTURE_KERNEL'))).toBe(true);
    // The key is a key, not the kernel's message.
    expect(invocationErrorKey('INCIDENT_NOT_FOUND')).not.toContain(' ');
  });

  it('covers stances and confidences', () => {
    for (const stance of ['SUPPORTED', 'CONTRADICTED', 'UNCERTAIN', 'CONFLICTED']) {
      expect(keyExists(stanceKey(stance))).toBe(true);
    }
    for (const confidence of ['HIGH', 'MEDIUM', 'LOW']) {
      expect(keyExists(confidenceKey(confidence))).toBe(true);
    }
  });
});

describe('the synthetic marker cannot be inferred', () => {
  it('is true only when the adapter and the boolean agree', () => {
    expect(isSynthetic({ adapter: 'TEST_FIXTURE', synthetic: true })).toBe(true);
    // A label is not evidence: either field alone is not enough.
    expect(isSynthetic({ adapter: 'HTTP_OPENAI_COMPATIBLE', synthetic: false })).toBe(false);
    expect(isSynthetic({ adapter: 'TEST_FIXTURE', synthetic: false })).toBe(false);
    expect(isSynthetic({ adapter: 'HTTP_OPENAI_COMPATIBLE', synthetic: true })).toBe(false);
  });

  it('names the fixture rather than a model', () => {
    expect(keyExists(adapterBadgeKey('TEST_FIXTURE'))).toBe(true);
    expect(keyExists(adapterBadgeKey('HTTP_OPENAI_COMPATIBLE'))).toBe(true);
    expect(adapterBadgeKey('TEST_FIXTURE')).not.toBe(adapterBadgeKey('HTTP_OPENAI_COMPATIBLE'));
  });
});

describe('the panel offers only what the server would accept', () => {
  it('reviews a finished, unreviewed run and nothing else', () => {
    expect(canReview(run({ status: 'SUCCEEDED' }))).toBe(true);
    expect(canReview(run({ status: 'RUNNING' }))).toBe(false);
    expect(
      canReview(
        run({
          status: 'SUCCEEDED',
          review: {
            decision: 'ACCEPTED',
            note: 'a note long enough',
            reviewedBy: '00000000-0000-4000-8000-000000000003',
            reviewedAt: '2026-10-31T08:01:00Z',
            isHumanVerdict: false,
          },
        }),
      ),
    ).toBe(false);
  });

  it('cancels a running run once', () => {
    expect(canCancel(run({ status: 'RUNNING' }))).toBe(true);
    expect(canCancel(run({ status: 'RUNNING', cancelRequestedAt: '2026-10-31T08:00:02Z' }))).toBe(false);
    expect(canCancel(run({ status: 'CANCELLED' }))).toBe(false);
  });
});

describe('the verdict guarantee is one auditable sentence', () => {
  it('exists, and says that nothing here changes the Human Verdict', () => {
    expect(keyExists(VERDICT_SAFETY_KEY)).toBe(true);
    const message = (en as Record<string, string>)[VERDICT_SAFETY_KEY];
    expect(message.toLowerCase()).toContain('human verdict');
  });
});

describe('citations', () => {
  it('collects both roles once and keeps duplicates out', () => {
    const citation = {
      evidenceId: '00000000-0000-4000-8000-000000000010',
      role: 'SUPPORTING' as const,
      kind: 'LOG_EXCERPT',
      verifiedTrust: 'OPERATOR_ASSERTED',
      collectedAt: '2026-10-31T07:00:00Z',
      contentStatus: 'STORED' as const,
      invocationId: null,
    };
    const hypothesis: InvestigationHypothesis = {
      hypothesisId: '00000000-0000-4000-8000-000000000020',
      ordinal: 1,
      statement: 'a statement long enough to be stored',
      stance: 'SUPPORTED',
      confidence: 'HIGH',
      reasoning: 'a reasoning sentence long enough',
      uncertainty: null,
      gapCodes: [],
      supportingEvidence: [citation],
      contradictingEvidence: [{ ...citation, role: 'CONTRADICTING' }],
      isHumanVerdict: false,
    };
    const all = citationsOf([hypothesis, hypothesis]);
    expect(all).toHaveLength(2);
    expect(all.map((item) => item.role).sort()).toEqual(['CONTRADICTING', 'SUPPORTING']);
  });
});
