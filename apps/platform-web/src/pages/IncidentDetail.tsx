import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { IncidentEvidence, IncidentEvidenceList, IncidentList, IncidentOwnerTransfer, IncidentTimeline, IncidentTimelineEvent, IncidentView } from '../types';
import { useAuth } from '../auth';
import { useDocumentTitle } from '../hooks';
import { useI18n, useT } from '../i18n';
import { ageMessage, clockMessage } from '../lib/age';
import { cn } from '../lib/utils';
import { Icon } from '../components/Icons';
import { Badge } from '../components/ui/badge';
import { Button, buttonVariants } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { CopyButton, Field, KV, useToast } from '../components/Ui';
import { EvidenceContentViewer } from '../components/evidence-viewer';
import { InvestigationPanel } from '../components/investigation-panel';
import { InvestigationLayout, useCompactLayout, type InvestigationPaneId } from '../components/app/investigation-layout';
import { MetricCard } from '../components/app/metric-card';
import { PageHeader } from '../components/app/page-header';
import { Status } from '../components/app/status';
import { badgeVariantForTone, statusForCode } from '../components/status-tone';
import {
  CLOSURE_NOTE_MAX_CHARS,
  CLAIMABLE_TRUST_CODES,
  EVIDENCE_KIND_CODES,
  RATIONALE_MIN_CHARS,
  TRANSFER_REASON_MAX_CHARS,
  VERDICT_CHOICES,
  classifyFailure,
  detailPhase,
  evidenceContentStatusKey,
  evidenceContentStatusTone,
  detailReducer,
  emptyDetail,
  evidenceAssurance,
  evidenceKindKey,
  evidencePanelState,
  evidenceTrustKey,
  evidenceTrustTone,
  incidentCapabilities,
  closureNoteError,
  closurePanelState,
  closeIncidentPayload,
  isKernelVerified,
  kernelVerifiedCount,
  newIdempotencyKey,
  losesAccessAfterHandover,
  timelineEventFacts,
  timelineEventKey,
  timelineEventTone,
  transferIncidentPayload,
  transferReasonError,
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
import { TrustChip, TrustGap, TrustLegend, TrustSummary } from './incident-trust';
import { IdentityCell, LongId, StackCell, cardTwoLineRow, formatIdentity, stackBody, stackHead, stackRow, stackTable } from './table-kit';

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
  // What this account submitted as a handover, not what the write answered with. A write is
  // confirmed by a re-read (docs/design/ui-visual-v3/code-rules.md A5); the one case where a
  // re-read is impossible is the operator who just handed the incident away - and there the
  // account id and reason on this panel are the operator's own input to the form.
  const [handover, setHandover] = React.useState<{ toOwner: string; reason: string; at: string } | null>(null);
  React.useEffect(() => { setHandover(null); }, [incidentId]);
  // The kernel's own audit trail for this incident. Read separately from the incident so a failed
  // trail read degrades one panel instead of blanking the page.
  const trail = useIncidentTrail(incidentId, reload);
  // Which evidence row's content is open. Null means "no panel", never "the previous incident's
  // row": the id is cleared whenever the route changes, so a panel cannot outlive its incident.
  const [openEvidenceId, setOpenEvidenceId] = React.useState<string | null>(null);
  React.useEffect(() => {
    setOpenEvidenceId(null);
    // A route change is a new incident, so the workspace returns to the pane that shows it. Without
    // this, switching incidents from the rail on a phone left the reader on the rail: the list
    // updated and the incident did not, which reads as "the link did nothing".
    setPane('analysis');
  }, [incidentId]);
  // Which pane the workspace shows below 1024. The layout owns the fallback; the page owns the one
  // transition the page can predict - content that is the active content moves to the pane that
  // shows it.
  const [pane, setPane] = React.useState<InvestigationPaneId>('analysis');
  const compact = useCompactLayout();
  // The rule is stated on the state that decides it, not on the click that usually produces it.
  // Opening a row is not the only way content becomes active: a window narrowed onto a row that is
  // already open puts the same content in a phone layout, and before this the pane stayed on
  // 'analysis', so the reader watched the viewer disappear. The effect covers both entries with one
  // rule, and at 1440 it cannot fire - there no pane is hidden, so the reader's selection is never
  // touched.
  React.useEffect(() => {
    if (openEvidenceId && compact) setPane('detail');
  }, [openEvidenceId, compact]);

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
  // Resolved against the rows this page actually holds, so an id from a previous read cannot
  // resurrect a row that is no longer in the list.
  const openRow = (openEvidenceId ? evidence.find((row) => row.id === openEvidenceId) : undefined) ?? null;
  const ownerLabel = directory.names?.[incident.owner] ?? shortOwner(incident.owner);
  const decidedByLabel = incident.humanVerdict
    ? (directory.names?.[incident.humanVerdict.decidedBy] ?? shortOwner(incident.humanVerdict.decidedBy))
    : null;
  // Stale, and honestly labelled: the record on screen was read at a known instant and the most
  // recent read failed. That is a different sentence from "this incident could not be loaded".
  const staleFailure = view.incidentError ?? view.evidenceError ?? null;
  // Presentation only, and derived from the same three facts the kernel re-checks on every write:
  // the role, the owner (the operator data scope) and the status. The 403/404/409 responses are
  // still the authority; this exists so a viewer reads a sentence instead of a doomed form.
  const capabilities = incidentCapabilities({ incident, userId: user?.id ?? null, role: user?.role ?? null });
  const closureState = closurePanelState(incident);
  const verifiedCount = kernelVerifiedCount(evidence);
  // What the set is worth as its weakest row. The verdict rests on the whole set, so the figure a
  // reader needs before signing one is the floor, not the best row in it (incident-trust.tsx
  // TrustSummary renders exactly this and nothing else).
  const assurance = evidenceAssurance(evidence);

  // The handover succeeded and this account is no longer allowed to read the record. Saying that
  // is the whole point: the alternative is a form that would 404 on the next keystroke.
  if (handover && losesAccessAfterHandover(user?.role ?? null)) {
    const newOwner = directory.names?.[handover.toOwner] ?? shortOwner(handover.toOwner);
    return (
      <div className="page-stack" data-testid="incident-detail" data-detail-state="handed-over">
        <PageHeader eyebrow={t('incidents.eyebrow')} title={incident.title} actions={backLink} />
        <section className="panel pad" data-testid="incident-handover-complete" data-new-owner={handover.toOwner}>
          <h2>{t('incidents.transfer.done.title')}</h2>
          <p>{t('incidents.transfer.done.description', { owner: newOwner })}</p>
          <KV label={t('incidents.transfer.done.at')}>{ageMessage(locale, handover.at)}</KV>
          <KV label={t('incidents.transfer.done.reason')}>{handover.reason}</KV>
          <p className="muted small" data-testid="incident-handover-scope-lost">{t('incidents.transfer.done.scope')}</p>
        </section>
      </div>
    );
  }

  return (
    <div className="page-stack investigation-page" data-testid="incident-detail" data-incident-id={incident.id} data-route-id={incidentId}>
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

      {/* Why the write controls below are absent, said before the reader looks for them. The
          kernel refuses these writes regardless (403), so this is an explanation and not a gate. */}
      {capabilities.readOnlyReason ? (
        <section className="panel pad" data-testid="incident-readonly-notice" data-role={user?.role ?? ''}>
          <h2>{t('incidents.permission.title')}</h2>
          <p className="muted" data-testid="incident-readonly-reason">{t(capabilities.readOnlyReason)}</p>
          <p className="muted small">{t('incidents.permission.askAdmin')}</p>
        </section>
      ) : null}

          {/* G12 D: the page is a three-pane workspace, not a column of cards. The DOM order is the
        reading order at every width - rail, analysis, detail - and below 1024 those three panes
        become tabs (components/app/investigation-layout.tsx). A row opened in the analysis pane
        selects the evidence the detail pane shows; on a phone it also moves the tab there, so
        opening a row never leaves the reader looking at a list that did not change. */}
      <InvestigationLayout
        label={t('incidents.workspace.aria', { title: incident.title })}
        activePane={pane}
        onPaneChange={setPane}
        initialPane="analysis"
        panes={[
          {
            id: 'rail',
            label: t('incidents.rail.title'),
            content: <IncidentRail currentId={incident.id} />,
          },
          {
            id: 'analysis',
            label: t('incidents.pane.analysis'),
            count: view.evidence ? evidence.length : null,
            content: (
              <>
                <section className="summary-grid">
                        <div className="panel metric-card"><span className="metric-label">{t('table.status')}</span><strong className="metric-value"><Status code={incident.status} /></strong></div>
                        <div className="panel metric-card"><span className="metric-label">{t('table.severity')}</span><strong className="metric-value"><Status code={incident.severity} /></strong></div>
                        <div className="panel metric-card"><span className="metric-label">{t('table.evidence')}</span><strong className="metric-value mono" data-testid="incident-detail-evidence-count">{view.evidence ? evidence.length : '—'}</strong></div>
                        <div className="panel metric-card"><span className="metric-label">{t('table.updated')}</span><strong className="metric-value"><span title={incident.updatedAt}>{ageMessage(locale, incident.updatedAt)}</span></strong></div>
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
                              {/* The dot's SHAPE carries the kind, so the three entry types are
                                  distinguishable in greyscale and under a colour deficiency (the
                                  audit's shape-before-colour requirement). Colour repeats the same
                                  fact; neither carries it alone. */}
                              <span className={cn('timeline-dot', 'ow-fact-dot', 'ow-fact-dot--' + fact.kind)} aria-hidden="true" />
                              <div>
                                <strong>
                                  {fact.kind === 'started' ? t('incidents.timeline.started') : fact.kind === 'evidence' ? t('incidents.timeline.evidence') : t('incidents.timeline.verdict')}
                                </strong>
                                {fact.kind === 'evidence' && fact.evidence ? (
                                  <>
                                    <span className="tag">{t(evidenceKindKey(fact.evidence.kind))}</span>
                                    {/* Provenance travels with the entry: a timeline that shows
                                        WHAT was collected without showing how well attested it is
                                        invites the reader to weigh a hand-written note like a
                                        signed snapshot. */}
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
                                  {fact.atValid ? <span title={fact.at}>{ageMessage(locale, fact.at)}</span> : t('incidents.timeline.unparseable', { value: fact.at })}
                                </span>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </section>
                <InvestigationPanel
                          incidentId={incident.id}
                          canOperate={capabilities.canAddEvidence}
                        />
                <section className="panel" data-testid="incident-audit" data-audit-state={trail.state}>
                        <div className="panel-head">
                          <div>
                            <h2>{t('incidents.audit.title')}</h2>
                            <p>{t('incidents.audit.description')}</p>
                          </div>
                        </div>
                        {trail.state === 'loading' ? (
                          <p className="muted small pad" aria-busy="true" data-testid="incident-audit-loading">{t('aria.loading')}</p>
                        ) : trail.state === 'unavailable' ? (
                          <div className="pad" data-testid="incident-audit-unavailable">
                            <p className="muted small">{t('incidents.audit.unavailable')}</p>
                            <Button variant="secondary" onClick={retry}><Icon name="refresh" size={15} /> {t('action.retry')}</Button>
                          </div>
                        ) : trail.events.length === 0 ? (
                          <p className="muted small pad" data-testid="incident-audit-empty">{t('incidents.audit.empty')}</p>
                        ) : (
                          <ol className="timeline pad" data-testid="incident-audit-list">
                            {trail.events.map((event) => (
                              <AuditRow key={event.id} event={event} directory={directory} />
                            ))}
                          </ol>
                        )}
                        {trail.truncated ? (
                          <p className="muted small pad" data-testid="incident-audit-truncated">{t('incidents.audit.truncated')}</p>
                        ) : null}
                      </section>

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
                  {/* Two summaries, both earned. TrustSummary leads with the set's FLOOR (main's rule: a
                      verdict rests on the weakest row, never the best). E's trustedSummary is a COUNT of
                      kernel-verified rows, which answers a different question and is asserted by
                      g12-lifecycle. Neither is a repeat of the other. */}
                  {evidenceState === 'present' ? <TrustSummary assurance={assurance} /> : null}
                  <p className="muted small pad" data-testid="incident-evidence-trusted" data-kernel-verified-count={verifiedCount} data-evidence-count={evidence.length}>
                    {t('incidents.evidence.trustedSummary', { verified: verifiedCount, total: evidence.length })}
                  </p>
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
                            <TableRow key={row.id} data-evidence-row={row.id} data-trust={row.verifiedTrust} data-after-verdict={row.afterVerdict ? 'true' : 'false'} className={cn(stackRow, cardTwoLineRow)}>
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
                                {/* G12 B: where this row's bytes are is a fact the table states. On a phone
                                    card it rides the identity line; in the desktop table it gets its own
                                    line under the kind, because a reader deciding whether to open the viewer
                                    needs to know before the click whether there are bytes to read. */}
                                <Badge
                                  variant={badgeVariantForTone(evidenceContentStatusTone(row.contentStatus))}
                                  data-testid="evidence-content-status"
                                  data-content-status={row.contentStatus}
                                >
                                  {t(evidenceContentStatusKey(row.contentStatus))}
                                </Badge>
                                {row.afterVerdict ? (
                                  <Badge variant={badgeVariantForTone('warn')} data-testid="evidence-after-verdict">{t('incidents.evidence.afterVerdict')}</Badge>
                                ) : null}
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
                                {/* A1: TWO facts, not one. `data-verified-trust` is the Kernel's conclusion;
                                    `data-claimed-trust` is what the submitter asked for. They are printed
                                    together and compared, because a row that claimed SOURCE_ATTESTED and was
                                    downgraded is the whole reason the fields exist. */}
                                <TrustChip
                                  code={row.verifiedTrust}
                                  title={verificationTitle(t, row.verificationMethod, row.verifierIdentity)}
                                  data-verified-trust={row.verifiedTrust}
                                  data-claimed-trust={row.claimedTrust}
                                  data-trust-mismatch={trustMismatch(row) ? 'true' : 'false'}
                                />
                                <TrustGap row={row} />
                                <span className="muted small" data-testid="evidence-claimed" data-claimed-trust={row.claimedTrust}>
                                  {t('incidents.evidence.claimed', { value: t(evidenceTrustKey(row.claimedTrust)) })}
                                </span>
                                <span className="muted small" data-testid="evidence-method" data-verification-method={row.verificationMethod} data-verifier={row.verifierIdentity ?? ''}>
                                  {row.verifierIdentity
                                    ? t('incidents.evidence.verifiedBy', { adapter: row.verifierIdentity })
                                    : t(verificationMethodKey(row.verificationMethod))}
                                </span>
                                {/* G12 C: the one marker a reader may treat as 'the Kernel verified this',
                                    because SOURCE_ATTESTED is the only value an adapter signature can
                                    produce. Everything else is labelled as what it is - asserted. */}
                                {isKernelVerified(row) ? (
                                  <Badge variant={badgeVariantForTone('ok')} data-testid="evidence-kernel-verified" data-kernel-verified="true">
                                    {t('incidents.evidence.kernelVerified')}
                                  </Badge>
                                ) : (
                                  <span className="muted small" data-testid="evidence-not-kernel-verified" data-kernel-verified="false">
                                    {t('incidents.evidence.notKernelVerified')}
                                  </span>
                                )}
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
                                  copyable - demoted is not dropped.

                                  The LOCATOR gives way, not the cell. The cell also holds this row's one
                                  action - open the viewer - and hiding the whole cell with it made the
                                  stored bytes unreachable on a phone: at 390 the only "View content" on the
                                  page was inside a display:none cell, so a phone reader could read the
                                  reference but never the content, and D3's keyboard walk (focus the first
                                  Open, press Enter) found nothing to focus. Actions do not compete with
                                  §2.2's fact budget, so the button keeps its own place at every width and
                                  only the reference span is hidden below 769.

                                  It costs the card height: measured at 390/en, the evidence card goes
                                  163 -> 192px because a 44px control sets line 1's height. That is the
                                  WCAG 2.5.5 tap target, and the alternative - a compact icon that opens
                                  a whole panel - is a smaller target for a larger consequence. */}
                              <StackCell label={t('table.contentRef')}>
                                <span className="ow-longid max-[768px]:hidden">
                                  <span className="ow-longid-value" title={row.contentRef} data-testid="evidence-content-ref">{row.contentRef}</span>
                                  <CopyButton value={row.contentRef} label={t('table.copyIdentifier')} />
                                </span>
                                {/* G12 B: opening the viewer is a SEPARATE act from copying the locator. The
                                    locator is a string the kernel never fetches; the viewer reads the stored
                                    bytes and recomputes their digest in the browser. */}
                                <Button
                                  variant="secondary"
                                  data-testid="evidence-open"
                                  data-evidence-id={row.id}
                                  aria-expanded={openEvidenceId === row.id}
                                  onClick={() => setOpenEvidenceId(openEvidenceId === row.id ? null : row.id)}
                                >
                                  {t('incidents.content.action.open')}
                                </Button>
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
                  {/* Why the form is absent, in the order that gives the most useful sentence: a viewer is
                      told about the role (the closure is not what stops them), an operator on a closed
                      incident is told about the closure, and anyone else out of scope is told about scope.
                      The kernel refuses all three regardless, so this decides what the page explains. */}
                  {capabilities.readOnlyReason ? (
                    <p className="muted small pad" data-testid="incident-evidence-readonly">{t('incidents.permission.writeBlocked')}</p>
                  ) : incident.status === 'CLOSED' ? (
                    <p className="muted small pad" data-testid="incident-evidence-sealed">{t('incidents.error.closed')}</p>
                  ) : !capabilities.canAddEvidence ? (
                    <p className="muted small pad" data-testid="incident-evidence-readonly">{t('incidents.permission.writeBlocked')}</p>
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
              </>
            ),
          },
          {
            id: 'detail',
            label: t('incidents.pane.detail'),
            content: (
              <>
                {openRow ? (
                  <EvidenceContentViewer
                    key={openRow.id}
                    incidentId={incident.id}
                    row={openRow}
                    onClose={() => setOpenEvidenceId(null)}
                  />
                ) : evidence.length > 0 ? (
                  <section className="panel" data-testid="incident-evidence-idle">
                    <div className="panel-head">
                      <div>
                        <h2>{t('incidents.detail.evidence.idle.title')}</h2>
                        <p>{t('incidents.detail.evidence.idle.description')}</p>
                      </div>
                    </div>
                  </section>
                ) : null}
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
                        ) : capabilities.readOnlyReason ? (
                          <p className="muted small pad" data-testid="incident-verdict-readonly">{t('incidents.permission.writeBlocked')}</p>
                        ) : verdictState === 'sealed' ? (
                          <p className="muted small pad" data-testid="incident-verdict-sealed">{t('incidents.verdict.sealed')}</p>
                        ) : !capabilities.canRecordVerdict ? (
                          <p className="muted small pad" data-testid="incident-verdict-readonly">{t('incidents.permission.writeBlocked')}</p>
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
                <section className="panel" data-testid="incident-lifecycle" data-lifecycle-state={closureState}>
                        <div className="panel-head">
                          <div>
                            <h2>{t('incidents.close.title')}</h2>
                            <p>{t('incidents.close.description')}</p>
                          </div>
                        </div>
                        {closureState === 'closed' ? (
                          <div className="pad" data-testid="incident-closure-record" data-closed-at={incident.closedAt ?? ''}>
                            <p><Status code="CLOSED" /> <span className="muted small" data-testid="incident-closure-note">{incident.closureNote ?? t('common.none')}</span></p>
                            <p className="muted small">{t('incidents.close.record.writeOnce')}</p>
                          </div>
                        ) : capabilities.canClose ? (
                          <CloseIncidentForm
                            incidentId={incident.id}
                            revision={incident.revision}
                            onClosed={() => {
                              toast.push({ tone: 'ok', title: t('incidents.close.success') });
                              retry();
                            }}
                          />
                        ) : (
                          <p className="muted small pad" data-testid="incident-close-blocked" data-blocked-reason={capabilities.closeBlockedReason ?? ''}>
                            {capabilities.closeBlockedReason ? t(capabilities.closeBlockedReason) : t('incidents.close.blocked.notConcluded')}
                          </p>
                        )}
                        {capabilities.canTransferOwner ? (
                          <OwnerTransferForm
                            incidentId={incident.id}
                            revision={incident.revision}
                            currentOwner={incident.owner}
                            onTransferred={(submitted) => {
                              toast.push({ tone: 'ok', title: t('incidents.transfer.success') });
                              // Reload when this account may still read the record: the owner it shows then comes
                              // from a fresh GET, not from the write's echo. When the handover ended this account's
                              // access there is nothing to re-read, so the submitted values are what the page says.
                              if (losesAccessAfterHandover(user?.role ?? null)) setHandover(submitted);
                              else retry();
                            }}
                          />
                        ) : capabilities.transferBlockedReason && capabilities.transferBlockedReason !== capabilities.closeBlockedReason ? (
                          <p className="muted small pad" data-testid="incident-transfer-blocked">{t(capabilities.transferBlockedReason)}</p>
                        ) : null}
                      </section>
                <section className="panel" data-testid="incident-identity">
                        <div className="panel-head"><div><h2>{t('table.details')}</h2></div></div>
                        <div className="kv-grid">
                          <KV label={t('table.incident')} mono>{<LongId value={incident.id} label={t('table.copyIdentifier')} testId="incident-id" />}</KV>
                          <KV label={t('table.started')}>{<span title={incident.startedAt}>{ageMessage(locale, incident.startedAt)}</span>}</KV>
                          <KV label={t('table.owner')} mono>{<span title={incident.owner} data-testid="incident-detail-owner">{ownerLabel}</span>}</KV>
                          <KV label={t('incidents.owner.since')}>{<span title={incident.ownerAssignedAt} data-testid="incident-owner-since">{ageMessage(locale, incident.ownerAssignedAt)}</span>}</KV>
                          <KV label={t('table.source')}>{t(incidentSourceKey(incident.source))}</KV>
                          <KV label={t('table.relatedEntity')} mono>{incident.relatedEntity || t('common.none')}</KV>
                          <KV label={t('incidents.revision')} mono>{<span data-testid="incident-revision" data-revision={incident.revision}>{incident.revision}</span>}</KV>
                          {incident.closedAt ? <KV label={t('incidents.close.record.closedAt')}>{<span title={incident.closedAt}>{ageMessage(locale, incident.closedAt)}</span>}</KV> : null}
                          {incident.closedBy ? <KV label={t('incidents.close.record.closedBy')} mono>{directory.names?.[incident.closedBy] ?? shortOwner(incident.closedBy)}</KV> : null}
                        </div>
                      </section>
              </>
            ),
          },
        ]}
      />

    </div>
  );
}

/**
 * The left pane: the incidents this account can read, as a list you triage from.
 *
 * It is not a second copy of /app/incidents. The list page is a place you arrive at; this pane is
 * a place you stay - it answers "where am I in the queue" while the incident on screen is being
 * read, so moving to the next one is one click rather than a route change, a reload and a lost
 * scroll position.
 *
 * The filter set is derived from the rows the Kernel returned rather than from a hardcoded enum:
 * a status that no incident carries gets no chip, so the rail cannot offer an empty result as a
 * filter. `aria-pressed` carries the selection, and the count states how much of the list is
 * visible.
 */
function IncidentRail({ currentId }: { currentId: string }) {
  const t = useT();
  const { locale } = useI18n();
  const [items, setItems] = React.useState<IncidentView[] | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [reload, setReload] = React.useState(0);
  const [filter, setFilter] = React.useState<string>('ALL');

  React.useEffect(() => {
    let cancelled = false;
    setError(null);
    api.get<IncidentList>('/api/v1/incidents?limit=50')
      .then((result) => { if (!cancelled) setItems(result.items); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause); });
    return () => { cancelled = true; };
  }, [reload]);

  const statuses = React.useMemo(() => {
    const seen = new Map<string, number>();
    for (const row of items ?? []) seen.set(row.status, (seen.get(row.status) ?? 0) + 1);
    return Array.from(seen.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);
  const shown = filter === 'ALL' ? (items ?? []) : (items ?? []).filter((row) => row.status === filter);
  const label = (code: string) => {
    const entry = statusForCode(code);
    return entry ? t(entry.labelKey) : code;
  };

  return (
    <section className="panel investigation-rail" data-testid="investigation-rail" data-rail-state={error ? 'unavailable' : items ? 'ready' : 'loading'}>
      <div className="panel-head">
        <div>
          <h2>{t('incidents.rail.title')}</h2>
          <p>{t('incidents.rail.count', { shown: shown.length, total: items?.length ?? 0 })}</p>
        </div>
      </div>
      {items && items.length > 0 ? (
        <div className="investigation-rail-filter" role="group" aria-label={t('incidents.rail.filterAria')} data-testid="investigation-rail-filter">
          {[{ code: 'ALL', count: items.length }, ...statuses.map(([code, count]) => ({ code, count }))].map((chip) => (
            <button
              key={chip.code}
              type="button"
              className={'chip' + (filter === chip.code ? ' chip-active' : '')}
              aria-pressed={filter === chip.code}
              data-filter-status={chip.code}
              onClick={() => setFilter(chip.code)}
            >
              {chip.code === 'ALL' ? t('incidents.rail.all') : label(chip.code)}
              <span className="investigation-tab-count" data-filter-count={chip.count}>{chip.count}</span>
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <div className="pad" data-testid="investigation-rail-unavailable">
          <p><strong>{t('incidents.rail.unavailable.title')}</strong></p>
          <p className="muted small">{t('incidents.rail.unavailable.description')}</p>
          <Button variant="secondary" data-testid="investigation-rail-retry" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.retry')}</Button>
        </div>
      ) : items === null ? (
        <p className="muted small pad" aria-busy="true" data-testid="investigation-rail-loading">{t('incidents.rail.loading')}</p>
      ) : items.length === 0 ? (
        <div className="pad" data-testid="investigation-rail-empty">
          <p><strong>{t('incidents.rail.empty.title')}</strong></p>
          <p className="muted small">{t('incidents.rail.empty.description')}</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="muted small pad" data-testid="investigation-rail-empty-filter">{t('incidents.rail.emptyFiltered', { status: label(filter) })}</p>
      ) : (
        <ul className="investigation-rail-list" data-testid="investigation-rail-list">
          {shown.map((row) => (
            <li key={row.id}>
              <Link
                className="investigation-rail-item"
                to={'/app/incidents/' + row.id}
                aria-current={row.id === currentId ? 'page' : undefined}
                data-rail-incident={row.id}
                data-rail-status={row.status}
              >
                <span className="investigation-rail-head">
                  <span className="investigation-rail-title">{row.title}</span>
                </span>
                <span className="investigation-rail-facts">
                  <Status code={row.status} />
                  <Status code={row.severity} />
                  <span title={row.updatedAt}>{ageMessage(locale, row.updatedAt)}</span>
                  <span className="mono" title={row.owner}>{shortOwner(row.owner)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
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
/**
 * The tooltip a trust chip carries on a row: what this row's verification method was called, and
 * which adapter said so when an adapter did. `NONE` is not a method name a reader should have to
 * decode, so it becomes the sentence that says nothing was checked.
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
  // G12 B: the bytes, when the submitter has them. Left empty, the row is recorded as a Legacy
  // reference - which is a legitimate submission and is labelled as one wherever it is shown.
  const [content, setContent] = React.useState('');
  const [contentType, setContentType] = React.useState<string>('text/plain');
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
    if (!iso || trimmedSource.length < 2 || (content.length === 0 && trimmedRef.length < 2)) {
      setFieldError(t('incidents.error.invalidRequest'));
      return;
    }
    // Exactly one of the two travels: the kernel derives contentRef from the bytes when content
    // is present, and refuses a supplied ref that disagrees with them.
    const payload: Record<string, unknown> = {
      kind,
      source: trimmedSource,
      collectedAt: iso,
      claimedTrust,
    };
    if (content.length > 0) {
      payload.content = { contentType, body: content };
    } else {
      payload.contentRef = trimmedRef;
    }
    setSubmitting(true);
    try {
      await api.post<IncidentEvidence>('/api/v1/incidents/' + encodeURIComponent(incidentId) + '/evidence', payload);
      setContentRef('');
      setContent('');
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
      <div className="form-grid">
        <Field label={t('incidents.content.add.typeLabel')} htmlFor="incident-evidence-content-type">
          <Select value={contentType} onValueChange={setContentType}>
            <SelectTrigger id="incident-evidence-content-type" data-testid="incident-evidence-content-type" aria-label={t('incidents.content.add.typeLabel')}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="text/plain" data-testid="incident-evidence-content-type-text">text/plain</SelectItem>
              <SelectItem value="application/json" data-testid="incident-evidence-content-type-json">application/json</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label={t('incidents.content.add.contentLabel')} hint={t('incidents.content.add.contentHint')} htmlFor="incident-evidence-content">
        <textarea
          id="incident-evidence-content"
          data-testid="incident-evidence-content"
          rows={5}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
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
/** The trail snapshot, keyed by the route it describes so a late answer cannot cross incidents. */
interface TrailSnapshot {
  routeId: string;
  events: IncidentTimelineEvent[];
  truncated: boolean;
  loaded: boolean;
  failed: boolean;
}

/**
 * GET /incidents/{id}/timeline, for the audit panel.
 *
 * A separate read from the incident on purpose: a trail that cannot be read degrades one panel
 * (and says so) instead of blanking a page whose record was read successfully. The route id is
 * stored with the events and compared at render time, so a slow answer for the previous incident
 * is never painted under the new one.
 */
function useIncidentTrail(incidentId: string, reload: number): {
  state: 'loading' | 'ready' | 'unavailable';
  events: IncidentTimelineEvent[];
  truncated: boolean;
} {
  const [snapshot, setSnapshot] = React.useState<TrailSnapshot>({
    routeId: incidentId,
    events: [],
    truncated: false,
    loaded: false,
    failed: false,
  });
  const seqRef = React.useRef(0);

  React.useEffect(() => {
    const seq = ++seqRef.current;
    const live = () => seq === seqRef.current;
    setSnapshot((current) =>
      current.routeId === incidentId
        ? { ...current, failed: false }
        : { routeId: incidentId, events: [], truncated: false, loaded: false, failed: false },
    );
    api
      .get<IncidentTimeline>('/api/v1/incidents/' + encodeURIComponent(incidentId) + '/timeline')
      .then((result) => {
        if (!live()) return;
        setSnapshot({ routeId: incidentId, events: result.items, truncated: result.truncated, loaded: true, failed: false });
      })
      .catch(() => {
        if (!live()) return;
        setSnapshot((current) => ({ ...current, routeId: incidentId, failed: true }));
      });
  }, [incidentId, reload]);

  if (snapshot.routeId !== incidentId) return { state: 'loading', events: [], truncated: false };
  if (!snapshot.loaded) return { state: snapshot.failed ? 'unavailable' : 'loading', events: [], truncated: false };
  return { state: 'ready', events: snapshot.events, truncated: snapshot.truncated };
}

/** One audited write, rendered from the fields the trail carries for that event type. */
function AuditRow({ event, directory }: { event: IncidentTimelineEvent; directory: { names: Record<string, string> | null } }) {
  const t = useT();
  const { locale } = useI18n();
  const facts = timelineEventFacts(event);
  const actorName = directory.names?.[event.actorId] ?? shortOwner(event.actorId);
  const atValid = Number.isFinite(Date.parse(event.occurredAt));
  const fromName = facts.fromOwner ? (directory.names?.[facts.fromOwner] ?? shortOwner(facts.fromOwner)) : '';
  const toName = facts.toOwner ? (directory.names?.[facts.toOwner] ?? shortOwner(facts.toOwner)) : '';
  return (
    <li data-audit-event={event.eventType} data-audit-actor={event.actorId} data-audit-at={event.occurredAt}>
      <span className="timeline-dot" />
      <div>
        <strong>
          <Badge variant={badgeVariantForTone(timelineEventTone(event.eventType))} data-testid="audit-event-type">
            {t(timelineEventKey(event.eventType))}
          </Badge>
        </strong>
        <span className="tag mono" data-testid="audit-event-code">{event.eventType}</span>
        <span className="muted small" data-testid="audit-actor">{t('incidents.audit.actor', { name: actorName })}</span>
        <span className="muted small" data-testid="audit-time">
          {atValid ? <span title={event.occurredAt}>{ageMessage(locale, event.occurredAt)}</span> : event.occurredAt}
        </span>
        {facts.evidenceKind ? <span className="tag">{t(evidenceKindKey(facts.evidenceKind))}</span> : null}
        {facts.verifiedTrust ? <span className="muted small">{t(evidenceTrustKey(facts.verifiedTrust))}</span> : null}
        {facts.verdict ? <Status code={facts.verdict} /> : null}
        {facts.consideredEvidenceCount !== null ? (
          <span className="muted small" data-testid="audit-considered">{t('incidents.audit.considered', { count: facts.consideredEvidenceCount })}</span>
        ) : null}
        {facts.fromOwner || facts.toOwner ? (
          <span className="muted small" data-testid="audit-owner-change">
            {t('incidents.audit.ownerChange', { from: fromName, to: toName })}
          </span>
        ) : null}
        {facts.reason ? <span className="muted small" data-testid="audit-reason">{t('incidents.audit.reason', { reason: facts.reason })}</span> : null}
        {facts.closureNote ? <span className="muted small" data-testid="audit-note">{t('incidents.audit.note', { note: facts.closureNote })}</span> : null}
      </div>
    </li>
  );
}

/** G12 C: the closure and handover forms. */
/**
 * The closure form.
 *
 * Two things are stated before submission rather than discovered from a 409: the note is bounded,
 * and the closure is decided against the revision on screen. The idempotency key is created once
 * per form and reused by a retry, which is what makes 'the request timed out, try again' safe;
 * a definitive refusal rotates it so the next attempt is a fresh decision, not a replay claim.
 */
function CloseIncidentForm({ incidentId, revision, onClosed }: { incidentId: string; revision: number; onClosed: () => void }) {
  const t = useT();
  const [note, setNote] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const keyRef = React.useRef<string>(newIdempotencyKey());

  const submit = async () => {
    setFailure(null);
    setFieldError(null);
    const invalid = closureNoteError(note);
    if (invalid) {
      setFieldError(t(invalid));
      return;
    }
    setSubmitting(true);
    try {
      await api.post<IncidentView>(
        '/api/v1/incidents/' + encodeURIComponent(incidentId) + '/close',
        closeIncidentPayload(revision, note, keyRef.current),
      );
      setNote('');
      onClosed();
    } catch (cause) {
      setFailure(cause);
      if (cause instanceof ApiError && cause.status === 409) keyRef.current = newIdempotencyKey();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="form-stack pad" data-testid="incident-close-form" data-expected-revision={revision}>
      <p className="muted small" data-testid="incident-close-requirements">{t('incidents.close.requirements', { revision })}</p>
      <Field label={t('incidents.close.noteLabel')} hint={t('incidents.close.noteHint')} htmlFor="incident-close-note">
        <textarea
          id="incident-close-note"
          data-testid="incident-close-note"
          rows={3}
          maxLength={CLOSURE_NOTE_MAX_CHARS}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      {fieldError ? <p className="inline-error" role="alert" data-testid="incident-close-field-error">{fieldError}</p> : null}
      <IncidentFailureNotice error={failure} testId="incident-close-error" />
      <div>
        <Button onClick={() => void submit()} disabled={submitting} data-testid="incident-close-submit">
          {submitting ? t('incidents.close.submitting') : t('incidents.close.submit')}
        </Button>
      </div>
    </div>
  );
}
/**
 * The handover form.
 *
 * The target list comes from the user directory, which is admin-only. An operator therefore types
 * the account id - the honest consequence of a directory it may not read, rather than a picker
 * that silently offers nothing. Either way the kernel validates the target and names the refusal.
 */
function OwnerTransferForm({
  incidentId,
  revision,
  currentOwner,
  onTransferred,
}: {
  incidentId: string;
  revision: number;
  currentOwner: string;
  onTransferred: (submitted: { toOwner: string; reason: string; at: string }) => void;
}) {
  const t = useT();
  const directory = useUserDirectory();
  const [target, setTarget] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const candidates = directory.names
    ? Object.entries(directory.names).filter(([id]) => id !== currentOwner)
    : [];

  const submit = async () => {
    setFailure(null);
    setFieldError(null);
    const invalid = transferReasonError(reason);
    if (invalid || !target.trim()) {
      setFieldError(t(invalid ?? 'incidents.transfer.targetHint'));
      return;
    }
    setSubmitting(true);
    const submitted = { toOwner: target.trim(), reason: reason.trim(), at: new Date().toISOString() };
    try {
      await api.post<IncidentOwnerTransfer>(
        '/api/v1/incidents/' + encodeURIComponent(incidentId) + '/owner',
        transferIncidentPayload(revision, submitted.toOwner, submitted.reason),
      );
      setReason('');
      onTransferred(submitted);
    } catch (cause) {
      setFailure(cause);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="form-stack pad" data-testid="incident-transfer-form" data-expected-revision={revision}>
      <h3>{t('incidents.transfer.title')}</h3>
      <p className="muted small">{t('incidents.transfer.description')}</p>
      {candidates.length > 0 ? (
        <Field label={t('incidents.transfer.targetLabel')} hint={t('incidents.transfer.targetHint')} htmlFor="incident-transfer-target">
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger id="incident-transfer-target" data-testid="incident-transfer-target" aria-label={t('incidents.transfer.targetLabel')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {candidates.map(([id, name]) => (
                <SelectItem key={id} value={id} data-testid={'incident-transfer-target-' + id}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : (
        <Field
          label={t('incidents.transfer.targetLabel')}
          hint={directory.readable ? t('incidents.transfer.noTargets') : t('incidents.transfer.directoryUnavailable')}
          htmlFor="incident-transfer-target"
        >
          <Input
            id="incident-transfer-target"
            data-testid="incident-transfer-target"
            value={target}
            placeholder="00000000-0000-0000-0000-000000000000"
            onChange={(event) => setTarget(event.target.value)}
          />
        </Field>
      )}
      <Field label={t('incidents.transfer.reasonLabel')} hint={t('incidents.transfer.reasonHint')} htmlFor="incident-transfer-reason">
        <textarea
          id="incident-transfer-reason"
          data-testid="incident-transfer-reason"
          rows={3}
          maxLength={TRANSFER_REASON_MAX_CHARS}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      {fieldError ? <p className="inline-error" role="alert" data-testid="incident-transfer-field-error">{fieldError}</p> : null}
      <IncidentFailureNotice error={failure} testId="incident-transfer-error" />
      <div>
        <Button onClick={() => void submit()} disabled={submitting} data-testid="incident-transfer-submit">
          {submitting ? t('incidents.transfer.submitting') : t('incidents.transfer.submit')}
        </Button>
      </div>
    </div>
  );
}
