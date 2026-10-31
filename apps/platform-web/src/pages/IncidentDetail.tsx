import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { IncidentEvidence, IncidentEvidenceList, IncidentView } from '../types';
import { useAuth } from '../auth';
import { useDocumentTitle } from '../hooks';
import { useI18n, useT } from '../i18n';
import { ageMessage } from '../lib/age';
import { Icon } from '../components/Icons';
import { Badge } from '../components/ui/badge';
import { Button, buttonVariants } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { CopyButton, Field, KV, useToast } from '../components/Ui';
import { PageHeader } from '../components/app/page-header';
import { Status } from '../components/app/status';
import { badgeVariantForTone } from '../components/status-tone';
import {
  CLAIMABLE_TRUST_CODES,
  EVIDENCE_KIND_CODES,
  RATIONALE_MIN_CHARS,
  VERDICT_CHOICES,
  classifyFailure,
  detailPhase,
  detailReducer,
  emptyDetail,
  evidenceKindKey,
  evidencePanelState,
  evidenceTrustKey,
  evidenceTrustTone,
  incidentFacts,
  incidentSourceKey,
  partitionEvidence,
  projectDetail,
  shortOwner,
  toIsoInstant,
  toLocalInputValue,
  trustMismatch,
  verdictPanelState,
  verdictSnapshotState,
  verificationMethodKey,
} from '../incidents';
import { IncidentFailureNotice, useUserDirectory } from './Incidents';
import { LongId } from './table-kit';

/**
 * /app/incidents/:id - one incident, its evidence and its human verdict (G11 D3, hardened in G12).
 *
 * The rules this page keeps, in the order they matter:
 *
 *   * a route change is not a refresh. Arriving at another incident clears the snapshot before the
 *     new request leaves, so the previous incident's title, evidence and verdict are never painted
 *     under a different URL - not even for one frame (incidents.ts detailReducer / projectDetail);
 *   * an answer for another incident is dropped by comparison, never by a timeout. A slow response
 *     for A cannot land on B;
 *   * 401/403/404 are answers and they clear the view; a network error is the absence of an answer
 *     and keeps the data it already has, with the timestamp it was read at;
 *   * every write goes to the id on screen, because the forms are handed the projected incident and
 *     not the URL parameter;
 *   * what the kernel verified and what the submitter claimed are rendered as two facts, and what a
 *     verdict actually considered is separated from what was appended afterwards.
 */
