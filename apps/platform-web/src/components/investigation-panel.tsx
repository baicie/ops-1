import * as React from 'react';
import { api, ApiError } from '../api';
import { useI18n, useT } from '../i18n';
import { ageMessage } from '../lib/age';
import { Badge, type BadgeVariant } from './ui/badge';
import { Button } from './ui/button';
import { useToast } from './Ui';
import {
  VERDICT_SAFETY_KEY,
  adapterBadgeKey,
  canCancel,
  canReview,
  cancelInvestigation,
  confidenceKey,
  gapCodeKey,
  gateKey,
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
  toolKey,
  startInvestigation,
  type InvestigationCitation,
  type InvestigationHypothesis,
  type InvestigationRun,
  type ReviewDecision,
} from '../investigations';

/**
 * The investigation panel: what an AI investigator read, what it thought, and what a human did
 * with that.
 *
 * Four rules the component keeps:
 *
 *   * it never renders a server sentence. Every code becomes a message key, because the
 *     kernel's English refusal in a Chinese UI is the bug AGENTS.md's i18n rule prevents;
 *   * it never offers an action the server would refuse. The review controls appear only for a
 *     finished, unreviewed run; the cancel control only for a running one;
 *   * it has no verdict control at all, and the panel says so in one sentence whose key is
 *     fixed (VERDICT_SAFETY_KEY) so the guarantee can be asserted rather than assumed;
 *   * every inference carries its own provenance label. A hypothesis is rendered inside the
 *     region that names it an AI hypothesis, right next to the adapter that produced it, so a
 *     reader never has to know the wire shape to tell an inference from a fact (G12 R2).
 *
 * Every read is guarded by the identity it belongs to: the incident (an epoch), the run, and
 * the evidence row a citation names. A late answer from a previous incident is dropped instead
 * of painted, which is the difference between a slow panel and a wrong one.
 *
 * It is deliberately self-contained rather than reaching into the detail page's reducer: the
 * incident's view state machine is a careful thing (see the header of IncidentDetail.tsx) and
 * an investigation arriving or failing must not be able to disturb it.
 */
type LoadState = 'idle' | 'loading' | 'ready' | 'failed';

