import { api } from './api';
import type { MessageKey } from './i18n';

/**
 * G12 Phase E: the bounded read-only AI investigator, as the Web shell sees it.
 *
 * Everything here is a mapping from a closed kernel vocabulary to a message key, plus the
 * calls themselves. There is deliberately no place in this module that can produce a verdict:
 * the review vocabulary is ACCEPTED and REJECTED, and `InvestigationRun.isHumanVerdict` is
 * typed as the literal `false` so a component cannot even ask the question.
 */

export type InvestigationStatus =
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'PARTIAL'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'BUDGET_EXHAUSTED';

export type HypothesisStance = 'SUPPORTED' | 'CONTRADICTED' | 'UNCERTAIN' | 'CONFLICTED';
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
export type InvocationOutcome = 'OK' | 'REFUSED' | 'ERROR' | 'TIMEOUT' | 'BUDGET_EXHAUSTED';
export type ReviewDecision = 'ACCEPTED' | 'REJECTED';
export type AdapterKind = 'TEST_FIXTURE' | 'HTTP_OPENAI_COMPATIBLE';

export type ToolName =
  | 'get_incident'
  | 'list_evidence'
  | 'read_evidence'
  | 'get_incident_timeline'
  | 'get_related_context';

/** The complete tool surface, in the order the kernel's own catalogue lists it. */
export const TOOL_NAMES: readonly ToolName[] = [
  'get_incident',
  'list_evidence',
  'read_evidence',
  'get_incident_timeline',
  'get_related_context',
];

export interface InvestigationCitation {
  evidenceId: string;
  role: 'SUPPORTING' | 'CONTRADICTING';
  kind: string;
  verifiedTrust: string;
  collectedAt: string;
  contentStatus: 'STORED' | 'LEGACY_REFERENCE';
  invocationId: string | null;
}

export interface InvestigationHypothesis {
  hypothesisId: string;
  ordinal: number;
  statement: string;
  stance: HypothesisStance;
  confidence: Confidence;
  reasoning: string;
  uncertainty: string | null;
  gapCodes: string[];
  supportingEvidence: InvestigationCitation[];
  contradictingEvidence: InvestigationCitation[];
  isHumanVerdict: false;
}

export interface InvestigationInvocation {
  invocationId: string;
  sequence: number;
  attempt: number;
  tool: ToolName;
  arguments: Record<string, unknown>;
  outcome: InvocationOutcome;
  errorCode: string | null;
  errorDetail: string | null;
  authorizationPredicate: string | null;
  scopeActor: string | null;
  resultBytes: number | null;
  evidenceRefs: string[];
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}

export interface InvestigationBudget {
  maxSteps: number;
  maxToolCalls: number;
  toolTimeoutMs: number;
  maxRetries: number;
  tokenBudget: number;
  deadlineSeconds: number;
}

export interface InvestigationUsage {
  steps: number;
  toolCalls: number;
  retries: number;
  hypotheses: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicros: number;
  costBasis: 'NO_COST' | 'TEST_FIXTURE_NO_COST' | 'CONFIGURED_PRICE' | 'PROVIDER_REPORTED';
}

export interface InvestigationReview {
  decision: ReviewDecision;
  note: string;
  reviewedBy: string;
  reviewedAt: string;
  isHumanVerdict: false;
}

export interface InvestigationRun {
  runId: string;
  incidentId: string;
  status: InvestigationStatus;
  stale: boolean;
  adapter: AdapterKind;
  adapterLabel: string;
  adapterProviderId: string;
  adapterModelId: string | null;
  synthetic: boolean;
  hypothesisKind: 'AI_HYPOTHESIS';
  isHumanVerdict: false;
  idempotencyKey: string;
  idempotentReplay: boolean;
  requestedBy: string;
  scopeUserId: string;
  budget: InvestigationBudget;
  usage: InvestigationUsage;
  stopReason: string | null;
  detail: string | null;
  cancelRequestedAt: string | null;
  cancelRequestedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  deadlineAt: string;
  hypotheses: InvestigationHypothesis[];
  toolInvocations: InvestigationInvocation[];
  review: InvestigationReview | null;
}