export function IncidentDetailPage() {
  const t = useT();
  const { locale } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const { incidentId = '' } = useParams();
  useDocumentTitle(t('page.workspaceIncidents'));
  const directory = useUserDirectory();

  const [store, dispatch] = React.useReducer(detailReducer, incidentId, emptyDetail);
  // The ordering guard. Every request carries the sequence number it was issued under, and a
  // response whose number is no longer current is discarded. No delay is involved anywhere.
  const seqRef = React.useRef(0);
  const [reload, setReload] = React.useState(0);
  const retry = React.useCallback(() => setReload((value) => value + 1), []);

  // The state that is actually rendered. It is only ever the state that describes this route.
  const view = projectDetail(store, incidentId);
  const phase = detailPhase(view);

  React.useEffect(() => {
    const seq = ++seqRef.current;
    const id = incidentId;
    let cancelled = false;
    const live = () => !cancelled && seq === seqRef.current;

    // Before the first request leaves: if the route id changed, this clears the previous
    // incident's data; if it did not, it is a same-id refresh and the data stays.
    dispatch({ type: 'route', routeId: id });
    dispatch({ type: 'refresh' });

    const base = '/api/v1/incidents/' + encodeURIComponent(id);
    api.get<IncidentView>(base)
      .then((result) => {
        if (!live()) return;
        dispatch({ type: 'incident', routeId: id, incident: result, observedAt: new Date().toISOString() });
      })
      .catch((cause: unknown) => {
        if (!live()) return;
        dispatch({ type: 'incident-failed', routeId: id, cause });
      });
    api.get<IncidentEvidenceList>(base + '/evidence')
      .then((result) => {
        if (!live()) return;
        dispatch({ type: 'evidence', routeId: id, evidence: result.items });
      })
      .catch((cause: unknown) => {
        if (!live()) return;
        dispatch({ type: 'evidence-failed', routeId: id, cause });
      });

    return () => { cancelled = true; };
  }, [incidentId, reload]);

  const backLink = <Link className={buttonVariants({ variant: 'secondary' })} to="/app/incidents">{t('incidents.action.backToList')}</Link>;

  if (phase === 'not-found' || phase === 'denied') {
    const denied = phase === 'denied';
    return (
      <div className="page-stack" data-testid="incident-detail" data-detail-state={denied ? 'denied' : 'not-found'}>
        <PageHeader eyebrow={t('incidents.eyebrow')} title={t('page.workspaceIncidents')} actions={backLink} />
        <section className="panel pad">
          <div data-testid={denied ? 'incident-denied' : 'incident-not-found'} data-detail-state={denied ? 'denied' : 'not-found'}>
            <h2>{t(denied ? 'incidents.detail.denied.title' : 'incidents.detail.missing.title')}</h2>
            <p className="muted">{t(denied ? 'incidents.detail.denied.description' : 'incidents.detail.missing.description')}</p>
            <p className="muted small"><code>{incidentId}</code></p>
          </div>
          <IncidentFailureNotice error={view.incidentError} testId="incident-detail-error" />
        </section>
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div className="page-stack" data-testid="incident-detail" data-detail-state="failed">
        <PageHeader eyebrow={t('incidents.eyebrow')} title={t('page.workspaceIncidents')} actions={backLink} />
        <section className="panel pad">
          <IncidentFailureNotice error={view.incidentError} testId="incident-detail-error" />
          <Button variant="secondary" onClick={retry}><Icon name="refresh" size={15} /> {t('action.retry')}</Button>
        </section>
      </div>
    );
  }

  const incident = view.incident;
  if (!incident) {
    return (
      <div className="page-stack" data-testid="incident-detail" data-detail-state="loading">
        <PageHeader eyebrow={t('incidents.eyebrow')} title={t('page.workspaceIncidents')} actions={backLink} />
        <section className="panel pad" aria-busy={view.refreshing}>
          <div className="skeleton-stack" aria-label={t('aria.loading')}>
            <div className="skeleton" style={{ width: '38%' }} />
            <div className="skeleton" style={{ width: '62%' }} />
            <div className="skeleton" style={{ width: '48%' }} />
          </div>
        </section>
      </div>
    );
  }

  const evidence = view.evidence ?? [];
  const partition = partitionEvidence(evidence, incident.humanVerdict);
  const facts = incidentFacts(incident, partition.considered);
  const evidenceState = evidencePanelState(view.evidence, Boolean(view.evidenceError));
  const verdictState = verdictPanelState(incident);
  const ownerLabel = directory.names?.[incident.owner] ?? shortOwner(incident.owner);
  const decidedByLabel = incident.humanVerdict
    ? (directory.names?.[incident.humanVerdict.decidedBy] ?? shortOwner(incident.humanVerdict.decidedBy))
    : null;
  // Stale, and honestly labelled: the record on screen was read at a known instant and the most
  // recent read failed. That is a different sentence from "this incident could not be loaded".
  const staleFailure = view.incidentError ?? view.evidenceError ?? null;

  return (
    <div className="page-stack" data-testid="incident-detail" data-incident-id={incident.id} data-route-id={incidentId}>
      <PageHeader
        eyebrow={t('incidents.eyebrow')}
        title={incident.title}
        description={(
          <span className="job-subtitle">
            <span data-testid="incident-detail-status"><Status code={incident.status} /></span>
            <span data-testid="incident-detail-severity"><Status code={incident.severity} /></span>
            <span className="tag" data-testid="incident-detail-source" data-source={incident.source}>{t(incidentSourceKey(incident.source))}</span>
            {incident.relatedEntity ? <span className="muted" data-testid="incident-detail-related">{incident.relatedEntity}</span> : null}
          </span>
        )}
        actions={<><Button variant="secondary" data-testid="incident-refresh" onClick={retry}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>{backLink}</>}
      />

      {staleFailure ? <IncidentStale observedAt={view.observedAt} error={staleFailure} /> : null}

      <section className="summary-grid">
        <div className="panel metric-card"><span className="metric-label">{t('table.status')}</span><strong className="metric-value"><Status code={incident.status} /></strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('table.severity')}</span><strong className="metric-value"><Status code={incident.severity} /></strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('table.evidence')}</span><strong className="metric-value mono" data-testid="incident-detail-evidence-count">{view.evidence ? evidence.length : '—'}</strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('table.updated')}</span><strong className="metric-value"><span title={incident.updatedAt}>{ageMessage(locale, incident.updatedAt)}</span></strong></div>
      </section>

      <section className="panel" data-testid="incident-identity">
        <div className="panel-head"><div><h2>{t('table.details')}</h2></div></div>
        <div className="kv-grid">
          <KV label={t('table.incident')} mono>{<LongId value={incident.id} label={t('table.copyIdentifier')} testId="incident-id" />}</KV>
          <KV label={t('table.started')}>{<span title={incident.startedAt}>{ageMessage(locale, incident.startedAt)}</span>}</KV>
          <KV label={t('table.owner')} mono>{<span title={incident.owner} data-testid="incident-detail-owner">{ownerLabel}</span>}</KV>
          <KV label={t('table.source')}>{t(incidentSourceKey(incident.source))}</KV>
          <KV label={t('table.relatedEntity')} mono>{incident.relatedEntity || t('common.none')}</KV>
        </div>
      </section>

      <section className="panel" data-testid="incident-timeline">
        <div className="panel-head">
          <div>
            <h2>{t('incidents.timeline.title')}</h2>
            <p>{t('incidents.timeline.description')}</p>
          </div>
        </div>
        {facts.length <= 1 && !incident.humanVerdict ? (
          <p className="muted small pad" data-testid="incident-timeline-empty">{t('incidents.timeline.empty')}</p>
        ) : null}
        <ol className="timeline pad" data-testid="incident-timeline-list">
          {facts.map((fact) => (
            <li key={fact.id} data-fact-kind={fact.kind} data-fact-at={fact.at}>
              <span className="timeline-dot" />
              <div>
                <strong>
                  {fact.kind === 'started' ? t('incidents.timeline.started') : fact.kind === 'evidence' ? t('incidents.timeline.evidence') : t('incidents.timeline.verdict')}
                </strong>
                {fact.kind === 'evidence' && fact.evidence ? (
                  <>
                    <span className="tag">{t(evidenceKindKey(fact.evidence.kind))}</span>
                    <span className="muted small">{fact.evidence.source}</span>
                  </>
                ) : null}
                {fact.kind === 'verdict' && fact.verdict ? (
                  <>
                    <Status code={fact.verdict.verdict} />
                    <span className="muted small">{decidedByLabel}</span>
                  </>
                ) : null}
                <span className="muted small" data-testid="fact-time">
                  {fact.atValid ? <span title={fact.at}>{ageMessage(locale, fact.at)}</span> : t('incidents.timeline.unparseable', { value: fact.at })}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel" data-testid="incident-evidence" data-evidence-state={evidenceState}>
        <div className="panel-head">
          <div>
            <h2>{t('table.evidence')}</h2>
            <p>{t('incidents.detail.evidence.description')}</p>
          </div>
        </div>
        {evidenceState === 'loading' ? (
          <p className="muted small pad" aria-busy="true" data-testid="incident-evidence-loading">{t('aria.loading')}</p>
        ) : evidenceState === 'unavailable' ? (
          <div className="pad" data-testid="incident-evidence-unavailable">
            <p><strong>{t('incidents.detail.evidence.unavailable.title')}</strong></p>
            <p className="muted small">{t('incidents.detail.evidence.unavailable.description')}</p>
            <IncidentFailureNotice error={view.evidenceError} testId="incident-evidence-error" />
            <Button variant="secondary" onClick={retry}><Icon name="refresh" size={15} /> {t('action.retry')}</Button>
          </div>
        ) : evidenceState === 'missing' ? (
          <div className="pad" data-testid="incident-evidence-empty">
            <p><strong>{t('incidents.detail.evidence.empty.title')}</strong></p>
            <p className="muted small">{t('incidents.detail.evidence.empty.description')}</p>
          </div>
        ) : (
          <div className="table-panel">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('table.kind')}</TableHead>
                  <TableHead>{t('table.trust')}</TableHead>
                  <TableHead>{t('table.source')}</TableHead>
                  <TableHead>{t('table.collectedAt')}</TableHead>
                  <TableHead>{t('table.contentRef')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {evidence.map((row) => (
                  <TableRow key={row.id} data-evidence-row={row.id} data-after-verdict={row.afterVerdict ? 'true' : 'false'}>
                    <TableCell data-evidence-kind={row.kind}>
                      {t(evidenceKindKey(row.kind))}
                      {row.afterVerdict ? (
                        <Badge variant={badgeVariantForTone('warn')} data-testid="evidence-after-verdict">{t('incidents.evidence.afterVerdict')}</Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {/* The kernel's conclusion is the badge. The claim is printed under it, and
                          when the two disagree the row says so instead of showing only one of them. */}
                      <Badge
                        variant={badgeVariantForTone(evidenceTrustTone(row.verifiedTrust))}
                        data-verified-trust={row.verifiedTrust}
                        data-claimed-trust={row.claimedTrust}
                        data-trust-mismatch={trustMismatch(row) ? 'true' : 'false'}
                      >
                        {t(evidenceTrustKey(row.verifiedTrust))}
                      </Badge>
                      <span className="muted small" data-testid="evidence-claimed" data-claimed-trust={row.claimedTrust}>
                        {t('incidents.evidence.claimed', { value: t(evidenceTrustKey(row.claimedTrust)) })}
                      </span>
                      <span className="muted small" data-testid="evidence-method" data-verification-method={row.verificationMethod} data-verifier={row.verifierIdentity ?? ''}>
                        {row.verifierIdentity
                          ? t('incidents.evidence.verifiedBy', { adapter: row.verifierIdentity })
                          : t(verificationMethodKey(row.verificationMethod))}
                      </span>
                      {row.verificationNote ? <span className="muted small" data-testid="evidence-note">{row.verificationNote}</span> : null}
                    </TableCell>
                    <TableCell className="mono" title={row.source} data-evidence-source={row.source}>{row.source}</TableCell>
                    <TableCell><span title={row.collectedAt}>{row.collectedAt}</span></TableCell>
                    <TableCell>
                      <span className="ow-longid">
                        <span className="ow-longid-value" title={row.contentRef} data-testid="evidence-content-ref">{row.contentRef}</span>
                        <CopyButton value={row.contentRef} label={t('table.copyIdentifier')} />
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="table-footnote" data-testid="incident-evidence-ref-note">{t('incidents.detail.evidence.refNote')}</p>
          </div>
        )}
        {/* Evidence stays appendable AFTER a verdict: CONCLUDED accepts it (ADR-G11-001 §3.1),
            and only CLOSED refuses writes. Gating this on "no verdict yet" told the reader the
            opposite of what the kernel does. */}
        {incident.status === 'CLOSED' ? (
          <p className="muted small pad" data-testid="incident-evidence-sealed">{t('incidents.error.closed')}</p>
        ) : (
          <AddEvidenceForm
            incidentId={incident.id}
            defaultSource={user ? 'operator:' + user.email : 'operator:'}
            onAdded={() => {
              toast.push({ tone: 'ok', title: t('incidents.evidence.add.success') });
              retry();
            }}
          />
        )}
      </section>

      <section className="panel" data-testid="incident-verdict" data-verdict-state={verdictState}>
        <div className="panel-head">
          <div>
            <h2>{t('incidents.verdict.title')}</h2>
            <p>{t('incidents.verdict.description')}</p>
          </div>
        </div>
        {verdictState === 'recorded' && incident.humanVerdict ? (
          <div className="pad" data-testid="incident-verdict-record" data-verdict-value={incident.humanVerdict.verdict}>
            <p><Status code={incident.humanVerdict.verdict} /> <span className="muted small" data-testid="incident-verdict-attribution">{t('incidents.verdict.decidedBy', { id: decidedByLabel ?? '' })}</span></p>
            <p className="muted small">{t('incidents.verdict.writeOnce')}</p>
            <KV label={t('table.rationale')}>{incident.humanVerdict.rationale}</KV>
            <p className="muted small"><span title={incident.humanVerdict.decidedAt}>{ageMessage(locale, incident.humanVerdict.decidedAt)}</span></p>
            {/* A3: what the signature stands on, separated from what the record holds now. */}
            <p
              className="muted small"
              data-testid="incident-verdict-considered"
              data-snapshot-kind={incident.humanVerdict.snapshotKind}
              data-considered-count={incident.humanVerdict.consideredEvidenceCount}
              data-after-count={partition.afterVerdict.length}
            >
              {verdictSnapshotState(incident.humanVerdict) === 'recorded'
                ? t('incidents.verdict.considered.recorded', { count: incident.humanVerdict.consideredEvidenceCount })
                : t('incidents.verdict.considered.unknown')}
            </p>
            {incident.humanVerdict.consideredEvidenceDigest ? (
              <p className="muted small" data-testid="incident-verdict-digest">
                {t('incidents.verdict.considered.digest')} <code>{incident.humanVerdict.consideredEvidenceDigest}</code>
              </p>
            ) : null}
            {partition.afterVerdict.length > 0 ? (
              <p className="notice-bar" data-testid="incident-verdict-after">
                {t('incidents.verdict.considered.after', { count: partition.afterVerdict.length })}
              </p>
            ) : null}
          </div>
        ) : verdictState === 'sealed' ? (
          <p className="muted small pad" data-testid="incident-verdict-sealed">{t('incidents.verdict.sealed')}</p>
        ) : (
          <VerdictForm
            incidentId={incident.id}
            hasEvidence={evidence.length > 0}
            onRecorded={() => {
              toast.push({ tone: 'ok', title: t('incidents.verdict.success') });
              retry();
            }}
          />
        )}
        {verdictState !== 'recorded' ? <p className="muted small pad">{t('incidents.verdict.onlyTwo')}</p> : null}
      </section>
    </div>
  );
}

/** The banner a page shows when it is still rendering rows from a read that has since failed. */
function IncidentStale({ observedAt, error }: { observedAt: string | null; error: unknown }) {
  const t = useT();
  const at = observedAt ? new Date(observedAt) : null;
  const stamp = at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString() : (observedAt ?? '');
  const code = classifyFailure(error).code;
  return (
    <p className="notice-bar" data-testid="incident-freshness" data-stale="true">
      {t('incidents.freshness.stale', { at: stamp, reason: code ?? t('incidents.error.network') })}
    </p>
  );
}

/**
 * The append form.
 *
 * collectedAt defaults to now but is editable, because the kernel separates "when it was
 * collected" from "when it was recorded" and a late paste of an earlier log is a normal case.
 * contentRef is described as what it is - an opaque locator, not inline text.
 *
 * The trust control is gone. What replaced it is a claim control with two options, and the reason
 * the third is missing is written on the form: SOURCE_ATTESTED is the kernel's verdict and can
 * only be produced by a configured source adapter presenting a signature. Hiding the option is
 * presentation; the kernel refuses the value whatever this form sends.
 */
function AddEvidenceForm({ incidentId, defaultSource, onAdded }: { incidentId: string; defaultSource: string; onAdded: () => void }) {
  const t = useT();
  const [kind, setKind] = React.useState<string>('LOG_EXCERPT');
  const [source, setSource] = React.useState(defaultSource);
  const [collectedAt, setCollectedAt] = React.useState(() => toLocalInputValue(new Date()));
  const [contentRef, setContentRef] = React.useState('');
  const [claimedTrust, setClaimedTrust] = React.useState<string>('OPERATOR_ASSERTED');
  const [submitting, setSubmitting] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);
  const [fieldError, setFieldError] = React.useState<string | null>(null);

  const submit = async () => {
    setFailure(null);
    setFieldError(null);
    const iso = toIsoInstant(collectedAt);
    const trimmedSource = source.trim();
    const trimmedRef = contentRef.trim();
    if (!iso || trimmedSource.length < 2 || trimmedRef.length < 2) {
      setFieldError(t('incidents.error.invalidRequest'));
      return;
    }
    setSubmitting(true);
    try {
      await api.post<IncidentEvidence>('/api/v1/incidents/' + encodeURIComponent(incidentId) + '/evidence', {
        kind,
        source: trimmedSource,
        collectedAt: iso,
        contentRef: trimmedRef,
        claimedTrust,
      });
      setContentRef('');
      setCollectedAt(toLocalInputValue(new Date()));
      onAdded();
    } catch (cause) {
      setFailure(cause);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="form-stack pad" data-testid="incident-evidence-form">
      <h3>{t('incidents.evidence.add.title')}</h3>
      <p className="muted small">{t('incidents.evidence.add.description')}</p>
      <div className="form-grid">
        <Field label={t('table.kind')} htmlFor="incident-evidence-kind">
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger id="incident-evidence-kind" data-testid="incident-evidence-kind" aria-label={t('table.kind')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {EVIDENCE_KIND_CODES.map((code) => <SelectItem key={code} value={code} data-testid={'incident-evidence-kind-option-' + code}>{t(evidenceKindKey(code))}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('incidents.evidence.add.claimLabel')} hint={t('incidents.evidence.add.claimHint')} htmlFor="incident-evidence-claim">
          <Select value={claimedTrust} onValueChange={setClaimedTrust}>
            <SelectTrigger id="incident-evidence-claim" data-testid="incident-evidence-claim" aria-label={t('incidents.evidence.add.claimLabel')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {CLAIMABLE_TRUST_CODES.map((code) => <SelectItem key={code} value={code} data-testid={'incident-evidence-claim-option-' + code}>{t(evidenceTrustKey(code))}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('table.source')} hint={t('incidents.evidence.add.sourceHint')} htmlFor="incident-evidence-source">
          <Input id="incident-evidence-source" data-testid="incident-evidence-source" value={source} onChange={(event) => setSource(event.target.value)} />
        </Field>
        <Field label={t('table.collectedAt')} htmlFor="incident-evidence-collected-at">
          <Input id="incident-evidence-collected-at" data-testid="incident-evidence-collected-at" type="datetime-local" value={collectedAt} onChange={(event) => setCollectedAt(event.target.value)} />
        </Field>
      </div>
      <Field label={t('table.contentRef')} hint={t('incidents.evidence.add.contentHint')} htmlFor="incident-evidence-content-ref">
        <Input id="incident-evidence-content-ref" data-testid="incident-evidence-content-ref" value={contentRef} maxLength={1000} onChange={(event) => setContentRef(event.target.value)} />
      </Field>
      <p className="muted small" data-testid="incident-evidence-claim-notice">{t('incidents.evidence.add.claimedNotice')}</p>
      {fieldError ? <p className="inline-error" role="alert" data-testid="incident-evidence-field-error">{fieldError}</p> : null}
      <IncidentFailureNotice error={failure} testId="incident-evidence-write-error" />
      <div>
        <Button onClick={() => void submit()} disabled={submitting} data-testid="incident-evidence-submit">
          {submitting ? t('incidents.evidence.add.submitting') : t('incidents.evidence.add.submit')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The verdict form.
 *
 * Two outcomes are offered, and the pending-evidence rule is stated before submission rather
 * than discovered from a 409: the kernel refuses a confirming verdict on an incident with no
 * evidence, and that refusal is the reason the sentence is on the form.
 */
function VerdictForm({ incidentId, hasEvidence, onRecorded }: { incidentId: string; hasEvidence: boolean; onRecorded: () => void }) {
  const t = useT();
  const [verdict, setVerdict] = React.useState<string>('INCONCLUSIVE');
  const [rationale, setRationale] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);
  const [fieldError, setFieldError] = React.useState<string | null>(null);

  const submit = async () => {
    setFailure(null);
    setFieldError(null);
    if (rationale.trim().length < RATIONALE_MIN_CHARS) {
      setFieldError(t('incidents.verdict.rationaleHint'));
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/api/v1/incidents/' + encodeURIComponent(incidentId) + '/verdict', {
        verdict,
        rationale: rationale.trim(),
      });
      setRationale('');
      onRecorded();
    } catch (cause) {
      setFailure(cause);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="form-stack pad" data-testid="incident-verdict-form">
      {hasEvidence ? null : <p className="muted small" data-testid="incident-verdict-pending-evidence">{t('incidents.verdict.pendingEvidence')}</p>}
      <div className="form-grid">
        <Field label={t('table.verdict')} htmlFor="incident-verdict-value">
          <Select value={verdict} onValueChange={setVerdict}>
            <SelectTrigger id="incident-verdict-value" data-testid="incident-verdict-value" aria-label={t('table.verdict')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {VERDICT_CHOICES.map((code) => <SelectItem key={code} value={code} data-testid={'incident-verdict-option-' + code}><Status code={code} /></SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label={t('table.rationale')} hint={t('incidents.verdict.rationaleHint')} htmlFor="incident-verdict-rationale">
        <textarea id="incident-verdict-rationale" data-testid="incident-verdict-rationale" rows={4} value={rationale} onChange={(event) => setRationale(event.target.value)} />
      </Field>
      {fieldError ? <p className="inline-error" role="alert" data-testid="incident-verdict-field-error">{fieldError}</p> : null}
      <IncidentFailureNotice error={failure} testId="incident-verdict-error" />
      <div>
        <Button onClick={() => void submit()} disabled={submitting} data-testid="incident-verdict-submit">
          {submitting ? t('incidents.verdict.submitting') : t('incidents.verdict.submit')}
        </Button>
      </div>
    </div>
  );
}
