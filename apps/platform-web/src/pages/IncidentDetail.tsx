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
  EVIDENCE_KIND_CODES,
  EVIDENCE_TRUST_CODES,
  RATIONALE_MIN_CHARS,
  VERDICT_CHOICES,
  evidenceKindKey,
  evidencePanelState,
  evidenceTrustKey,
  evidenceTrustTone,
  incidentFacts,
  incidentSourceKey,
  shortOwner,
  toIsoInstant,
  toLocalInputValue,
  verdictPanelState,
} from '../incidents';
import { IncidentFailureNotice, useUserDirectory } from './Incidents';
import { LongId } from './table-kit';

/**
 * `/app/incidents/:id` - one incident, its evidence and its human verdict (G11 D3).
 *
 * Three rules this page keeps:
 *
 *   * every timestamp it prints came from the kernel (start, each evidence row's collected time,
 *     the verdict) - there is no status-history event, because the slice records none;
 *   * `missing` and `unavailable` are different sentences: an empty evidence list is a fact the
 *     kernel asserted, a failed evidence request is the absence of an answer;
 *   * nothing on the page is a conclusion the system made up. The only conclusion rendered is the
 *     one a human signed, with the identity the kernel authenticated.
 */
export function IncidentDetailPage() {
  const t = useT();
  const { locale } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const { incidentId = '' } = useParams();
  useDocumentTitle(t('page.workspaceIncidents'));
  const directory = useUserDirectory();

  const [incident, setIncident] = React.useState<IncidentView | null>(null);
  const [incidentError, setIncidentError] = React.useState<Error | null>(null);
  const [evidence, setEvidence] = React.useState<IncidentEvidence[] | null>(null);
  const [evidenceError, setEvidenceError] = React.useState<Error | null>(null);
  const [observedAt, setObservedAt] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [reload, setReload] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get<IncidentView>('/api/v1/incidents/' + encodeURIComponent(incidentId))
      .then((result) => {
        if (cancelled) return;
        setIncident(result);
        setIncidentError(null);
        setObservedAt(new Date().toISOString());
      })
      .catch((cause: Error) => { if (!cancelled) setIncidentError(cause); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [incidentId, reload]);

  React.useEffect(() => {
    let cancelled = false;
    api.get<IncidentEvidenceList>('/api/v1/incidents/' + encodeURIComponent(incidentId) + '/evidence')
      .then((result) => { if (!cancelled) { setEvidence(result.items); setEvidenceError(null); } })
      .catch((cause: Error) => { if (!cancelled) setEvidenceError(cause); });
    return () => { cancelled = true; };
  }, [incidentId, reload]);

  const backLink = <Link className={buttonVariants({ variant: 'secondary' })} to="/app/incidents">{t('incidents.action.backToList')}</Link>;

  if (incidentError && !incident) {
    const notFound = incidentError instanceof ApiError && incidentError.status === 404;
    return (
      <div className="page-stack" data-testid="incident-detail" data-detail-state={notFound ? 'not-found' : 'failed'}>
        <PageHeader eyebrow={t('incidents.eyebrow')} title={t('page.workspaceIncidents')} actions={backLink} />
        <section className="panel pad">
          {notFound ? (
            <div data-testid="incident-not-found">
              <h2>{t('incidents.detail.missing.title')}</h2>
              <p className="muted">{t('incidents.detail.missing.description')}</p>
              <p className="muted small"><code>{incidentId}</code></p>
            </div>
          ) : (
            <>
              <IncidentFailureNotice error={incidentError} testId="incident-detail-error" />
              <Button variant="secondary" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.retry')}</Button>
            </>
          )}
        </section>
      </div>
    );
  }

  if (!incident) {
    return (
      <div className="page-stack" data-testid="incident-detail" data-detail-state="loading">
        <PageHeader eyebrow={t('incidents.eyebrow')} title={t('page.workspaceIncidents')} actions={backLink} />
        <section className="panel pad" aria-busy={loading}>
          <div className="skeleton-stack" aria-label={t('aria.loading')}>
            <div className="skeleton" style={{ width: '38%' }} />
            <div className="skeleton" style={{ width: '62%' }} />
            <div className="skeleton" style={{ width: '48%' }} />
          </div>
        </section>
      </div>
    );
  }

  const facts = incidentFacts(incident, evidence ?? []);
  const evidenceState = evidencePanelState(evidence, Boolean(evidenceError));
  const verdictState = verdictPanelState(incident);
  const ownerLabel = directory.names?.[incident.owner] ?? shortOwner(incident.owner);
  const decidedByLabel = incident.humanVerdict
    ? (directory.names?.[incident.humanVerdict.decidedBy] ?? shortOwner(incident.humanVerdict.decidedBy))
    : null;

  return (
    <div className="page-stack" data-testid="incident-detail" data-incident-id={incident.id}>
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
        actions={<><Button variant="secondary" data-testid="incident-refresh" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>{backLink}</>}
      />

      {evidenceError && evidence ? <IncidentStale observedAt={observedAt} error={evidenceError} /> : null}

      <section className="summary-grid">
        <div className="panel metric-card"><span className="metric-label">{t('table.status')}</span><strong className="metric-value"><Status code={incident.status} /></strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('table.severity')}</span><strong className="metric-value"><Status code={incident.severity} /></strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('table.evidence')}</span><strong className="metric-value mono" data-testid="incident-detail-evidence-count">{evidence ? evidence.length : '—'}</strong></div>
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
            <IncidentFailureNotice error={evidenceError} testId="incident-evidence-error" />
            <Button variant="secondary" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.retry')}</Button>
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
                {(evidence ?? []).map((row) => (
                  <TableRow key={row.id} data-evidence-row={row.id}>
                    <TableCell data-evidence-kind={row.kind}>{t(evidenceKindKey(row.kind))}</TableCell>
                    <TableCell>
                      <Badge variant={badgeVariantForTone(evidenceTrustTone(row.trust))} data-trust={row.trust}>{t(evidenceTrustKey(row.trust))}</Badge>
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
              setReload((value) => value + 1);
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
          </div>
        ) : verdictState === 'sealed' ? (
          <p className="muted small pad" data-testid="incident-verdict-sealed">{t('incidents.verdict.sealed')}</p>
        ) : (
          <VerdictForm
            incidentId={incident.id}
            hasEvidence={(evidence?.length ?? 0) > 0}
            onRecorded={() => {
              toast.push({ tone: 'ok', title: t('incidents.verdict.success') });
              setReload((value) => value + 1);
            }}
          />
        )}
        {verdictState !== 'recorded' ? <p className="muted small pad">{t('incidents.verdict.onlyTwo')}</p> : null}
      </section>
    </div>
  );
}

