import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { IncidentEvidence, IncidentEvidenceList, IncidentView } from '../types';
import { useAuth } from '../auth';
import { useDocumentTitle } from '../hooks';
import { useI18n, useT } from '../i18n';
import { ageMessage, clockMessage } from '../lib/age';
import { cn } from '../lib/utils';
import { Icon } from '../components/Icons';
import { Button, buttonVariants } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { CopyButton, Field, KV, useToast } from '../components/Ui';
import { MetricCard } from '../components/app/metric-card';
import { PageHeader } from '../components/app/page-header';
import { Status } from '../components/app/status';
import {
  EVIDENCE_KIND_CODES,
  EVIDENCE_TRUST_CLAIM_CODES,
  RATIONALE_MIN_CHARS,
  VERDICT_CHOICES,
  evidenceAssurance,
  evidenceKindKey,
  evidencePanelState,
  evidenceTrustKey,
  incidentFacts,
  incidentSourceKey,
  shortOwner,
  toIsoInstant,
  toLocalInputValue,
  verificationMethodKey,
  verdictPanelState,
} from '../incidents';
import { TrustChip, TrustGap, TrustLegend, TrustSummary } from './incident-trust';
import { IncidentFailureNotice, useUserDirectory } from './Incidents';
import { IdentityCell, LongId, StackCell, cardTwoLineRow, formatIdentity, stackBody, stackHead, stackRow, stackTable } from './table-kit';

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
    const status = incidentError instanceof ApiError ? incidentError.status : null;
    const notFound = status === 404;
    const forbidden = status === 403;
    // Four answers, drawn four ways. A 404 means the id names nothing; a 403 means it may well
    // name something and this session may not see it - telling a reader "not found" when the
    // kernel said "forbidden" hides an access request behind a typo. A 409 is the kernel
    // refusing to answer a read it could not make consistent, which is neither.
    const conflict = status === 409;
    const state = notFound ? 'not-found' : forbidden ? 'forbidden' : conflict ? 'conflict' : 'failed';
    return (
      <div className="page-stack" data-testid="incident-detail" data-detail-state={state}>
        <PageHeader eyebrow={t('incidents.eyebrow')} title={t('page.workspaceIncidents')} actions={backLink} />
        <section className="panel pad">
          {notFound ? (
            <div data-testid="incident-not-found">
              <h2>{t('incidents.detail.missing.title')}</h2>
              <p className="muted">{t('incidents.detail.missing.description')}</p>
              <p className="muted small"><code>{incidentId}</code></p>
            </div>
          ) : forbidden ? (
            <div data-testid="incident-detail-forbidden">
              <h2>{t('incidents.detail.forbidden.title')}</h2>
              <p className="muted">{t('incidents.detail.forbidden.description')}</p>
            </div>
          ) : conflict ? (
            <div data-testid="incident-detail-conflict">
              <h2>{t('incidents.conflict.title')}</h2>
              <p className="muted">{t('incidents.conflict.description')}</p>
              <Button variant="secondary" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.retry')}</Button>
            </div>
          ) : (
            <>
              <IncidentFailureNotice error={incidentError} testId="incident-detail-error" />
              <p className="muted small"><strong>{t('incidents.failed.title')}</strong> {t('incidents.failed.description')}</p>
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
        <section className="panel pad" aria-busy={loading} aria-label={t('incidents.detail.loadingAria')}>
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
  const evidenceState = evidencePanelState(
    evidence,
    Boolean(evidenceError),
    evidenceError instanceof ApiError ? evidenceError.status : null,
  );
  const verdictState = verdictPanelState(incident);
  // What the evidence set is worth, as its weakest row. The verdict rests on the whole set, so
  // the figure a reader needs before signing one is the floor, not the best row in it.
  const assurance = evidenceAssurance(evidence ?? []);
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

      {/* page-template §2.1: one KPI band, straight after the header, 4 columns and never 3.
          Every figure is a fact the kernel returned. The evidence count is the ONLY number on
          this page that may be absent, and it is drawn as NO_DATA rather than as 0 - an
          unanswered evidence request and an incident with no evidence are different facts
          (machine-language-rules M1, and the one dashed token this region is allowed). */}
      <section className="metric-grid" data-testid="incident-kpi">
        <MetricCard
          metricId="incident-status"
          label={t('table.status')}
          value={<Status code={incident.status} />}
          showSampled={false}
        />
        <MetricCard
          metricId="incident-severity"
          label={t('table.severity')}
          value={<Status code={incident.severity} />}
          showSampled={false}
        />
        <MetricCard
          metricId="incident-evidence-count"
          label={t('table.evidence')}
          // `evidence` is null until the evidence read answers; `state` therefore distinguishes
          // "no sample" from the zero the kernel actually asserted.
          state={evidence ? 'ready' : 'noData'}
          value={<span data-testid="incident-detail-evidence-count">{evidence ? evidence.length : null}</span>}
          // The band's fourth fact is the set's floor, not its best row. It is prefixed with the
          // word "weakest" because a bare "Operator asserted" under an evidence count reads as a
          // property of the incident rather than as the floor of the three claims below it.
          detail={assurance.total > 0
            ? t('incidents.kpi.weakestTrust', { level: t(evidenceTrustKey(assurance.weakest)) })
            : undefined}
          showSampled={false}
        />
        <MetricCard
          metricId="incident-updated"
          label={t('table.updated')}
          value={<span title={incident.updatedAt}>{ageMessage(locale, incident.updatedAt) || incident.updatedAt}</span>}
          showSampled={false}
        />
      </section>

      {/* The workspace: three regions in the order a reader asks the questions - what happened,
          what it rests on, what a human concluded. The grid is a LAYOUT, not three more cards:
          each region is one panel, so the page has one border depth instead of the audit's
          three (visual-audit S3: "solid panel -> solid region -> dashed slot"). */}
      <div className="ow-incident-workspace" data-testid="incident-workspace">
        <section className="panel ow-incident-narrative" data-testid="incident-timeline">
          <div className="panel-head">
            <div>
              <h2>{t('incidents.workspace.narrative')}</h2>
              <p>{t('incidents.workspace.narrativeNote')}</p>
            </div>
          </div>
          {facts.length <= 1 && !incident.humanVerdict ? (
            <p className="muted small pad" data-testid="incident-timeline-empty">{t('incidents.timeline.empty')}</p>
          ) : null}
          <ol className="timeline pad" data-testid="incident-timeline-list">
            {facts.map((fact) => (
              <li key={fact.id} data-fact-kind={fact.kind} data-fact-at={fact.at}>
                {/* The dot's SHAPE carries the kind, so the three entry types are distinguishable
                    in greyscale and under a colour deficiency (the audit's shape-before-colour
                    requirement). Colour repeats the same fact; neither carries it alone. */}
                <span className={cn('timeline-dot', 'ow-fact-dot', 'ow-fact-dot--' + fact.kind)} aria-hidden="true" />
                <div>
                  <strong>
                    {fact.kind === 'started' ? t('incidents.timeline.started') : fact.kind === 'evidence' ? t('incidents.timeline.evidence') : t('incidents.timeline.verdict')}
                  </strong>
                  {fact.kind === 'evidence' && fact.evidence ? (
                    <>
                      <span className="tag">{t(evidenceKindKey(fact.evidence.kind))}</span>
                      {/* Provenance travels with the entry: a timeline that shows WHAT was
                          collected without showing how well attested it is invites the reader
                          to weigh a hand-written note like a signed snapshot. */}
                      <TrustChip code={fact.evidence.verifiedTrust} />
                      <span className="muted small mono" title={fact.evidence.source}>{fact.evidence.source}</span>
                    </>
                  ) : null}
                  {fact.kind === 'verdict' && fact.verdict ? (
                    <>
                      <Status code={fact.verdict.verdict} />
                      <span className="muted small">{decidedByLabel}</span>
                    </>
                  ) : null}
                  <span className="muted small" data-testid="fact-time">
                    {fact.atValid
                      ? <span title={fact.at}>{ageMessage(locale, fact.at) || fact.at}</span>
                      : t('incidents.timeline.unparseable', { value: fact.at })}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="panel ow-incident-record" data-testid="incident-identity">
          <div className="panel-head"><div><h2>{t('incidents.workspace.identity')}</h2></div></div>
          <div className="kv-grid">
            <KV label={t('table.incident')} mono>{<LongId value={incident.id} label={t('table.copyIdentifier')} testId="incident-id" />}</KV>
            <KV label={t('table.started')}>{<span title={incident.startedAt}>{ageMessage(locale, incident.startedAt) || incident.startedAt}</span>}</KV>
            <KV label={t('table.owner')} mono>{<span title={incident.owner} data-testid="incident-detail-owner">{ownerLabel}</span>}</KV>
            <KV label={t('table.source')}>{t(incidentSourceKey(incident.source))}</KV>
            <KV label={t('table.relatedEntity')} mono>{incident.relatedEntity || t('common.none')}</KV>
          </div>
          {/* Point 2 of the task: the collector boundary is stated on the detail page too, so a
              reader who lands here from a link still learns that no connector wrote this row. */}
          <p className="table-footnote" data-testid="incident-detail-collectors">{t('incidents.boundary.collectors')}</p>
        </section>
      </div>

      <section className="panel ow-incident-evidence" data-testid="incident-evidence" data-evidence-state={evidenceState}>
        <div className="panel-head">
          <div>
            <h2>{t('incidents.workspace.evidence')}</h2>
            <p>{t('incidents.detail.evidence.description')}</p>
          </div>
        </div>
        {/* The set's floor, directly under the panel head: a verdict rests on the weakest row, so
            that is the fact a reader needs BEFORE scrolling the table, not after it. It is its own
            block rather than a second child of .panel-head - the head is a title/actions flex row,
            and a multi-line summary added to it competes with the title for width and wins, which
            at 390 squeezed the panel's description into a one-word-wide column. */}
        {evidenceState === 'present' ? <TrustSummary assurance={assurance} /> : null}
        {evidenceState === 'loading' ? (
          <p className="muted small pad" aria-busy="true" data-testid="incident-evidence-loading">{t('aria.loading')}</p>
        ) : evidenceState === 'forbidden' ? (
          // The incident loaded; the evidence request was refused. A grant fixes this and a
          // retry does not, so it must not share the failure panel's "try again" advice.
          <div className="pad" data-testid="incident-evidence-forbidden">
            <p><strong>{t('incidents.detail.evidence.forbidden.title')}</strong></p>
            <p className="muted small">{t('incidents.detail.evidence.forbidden.description')}</p>
          </div>
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
            <Table className={stackTable} data-testid="incident-evidence-table">
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('table.kind')}</TableHead>
                  <TableHead>{t('table.trust')}</TableHead>
                  <TableHead>{t('table.source')}</TableHead>
                  <TableHead>{t('table.collectedAt')}</TableHead>
                  <TableHead>{t('table.contentRef')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {(evidence ?? []).map((row) => (
                  <TableRow key={row.id} data-evidence-row={row.id} data-trust={row.verifiedTrust} className={cn(stackRow, cardTwoLineRow)}>
                    {/* §2.5 at 390: a five-column table stacks into a card, and the kind - the
                        fact the card is about - becomes its identity line. Without this the row
                        kept its five columns in a 390px box and squeezed `prometheus` into
                        `pro-meth-eus` and the content reference off the edge. The source rides
                        the identity line's qualifier at 390, so the card states what produced
                        the row without spending one of its three facts on it. */}
                    <IdentityCell
                      label={t('table.kind')}
                      identity={formatIdentity({ name: t(evidenceKindKey(row.kind)), id: row.id, at: row.collectedAt, locale })}
                      data-evidence-kind={row.kind}
                      cardFact
                    >
                      <span className="mono">{row.source}</span>
                      {/* The demoted content reference (§2.2): inline secondary on the card,
                          still present and still copyable, no longer spending a fact slot. */}
                      <span className="ow-longid ow-ident-tail min-[769px]:hidden" data-testid="evidence-content-ref-card">
                        <span className="ow-longid-value" title={row.contentRef}>{row.contentRef}</span>
                        <CopyButton value={row.contentRef} label={t('table.copyIdentifier')} />
                      </span>
                    </IdentityCell>
                    {/* Trust is a first-class cell, not a colour on another one: glyph + word +
                        tone, and the word names the check the Kernel actually ran
                        (incidents.ts, evidenceTrustTone). The method rides in the chip's tooltip
                        rather than on a second line: table-spec §2.3 fixes the row at 40px and
                        this cell's neighbours are one line high, so a stacked second line was
                        measured pushing the trust text over the Source column at 390 and
                        wrapping at 1024. The gap sentence below it is conditional - it exists
                        only when the claim and the verdict disagree, which is the one case a
                        reader cannot resolve from the chip alone. */}
                    <StackCell label={t('table.trust')}>
                      <TrustChip
                        code={row.verifiedTrust}
                        title={verificationTitle(t, row.verificationMethod, row.verifierIdentity)}
                      />
                      <TrustGap row={row} />
                    </StackCell>
                    <StackCell label={t('table.source')} className="mono max-[768px]:hidden" title={row.source} data-evidence-source={row.source}>{row.source}</StackCell>
                    {/* The age is what the eye scans; the wall clock is what separates two rows
                        collected in the same hour, and the full instant stays in `title`. The two
                        are joined by a catalog string rather than by adjacent spans, because
                        "12h ago06:31:00" is what two spans with no separator render as. */}
                    <StackCell label={t('table.collectedAt')}>
                      <span className="ow-stamp" title={row.collectedAt}>
                        {(() => {
                          const age = ageMessage(locale, row.collectedAt) || row.collectedAt;
                          const clock = clockMessage(locale, row.collectedAt);
                          return clock ? t('incidents.detail.evidence.stamp', { age, clock }) : age;
                        })()}
                      </span>
                    </StackCell>
                    {/* §2.2's <768 cap is three facts per card, and this table has four. The
                        content reference is the one that gives way: it is an opaque locator the
                        kernel never fetches (the note under the table says exactly that), so it
                        moves onto the identity line's qualifier as inline secondary rather than
                        occupying a card row the reader has to decode. It stays visible and
                        copyable - demoted is not dropped. */}
                    <StackCell label={t('table.contentRef')} className="max-[768px]:hidden">
                      <span className="ow-longid">
                        <span className="ow-longid-value" title={row.contentRef} data-testid="evidence-content-ref">{row.contentRef}</span>
                        <CopyButton value={row.contentRef} label={t('table.copyIdentifier')} />
                      </span>
                    </StackCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="ow-table-notes">
              <p className="table-footnote" data-testid="incident-evidence-ref-note">{t('incidents.detail.evidence.refNote')}</p>
              {/* The three levels, what each one claims, and what this build does NOT check. It
                  sits under the table rather than in a tooltip because the reader who has to weigh
                  the set is the reader about to sign a verdict, and a hover is not a disclosure. */}
              <TrustLegend />
            </div>
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
/**
 * The chip's tooltip: how this row's level was reached, in words that stay true for `NONE`.
 *
 * "Verified by Nothing verified" is what a naive template produces, and it is nonsense on the
 * one row where the absence of verification is the whole point. `NONE` therefore states that
 * nothing was checked rather than naming a method, and the adapter id is appended only when an
 * adapter is what did the checking.
 */
function verificationTitle(t: ReturnType<typeof useT>, method: string, adapter: string | null): string {
  if ((method ?? '').toUpperCase() === 'NONE') return t('incidents.verification.notChecked');
  const named = t(verificationMethodKey(method));
  return t('incidents.trust.method', { method: adapter ? named + ' · ' + adapter : named });
}

function AddEvidenceForm({ incidentId, defaultSource, onAdded }: { incidentId: string; defaultSource: string; onAdded: () => void }) {
  const t = useT();
  const [kind, setKind] = React.useState<string>('LOG_EXCERPT');
  const [source, setSource] = React.useState(defaultSource);
  const [collectedAt, setCollectedAt] = React.useState(() => toLocalInputValue(new Date()));
  const [contentRef, setContentRef] = React.useState('');
  const [claim, setClaim] = React.useState<string>('OPERATOR_ASSERTED');
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
        // The kernel decides verifiedTrust; this field is only what we claim. Sending the
        // retired "trust" field, or claiming SOURCE_ATTESTED here, is a 400 that writes nothing.
        claimedTrust: claim,
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
          <Select value={claim} onValueChange={setClaim}>
            <SelectTrigger id="incident-evidence-claim" data-testid="incident-evidence-claim" aria-label={t('incidents.evidence.add.claimLabel')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {EVIDENCE_TRUST_CLAIM_CODES.map((code) => <SelectItem key={code} value={code} data-testid={'incident-evidence-claim-option-' + code}>{t(evidenceTrustKey(code))}</SelectItem>)}
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
        <Button variant="secondary" onClick={() => void submit()} disabled={submitting} data-testid="incident-evidence-submit">
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
        {/* The page's one primary CTA. Appending evidence is a secondary, repeatable step on the
            way here; recording the verdict is the terminus, is written once, and cannot be
            edited - so it is the action the page is built around, and the evidence submit above
            is deliberately not styled as a peer of it. */}
        <Button onClick={() => void submit()} disabled={submitting} data-testid="incident-verdict-submit">
          {submitting ? t('incidents.verdict.submitting') : t('incidents.verdict.submit')}
        </Button>
      </div>
    </div>
  );
}