export interface StartInvestigationInput {
  idempotencyKey?: string;
  scenario?: string;
  maxSteps?: number;
  maxToolCalls?: number;
  toolTimeoutMs?: number;
  maxRetries?: number;
  tokenBudget?: number;
  deadlineSeconds?: number;
}

function statusKeyOf(status: InvestigationStatus): MessageKey {
  switch (status) {
    case 'RUNNING': return 'investigations.status.RUNNING';
    case 'SUCCEEDED': return 'investigations.status.SUCCEEDED';
    case 'PARTIAL': return 'investigations.status.PARTIAL';
    case 'FAILED': return 'investigations.status.FAILED';
    case 'CANCELLED': return 'investigations.status.CANCELLED';
    case 'EXPIRED': return 'investigations.status.EXPIRED';
    case 'BUDGET_EXHAUSTED': return 'investigations.status.budgetExhausted';
  }
}

export function statusKey(status: string): MessageKey {
  return statusKeyOf(status as InvestigationStatus);
}

/** A status is terminal when nothing more will happen to the run. */
export function isTerminal(status: InvestigationStatus): boolean {
  return status !== 'RUNNING';
}

export function stopReasonKey(reason: string | null): MessageKey {
  switch (reason) {
    case 'FINAL_ANSWER': return 'investigations.stopReason.finalAnswer';
    case 'STEP_BUDGET': return 'investigations.stopReason.stepBudget';
    case 'TOOL_CALL_BUDGET': return 'investigations.stopReason.toolCallBudget';
    case 'TOKEN_BUDGET': return 'investigations.stopReason.tokenBudget';
    case 'DEADLINE': return 'investigations.stopReason.DEADLINE';
    case 'CANCELLED': return 'investigations.stopReason.CANCELLED';
    case 'PROVIDER_ERROR': return 'investigations.stopReason.providerError';
    case 'INTERNAL_ERROR': return 'investigations.stopReason.internalError';
    case 'REFUSED': return 'investigations.stopReason.REFUSED';
    default: return 'investigations.stopReason.none';
  }
}

export function gapCodeKey(code: string): MessageKey {
  switch (code) {
    case 'NO_EVIDENCE_ROWS': return 'investigations.gap.noEvidenceRows';
    case 'EVIDENCE_PREDATES_INCIDENT': return 'investigations.gap.evidencePredatesIncident';
    case 'EVIDENCE_UNVERIFIED': return 'investigations.gap.evidenceUnverified';
    case 'TOOL_REFUSED': return 'investigations.gap.toolRefused';
    case 'TOOL_FAILED': return 'investigations.gap.toolFailed';
    case 'TOOL_TIMED_OUT': return 'investigations.gap.toolTimedOut';
    case 'SOURCE_UNAVAILABLE': return 'investigations.gap.sourceUnavailable';
    case 'BUDGET_EXHAUSTED': return 'investigations.gap.budgetExhausted';
    default: return 'investigations.gap.unknown';
  }
}

export function toolKey(tool: string): MessageKey {
  switch (tool) {
    case 'get_incident': return 'investigations.tool.getIncident';
    case 'list_evidence': return 'investigations.tool.listEvidence';
    case 'read_evidence': return 'investigations.tool.readEvidence';
    case 'get_incident_timeline': return 'investigations.tool.getIncidentTimeline';
    case 'get_related_context': return 'investigations.tool.getRelatedContext';
    default: return 'investigations.tool.unknown';
  }
}

export function outcomeKey(outcome: string): MessageKey {
  switch (outcome) {
    case 'OK': return 'investigations.outcome.OK';
    case 'REFUSED': return 'investigations.outcome.REFUSED';
    case 'ERROR': return 'investigations.outcome.ERROR';
    case 'TIMEOUT': return 'investigations.outcome.TIMEOUT';
    case 'BUDGET_EXHAUSTED': return 'investigations.outcome.budgetExhausted';
    default: return 'investigations.outcome.ERROR';
  }
}

