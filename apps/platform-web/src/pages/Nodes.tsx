import React, { useEffect, useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { usePolling } from '../hooks';
import type { AuditEvent, NodeView } from '../types';
import { Icon } from '../components/Icons';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { CopyButton, EmptyState, ErrorState, KV, PageHeader, Skeleton, TimeAgo, useToast } from '../components/Ui';
import { formatBytes, formatDate } from '../format';
import { useT } from '../i18n';
import { cn } from '../lib/utils';
import { STATUS_MAP, badgeVariantForTone, glyphForTone } from '../components/status-tone';

/** Replaces the legacy .status pill: a Badge, the same glyph, the same localized label. */
function StatusPill({ status }: { status: string }) {
  const t = useT();
  const code = status?.toUpperCase();
  const known = code ? STATUS_MAP[code] : undefined;
  const tone = known?.tone ?? 'unknown';
  // A code the shared mapping does not know is protocol data, not copy: render it verbatim.
  const text = known ? t(known.labelKey) : status || t('status.unknown');
  return (
    <Badge variant={badgeVariantForTone(tone)} data-status={code || undefined} className={cn(!known && 'border-dashed')}>
      <Icon name={glyphForTone(tone)} size={12} />
      {text}
    </Badge>
  );
}

// The legacy .data-table card layout at <=760px (thead hidden, one row per node) keyed off
// the .data-table selector; these constants carry the same breakpoint as Tailwind variants so
// the tables no longer need that selector at all.
const stackTable = 'max-[760px]:block';
const stackHead = 'max-[760px]:hidden';
const stackBody = 'max-[760px]:block';
const stackRow = 'max-[760px]:flex max-[760px]:flex-col max-[760px]:px-1 max-[760px]:py-2.5';
const stackCell =
  'max-[760px]:flex max-[760px]:items-start max-[760px]:justify-between max-[760px]:gap-3.5 ' +
  'max-[760px]:border-0 max-[760px]:px-3.5 max-[760px]:py-[5px] max-[760px]:text-right';
const stackLabel = 'hidden text-muted-foreground max-[760px]:inline';

/** Table cell that keeps its data-label and prints that label inline only in the stacked layout. */
function StackCell({ label, className, children, ...props }: React.TdHTMLAttributes<HTMLTableCellElement> & { label: string }) {
  return (
    <TableCell data-label={label} className={cn(stackCell, className)} {...props}>
      <span className={stackLabel}>{label}</span>
      {children}
    </TableCell>
  );
}

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
  const { data, error, loading, reload } = usePolling(() => api.get<NodeView[]>('/api/v1/nodes'), 5000);
  const { user } = useAuth();
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
  const nodes = data || [];

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

  return (
    <div className="page-stack">
      <PageHeader
        title={t('page.nodes')}
        description={t('nodes.description')}
        actions={<><Button variant="secondary" className="max-[760px]:flex-1" onClick={() => void reload()}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button><Button className="max-[760px]:flex-1" onClick={() => setJoinOpen(true)} disabled={user?.role !== 'admin'} title={user?.role !== 'admin' ? t('nodes.join.adminRequired') : ''}><Icon name="plus" size={15} /> {t('nodes.join.action')}</Button></>}
      />
      {loading && !data ? <Skeleton rows={5} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : nodes.length === 0 ? (
        <EmptyState icon="nodes" title={t('nodes.empty.title')} description={t('nodes.empty.description')} action={<Button onClick={() => setJoinOpen(true)} disabled={user?.role !== 'admin'}>{t('nodes.empty.action')}</Button>} />
      ) : (
        <section className="panel table-panel">
          <Table className={cn('nodes-table', stackTable)}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('table.node')}</TableHead>
                <TableHead>{t('table.status')}</TableHead>
                <TableHead>{t('table.identity')}</TableHead>
                <TableHead>{t('table.instances')}</TableHead>
                <TableHead>{t('table.memory')}</TableHead>
                <TableHead>{t('table.lastHeartbeat')}</TableHead>
                <TableHead aria-label={t('table.open')} />
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {nodes.map((node) => (
                <TableRow key={node.id} className={cn('cursor-pointer focus-visible:outline-offset-[-2px]', stackRow)} onClick={() => navigate(`/nodes/${node.id}`)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') navigate(`/nodes/${node.id}`); }}>
                  <StackCell label={t('table.node')}><div className="entity-cell"><span className="entity-icon"><Icon name="server" size={17} /></span><div><strong>{node.name}</strong><span className="mono">{node.id.slice(0, 13)}…</span></div></div></StackCell>
                  <StackCell label={t('table.status')}><StatusPill status={node.status} />{node.stale && <div className="mt-[3px] text-sm text-warning">{t('table.lastObserved')} <TimeAgo value={node.lastSeenAt} /></div>}</StackCell>
                  <StackCell label={t('table.identity')}><span className="mono text-sm">{node.os}/{node.arch}</span><div className="text-sm text-muted-foreground">{t('nodes.table.generation', { generation: node.generation })}</div></StackCell>
                  <StackCell label={t('table.instances')}><strong>{node.instancesReady}/{node.instancesTotal}</strong><span className="text-sm text-muted-foreground"> READY</span></StackCell>
                  <StackCell label={t('table.memory')}>{node.resourceSnapshot?.memoryTotalBytes ? <><strong>{formatBytes(node.resourceSnapshot.memoryUsedBytes)}</strong><span className="text-sm text-muted-foreground"> / {formatBytes(node.resourceSnapshot.memoryTotalBytes)}</span></> : <span className="text-muted-foreground">{t('common.noData')}</span>}</StackCell>
                  <StackCell label={t('table.lastHeartbeat')}><TimeAgo value={node.lastSeenAt} /></StackCell>
                  <TableCell className="w-8 text-right text-muted-foreground max-[760px]:hidden"><Icon name="chevron" size={16} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      <div className="info-grid">
        <div className="callout"><Icon name="access" size={16} /><p>{t('nodes.credentialsNote')}</p></div>
        <div className="callout"><Icon name="alert" size={16} /><p>{t('nodes.staleNote.before')} <strong>UNREACHABLE</strong>{t('nodes.staleNote.after')}</p></div>
      </div>

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
      await api.del(`/api/v1/nodes/${id}`);
      toast.push({ tone: 'ok', title: t('nodeDetail.revoked.title'), detail: t('nodeDetail.revoked.detail') });
      await reload();
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
        actions={<><Button variant="secondary" className="max-[760px]:flex-1" onClick={() => { void reload(); void reloadInstances(); }}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>{user?.role === 'admin' && <Button variant="destructive" className="max-[760px]:flex-1" onClick={() => setConfirm(true)}><Icon name="trash" size={15} /> {t('action.revoke')}</Button>}</>}
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
              <div><div className="resource-row"><span>{t('nodeDetail.resource.cpuUtilization')}</span><strong>{snapshot.cpuUtilization === null || snapshot.cpuUtilization === undefined ? t('common.noData') : `${(snapshot.cpuUtilization * 100).toFixed(0)}%`}</strong></div><ProgressBar percent={snapshot.cpuUtilization ?? null} /></div>
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
            <svg viewBox="0 0 400 80" role="img" aria-label={t('nodeDetail.history.chartAria')} preserveAspectRatio="none">
              {historySegments(history).map((points, index) => <polyline key={index} fill="none" stroke="var(--accent, #4f8cff)" strokeWidth="2" points={points} />)}
            </svg>
            <p className="text-sm text-muted-foreground">{t(history.length === 1 ? 'nodeDetail.history.one' : 'nodeDetail.history.many', { count: history.length, at: formatDate(history[0].observedAt) })} · {t('nodeDetail.generation', { generation: history[0].generation })}</p>
            <Table className={stackTable}>
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('table.observed')}</TableHead>
                  <TableHead>{t('table.cpu')}</TableHead>
                  <TableHead>{t('table.memory')}</TableHead>
                  <TableHead>{t('table.filesystem')}</TableHead>
                  <TableHead>{t('table.generation')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {history.slice(0, 20).map((sample) => (
                  <TableRow key={sample.sampleId}>
                    <StackCell label={t('table.observed')}>{formatDate(sample.observedAt)}</StackCell>
                    <StackCell label={t('table.cpu')}>{sample.cpuUtilization === null ? t('common.noData') : `${(sample.cpuUtilization * 100).toFixed(0)}%`}</StackCell>
                    <StackCell label={t('table.memory')}>{formatBytes(sample.memoryUsedBytes)} / {formatBytes(sample.memoryTotalBytes)}</StackCell>
                    <StackCell label={t('table.filesystem')}>{formatBytes(sample.filesystemUsedBytes)} / {formatBytes(sample.filesystemTotalBytes)}</StackCell>
                    <StackCell label={t('table.generation')}>{sample.generation}</StackCell>
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
                <TableHead>{t('table.plugin')}</TableHead>
                <TableHead>{t('table.version')}</TableHead>
                <TableHead>{t('table.slot')}</TableHead>
                <TableHead>{t('table.state')}</TableHead>
                <TableHead>{t('table.container')}</TableHead>
                <TableHead>{t('table.restarts')}</TableHead>
                <TableHead>{t('table.logs')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {instances.map((instance) => (
                <TableRow key={instance.id}>
                  <StackCell label={t('table.plugin')}><span className="mono">{instance.pluginId}</span></StackCell>
                  <StackCell label={t('table.version')}>{instance.version}</StackCell>
                  <StackCell label={t('table.slot')}>#{instance.slot}</StackCell>
                  <StackCell label={t('table.state')}><StatusPill status={instance.state} /></StackCell>
                  <StackCell label={t('table.container')}><span className="mono text-sm">{instance.containerId ? instance.containerId.slice(0, 12) : '—'}</span></StackCell>
                  <StackCell label={t('table.restarts')}>{instance.restartCount}</StackCell>
                  <StackCell label={t('table.logs')}><Link className="text-link" to={`/instances/${instance.id}/logs`}><Icon name="logs" size={14} /> {t('table.live')}</Link></StackCell>
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