/** What the panel keeps about one citation's bytes: the row it belongs to, and the outcome. */
type CitationBody = { evidenceId: string; runId: string; text: string; note: string } | null;

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
  const [stale, setStale] = React.useState<{ code: string; at: string } | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [selectionGone, setSelectionGone] = React.useState(false);
  const [busy, setBusy] = React.useState<'start' | 'cancel' | 'review' | null>(null);
  const [note, setNote] = React.useState('');
  const [openCitation, setOpenCitation] = React.useState<string | null>(null);
  const [citationBody, setCitationBody] = React.useState<CitationBody>(null);

  // The identity of the reads in flight. A response is applied only when the incident it was
  // issued for, the run it belongs to and the citation a reader opened are still the same
  // three things; anything else is a late answer to a question nobody is asking any more.
  const epoch = React.useRef(0);
  const listTicket = React.useRef(0);
  const selectedRef = React.useRef<string | null>(null);
  const openCitationRef = React.useRef<string | null>(null);
  // When the rows on screen were read, so a failed re-read can say what it is showing.
  const lastGoodAt = React.useRef<string | null>(null);
  selectedRef.current = selected;
  openCitationRef.current = openCitation;

  const refresh = React.useCallback(async () => {
    const issuedAt = epoch.current;
    const ticket = ++listTicket.current;
    const live = () => epoch.current === issuedAt && listTicket.current === ticket;
    setState('loading');
    try {
      const items = await listInvestigations(incidentId);
      if (!live()) return;
      setRuns(items);
      const previous = selectedRef.current;
      const stillThere = previous !== null && items.some((run) => run.runId === previous);
      if (stillThere) {
        setSelectionGone(false);
      } else {
        // The selection is gone: the list is bounded, so a run can fall out of it. Say so and
        // move to the newest run rather than leaving the detail pane blank under a title.
        setSelectionGone(previous !== null && items.length > 0);
        setSelected(items[0]?.runId ?? null);
      }
      lastGoodAt.current = new Date().toISOString();
      setState('ready');
      setFailure(null);
      setStale(null);
    } catch (error) {
      if (!live()) return;
      // A refused or failed read carries the Kernel's code. A transport failure carries none,
      // and "an unknown code" would tell a reader nothing about what to do next.
      const code = error instanceof ApiError ? error.code : 'NETWORK';
      setState('failed');
      setFailure(code);
      // The rows on screen were read by an earlier request. They are kept - throwing them away
      // would hide the only record a reader has - but they are labelled as what they are and
      // every write control below goes away, because the authorization that allowed the read
      // is exactly what just failed.
      // Re-stated on every failure: a banner that kept the first error would name the wrong
      // reason for the second one, and the reader would act on a stale diagnosis.
      setStale({ code, at: lastGoodAt.current ?? new Date().toISOString() });
    }
  }, [incidentId]);

  React.useEffect(() => {
    // A new incident is a new panel: nothing from the previous one may survive a route change,
    // and every read issued for the previous one is invalidated here, not when it answers.
    epoch.current += 1;
    listTicket.current += 1;
    setRuns([]);
    setSelected(null);
    setSelectionGone(false);
    setOpenCitation(null);
    setCitationBody(null);
    setStale(null);
    setNote('');
    void refresh();
  }, [incidentId, refresh]);

  // A different run is a different set of citations: content opened for one run must not stay
  // under another, even though both belong to the same incident.
  React.useEffect(() => {
    setOpenCitation(null);
    setCitationBody(null);
  }, [selected]);

  const current = runs.find((run) => run.runId === selected) ?? null;
  // Everything that writes is gated on the last read having succeeded.
  const writable = canOperate && stale === null && state !== 'failed';

  async function onStart() {
    const issuedAt = epoch.current;
    setBusy('start');
    try {
      const run = await startInvestigation(incidentId, { idempotencyKey: crypto.randomUUID() });
      if (epoch.current !== issuedAt) return;
      setRuns((previous) => [run, ...previous.filter((item) => item.runId !== run.runId)]);
      setSelected(run.runId);
      toast.push({ title: t('investigations.toast.started'), tone: 'ok' });
    } catch (error) {
      if (epoch.current !== issuedAt) return;
      toast.push({
        title: t('investigations.toast.startFailed'),
        detail: t(errorKeyFor(error)),
        tone: 'danger',
      });
    } finally {
      if (epoch.current === issuedAt) setBusy(null);
    }
  }

  async function onCancel(run: InvestigationRun) {
    const issuedAt = epoch.current;
    setBusy('cancel');
    try {
      const updated = await cancelInvestigation(incidentId, run.runId);
      if (epoch.current !== issuedAt) return;
      setRuns((previous) => previous.map((item) => (item.runId === updated.runId ? updated : item)));
      toast.push({ title: t('investigations.toast.cancelRequested'), tone: 'ok' });
    } catch (error) {
      if (epoch.current !== issuedAt) return;
      toast.push({
        title: t('investigations.toast.cancelFailed'),
        detail: t(errorKeyFor(error)),
        tone: 'danger',
      });
    } finally {
      if (epoch.current === issuedAt) setBusy(null);
    }
  }

  async function onReview(run: InvestigationRun, decision: ReviewDecision) {
    if (note.trim().length < REVIEW_NOTE_MIN) {
      toast.push({ title: t('investigations.review.noteTooShort'), tone: 'danger' });
      return;
    }
    const issuedAt = epoch.current;
    setBusy('review');
    try {
      const updated = await reviewInvestigation(incidentId, run.runId, decision, note.trim());
      if (epoch.current !== issuedAt) return;
      setRuns((previous) => previous.map((item) => (item.runId === updated.runId ? updated : item)));
      setNote('');
      toast.push({ title: t('investigations.toast.reviewed'), tone: 'ok' });
    } catch (error) {
      if (epoch.current !== issuedAt) return;
      toast.push({
        title: t('investigations.toast.reviewFailed'),
        detail: t(errorKeyFor(error)),
        tone: 'danger',
      });
    } finally {
      if (epoch.current === issuedAt) setBusy(null);
    }
  }

  async function onOpenCitation(citation: InvestigationCitation, runId: string) {
    if (openCitation === citation.evidenceId) {
      setOpenCitation(null);
      setCitationBody(null);
      return;
    }
    setOpenCitation(citation.evidenceId);
    setCitationBody(null);
    if (citation.contentStatus !== 'STORED') {
      setCitationBody({
        evidenceId: citation.evidenceId,
        runId,
        text: '',
        note: t('investigations.citation.referenceOnly'),
      });
      return;
    }
    const issuedAt = epoch.current;
    try {
      const content = await api.text(
        '/api/v1/incidents/' + encodeURIComponent(incidentId) + '/evidence/' + encodeURIComponent(citation.evidenceId) + '/content',
      );
      // Three identities, not one: the incident, the run, and the citation the reader opened.
      if (epoch.current !== issuedAt || selectedRef.current !== runId || openCitationRef.current !== citation.evidenceId) return;
      setCitationBody({ evidenceId: citation.evidenceId, runId, text: content.text, note: '' });
    } catch (error) {
      if (epoch.current !== issuedAt || selectedRef.current !== runId || openCitationRef.current !== citation.evidenceId) return;
      setCitationBody({
        evidenceId: citation.evidenceId,
        runId,
        text: '',
        note: t(invocationErrorKey(error instanceof ApiError ? error.code : null)),
      });
    }
  }

  return (
    <section className="panel" data-testid="incident-investigations" data-runs={runs.length} data-state={state} data-stale={stale ? 'true' : 'false'}>
      <div className="panel-head">
        <div>
          <h2>{t('investigations.title')}</h2>
          <p>{t('investigations.description')}</p>
        </div>
        <div className="inline-actions">
          {writable ? (
            <Button variant="default" data-testid="investigation-start" disabled={busy !== null} onClick={onStart}>
              {busy === 'start' ? t('investigations.action.starting') : t('investigations.action.start')}
            </Button>
          ) : null}
          <Button variant="secondary" data-testid="investigation-refresh" onClick={() => void refresh()}>
            {t('action.refresh')}
          </Button>
        </div>
      </div>

      <p className="muted small pad investigation-safety" data-testid="investigation-verdict-untouched">
        {t(VERDICT_SAFETY_KEY)}
      </p>

      {stale ? (
        <p className="notice-bar" role="status" data-testid="investigation-stale-banner" data-stale-code={stale.code}>
          {t('investigations.staleNotice', { at: new Date(stale.at).toLocaleTimeString(), reason: t(errorKeyForCode(stale.code)) })}
        </p>
      ) : null}

      {state === 'loading' && runs.length === 0 ? (
        <p className="muted small pad" aria-busy="true" data-testid="investigation-loading">{t('aria.loading')}</p>
      ) : null}
      {state === 'failed' && stale === null ? (
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
          <h3>
            {t('investigations.history.title')}
            <span className="muted small"> · {runs.length}</span>
          </h3>
          {/* A record list, not a timeline (G12 F, P1-4) and not a stack of look-alike buttons:
              one quiet row per run, the selected one and only it carrying the panel's accent. */}
          <ul className="record-list" data-testid="investigation-history-list" data-list="run-chooser">
            {runs.map((run) => {
              const isSelected = run.runId === selected;
              return (
                <li key={run.runId} data-run-id={run.runId} data-run-status={run.status}>
                  <button
                    type="button"
                    className="investigation-run-row"
                    data-testid="investigation-select"
                    data-selected={isSelected}
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={() => setSelected(run.runId)}
                  >
                    <span className="investigation-run-state">
                      <Badge variant={variantFor(statusTone(run.status))}>{t(statusKey(run.status))}</Badge>
                      {run.review ? (
                        <span className="muted small" data-run-review={run.review.decision}>
                          {t(run.review.decision === 'ACCEPTED' ? 'investigations.review.ACCEPTED' : 'investigations.review.REJECTED')}
                        </span>
                      ) : null}
                    </span>
                    <span className="muted small investigation-run-when">
                      <span title={run.startedAt}>{ageMessage(locale, run.startedAt)}</span>
                      <span className="mono"> · {run.runId.slice(0, 8)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selectionGone ? (
            <p className="muted small" data-testid="investigation-selection-gone">{t('investigations.selectionGone')}</p>
          ) : null}
        </div>
      ) : null}

      {current ? (
        <div className="pad" data-testid="investigation-run" data-run-status={current.status} data-adapter={current.adapter} data-stale={stale ? 'true' : 'false'}>
          <div className="investigation-run-head">
            <div className="inline-actions" data-testid="investigation-adapter">
              <Badge variant={variantFor(isSynthetic(current) ? 'warning' : 'neutral')} data-testid="investigation-adapter-badge">
                {t(adapterBadgeKey(current.adapter))}
              </Badge>
              <Badge variant={variantFor(statusTone(current.status))} data-testid="investigation-status">{t(statusKey(current.status))}</Badge>
              {current.stale ? <Badge variant="warning" data-testid="investigation-stale">{t('investigations.stale')}</Badge> : null}
              <span className="muted small" data-testid="investigation-stop-reason">{t(stopReasonKey(current.stopReason))}</span>
            </div>
            {writable && canCancel(current) ? (
              <Button variant="secondary" data-testid="investigation-cancel" disabled={busy !== null} onClick={() => void onCancel(current)}>
                {busy === 'cancel' ? t('investigations.action.cancelling') : t('investigations.action.cancel')}
              </Button>
            ) : null}
          </div>
          {isSynthetic(current) ? (
            <p className="notice-bar" role="note" data-testid="investigation-fixture-notice">{t('investigations.adapter.fixtureNotice')}</p>
          ) : null}

          {/* One meta strip instead of four nested metric cards and four label/value rows: the
              numbers a reader needs before reading the conclusion, at one weight, in one place. */}
          <dl className="investigation-meta" data-testid="investigation-meta">
            <div><dt>{t('investigations.metric.steps')}</dt><dd className="mono">{current.usage.steps} / {current.budget.maxSteps}</dd></div>
            <div><dt>{t('investigations.metric.calls')}</dt><dd className="mono">{current.usage.toolCalls} / {current.budget.maxToolCalls}</dd></div>
            <div><dt>{t('investigations.metric.tokens')}</dt><dd className="mono">{current.usage.totalTokens} / {current.budget.tokenBudget}</dd></div>
            <div><dt>{t('investigations.metric.cost')}</dt><dd>{t(costKey(current.usage.costBasis))}</dd></div>
            <div><dt>{t('investigations.field.deadline')}</dt><dd><span title={current.deadlineAt}>{ageMessage(locale, current.deadlineAt)}</span></dd></div>
            <div><dt>{t('investigations.field.retries')}</dt><dd className="mono">{current.usage.retries} / {current.budget.maxRetries}</dd></div>
            <div><dt>{t('investigations.field.toolTimeout')}</dt><dd className="mono">{current.budget.toolTimeoutMs}</dd></div>
            <div><dt>{t('investigations.field.provider')}</dt><dd className="mono">{current.adapterProviderId}</dd></div>
          </dl>

          <h3>{t('investigations.hypotheses.title')}</h3>
          {current.hypotheses.length === 0 ? (
            <p className="muted small" data-testid="investigation-hypotheses-empty">{t('investigations.hypotheses.empty')}</p>
          ) : (
            <ul className="record-list" data-testid="investigation-hypotheses">
              {current.hypotheses.map((hypothesis) => (
                <Hypothesis
                  key={hypothesis.hypothesisId}
                  hypothesis={hypothesis}
                  runId={current.runId}
                  openCitation={openCitation}
                  citationBody={citationBody}
                  onOpen={onOpenCitation}
                />
              ))}
            </ul>
          )}

          <h3>{t('investigations.tools.title')}</h3>
          {current.toolInvocations.length === 0 ? (
            <p className="muted small" data-testid="investigation-tools-empty">{t('investigations.tools.empty')}</p>
          ) : (
            <ul className="record-list" data-testid="investigation-tools">
              {current.toolInvocations.map((invocation) => (
                <li key={invocation.invocationId} data-tool={invocation.tool} data-outcome={invocation.outcome}>
                  <div className="record-line">
                    <Badge variant={variantFor(outcomeTone(invocation.outcome))}>{t(outcomeKey(invocation.outcome))}</Badge>
                    <strong>{t(toolKey(invocation.tool))}</strong>
                    <span className="muted small">· {String(invocation.durationMs)} ms</span>
                    <span className="muted small">· {t('investigations.tools.attempt', { attempt: invocation.attempt })}</span>
                    {invocation.authorizationPredicate ? (
                      // G12 H (P2). The column now names the layer that decided the call for
                      // refusals as well as for successes, so this row answers "which layer"
                      // and not only "which code". The label is localized; the raw token stays
                      // in data-gate so no test depends on the copy.
                      <span
                        className="mono small"
                        data-testid="investigation-predicate"
                        data-gate={invocation.authorizationPredicate}
                      >
                        · {t('investigations.gate.decidedBy', { gate: t(gateKey(invocation.authorizationPredicate)) })}
                      </span>
                    ) : null}
                  </div>
                  {invocation.errorCode ? (
                    <div className="muted small" data-testid="investigation-tool-error">
                      {t(invocationErrorKey(invocation.errorCode))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}

          <h3>{t('investigations.review.title')}</h3>
          {current.review ? (
            <div data-testid="investigation-review" data-decision={current.review.decision}>
              <Badge variant={current.review.decision === 'ACCEPTED' ? 'success' : 'destructive'}>
                {t(current.review.decision === 'ACCEPTED' ? 'investigations.review.ACCEPTED' : 'investigations.review.REJECTED')}
              </Badge>
              <span className="muted small"> · {ageMessage(locale, current.review.reviewedAt)}</span>
              <p className="muted small">{current.review.note}</p>
            </div>
          ) : writable && canReview(current) ? (
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
                  variant="default"
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

/**
 * One hypothesis: its provenance label, its statement, what it is unsure about, the reads it
 * cites, and - when a reader opens one - the bytes of that read, in place.
 *
 * The content opens under the citation that named it rather than in a block at the bottom of the
 * run: a reader who opened a citation should not have to scroll away from it to read it, and the
 * block cannot then be mistaken for the conclusion.
 */
function Hypothesis({
  hypothesis,
  runId,
  openCitation,
  citationBody,
  onOpen,
}: {
  hypothesis: InvestigationHypothesis;
  runId: string;
  openCitation: string | null;
  citationBody: CitationBody;
  onOpen: (citation: InvestigationCitation, runId: string) => void;
}) {
  const t = useT();
  const body = citationBody && citationBody.runId === runId ? citationBody : null;
  return (
    <li data-stance={hypothesis.stance} data-hypothesis-id={hypothesis.hypothesisId}>
      <div className="record-line">
        <Badge variant="outline" data-testid="investigation-hypothesis-kind" data-hypothesis-kind="AI_HYPOTHESIS">
          {t('investigations.hypotheses.kind')}
        </Badge>
        <Badge variant={variantFor(stanceTone(hypothesis.stance))} data-testid="investigation-stance">
          {t(stanceKey(hypothesis.stance))}
        </Badge>
        <span className="muted small" data-testid="investigation-confidence">
          {t(confidenceKey(hypothesis.confidence))}
        </span>
      </div>
      <p className="investigation-statement" data-testid="investigation-statement">{hypothesis.statement}</p>
      <p className="muted small" data-testid="investigation-reasoning">{hypothesis.reasoning}</p>
      {hypothesis.uncertainty ? (
        <p className="investigation-caveat" data-testid="investigation-uncertainty">{hypothesis.uncertainty}</p>
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
        runId={runId}
        body={body}
        onOpen={onOpen}
      />
      <CitationList
        title={t('investigations.hypotheses.contradicting')}
        citations={hypothesis.contradictingEvidence}
        openId={openCitation}
        runId={runId}
        body={body}
        onOpen={onOpen}
      />
    </li>
  );
}

function CitationList({
  title,
  citations,
  openId,
  runId,
  body,
  onOpen,
}: {
  title: string;
  citations: InvestigationCitation[];
  openId: string | null;
  runId: string;
  body: CitationBody;
  onOpen: (citation: InvestigationCitation, runId: string) => void;
}) {
  const t = useT();
  if (citations.length === 0) return null;
  return (
    <div className="investigation-citations" data-testid="investigation-citations">
      <span className="muted small">{title}</span>
      <ul>
        {citations.map((citation) => {
          const isOpen = openId === citation.evidenceId;
          return (
            <li key={citation.evidenceId + citation.role}>
              <button
                type="button"
                className="link-button mono small"
                data-testid="investigation-citation"
                data-evidence-id={citation.evidenceId}
                data-open={isOpen}
                data-content-status={citation.contentStatus}
                aria-expanded={isOpen}
                aria-label={t('investigations.citation.toggle', { id: citation.evidenceId })}
                title={citation.evidenceId}
                onClick={() => onOpen(citation, runId)}
              >
                {citation.evidenceId.slice(0, 8)}
              </button>
            </li>
          );
        })}
      </ul>
      {body ? (
        <div
          className="investigation-citation-body"
          data-testid="investigation-citation-content"
          data-evidence-id={body.evidenceId}
          data-content-state={body.note ? 'unavailable' : 'stored'}
        >
          {body.note ? (
            <p className="muted small">{body.note}</p>
          ) : (
            <pre className="mono small evidence-body">{body.text}</pre>
          )}
        </div>
      ) : null}
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
    case 'NETWORK': return 'investigations.error.network' as const;
    case 'FORBIDDEN': return 'investigations.error.FORBIDDEN' as const;
    case null: return 'investigations.error.none' as const;
    default: return 'investigations.error.unknown' as const;
  }
}