/**
 * A kernel error code, as a message key.
 *
 * The server's own sentence is never rendered: AGENTS.md requires a stable code the client
 * localizes, and an English refusal from the kernel inside a Chinese UI is exactly the bug
 * that rule exists to prevent.
 */
export function invocationErrorKey(code: string | null): MessageKey {
  switch (code) {
    case 'INCIDENT_NOT_FOUND': return 'investigations.error.incidentNotFound';
    case 'EVIDENCE_NOT_FOUND': return 'investigations.error.evidenceNotFound';
    case 'EVIDENCE_CONTENT_NOT_STORED': return 'investigations.error.evidenceContentNotStored';
    case 'EVIDENCE_CONTENT_EXPIRED': return 'investigations.error.evidenceContentExpired';
    case 'EVIDENCE_CONTENT_INTEGRITY_FAILED': return 'investigations.error.evidenceContentIntegrityFailed';
    case 'SOURCE_UNAVAILABLE': return 'investigations.error.sourceUnavailable';
    case 'SOURCE_PREDICATE_UNKNOWN': return 'investigations.error.sourcePredicateUnknown';
    case 'TOOL_TIMEOUT': return 'investigations.error.toolTimeout';
    case 'TOOL_NOT_AVAILABLE': return 'investigations.error.toolNotAvailable';
    case 'TOOL_ARGUMENT_INVALID': return 'investigations.error.toolArgumentInvalid';
    case 'TOOL_SCOPE_UNAVAILABLE': return 'investigations.error.toolScopeUnavailable';
    case 'SCOPE_IDENTITY_UNAVAILABLE': return 'investigations.error.scopeIdentityUnavailable';
    case 'TOOL_READ_FAILED': return 'investigations.error.toolReadFailed';
    case null: return 'investigations.error.none';
    default: return 'investigations.error.unknown';
  }
}

export function stanceKey(stance: string): MessageKey {
  switch (stance) {
    case 'SUPPORTED': return 'investigations.stance.SUPPORTED';
    case 'CONTRADICTED': return 'investigations.stance.CONTRADICTED';
    case 'UNCERTAIN': return 'investigations.stance.UNCERTAIN';
    case 'CONFLICTED': return 'investigations.stance.CONFLICTED';
    default: return 'investigations.stance.UNCERTAIN';
  }
}

/** The tone a stance paints with, so a conflict never looks like an agreement. */
export function stanceTone(stance: string): 'neutral' | 'positive' | 'warning' | 'negative' {
  switch (stance) {
    case 'SUPPORTED': return 'positive';
    case 'CONTRADICTED': return 'negative';
    case 'CONFLICTED': return 'warning';
    default: return 'neutral';
  }
}

export function confidenceKey(confidence: string): MessageKey {
  switch (confidence) {
    case 'HIGH': return 'investigations.confidence.HIGH';
    case 'MEDIUM': return 'investigations.confidence.MEDIUM';
    case 'LOW': return 'investigations.confidence.LOW';
    default: return 'investigations.confidence.LOW';
  }
}

export function outcomeTone(outcome: string): 'neutral' | 'positive' | 'warning' | 'negative' {
  switch (outcome) {
    case 'OK': return 'positive';
    case 'REFUSED': return 'warning';
    case 'TIMEOUT': return 'warning';
    case 'BUDGET_EXHAUSTED': return 'warning';
    default: return 'negative';
  }
}

export function statusTone(status: string): 'neutral' | 'positive' | 'warning' | 'negative' {
  switch (status) {
    case 'SUCCEEDED': return 'positive';
    case 'PARTIAL': return 'warning';
    case 'BUDGET_EXHAUSTED': return 'warning';
    case 'CANCELLED': return 'warning';
    case 'EXPIRED': return 'warning';
    case 'FAILED': return 'negative';
    default: return 'neutral';
  }
}

/**
 * True exactly when the deterministic test adapter answered.
 *
 * Both fields are checked and they must agree: `adapter` is what the run document says and
 * `synthetic` is the boolean form of the same fact, so a disagreement is rendered as
 * "unknown" rather than quietly picking one. The UI never infers this from a label.
 */
