import * as React from 'react';
import { api, ApiError } from '../api';
import { useI18n, useT } from '../i18n';
import { ageMessage } from '../lib/age';
import { Badge, type BadgeVariant } from './ui/badge';
import { Button } from './ui/button';
import { KV, useToast } from './Ui';
import {
  VERDICT_SAFETY_KEY,
  adapterBadgeKey,
  canCancel,
  canReview,
  cancelInvestigation,
  citationsOf,
  confidenceKey,
  gapCodeKey,
  invocationErrorKey,
  isSynthetic,
  listInvestigations,
  outcomeKey,
  outcomeTone,
  reviewInvestigation,
  stanceKey,
  stanceTone,
  statusKey,
  statusTone,
  stopReasonKey,
  startInvestigation,
  toolKey,
  type InvestigationCitation,
  type InvestigationRun,
  type ReviewDecision,
} from '../investigations';

/**
 * The investigation panel: what an AI investigator read, what it thought, and what a human
 * did with that.
 *
 * Three rules the component keeps:
 *
 *   * it never renders a server sentence. Every code becomes a message key, because the
 *     kernel's English refusal in a Chinese UI is the bug AGENTS.md's i18n rule prevents;
 *   * it never offers an action that the server would refuse. The review controls appear only
 *     for a finished, unreviewed run; the cancel control only for a running one;
 *   * it has no verdict control at all, and the panel says so in one sentence whose key is
 *     fixed (VERDICT_SAFETY_KEY) so the guarantee can be asserted rather than assumed.
 *
 * It is deliberately self-contained rather than reaching into the detail page's reducer: the
 * incident's view state machine is a careful thing (see the header of IncidentDetail.tsx) and
 * an investigation arriving or failing must not be able to disturb it.
 */
type LoadState = 'idle' | 'loading' | 'ready' | 'failed';


/** This panel's tone vocabulary, mapped once onto the design system's badge variants. */
function variantFor(tone: 'neutral' | 'positive' | 'warning' | 'negative'): BadgeVariant {
  switch (tone) {
    case 'positive': return 'success';
    case 'warning': return 'warning';
    case 'negative': return 'destructive';
    default: return 'secondary';
  }
}

const REVIEW_NOTE_MIN = 10;
const REVIEW_NOTE_MAX = 2000;

