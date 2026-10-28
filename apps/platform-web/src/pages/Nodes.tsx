import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { usePolling } from '../hooks';
import type { AuditEvent, NodeView } from '../types';
import { Icon } from '../components/Icons';
import { ConfirmDialog, CopyButton, EmptyState, ErrorState, Field, KV, Modal, PageHeader, Skeleton, StatusBadge, TimeAgo, useToast } from '../components/Ui';
import { formatBytes, formatDate } from '../format';
import { useT } from '../i18n';

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
        actions={<><button className="btn btn-secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> {t('action.refresh')}</button><button className="btn btn-primary" onClick={() => setJoinOpen(true)} disabled={user?.role !== 'admin'} title={user?.role !== 'admin' ? t('nodes.join.adminRequired') : ''}><Icon name="plus" size={15} /> {t('nodes.join.action')}</button></>}
      />
      {loading && !data ? <Skeleton rows={5} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : nodes.length === 0 ? (
        <EmptyState icon="nodes" title={t('nodes.empty.title')} description={t('nodes.empty.description')} action={<button className="btn btn-primary" onClick={() => setJoinOpen(true)} disabled={user?.role !== 'admin'}>{t('nodes.empty.action')}</button>} />
      ) : (
        <section className="panel table-panel">
          <table className="data-table nodes-table">
            <thead><tr><th>{t('table.node')}</th><th>{t('table.status')}</th><th>{t('table.identity')}</th><th>{t('table.instances')}</th><th>{t('table.memory')}</th><th>{t('table.lastHeartbeat')}</th><th aria-label={t('table.open')} /></tr></thead>
            <tbody>{nodes.map((node) => (
              <tr key={node.id} className="clickable" onClick={() => navigate(`/nodes/${node.id}`)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') navigate(`/nodes/${node.id}`); }}>
                <td data-label={t('table.node')}><div className="entity-cell"><span className="entity-icon"><Icon name="server" size={17} /></span><div><strong>{node.name}</strong><span className="mono">{node.id.slice(0, 13)}…</span></div></div></td>
                <td data-label={t('table.status')}><StatusBadge status={node.status} />{node.stale && <div className="inline-hint text-warn">{t('table.lastObserved')} <TimeAgo value={node.lastSeenAt} /></div>}</td>
                <td data-label={t('table.identity')}><span className="mono small">{node.os}/{node.arch}</span><div className="muted small">{t('nodes.table.generation', { generation: node.generation })}</div></td>
                <td data-label={t('table.instances')}><strong>{node.instancesReady}/{node.instancesTotal}</strong><span className="muted small"> READY</span></td>
                <td data-label={t('table.memory')}>{node.resourceSnapshot?.memoryTotalBytes ? <><strong>{formatBytes(node.resourceSnapshot.memoryUsedBytes)}</strong><span className="muted small"> / {formatBytes(node.resourceSnapshot.memoryTotalBytes)}</span></> : <span className="muted">{t('common.noData')}</span>}</td>
                <td data-label={t('table.lastHeartbeat')}><TimeAgo value={node.lastSeenAt} /></td>
                <td className="row-action"><Icon name="chevron" size={16} /></td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}
      <div className="info-grid">
        <div className="callout"><Icon name="access" size={16} /><p>{t('nodes.credentialsNote')}</p></div>
        <div className="callout"><Icon name="alert" size={16} /><p>{t('nodes.staleNote.before')} <strong>UNREACHABLE</strong>{t('nodes.staleNote.after')}</p></div>
      </div>

      <Modal open={joinOpen} onClose={() => { setJoinOpen(false); setToken(null); setShowToken(false); }} title={t('nodes.join.title')} size="large" footer={<><button className="btn btn-secondary" onClick={() => { setJoinOpen(false); setToken(null); }}>{t('action.close')}</button>{!token && <button className="btn btn-primary" onClick={() => void createToken()} disabled={busy}>{busy ? t('nodes.join.creating') : t('nodes.join.submit')}</button>}</>}>
        <div className="form-stack">
          {!token ? (
            <>
              <div className="callout"><Icon name="key" size={16} /><p>{t('nodes.join.note')}</p></div>
              <div className="form-grid">
                <Field label={t('nodes.join.field.label')} hint={t('nodes.join.field.label.hint')}><input value={label} onChange={(event) => setLabel(event.target.value)} /></Field>
                <Field label={t('nodes.join.field.ttl')}><input type="number" min={5} max={1440} value={ttl} onChange={(event) => setTtl(Number(event.target.value))} /></Field>
              </div>
              {joinError && <div className="inline-error"><Icon name="warning" size={16} /> {joinError}</div>}
              <div className="command-block"><span className="command-label">{t('nodes.join.commandLabel')}</span><pre>{`export OPSWEAVE_KERNEL_URL=http://<kernel-host>:18181
export OPSWEAVE_ENROLLMENT_TOKEN=<token>
export OPSWEAVE_NODE_NAME=node-a
export OPSWEAVE_NODE_LABELS=role=node,zone=lab
export OPSWEAVE_DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
opsweave-node`}</pre><CopyButton value={`export OPSWEAVE_KERNEL_URL=http://<kernel-host>:18181\nexport OPSWEAVE_ENROLLMENT_TOKEN=<token>\nexport OPSWEAVE_NODE_NAME=node-a\nexport OPSWEAVE_NODE_LABELS=role=node,zone=lab\nexport OPSWEAVE_DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock\nopsweave-node`} /></div>
            </>
          ) : (
            <>
              <div className="callout callout-ok"><Icon name="check" size={16} /><p>{t('nodes.join.created', { expiresAt: formatDate(token.expiresAt) })}</p></div>
              <Field label={t('nodes.join.tokenLabel')} hint={t('nodes.join.tokenHint')}><div className="secret-row"><input readOnly type={showToken ? 'text' : 'password'} value={token.token} /><button className="btn btn-small" onClick={() => setShowToken(!showToken)}>{showToken ? t('action.hide') : t('action.reveal')}</button><CopyButton value={token.token} label={t('nodes.join.copyToken')} /></div></Field>
            </>
          )}
        </div>
      </Modal>
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
        actions={<><button className="btn btn-secondary" onClick={() => { void reload(); void reloadInstances(); }}><Icon name="refresh" size={15} /> {t('action.refresh')}</button>{user?.role === 'admin' && <button className="btn btn-danger" onClick={() => setConfirm(true)}><Icon name="trash" size={15} /> {t('action.revoke')}</button>}</>}
      />
      <div className="detail-meta"><StatusBadge status={data.status} />{data.stale && <span className="meta-chip text-warn"><Icon name="warning" size={13} /> {t('nodeDetail.staleSince')} <TimeAgo value={data.lastSeenAt} /></span>}<span className="meta-chip"><Icon name="clock" size={13} /> {t('nodeDetail.enrolled', { at: formatDate(data.enrolledAt) })}</span><span className="meta-chip"><Icon name="server" size={13} /> {data.runtimeAdapterVersion || t('nodeDetail.adapterUnknown')}</span></div>
      <div className="summary-grid">
        <section className="panel">
          <div className="panel-head"><div><h2>{t('nodeDetail.control.title')}</h2><p>{t('nodeDetail.control.description')}</p></div></div>
          <div className="kv-grid">
            <KV label={t('table.status')}><StatusBadge status={data.status} /></KV>
            <KV label={t('table.lastObserved')}><TimeAgo value={data.lastSeenAt} /> <span className="muted small">{data.lastSeenAt ? formatDate(data.lastSeenAt) : ''}</span></KV>
            <KV label={t('table.generation')}>{data.generation}</KV>
            <KV label={t('nodeDetail.field.dataEndpoint')} mono>{data.dataEndpoint || t('nodeDetail.notRegistered')}</KV>
            <KV label={t('common.capabilities')}>{(data.capabilities || []).join(', ') || '—'}</KV>
            <KV label={t('nodeDetail.field.labels')}>{(Object.entries(data.labels || {}).map(([k, v]) => `${k}=${v}`).join(', ')) || '—'}</KV>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>{t('nodeDetail.resources.title')}</h2><p>{t('nodeDetail.resources.description')}</p></div></div>
          {!snapshot ? <p className="muted pad">{t('nodeDetail.resources.empty')}</p> : (
            <div className="resource-stack">
              <div><div className="resource-row"><span>{t('nodeDetail.resource.cpuUtilization')}</span><strong>{snapshot.cpuUtilization === null || snapshot.cpuUtilization === undefined ? t('common.noData') : `${(snapshot.cpuUtilization * 100).toFixed(0)}%`}</strong></div><ProgressBar percent={snapshot.cpuUtilization ?? null} /></div>
              <div><div className="resource-row"><span>{t('table.memory')}</span><strong>{formatBytes(snapshot.memoryUsedBytes)} / {formatBytes(snapshot.memoryTotalBytes)}</strong></div><ProgressBar percent={memoryPercent} /></div>
              <div><div className="resource-row"><span>{t('table.filesystem')}</span><strong>{formatBytes(snapshot.filesystemUsedBytes)} / {formatBytes(snapshot.filesystemTotalBytes)}</strong></div><ProgressBar percent={diskPercent} /></div>
              <p className="muted small">{t('nodeDetail.resources.sampledAt', { at: formatDate(snapshot.sampledAt) })}</p>
            </div>
          )}
        </section>
      </div>
      <section className="panel" data-testid="node-resource-history">
        <div className="panel-head"><div><h2>{t('nodeDetail.history.title')}</h2><p>{t('nodeDetail.history.description')}</p></div><div className="segmented" aria-label={t('nodeDetail.history.aria')}>{[1, 6, 24].map((hours) => <button key={hours} className={`btn btn-small ${historyWindow === hours ? 'active' : ''}`} onClick={() => setHistoryWindow(hours)}>{t('nodeDetail.history.hours', { hours })}</button>)}</div></div>
        {!history?.length ? <EmptyState icon="activity" title={t('nodeDetail.history.empty.title')} description={t('nodeDetail.history.empty.description')} /> : (
          <div className="resource-history">
            <svg viewBox="0 0 400 80" role="img" aria-label={t('nodeDetail.history.chartAria')} preserveAspectRatio="none">
              {historySegments(history).map((points, index) => <polyline key={index} fill="none" stroke="var(--accent, #4f8cff)" strokeWidth="2" points={points} />)}
            </svg>
            <p className="muted small">{t(history.length === 1 ? 'nodeDetail.history.one' : 'nodeDetail.history.many', { count: history.length, at: formatDate(history[0].sampledAt) })} · {t('nodeDetail.generation', { generation: history[0].generation })}</p>
            <table className="data-table"><thead><tr><th>{t('table.observed')}</th><th>{t('table.cpu')}</th><th>{t('table.memory')}</th><th>{t('table.filesystem')}</th><th>{t('table.generation')}</th></tr></thead><tbody>{history.slice(0, 20).map((sample) => <tr key={sample.sampleId}><td data-label={t('table.observed')}>{formatDate(sample.observedAt)}</td><td data-label={t('table.cpu')}>{sample.cpuUtilization === null ? t('common.noData') : `${(sample.cpuUtilization * 100).toFixed(0)}%`}</td><td data-label={t('table.memory')}>{formatBytes(sample.memoryUsedBytes)} / {formatBytes(sample.memoryTotalBytes)}</td><td data-label={t('table.filesystem')}>{formatBytes(sample.filesystemUsedBytes)} / {formatBytes(sample.filesystemTotalBytes)}</td><td data-label={t('table.generation')}>{sample.generation}</td></tr>)}</tbody></table>
          </div>
        )}
      </section>
      <section className="panel table-panel">
        <div className="panel-head"><div><h2>{t('nodeDetail.instances.title')}</h2><p>{t('nodeDetail.instances.description')}</p></div></div>
        {!instances?.length ? <EmptyState icon="plugins" title={t('nodeDetail.instances.empty.title')} description={t('nodeDetail.instances.empty.description')} /> : (
          <table className="data-table"><thead><tr><th>{t('table.plugin')}</th><th>{t('table.version')}</th><th>{t('table.slot')}</th><th>{t('table.state')}</th><th>{t('table.container')}</th><th>{t('table.restarts')}</th><th>{t('table.logs')}</th></tr></thead><tbody>
            {instances.map((instance) => <tr key={instance.id}><td data-label={t('table.plugin')}><span className="mono">{instance.pluginId}</span></td><td data-label={t('table.version')}>{instance.version}</td><td data-label={t('table.slot')}>#{instance.slot}</td><td data-label={t('table.state')}><StatusBadge status={instance.state} /></td><td data-label={t('table.container')}><span className="mono small">{instance.containerId ? instance.containerId.slice(0, 12) : '—'}</span></td><td data-label={t('table.restarts')}>{instance.restartCount}</td><td data-label={t('table.logs')}><Link className="text-link" to={`/instances/${instance.id}/logs`}><Icon name="logs" size={14} /> {t('table.live')}</Link></td></tr>)}
          </tbody></table>
        )}
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>{t('nodeDetail.events.title')}</h2><p>{t('nodeDetail.events.description')}</p></div></div>
        {!events?.length ? <EmptyState icon="activity" title={t('nodeDetail.events.empty.title')} /> : <ul className="event-list">{events.map((event) => <li key={event.id}><div className="event-marker"><Icon name={event.result === 'REJECTED' ? 'warning' : 'check'} size={13} /></div><div className="event-copy"><div className="event-title"><strong>{event.eventType}</strong><StatusBadge status={event.result} /></div><p>{event.action}</p></div><TimeAgo value={event.occurredAt} /></li>)}</ul>}
      </section>
      <ConfirmDialog open={confirm} title={t('nodeDetail.confirmRevoke.title', { name: data.name })} description={t('nodeDetail.confirmRevoke.description')} confirmLabel={t('nodeDetail.confirmRevoke.confirm')} danger busy={busy} onConfirm={() => void revoke()} onClose={() => setConfirm(false)} />
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

function ProgressBar({ percent }: { percent: number | null }) {
  return <div className="bar" aria-hidden="true"><div className="bar-fill" style={{ width: percent === null ? '0%' : `${Math.min(100, Math.max(0, percent * 100))}%` }} /></div>;
}