export function isSynthetic(run: Pick<InvestigationRun, 'adapter' | 'synthetic'>): boolean {
  return run.adapter === 'TEST_FIXTURE' && run.synthetic === true;
}

export function adapterBadgeKey(adapter: string): MessageKey {
  switch (adapter) {
    case 'TEST_FIXTURE': return 'investigations.adapter.fixture';
    case 'HTTP_OPENAI_COMPATIBLE': return 'investigations.adapter.model';
    default: return 'investigations.adapter.unknown';
  }
}

/** A run may be reviewed once it has finished and has no review yet. */
export function canReview(run: InvestigationRun): boolean {
  return isTerminal(run.status) && run.review === null;
}

/** A run may be cancelled while it is still running and nothing was requested yet. */
export function canCancel(run: InvestigationRun): boolean {
  return run.status === 'RUNNING' && run.cancelRequestedAt === null;
}

/**
 * The one sentence the panel exists to make unmissable.
 *
 * It is a single key rather than an inline string so the guarantee can be audited: the panel
 * cannot say anything different, and the tests assert this key is what it renders.
 */
export const VERDICT_SAFETY_KEY: MessageKey = 'investigations.verdictUntouched';

/** Every citation of a hypothesis, in one list, for the "evidence used" section. */
export function citationsOf(hypotheses: InvestigationHypothesis[]): InvestigationCitation[] {
  const seen = new Set<string>();
  const out: InvestigationCitation[] = [];
  for (const hypothesis of hypotheses) {
    for (const citation of [...hypothesis.supportingEvidence, ...hypothesis.contradictingEvidence]) {
      const key = citation.evidenceId + ':' + citation.role;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(citation);
    }
  }
  return out;
}

/** How many of the cited rows the Kernel stored bytes for, so the count can be trusted. */
export function storedCitationCount(hypotheses: InvestigationHypothesis[]): number {
  return citationsOf(hypotheses).filter((citation) => citation.contentStatus === 'STORED').length;
}

export function listInvestigations(incidentId: string): Promise<InvestigationRun[]> {
  return api.get<InvestigationRun[]>(
    '/api/v1/incidents/' + encodeURIComponent(incidentId) + '/investigations',
  );
}

export function getInvestigation(incidentId: string, runId: string): Promise<InvestigationRun> {
  return api.get<InvestigationRun>(
    '/api/v1/incidents/' +
      encodeURIComponent(incidentId) +
      '/investigations/' +
      encodeURIComponent(runId),
  );
}

export function startInvestigation(
  incidentId: string,
  input: StartInvestigationInput = {},
): Promise<InvestigationRun> {
  const body: Record<string, unknown> = { idempotencyKey: input.idempotencyKey };
  const optional = [
    'scenario',
    'maxSteps',
    'maxToolCalls',
    'toolTimeoutMs',
    'maxRetries',
    'tokenBudget',
    'deadlineSeconds',
  ] as const;
  for (const field of optional) {
    if (input[field] !== undefined) body[field] = input[field];
  }
  return api.post<InvestigationRun>(
    '/api/v1/incidents/' + encodeURIComponent(incidentId) + '/investigations',
    body,
    input.idempotencyKey,
  );
}

export function cancelInvestigation(incidentId: string, runId: string): Promise<InvestigationRun> {
  return api.post<InvestigationRun>(
    '/api/v1/incidents/' +
      encodeURIComponent(incidentId) +
      '/investigations/' +
      encodeURIComponent(runId) +
      '/cancel',
    {},
  );
}

/**
 * Review an investigation.
 *
 * The signature accepts only the two decisions this system has for a review. There is no
 * overload, no free string and no CONFIRMED: a caller that wants to conclude the incident has
 * to go to the verdict endpoint, which is a different act by a different person at a different
 * time.
 */
export function reviewInvestigation(
  incidentId: string,
  runId: string,
  decision: ReviewDecision,
  note: string,
): Promise<InvestigationRun> {
  return api.post<InvestigationRun>(
    '/api/v1/incidents/' +
      encodeURIComponent(incidentId) +
      '/investigations/' +
      encodeURIComponent(runId) +
      '/review',
    { decision, note },
  );
}
