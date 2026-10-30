import React, { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { usePolling } from '../hooks';
import type { AuditEvent, NodeView } from '../types';
import { Icon } from '../components/Icons';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { CopyButton, EmptyState, ErrorState, KV, Skeleton, TimeAgo, useToast } from '../components/Ui';
import { formatBytes, formatDate } from '../format';
import { useI18n, useT } from '../i18n';
import { cn } from '../lib/utils';
import { verifiedWriteDetail, verifiedWriteFailure, verifyAfterWrite } from '../lib/verify-after-write';
import { describeNodeState, nodeRevokedLanded } from '../lib/verified-writes';
import { AsyncBoundary, NoticeBar, isStale, useObservedPolling } from '../components/app/async-boundary';
import { PageHeader } from '../components/app/page-header';
import { NoData, StatusIndicator, UnknownValue, indicatorStateForCode, labelKeyForState, type IndicatorState } from '../components/app/status-indicator';
import { ConfirmAction } from '../components/app/confirm-action';
import { IdentityCell, RowActions, StackCell, cardActionCell, cardCellClass, cardLineAfter, cardTwoLineRow, copyIdAction, formatIdentity, rankCardFacts, stackBody, stackHead, stackRow, stackTable, type RowAction } from './table-kit';

/**
 * A revoked node is proven by the node route, not by the DELETE's 200. `DELETE /nodes/{id}`
 * writes `revoked_at`, and the row keeps answering 200 with that timestamp; a node the Kernel has
 * since dropped answers 404 instead, which is the same fact stated by absence (hence
 * `absentIsExpected` - nothing else is allowed to read as success).
 */
function revokeSpec(id: string) {
  return verifyAfterWrite<NodeView>({
    write: () => api.del(`/api/v1/nodes/${id}`),
    read: () => api.get<NodeView>(`/api/v1/nodes/${id}`),
    expected: nodeRevokedLanded,
    describe: describeNodeState,
    absentIsExpected: true,
  });
}

/**
 * Status rendering for every node surface: colour + glyph + text, and the effective state is
 * the observed one — revoked beats stale beats the stored code, so a silent node can never
 * render as READY (docs/09 §9.5).
 */
function StatusPill({ status }: { status: string }) {
  const state = indicatorStateForCode(status);
  return <StatusIndicator state={state} label={state === 'unknown' ? status : undefined} />;
}

/** Effective node state: revocation, then UNREACHABLE, then staleness, then the stored code. */
function nodeState(node: NodeView): IndicatorState {
  return indicatorStateForCode(node.status, { stale: node.stale, revoked: Boolean(node.revokedAt) });
}

/** A utilisation ratio, or null when the sample is missing or not a usable number. */
function ratio(used?: number | null, total?: number | null): number | null {
  if (typeof used !== 'number' || typeof total !== 'number') return null;
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0 || used < 0) return null;
  return Math.min(1, used / total);
}

function percentOf(value?: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

// The record layout, the row menu and the status pill come from ./table-kit: one breakpoint
// (768px) shared with Plugins and with the card CSS in styles.css, so a viewport can never be
// stacked without also getting the labels.

/** Label + control + hint, the shadcn replacement for the shared Field wrapper. */
function FormField({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <span className="text-sm text-muted-foreground">{hint}</span>}
    </div>
  );
}

const joinCommand = `export OPSWEAVE_KERNEL_URL=http://<kernel-host>:18181
export OPSWEAVE_ENROLLMENT_TOKEN=<token>
export OPSWEAVE_NODE_NAME=node-a
export OPSWEAVE_NODE_LABELS=role=node,zone=lab
export OPSWEAVE_DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
opsweave-node`;