/** The banner a page shows when it is still rendering rows from a read that has since failed. */
function IncidentStale({ observedAt, error }: { observedAt: string | null; error: Error | null }) {
  const t = useT();
  const at = observedAt ? new Date(observedAt) : null;
  const stamp = at && !Number.isNaN(at.getTime()) ? at.toLocaleTimeString() : (observedAt ?? '');
  const code = error instanceof ApiError ? error.code : null;
  return (
    <p className="notice-bar" data-testid="incident-freshness" data-stale="true">
      {t('incidents.freshness.stale', { at: stamp, reason: code ?? t('incidents.error.network') })}
    </p>
  );
}

/**
 * The append form.
 *
 * `collectedAt` defaults to now but is editable, because the kernel separates "when it was
 * collected" from "when it was recorded" and a late paste of an earlier log is a normal case.
 * `contentRef` is described as what it is - an opaque locator, not inline text.
 */
function AddEvidenceForm({ incidentId, defaultSource, onAdded }: { incidentId: string; defaultSource: string; onAdded: () => void }) {
  const t = useT();
  const [kind, setKind] = React.useState<string>('LOG_EXCERPT');
  const [source, setSource] = React.useState(defaultSource);
  const [collectedAt, setCollectedAt] = React.useState(() => toLocalInputValue(new Date()));
  const [contentRef, setContentRef] = React.useState('');
  const [trust, setTrust] = React.useState<string>('OPERATOR_ASSERTED');
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
        trust,
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
        <Field label={t('table.trust')} htmlFor="incident-evidence-trust">
          <Select value={trust} onValueChange={setTrust}>
            <SelectTrigger id="incident-evidence-trust" data-testid="incident-evidence-trust" aria-label={t('table.trust')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {EVIDENCE_TRUST_CODES.map((code) => <SelectItem key={code} value={code} data-testid={'incident-evidence-trust-option-' + code}>{t(evidenceTrustKey(code))}</SelectItem>)}
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