export function InvestigationPanel({ incidentId, canOperate }: { incidentId: string; canOperate: boolean }) {
  const t = useT();
  const { locale } = useI18n();
  const toast = useToast();
  const [runs, setRuns] = React.useState<InvestigationRun[]>([]);
  const [state, setState] = React.useState<LoadState>('idle');
  const [failure, setFailure] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'start' | 'cancel' | 'review' | null>(null);
  const [note, setNote] = React.useState('');
  const [openCitation, setOpenCitation] = React.useState<string | null>(null);
  const [citationBody, setCitationBody] = React.useState<{ id: string; text: string; note: string } | null>(null);

  const refresh = React.useCallback(async () => {
    setState('loading');
    try {
      const items = await listInvestigations(incidentId);
      setRuns(items);
      setSelected((current) => current ?? items[0]?.runId ?? null);
      setState('ready');
      setFailure(null);
    } catch (error) {
      setState('failed');
      setFailure(error instanceof ApiError ? error.code : 'INVESTIGATION_LIST_FAILED');
    }
  }, [incidentId]);

  React.useEffect(() => {
    // A new incident is a new panel: nothing from the previous one may survive a route change.
    setRuns([]);
    setSelected(null);
    setOpenCitation(null);
    setCitationBody(null);
    void refresh();
  }, [incidentId, refresh]);

  const current = runs.find((run) => run.runId === selected) ?? null;

  async function onStart() {
    setBusy('start');
    try {
      const run = await startInvestigation(incidentId, { idempotencyKey: crypto.randomUUID() });
      setRuns((previous) => [run, ...previous.filter((item) => item.runId !== run.runId)]);
      setSelected(run.runId);
      toast.push({ title: t('investigations.toast.started'), tone: 'ok' });
    } catch (error) {
      toast.push({
        title: t('investigations.toast.startFailed'),
        detail: t(errorKeyFor(error)),
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  }

  async function onCancel(run: InvestigationRun) {
    setBusy('cancel');
    try {
      const updated = await cancelInvestigation(incidentId, run.runId);
      setRuns((previous) => previous.map((item) => (item.runId === updated.runId ? updated : item)));
      toast.push({ title: t('investigations.toast.cancelRequested'), tone: 'ok' });
    } catch (error) {
      toast.push({
        title: t('investigations.toast.cancelFailed'),
        detail: t(errorKeyFor(error)),
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  }

  async function onReview(run: InvestigationRun, decision: ReviewDecision) {
    if (note.trim().length < REVIEW_NOTE_MIN) {
      toast.push({ title: t('investigations.review.noteTooShort'), tone: 'danger' });
      return;
    }
    setBusy('review');
    try {
      const updated = await reviewInvestigation(incidentId, run.runId, decision, note.trim());
      setRuns((previous) => previous.map((item) => (item.runId === updated.runId ? updated : item)));
      setNote('');
      toast.push({ title: t('investigations.toast.reviewed'), tone: 'ok' });
    } catch (error) {
      toast.push({
        title: t('investigations.toast.reviewFailed'),
        detail: t(errorKeyFor(error)),
        tone: 'danger',
      });
    } finally {
      setBusy(null);
    }
  }

  async function onOpenCitation(citation: InvestigationCitation) {
    if (openCitation === citation.evidenceId) {
      setOpenCitation(null);
      setCitationBody(null);
      return;
    }
    setOpenCitation(citation.evidenceId);
    setCitationBody(null);
    if (citation.contentStatus !== 'STORED') {
      setCitationBody({ id: citation.evidenceId, text: '', note: t('investigations.citation.referenceOnly') });
      return;
    }
    try {
      const content = await api.text(
        '/api/v1/incidents/' + encodeURIComponent(incidentId) + '/evidence/' + encodeURIComponent(citation.evidenceId) + '/content',
      );
      setCitationBody({ id: citation.evidenceId, text: content.text, note: '' });
    } catch (error) {
      setCitationBody({
        id: citation.evidenceId,
        text: '',
        note: t(invocationErrorKey(error instanceof ApiError ? error.code : null)),
      });
    }
  }

  return (
    <section className="panel" data-testid="incident-investigations" data-runs={runs.length} data-state={state}>
      <div className="panel-head">
        <div>
          <h2>{t('investigations.title')}</h2>
          <p>{t('investigations.description')}</p>
        </div>
        <div className="inline-actions">
          {canOperate ? (
            <Button variant="default" data-testid="investigation-start" disabled={busy !== null} onClick={onStart}>
              {busy === 'start' ? t('investigations.action.starting') : t('investigations.action.start')}
            </Button>
          ) : null}
          <Button variant="secondary" data-testid="investigation-refresh" onClick={() => void refresh()}>
            {t('action.refresh')}
          </Button>
        </div>
      </div>

      <p className="muted small pad" data-testid="investigation-verdict-untouched">
        {t(VERDICT_SAFETY_KEY)}
      </p>

      {state === 'loading' && runs.length === 0 ? (
        <p className="muted small pad" aria-busy="true" data-testid="investigation-loading">{t('aria.loading')}</p>
      ) : null}
      {state === 'failed' ? (
        <div className="pad" data-testid="investigation-unavailable">
          <p className="muted small">{t('investigations.unavailable')}</p>
          <p className="mono small" data-testid="investigation-unavailable-code">{t(errorKeyForCode(failure))}</p>
          <Button variant="secondary" onClick={() => void refresh()}>{t('action.retry')}</Button>
        </div>
      ) : null}
      {state === 'ready' && runs.length === 0 ? (
        <p className="muted small pad" data-testid="investigation-empty">{t('investigations.empty')}</p>
      ) : null}

      {runs.length > 0 ? (
        <div className="pad" data-testid="investigation-history">
          <h3>{t('investigations.history.title')}</h3>
          <ol className="timeline" data-testid="investigation-history-list">
            {runs.map((run) => (
              <li key={run.runId} data-run-id={run.runId} data-run-status={run.status}>
                <button
                  type="button"
                  className="link-button"
                  data-testid="investigation-select"
                  data-selected={run.runId === selected}
                  onClick={() => setSelected(run.runId)}
                >
                  {t(statusKey(run.status))}
                  <span className="muted small"> · {ageMessage(locale, run.startedAt)}</span>
                  <span className="mono small"> · {t(adapterBadgeKey(run.adapter))}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {current ? (
        <div className="pad" data-testid="investigation-run" data-run-status={current.status} data-adapter={current.adapter}>
          <div className="inline-actions" data-testid="investigation-adapter">
            <Badge variant={variantFor(isSynthetic(current) ? 'warning' : 'neutral')} data-testid="investigation-adapter-badge">
              {t(adapterBadgeKey(current.adapter))}
            </Badge>
            <Badge variant={variantFor(statusTone(current.status))} data-testid="investigation-status">{t(statusKey(current.status))}</Badge>
            {current.stale ? <Badge variant="warning" data-testid="investigation-stale">{t('investigations.stale')}</Badge> : null}
            <span className="muted small" data-testid="investigation-stop-reason">{t(stopReasonKey(current.stopReason))}</span>
          </div>
          {isSynthetic(current) ? (
            <p className="muted small" data-testid="investigation-fixture-notice">{t('investigations.adapter.fixtureNotice')}</p>
          ) : null}

          <div className="summary-grid">
            <div className="panel metric-card"><span className="metric-label">{t('investigations.metric.steps')}</span><strong className="metric-value mono">{current.usage.steps} / {current.budget.maxSteps}</strong></div>
            <div className="panel metric-card"><span className="metric-label">{t('investigations.metric.calls')}</span><strong className="metric-value mono">{current.usage.toolCalls} / {current.budget.maxToolCalls}</strong></div>
            <div className="panel metric-card"><span className="metric-label">{t('investigations.metric.tokens')}</span><strong className="metric-value mono">{current.usage.totalTokens} / {current.budget.tokenBudget}</strong></div>
            <div className="panel metric-card"><span className="metric-label">{t('investigations.metric.cost')}</span><strong className="metric-value mono">{t(costKey(current.usage.costBasis))}</strong></div>
          </div>

          <KV label={t('investigations.field.deadline')}>{ageMessage(locale, current.deadlineAt)}</KV>
          <KV label={t('investigations.field.retries')}>{String(current.usage.retries) + ' / ' + String(current.budget.maxRetries)}</KV>
          <KV label={t('investigations.field.toolTimeout')}>{String(current.budget.toolTimeoutMs)}</KV>
          <KV label={t('investigations.field.provider')}>{current.adapterProviderId}</KV>

          {canOperate && canCancel(current) ? (
            <Button variant="secondary" data-testid="investigation-cancel" disabled={busy !== null} onClick={() => void onCancel(current)}>
              {busy === 'cancel' ? t('investigations.action.cancelling') : t('investigations.action.cancel')}
            </Button>
          ) : null}

          <h3>{t('investigations.tools.title')}</h3>
          {current.toolInvocations.length === 0 ? (
            <p className="muted small" data-testid="investigation-tools-empty">{t('investigations.tools.empty')}</p>
          ) : (
            <ol className="timeline" data-testid="investigation-tools">
              {current.toolInvocations.map((invocation) => (
                <li key={invocation.invocationId} data-tool={invocation.tool} data-outcome={invocation.outcome}>
                  <Badge variant={variantFor(outcomeTone(invocation.outcome))}>{t(outcomeKey(invocation.outcome))}</Badge>
                  <strong> {t(toolKey(invocation.tool))}</strong>
                  <span className="muted small"> · {String(invocation.durationMs)} ms</span>
                  <span className="muted small"> · {t('investigations.tools.attempt', { attempt: invocation.attempt })}</span>
                  {invocation.authorizationPredicate ? (
                    <span className="mono small" data-testid="investigation-predicate"> · {invocation.authorizationPredicate}</span>
                  ) : null}
                  {invocation.errorCode ? (
                    <div className="muted small" data-testid="investigation-tool-error">
                      {t(invocationErrorKey(invocation.errorCode))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          )}

          <h3>{t('investigations.hypotheses.title')}</h3>
          {current.hypotheses.length === 0 ? (
            <p className="muted small" data-testid="investigation-hypotheses-empty">{t('investigations.hypotheses.empty')}</p>
          ) : (
            <ol className="timeline" data-testid="investigation-hypotheses">
              {current.hypotheses.map((hypothesis) => (
                <li key={hypothesis.hypothesisId} data-stance={hypothesis.stance}>
                  <Badge variant={variantFor(stanceTone(hypothesis.stance))} data-testid="investigation-stance">
                    {t(stanceKey(hypothesis.stance))}
                  </Badge>
                  <span className="muted small" data-testid="investigation-confidence">
                    {' '}{t(confidenceKey(hypothesis.confidence))}
                  </span>
                  <p data-testid="investigation-statement">{hypothesis.statement}</p>
                  <p className="muted small" data-testid="investigation-reasoning">{hypothesis.reasoning}</p>
                  {hypothesis.uncertainty ? (
                    <p className="muted small" data-testid="investigation-uncertainty">{hypothesis.uncertainty}</p>
                  ) : null}
                  {hypothesis.gapCodes.length > 0 ? (
                    <p className="inline-actions" data-testid="investigation-gaps">
                      {hypothesis.gapCodes.map((code) => (
                        <Badge key={code} variant="warning">{t(gapCodeKey(code))}</Badge>
                      ))}
                    </p>
                  ) : null}
                  <CitationList
                    title={t('investigations.hypotheses.supporting')}
                    citations={hypothesis.supportingEvidence}
                    openId={openCitation}
                    onOpen={onOpenCitation}
                  />
                  <CitationList
                    title={t('investigations.hypotheses.contradicting')}
                    citations={hypothesis.contradictingEvidence}
                    openId={openCitation}
                    onOpen={onOpenCitation}
                  />
                </li>
              ))}
            </ol>
          )}

          {citationBody ? (
            <div className="panel pad" data-testid="investigation-citation-content" data-evidence-id={citationBody.id}>
              {citationBody.note ? (
                <p className="muted small">{citationBody.note}</p>
              ) : (
                <pre className="mono small evidence-body">{citationBody.text}</pre>
              )}
            </div>
          ) : null}

          <h3>{t('investigations.review.title')}</h3>
          {current.review ? (
            <div data-testid="investigation-review" data-decision={current.review.decision}>
              <Badge variant={current.review.decision === 'ACCEPTED' ? 'success' : 'destructive'}>
                {t(current.review.decision === 'ACCEPTED' ? 'investigations.review.ACCEPTED' : 'investigations.review.REJECTED')}
              </Badge>
              <span className="muted small"> · {ageMessage(locale, current.review.reviewedAt)}</span>
              <p className="muted small">{current.review.note}</p>
            </div>
          ) : canOperate && canReview(current) ? (
            <div data-testid="investigation-review-form">
              <p className="muted small">{t('investigations.review.prompt')}</p>
              <textarea
                className="input"
                data-testid="investigation-review-note"
                value={note}
                maxLength={REVIEW_NOTE_MAX}
                minLength={REVIEW_NOTE_MIN}
                onChange={(event) => setNote(event.target.value)}
                aria-label={t('investigations.review.noteAria')}
              />
              <div className="inline-actions">
                <Button
                  variant="secondary"
                  data-testid="investigation-review-accept"
                  disabled={busy !== null}
                  onClick={() => void onReview(current, 'ACCEPTED')}
                >
                  {t('investigations.review.accept')}
                </Button>
                <Button
                  variant="secondary"
                  data-testid="investigation-review-reject"
                  disabled={busy !== null}
                  onClick={() => void onReview(current, 'REJECTED')}
                >
                  {t('investigations.review.reject')}
                </Button>
              </div>
            </div>
          ) : (
            <p className="muted small" data-testid="investigation-review-waiting">
              {t(current.status === 'RUNNING' ? 'investigations.review.notFinished' : 'investigations.review.readOnly')}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function CitationList({
  title,
  citations,
  openId,
  onOpen,
}: {
  title: string;
  citations: InvestigationCitation[];
  openId: string | null;
  onOpen: (citation: InvestigationCitation) => void;
}) {
  if (citations.length === 0) return null;
  return (
    <div data-testid="investigation-citations">
      <span className="muted small">{title}</span>
      <ul className="inline-actions">
        {citations.map((citation) => (
          <li key={citation.evidenceId + citation.role}>
            <button
              type="button"
              className="link-button mono small"
              data-testid="investigation-citation"
              data-evidence-id={citation.evidenceId}
              data-open={openId === citation.evidenceId}
              onClick={() => onOpen(citation)}
            >
              {citation.evidenceId}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function costKey(basis: string) {
  switch (basis) {
    case 'TEST_FIXTURE_NO_COST': return 'investigations.cost.testFixtureNoCost' as const;
    case 'CONFIGURED_PRICE': return 'investigations.cost.configuredPrice' as const;
    case 'PROVIDER_REPORTED': return 'investigations.cost.providerReported' as const;
    default: return 'investigations.cost.noCost' as const;
  }
}

/** Any error the panel can receive, as a message key. Never the server's sentence. */
function errorKeyFor(error: unknown) {
  return errorKeyForCode(error instanceof ApiError ? error.code : null);
}

function errorKeyForCode(code: string | null) {
  switch (code) {
    case 'INVESTIGATION_LIMIT_INVALID': return 'investigations.error.investigationLimitInvalid' as const;
    case 'INVESTIGATION_IDEMPOTENCY_KEY_INVALID': return 'investigations.error.investigationIdempotencyKeyInvalid' as const;
    case 'MODEL_PROVIDER_NOT_CONFIGURED': return 'investigations.error.modelProviderNotConfigured' as const;
    case 'INVESTIGATION_NOT_RUNNING': return 'investigations.error.investigationNotRunning' as const;
    case 'INVESTIGATION_ALREADY_CANCELLED': return 'investigations.error.investigationAlreadyCancelled' as const;
    case 'INVESTIGATION_ALREADY_REVIEWED': return 'investigations.error.investigationAlreadyReviewed' as const;
    case 'INVESTIGATION_NOT_FINISHED': return 'investigations.error.investigationNotFinished' as const;
    case 'INVESTIGATION_REVIEW_DECISION_INVALID': return 'investigations.error.investigationReviewDecisionInvalid' as const;
    case 'INVESTIGATION_REVIEW_NOTE_INVALID': return 'investigations.error.investigationReviewNoteInvalid' as const;
    case 'INCIDENT_NOT_FOUND': return 'investigations.error.incidentNotFound' as const;
    case 'FORBIDDEN': return 'investigations.error.FORBIDDEN' as const;
    case null: return 'investigations.error.none' as const;
    default: return 'investigations.error.unknown' as const;
  }
}