export function NodesPage() {
  const t = useT();
  const { locale } = useI18n();
  const { data, error, loading, reload, observedAt } = useObservedPolling(() => api.get<NodeView[]>('/api/v1/nodes'), 5000);
  const { user } = useAuth();
  const [stateFilter, setStateFilter] = useState('ALL');
  const [osFilter, setOsFilter] = useState('ALL');
  const [joinOpen, setJoinOpen] = useState(false);
  const [label, setLabel] = useState('role=node');
  const [ttl, setTtl] = useState(30);
  const [token, setToken] = useState<{ token: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const labelFieldId = useId();
  const ttlFieldId = useId();
  const tokenFieldId = useId();
  const navigate = useNavigate();
  const toast = useToast();
  const isAdmin = user?.role === 'admin';
  // Revoking a node used to require opening the node, finding Revoke, and confirming there:
  // four interactions for a verb that belongs on the row it applies to.
  const [revokeTarget, setRevokeTarget] = useState<NodeView | null>(null);
  const nodes = data || [];
  const operatingSystems = useMemo(
    () => Array.from(new Set(nodes.map((node) => node.os).filter(Boolean))).sort(),
    [nodes],
  );
  // The state filter runs on the *effective* state, not the stored code: filtering by READY
  // must never surface a node whose heartbeat went stale (docs/09 §9.5).
  const visible = useMemo(
    () => nodes.filter((node) => (stateFilter === 'ALL' || nodeState(node) === stateFilter) && (osFilter === 'ALL' || node.os === osFilter)),
    [nodes, stateFilter, osFilter],
  );
  /**
   * table-spec §2.7: a column exists only while the rows can answer it. At half the rows without a
   * sample the column is dropped (§2.7's own threshold) and one sentence above the table says why,
   * instead of twelve rows spending four dashed boxes each on the same fact.
   */
  const sampledNodes = visible.filter((node) => Boolean(node.resourceSnapshot)).length;
  const missingSamples = visible.length - sampledNodes;
  const resourcesMeasurable = visible.length > 0 && sampledNodes / visible.length > 0.5;
  /**
   * table-spec §2.5: the three facts the 390 card keeps, ranked by §2.2's distinct ratio over the
   * rows on screen. Capacity and the sample time are the second line of the resource cell, not
   * facts of their own: a card would spend a line saying what the line above it said.
   */
  const cardFacts = rankCardFacts({
    status: visible.map((node) => nodeState(node)),
    instances: visible.map((node) => `${node.instancesReady}/${node.instancesTotal}`),
    resources: visible.map((node) => {
      const snapshot = node.resourceSnapshot;
      const cpu = percentOf(snapshot?.cpuUtilization);
      const memory = ratio(snapshot?.memoryUsedBytes, snapshot?.memoryTotalBytes);
      return snapshot && cpu !== null && memory !== null ? `${Math.round(cpu * 100)}/${Math.round(memory * 100)}` : '';
    }),
  });

  async function createToken() {
    setBusy(true);
    setJoinError(null);
    try {
      const result = await api.post<{ token: string; expiresAt: string }>('/api/v1/nodes/enrollment-tokens', { label, ttlMinutes: ttl });
      setToken(result);
      setShowToken(true);
    } catch (cause: any) {
      setJoinError(cause.message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeNode(): Promise<void> {
    if (!revokeTarget) return;
    const result = await revokeSpec(revokeTarget.id);
    const failure = verifiedWriteFailure(result, t);
    await reload();
    // ConfirmAction keeps the dialog (and its retry) open when the node is still serving.
    if (failure) throw failure;
    toast.push({ tone: 'ok', title: t('nodeDetail.revoked.title'), detail: t('nodeDetail.revoked.detail') + ' ' + verifiedWriteDetail(result, t) });
  }

  /** Every verb one node row may run, with the reason printed when one is refused. */
  function nodeActions(node: NodeView): RowAction[] {
    const actions: RowAction[] = [
      // table-spec §2.1: the full id is always one click away and it is the FIRST item of the row
      // menu. Hover text on the identity cell is not a copy affordance - a 36-character UUID
      // cannot be transcribed by eye.
      copyIdAction(node.id, t('nodes.action.copyId'), { onCopied: () => toast.push({ tone: 'ok', title: t('nodes.action.copyId'), detail: node.id }) }),
      { id: 'details', label: t('nodes.action.open'), icon: 'external', onSelect: () => navigate(`/admin/nodes/${node.id}`) },
      { id: 'instances', label: t('nodes.action.instances'), icon: 'box', onSelect: () => navigate(`/admin/nodes/${node.id}`) },
    ];
    actions.push({
      id: 'revoke',
      label: t('action.revoke'),
      icon: 'trash',
      danger: true,
      divider: true,
      // DELETE /api/v1/nodes/{id} is require_admin; the other roles are told why, not handed a 403.
      disabled: !isAdmin || Boolean(node.revokedAt),
      disabledReason: !isAdmin ? t('nodes.action.adminOnly') : t('nodes.action.alreadyRevoked'),
      onSelect: () => setRevokeTarget(node),
    });
    return actions;
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={t('page.nodes')}
        actions={<Button variant="secondary" className="max-[768px]:flex-1" onClick={() => void reload()}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>}
        primary={<Button className="max-[768px]:flex-1" onClick={() => setJoinOpen(true)} disabled={user?.role !== 'admin'} title={user?.role !== 'admin' ? t('nodes.join.adminRequired') : ''}><Icon name="plus" size={15} /> {t('nodes.join.action')}</Button>}
      />
      <AsyncBoundary
        loading={loading}
        error={error}
        hasData={Boolean(data)}
        isEmpty={nodes.length === 0}
        onRetry={() => void reload()}
        skeletonRows={5}
        emptyState={<EmptyState icon="nodes" title={t('nodes.empty.title')} description={t('nodes.empty.description')} action={<Button onClick={() => setJoinOpen(true)} disabled={user?.role !== 'admin'}>{t('nodes.empty.action')}</Button>} />}
      >
        {/* A count you cannot click is a number you then have to hunt for again: each cell
            selects the state it counts, and aria-pressed keeps the current filter readable.
            V4 removed the second, identical filter underneath: a state strip plus a tab row
            offered the same five choices twice, 40px apart. */}
        <section className="stat-block" aria-label={t('nodes.summary.aria')} data-testid="nodes-summary">
          <div className="ow-summary">
            <button type="button" className={cn('ow-summary-card', stateFilter === 'ALL' && 'is-active')} aria-pressed={stateFilter === 'ALL'} onClick={() => setStateFilter('ALL')}>
              <span className="ow-summary-label">{t('nodes.summary.total')}</span>
              <span className="ow-summary-value">{nodes.length}</span>
              <span className="ow-summary-definition">{t('nodes.summary.definition')}</span>
            </button>
            {(['ready', 'stale', 'unreachable', 'revoked'] as IndicatorState[]).map((state) => (
              // Keyed on the IndicatorState itself, never on its upper-cased display form: the
              // filter below compares nodeState() values, which are lower case, so an upper-cased
              // key selected zero rows and the table emptied on click.
              <button type="button" className={cn('ow-summary-card', stateFilter === state && 'is-active')} key={state} aria-pressed={stateFilter === state} onClick={() => setStateFilter((current) => current === state ? 'ALL' : state)}>
                <span className="ow-summary-label state-count">
                  <span className="state-count-dot" data-indicator={state} aria-hidden="true" />
                  {t(labelKeyForState(state))}
                </span>
                <span className="ow-summary-value">{nodes.filter((node) => nodeState(node) === state).length}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="toolbar">
          {operatingSystems.length > 1 ? (
            <label className="ow-filter-select">
              <span>{t('nodes.filter.os')}</span>
              <select value={osFilter} onChange={(event) => setOsFilter(event.target.value)} aria-label={t('nodes.filter.os')}>
                <option value="ALL">{t('nodes.filter.os.all')}</option>
                {operatingSystems.map((os) => <option key={os} value={os}>{os}</option>)}
              </select>
            </label>
          ) : null}
          <span className="toolbar-count">{t('nodes.count.summary', { filtered: visible.length, total: nodes.length })}</span>
        </section>
        {isStale(observedAt, 5000) ? <NoticeBar state="stale" title={t('ui.stale.title')} detail={t('ui.stale.detail', { at: observedAt ?? '' })} /> : null}
        <section className="panel table-panel">
          {/* table-spec §2.2: four columns, not seven. CPU, memory, capacity and the sample time
              are one fact about one sample, so they share one resource cell - the 13px value line
              and the 11px label line §2.3 already defines - instead of four headings, four widths
              and four borders for one reading. §2.7: a sample that never arrived is stated once,
              here, above the table; the row says the same thing in words instead of spending its
              cells on dashed boxes. */}
          <p className="stat-note" data-table-note="resources">
            {resourcesMeasurable ? t('nodes.table.note') : t('nodes.resource.none')}
            {resourcesMeasurable && missingSamples > 0 ? (
              <>
                {' '}
                <NoData detail={t('nodes.resource.missingSnapshot')} />{' '}
                {t('nodes.resource.coverage', { missing: missingSamples, total: visible.length })}
              </>
            ) : null}
          </p>
          <Table className={cn('nodes-table', stackTable)}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('table.node')}</TableHead>
                <TableHead>{t('table.status')}</TableHead>
                <TableHead>{t('table.instances')}</TableHead>
                {resourcesMeasurable ? <TableHead>{t('table.resources')}</TableHead> : null}
                <TableHead aria-label={t('table.open')} />
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {visible.map((node) => {
                const snapshot = node.resourceSnapshot;
                const cpu = percentOf(snapshot?.cpuUtilization);
                const memory = ratio(snapshot?.memoryUsedBytes, snapshot?.memoryTotalBytes);
                const open = () => navigate(`/admin/nodes/${node.id}`);
                /* §2.5 at 390: two lines. The identity and the state share the first one; the
                   qualifier (os/arch, generation) continues into instances and resources on the
                   second. Which cell rides which line is the same hook /admin/jobs uses, but the
                   VALUES are this page's: jobs prints a duration and an age, a node prints an
                   instances ratio and a utilisation pair, and each keeps its own cell, its own
                   data-label and its own arithmetic (1/4 is ready-over-total, 12% is a ratio of
                   one snapshot) - so the mapping is declared here rather than borrowed. */
                return (
                  <TableRow key={node.id} className={cn('cursor-pointer focus-visible:outline-offset-[-2px]', cardTwoLineRow, stackRow)} data-node-state={nodeState(node)} onClick={open} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') open(); }}>
                    <IdentityCell label={t('table.node')} identity={formatIdentity({ name: node.name, id: node.id, at: node.lastSeenAt, locale, rowsOnPage: visible.length })} cardFact>
                      <span className="mono">{node.os}/{node.arch}</span>
                      <span className="ow-key">{t('nodes.table.generation', { generation: node.generation })}</span>
                    </IdentityCell>
                    {/* §2.3: a two-line cell must fit 40px, and this one did not - it printed
                        lastSeenAt a second time (the identity cell's age IS that field) on a 24px
                        hit area, and the row measured 50.4px against §4.2's 42. The pill is the
                        fact; the age is already on the line above it. */}
                    <StackCell label={t('table.status')} className={cardCellClass(cardFacts.includes('status'))}>
                      <div className="ow-cell-stack">
                        {/* The state is an entity: it opens the node it describes. */}
                        <Link className="status-entity" to={`/admin/nodes/${node.id}`} data-status-entity={node.id} title={t('nodes.status.openEntity', { name: node.name })} onClick={(event) => event.stopPropagation()}>
                          <StatusIndicator state={nodeState(node)} />
                        </Link>
                      </div>
                    </StackCell>
                    <StackCell label={t('table.instances')} className={cn(cardLineAfter, cardCellClass(cardFacts.includes('instances')))}><strong className="ow-tnum">{node.instancesReady}/{node.instancesTotal}</strong><span className="ow-cell-meta ms-1">{t('status.ready')}</span></StackCell>
                    {resourcesMeasurable ? (
                      <StackCell label={t('table.resources')} data-resource="resources" className={cn(cardLineAfter, cardCellClass(cardFacts.includes('resources')))}>
                        {snapshot ? (
                          <div className="ow-cell">
                            <span className="ow-cell-value ow-tnum">
                              {cpu === null
                                ? <UnknownValue detail={t('nodes.resource.missingSnapshot')} />
                                : <span data-resource="cpu" className="ow-utilization">{Math.round(cpu * 100)}%</span>}
                              {' · '}
                              {memory === null
                                ? <UnknownValue detail={t('nodes.resource.missingSnapshot')} />
                                : <span data-resource="memory" className="ow-utilization">{Math.round(memory * 100)}%</span>}
                            </span>
                            <span className="ow-cell-meta ow-tnum">
                              {snapshot.memoryTotalBytes ? (
                                <span data-resource="capacity">{memory === null ? formatBytes(snapshot.memoryTotalBytes) : `${formatBytes(snapshot.memoryUsedBytes)} / ${formatBytes(snapshot.memoryTotalBytes)}`}</span>
                              ) : null}
                              {snapshot.sampledAt ? (
                                <>
                                  {snapshot.memoryTotalBytes ? ' · ' : null}
                                  <span data-resource="sampled-at"><TimeAgo value={snapshot.sampledAt} /></span>
                                </>
                              ) : null}
                            </span>
                          </div>
                        ) : (
                          <span className="ow-cell-meta" data-resource="absent">{t('nodes.resource.missingSnapshot')}</span>
                        )}
                      </StackCell>
                    ) : null}
                    <TableCell className={cn('w-8 text-right text-muted-foreground', cardActionCell)}>
                      <RowActions label={t('nodes.action.menu', { name: node.name })} actions={nodeActions(node)} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </section>
      </AsyncBoundary>

      <ConfirmAction
        open={revokeTarget !== null}
        title={t('nodeDetail.confirmRevoke.title', { name: revokeTarget?.name ?? '' })}
        description={t('nodeDetail.confirmRevoke.description')}
        confirmLabel={t('action.revoke')}
        onConfirm={revokeNode}
        onClose={() => setRevokeTarget(null)}
      />

      <Dialog open={joinOpen} onOpenChange={(open) => { setJoinOpen(open); if (!open) { setToken(null); setShowToken(false); } }}>
        <DialogContent closeLabel={t('aria.closeDialog')} className="max-w-[860px]">
          <DialogHeader><DialogTitle>{t('nodes.join.title')}</DialogTitle></DialogHeader>
          <div className="form-stack">
            {!token ? (
              <>
                <div className="callout"><Icon name="key" size={16} /><p>{t('nodes.join.note')}</p></div>
                <div className="form-grid">
                  <FormField label={t('nodes.join.field.label')} hint={t('nodes.join.field.label.hint')} htmlFor={labelFieldId}><Input id={labelFieldId} value={label} onChange={(event) => setLabel(event.target.value)} /></FormField>
                  <FormField label={t('nodes.join.field.ttl')} htmlFor={ttlFieldId}><Input id={ttlFieldId} type="number" min={5} max={1440} value={ttl} onChange={(event) => setTtl(Number(event.target.value))} /></FormField>
                </div>
                {joinError && <div className="inline-error"><Icon name="warning" size={16} /> {joinError}</div>}
                <div className="command-block"><span className="command-label">{t('nodes.join.commandLabel')}</span><pre>{joinCommand}</pre><CopyButton value={joinCommand} /></div>
              </>
            ) : (
              <>
                <div className="callout callout-ok"><Icon name="check" size={16} /><p>{t('nodes.join.created', { expiresAt: formatDate(token.expiresAt) })}</p></div>
                <FormField label={t('nodes.join.tokenLabel')} hint={t('nodes.join.tokenHint')} htmlFor={tokenFieldId}>
                  <div className="flex items-center gap-2">
                    <Input id={tokenFieldId} readOnly className="font-mono" type={showToken ? 'text' : 'password'} value={token.token} />
                    <Button variant="secondary" size="sm" onClick={() => setShowToken(!showToken)}>{showToken ? t('action.hide') : t('action.reveal')}</Button>
                    <CopyButton value={token.token} label={t('nodes.join.copyToken')} />
                  </div>
                </FormField>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => { setJoinOpen(false); setToken(null); }}>{t('action.close')}</Button>
            {!token && <Button onClick={() => void createToken()} disabled={busy}>{busy ? t('nodes.join.creating') : t('nodes.join.submit')}</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function NodeDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { data, error, loading, reload } = usePolling(() => api.get<NodeView>(`/api/v1/nodes/${id}`), 5000);
  const { data: instances, reload: reloadInstances } = usePolling(() => api.get<any[]>(`/api/v1/nodes/${id}/instances`), 5000);
  const [history, setHistory] = useState<any[]>([]);
  const [historyWindow, setHistoryWindow] = useState(1);
  useEffect(() => {
    let cancelled = false;
    const from = new Date(Date.now() - historyWindow * 3600_000).toISOString();
    const resolution = historyWindow <= 1 ? 'raw' : 'hour';
    void api.get<any[]>(`/api/v1/nodes/${id}/resource-history?limit=100&resolution=${resolution}&from=${encodeURIComponent(from)}`)
      .then((items) => { if (!cancelled) setHistory(items || []); })
      .catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; };
  }, [id, historyWindow]);
  const { data: events } = usePolling(() => api.get<AuditEvent[]>(`/api/v1/audit?subjectType=node&subjectId=${id}&limit=20`), 0);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  if (loading && !data) return <><PageHeader title={t('nodeDetail.title')} /><Skeleton rows={6} /></>;
  if (error) return <><PageHeader title={t('nodeDetail.title')} /><ErrorState error={error} onRetry={() => void reload()} /></>;
  if (!data) return null;
  const snapshot = data.resourceSnapshot;
  const memoryPercent = snapshot?.memoryUsedBytes && snapshot?.memoryTotalBytes ? snapshot.memoryUsedBytes / snapshot.memoryTotalBytes : null;
  const diskPercent = snapshot?.filesystemUsedBytes && snapshot?.filesystemTotalBytes ? snapshot.filesystemUsedBytes / snapshot.filesystemTotalBytes : null;

  async function revoke() {
    setBusy(true);
    try {
      const result = await revokeSpec(id);
      const failure = verifiedWriteFailure(result, t);
      await reload();
      if (failure) throw failure;
      toast.push({ tone: 'ok', title: t('nodeDetail.revoked.title'), detail: t('nodeDetail.revoked.detail') + ' ' + verifiedWriteDetail(result, t) });
    } catch (cause: any) {
      toast.push({ tone: 'danger', title: t('common.revokeFailed'), detail: cause.message });
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t('nodeDetail.eyebrow')}
        title={data.name}
        description={<><span className="mono">{data.id}</span> · {t('nodeDetail.generation', { generation: data.generation })} · {data.os}/{data.arch}</>}
        actions={<><Button variant="secondary" className="max-[768px]:flex-1" onClick={() => { void reload(); void reloadInstances(); }}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>{user?.role === 'admin' && <Button variant="destructive" className="max-[768px]:flex-1" onClick={() => setConfirm(true)}><Icon name="trash" size={15} /> {t('action.revoke')}</Button>}</>}
      />
      <div className="detail-meta"><StatusPill status={data.status} />{data.stale && <span className="meta-chip text-warning"><Icon name="warning" size={13} /> {t('nodeDetail.staleSince')} <TimeAgo value={data.lastSeenAt} /></span>}<span className="meta-chip"><Icon name="clock" size={13} /> {t('nodeDetail.enrolled', { at: formatDate(data.enrolledAt) })}</span><span className="meta-chip"><Icon name="server" size={13} /> {data.runtimeAdapterVersion || t('nodeDetail.adapterUnknown')}</span></div>
      <div className="summary-grid">
        <section className="panel">
          <div className="panel-head"><div><h2>{t('nodeDetail.control.title')}</h2><p>{t('nodeDetail.control.description')}</p></div></div>
          <div className="kv-grid">
            <KV label={t('table.status')}><StatusPill status={data.status} /></KV>
            <KV label={t('table.lastObserved')}><TimeAgo value={data.lastSeenAt} /> <span className="text-sm text-muted-foreground">{data.lastSeenAt ? formatDate(data.lastSeenAt) : ''}</span></KV>
            <KV label={t('table.generation')}>{data.generation}</KV>
            <KV label={t('nodeDetail.field.dataEndpoint')} mono>{data.dataEndpoint || t('nodeDetail.notRegistered')}</KV>
            <KV label={t('common.capabilities')}>{(data.capabilities || []).join(', ') || '—'}</KV>
            <KV label={t('nodeDetail.field.labels')}>{(Object.entries(data.labels || {}).map(([k, v]) => `${k}=${v}`).join(', ')) || '—'}</KV>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>{t('nodeDetail.resources.title')}</h2><p>{t('nodeDetail.resources.description')}</p></div></div>
          {!snapshot ? <p className="text-muted-foreground p-4">{t('nodeDetail.resources.empty')}</p> : (
            <div className="resource-stack">
              <div><div className="resource-row"><span>{t('nodeDetail.resource.cpuUtilization')}</span><strong>{typeof snapshot.cpuUtilization === 'number' ? `${(snapshot.cpuUtilization * 100).toFixed(0)}%` : <NoData detail={t('nodes.resource.missingSnapshot')} />}</strong></div><ProgressBar percent={snapshot.cpuUtilization ?? null} /></div>
              <div><div className="resource-row"><span>{t('table.memory')}</span><strong>{formatBytes(snapshot.memoryUsedBytes)} / {formatBytes(snapshot.memoryTotalBytes)}</strong></div><ProgressBar percent={memoryPercent} /></div>
              <div><div className="resource-row"><span>{t('table.filesystem')}</span><strong>{formatBytes(snapshot.filesystemUsedBytes)} / {formatBytes(snapshot.filesystemTotalBytes)}</strong></div><ProgressBar percent={diskPercent} /></div>
              <p className="text-sm text-muted-foreground">{t('nodeDetail.resources.sampledAt', { at: formatDate(snapshot.sampledAt) })}</p>
            </div>
          )}
        </section>
      </div>
      <section className="panel" data-testid="node-resource-history">
        <div className="panel-head"><div><h2>{t('nodeDetail.history.title')}</h2><p>{t('nodeDetail.history.description')}</p></div>
          <Tabs value={String(historyWindow)} onValueChange={(value) => setHistoryWindow(Number(value))}>
            <TabsList aria-label={t('nodeDetail.history.aria')}>
              {[1, 6, 24].map((hours) => <TabsTrigger key={hours} value={String(hours)}>{t('nodeDetail.history.hours', { hours })}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </div>
        {!history?.length ? <EmptyState icon="activity" title={t('nodeDetail.history.empty.title')} description={t('nodeDetail.history.empty.description')} /> : (
          <div className="resource-history">
            {/* B4.2: no axis meant 3% and 100% drew the same picture - a flat line at the bottom
                of a box with nothing to read it against. The 0-100% scale is printed beside the
                plot and drawn as three gridlines, and the window's own two stamps sit under it,
                so the plot answers how full and when instead of some shape. */}
            <div className="resource-history-plot">
              <div className="resource-history-axis" aria-hidden="true">
                <span>100%</span>
                <span>50%</span>
                <span>0%</span>
              </div>
              <svg viewBox="0 0 400 80" role="img" aria-label={t('nodeDetail.history.chartAria')} preserveAspectRatio="none">
                <g className="resource-history-grid" aria-hidden="true">
                  <line x1="0" y1="0.5" x2="400" y2="0.5" />
                  <line x1="0" y1="40" x2="400" y2="40" />
                  <line x1="0" y1="79.5" x2="400" y2="79.5" />
                </g>
                {historySegments(history).map((points, index) => <polyline key={index} fill="none" stroke="var(--accent, #4f8cff)" strokeWidth="2" points={points} vectorEffect="non-scaling-stroke" />)}
              </svg>
            </div>
            <p className="resource-history-axis-time">
              <span>{formatDate(history[0].observedAt)}</span>
              <span>{formatDate(history[history.length - 1].observedAt)}</span>
            </p>
            <p className="text-sm text-muted-foreground">{t(history.length === 1 ? 'nodeDetail.history.one' : 'nodeDetail.history.many', { count: history.length, at: formatDate(history[0].observedAt) })} · {t('nodeDetail.generation', { generation: history[0].generation })}</p>
            <Table className={stackTable}>
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('table.observed')}</TableHead>
                  <TableHead>{t('table.cpu')}</TableHead>
                  <TableHead>{t('table.memory')}</TableHead>
                  <TableHead>{t('table.filesystem')}</TableHead>
                  {/* §2.2: a node's generation does not change inside a sample window, so the column
                      answered the same value twelve times (measured ratio 0.08). It is stated once,
                      in the caption above the chart, where it belongs. */}
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {history.slice(0, 20).map((sample) => (
                  <TableRow key={sample.sampleId}>
                    <StackCell label={t('table.observed')}>{formatDate(sample.observedAt)}</StackCell>
                    <StackCell label={t('table.cpu')}>{typeof sample.cpuUtilization === 'number' ? `${(sample.cpuUtilization * 100).toFixed(0)}%` : <NoData detail={t('nodes.resource.missingSnapshot')} />}</StackCell>
                    <StackCell label={t('table.memory')}>{formatBytes(sample.memoryUsedBytes)} / {formatBytes(sample.memoryTotalBytes)}</StackCell>
                    <StackCell label={t('table.filesystem')}>{formatBytes(sample.filesystemUsedBytes)} / {formatBytes(sample.filesystemTotalBytes)}</StackCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      <section className="panel table-panel">
        <div className="panel-head"><div><h2>{t('nodeDetail.instances.title')}</h2><p>{t('nodeDetail.instances.description')}</p></div></div>
        {!instances?.length ? <EmptyState icon="plugins" title={t('nodeDetail.instances.empty.title')} description={t('nodeDetail.instances.empty.description')} /> : (
          <Table className={stackTable}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                {/* §2.2 caps a table at five columns at 1024+. Slot and restarts are one value
                    each (a slot number, a small count) and they qualify the instance, so they ride
                    the plugin name's second line instead of spending two of the seven. */}
                <TableHead>{t('table.plugin')}</TableHead>
                <TableHead>{t('table.version')}</TableHead>
                <TableHead>{t('table.state')}</TableHead>
                <TableHead>{t('table.container')}</TableHead>
                <TableHead>{t('table.logs')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {instances.map((instance) => (
                <TableRow key={instance.id}>
                  <StackCell label={t('table.plugin')}>
                    <div className="ow-cell">
                      <span className="mono ow-cell-value">{instance.pluginId}</span>
                      <span className="ow-cell-meta">{t('table.slot')} #{instance.slot} · {t('table.restarts')} {instance.restartCount}</span>
                    </div>
                  </StackCell>
                  <StackCell label={t('table.version')}>{instance.version}</StackCell>
                  <StackCell label={t('table.state')}><StatusPill status={instance.state} /></StackCell>
                  <StackCell label={t('table.container')}><span className="mono text-sm">{instance.containerId ? instance.containerId.slice(0, 12) : '—'}</span></StackCell>
                  <StackCell label={t('table.logs')}><Link className="text-link" to={`/admin/instances/${instance.id}/logs`}><Icon name="logs" size={14} /> {t('table.live')}</Link></StackCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>{t('nodeDetail.events.title')}</h2><p>{t('nodeDetail.events.description')}</p></div></div>
        {!events?.length ? <EmptyState icon="activity" title={t('nodeDetail.events.empty.title')} /> : <ul className="event-list">{events.map((event) => <li key={event.id}><div className="event-marker"><Icon name={event.result === 'REJECTED' ? 'warning' : 'check'} size={13} /></div><div className="event-copy"><div className="event-title"><strong>{event.eventType}</strong><StatusPill status={event.result} /></div><p>{event.action}</p></div><TimeAgo value={event.occurredAt} /></li>)}</ul>}
      </section>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent closeLabel={t('aria.closeDialog')} className="max-w-[480px]">
          <DialogHeader><DialogTitle>{t('nodeDetail.confirmRevoke.title', { name: data.name })}</DialogTitle></DialogHeader>
          <div className="text-[var(--ow-text-secondary)] leading-relaxed">{t('nodeDetail.confirmRevoke.description')}</div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirm(false)} disabled={busy}>{t('action.cancel')}</Button>
            <Button variant="destructive" onClick={() => void revoke()} disabled={busy}>{busy ? t('action.working') : t('nodeDetail.confirmRevoke.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function historySegments(history: any[]) {
  const ordered = history.slice().reverse().filter((sample) => sample.cpuUtilization !== null && sample.cpuUtilization !== undefined);
  if (ordered.length === 0) return [] as string[];
  const start = new Date(ordered[0].observedAt).getTime();
  const end = new Date(ordered[ordered.length - 1].observedAt).getTime();
  const span = Math.max(1, end - start);
  const segments: string[] = [];
  let current: string[] = [];
  let previous: any = null;
  for (const sample of ordered) {
    const at = new Date(sample.observedAt).getTime();
    const gap = previous ? at - new Date(previous.observedAt).getTime() : 0;
    if (previous && (gap > 5 * 60_000 || sample.generation !== previous.generation)) {
      if (current.length > 0) segments.push(current.join(' '));
      current = [];
    }
    const x = ((at - start) / span) * 400;
    const y = 80 - Math.min(1, Math.max(0, sample.cpuUtilization)) * 72;
    current.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    previous = sample;
  }
  if (current.length > 0) segments.push(current.join(' '));
  return segments;
}

/** Tailwind replacement for the page-local .bar/.bar-fill pair; the width stays a runtime style. */
function ProgressBar({ percent }: { percent: number | null }) {
  return (
    <div className="h-[5px] overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
      <div className="h-full rounded-[inherit] bg-primary" style={{ width: percent === null ? '0%' : `${Math.min(100, Math.max(0, percent * 100))}%` }} />
    </div>
  );
}
