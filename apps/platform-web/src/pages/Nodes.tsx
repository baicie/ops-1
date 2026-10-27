import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { usePolling } from '../hooks';
import type { AuditEvent, NodeView } from '../types';
import { Icon } from '../components/Icons';
import { ConfirmDialog, CopyButton, EmptyState, ErrorState, Field, KV, Modal, PageHeader, Skeleton, StatusBadge, TimeAgo, useToast } from '../components/Ui';
import { formatBytes, formatDate } from '../format';

export function NodesPage() {
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
        title="Nodes"
        description="A node heartbeat proves control reachability. It does not prove plugin readiness."
        actions={<><button className="btn btn-secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> Refresh</button><button className="btn btn-primary" onClick={() => setJoinOpen(true)} disabled={user?.role !== 'admin'} title={user?.role !== 'admin' ? 'Admin role required' : ''}><Icon name="plus" size={15} /> Join node</button></>}
      />
      {loading && !data ? <Skeleton rows={5} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : nodes.length === 0 ? (
        <EmptyState icon="nodes" title="No nodes enrolled" description="Create a one-time enrollment token, run the Node Runtime on a Linux host with Rootless Docker, and verify the data proxy endpoint." action={<button className="btn btn-primary" onClick={() => setJoinOpen(true)} disabled={user?.role !== 'admin'}>Join first node</button>} />
      ) : (
        <section className="panel table-panel">
          <table className="data-table nodes-table">
            <thead><tr><th>Node</th><th>Status</th><th>Identity</th><th>Instances</th><th>Memory</th><th>Last heartbeat</th><th aria-label="Open" /></tr></thead>
            <tbody>{nodes.map((node) => (
              <tr key={node.id} className="clickable" onClick={() => navigate(`/nodes/${node.id}`)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') navigate(`/nodes/${node.id}`); }}>
                <td data-label="Node"><div className="entity-cell"><span className="entity-icon"><Icon name="server" size={17} /></span><div><strong>{node.name}</strong><span className="mono">{node.id.slice(0, 13)}…</span></div></div></td>
                <td data-label="Status"><StatusBadge status={node.status} />{node.stale && <div className="inline-hint text-warn">Last observed <TimeAgo value={node.lastSeenAt} /></div>}</td>
                <td data-label="Identity"><span className="mono small">{node.os}/{node.arch}</span><div className="muted small">gen {node.generation}</div></td>
                <td data-label="Instances"><strong>{node.instancesReady}/{node.instancesTotal}</strong><span className="muted small"> READY</span></td>
                <td data-label="Memory">{node.resourceSnapshot?.memoryTotalBytes ? <><strong>{formatBytes(node.resourceSnapshot.memoryUsedBytes)}</strong><span className="muted small"> / {formatBytes(node.resourceSnapshot.memoryTotalBytes)}</span></> : <span className="muted">No data</span>}</td>
                <td data-label="Last heartbeat"><TimeAgo value={node.lastSeenAt} /></td>
                <td className="row-action"><Icon name="chevron" size={16} /></td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      )}
      <div className="info-grid">
        <div className="callout"><Icon name="access" size={16} /><p>Node credentials are one-time enrolled and separately revocable. They are not user sessions and cannot act as one.</p></div>
        <div className="callout"><Icon name="alert" size={16} /><p>A stale heartbeat becomes <strong>UNREACHABLE</strong>; the platform preserves the last observation instead of claiming the process stopped.</p></div>
      </div>

      <Modal open={joinOpen} onClose={() => { setJoinOpen(false); setToken(null); setShowToken(false); }} title="Join a Linux node" size="large" footer={<><button className="btn btn-secondary" onClick={() => { setJoinOpen(false); setToken(null); }}>Close</button>{!token && <button className="btn btn-primary" onClick={() => void createToken()} disabled={busy}>{busy ? 'Creating…' : 'Create enrollment token'}</button>}</>}>
        <div className="form-stack">
          {!token ? (
            <>
              <div className="callout"><Icon name="key" size={16} /><p>Enrollment tokens are one-time, short-lived and never written to the audit log. The Node stores its credential locally with mode 0600.</p></div>
              <div className="form-grid">
                <Field label="Token label" hint="For operators, never a secret"><input value={label} onChange={(event) => setLabel(event.target.value)} /></Field>
                <Field label="Valid for (minutes)"><input type="number" min={5} max={1440} value={ttl} onChange={(event) => setTtl(Number(event.target.value))} /></Field>
              </div>
              {joinError && <div className="inline-error"><Icon name="warning" size={16} /> {joinError}</div>}
              <div className="command-block"><span className="command-label">Run on the Linux node after installing the Node Runtime</span><pre>{`export OPSWEAVE_KERNEL_URL=http://<kernel-host>:18181
export OPSWEAVE_ENROLLMENT_TOKEN=<token>
export OPSWEAVE_NODE_NAME=node-a
export OPSWEAVE_NODE_LABELS=role=node,zone=lab
export OPSWEAVE_DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock
opsweave-node`}</pre><CopyButton value={`export OPSWEAVE_KERNEL_URL=http://<kernel-host>:18181\nexport OPSWEAVE_ENROLLMENT_TOKEN=<token>\nexport OPSWEAVE_NODE_NAME=node-a\nexport OPSWEAVE_NODE_LABELS=role=node,zone=lab\nexport OPSWEAVE_DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock\nopsweave-node`} /></div>
            </>
          ) : (
            <>
              <div className="callout callout-ok"><Icon name="check" size={16} /><p>Token created. It expires at {formatDate(token.expiresAt)} and can be redeemed once.</p></div>
              <Field label="One-time enrollment token" hint="Copy now. It is not available again."><div className="secret-row"><input readOnly type={showToken ? 'text' : 'password'} value={token.token} /><button className="btn btn-small" onClick={() => setShowToken(!showToken)}>{showToken ? 'Hide' : 'Reveal'}</button><CopyButton value={token.token} label="Copy token" /></div></Field>
            </>
          )}
        </div>
      </Modal>
    </div>
  );
}

export function NodeDetailPage() {
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

  if (loading && !data) return <><PageHeader title="Node" /><Skeleton rows={6} /></>;
  if (error) return <><PageHeader title="Node" /><ErrorState error={error} onRetry={() => void reload()} /></>;
  if (!data) return null;
  const snapshot = data.resourceSnapshot;
  const memoryPercent = snapshot?.memoryUsedBytes && snapshot?.memoryTotalBytes ? snapshot.memoryUsedBytes / snapshot.memoryTotalBytes : null;
  const diskPercent = snapshot?.filesystemUsedBytes && snapshot?.filesystemTotalBytes ? snapshot.filesystemUsedBytes / snapshot.filesystemTotalBytes : null;

  async function revoke() {
    setBusy(true);
    try {
      await api.del(`/api/v1/nodes/${id}`);
      toast.push({ tone: 'ok', title: 'Node credential revoked', detail: 'New deployments and reports are rejected.' });
      await reload();
    } catch (cause: any) {
      toast.push({ tone: 'danger', title: 'Revoke failed', detail: cause.message });
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Node identity · control channel"
        title={data.name}
        description={<><span className="mono">{data.id}</span> · generation {data.generation} · {data.os}/{data.arch}</>}
        actions={<><button className="btn btn-secondary" onClick={() => { void reload(); void reloadInstances(); }}><Icon name="refresh" size={15} /> Refresh</button>{user?.role === 'admin' && <button className="btn btn-danger" onClick={() => setConfirm(true)}><Icon name="trash" size={15} /> Revoke</button>}</>}
      />
      <div className="detail-meta"><StatusBadge status={data.status} />{data.stale && <span className="meta-chip text-warn"><Icon name="warning" size={13} /> Stale since <TimeAgo value={data.lastSeenAt} /></span>}<span className="meta-chip"><Icon name="clock" size={13} /> Enrolled {formatDate(data.enrolledAt)}</span><span className="meta-chip"><Icon name="server" size={13} /> {data.runtimeAdapterVersion || 'adapter unknown'}</span></div>
      <div className="summary-grid">
        <section className="panel">
          <div className="panel-head"><div><h2>Control channel</h2><p>Node-initiated, authenticated heartbeat and desired-state pull.</p></div></div>
          <div className="kv-grid">
            <KV label="Status"><StatusBadge status={data.status} /></KV>
            <KV label="Last observed"><TimeAgo value={data.lastSeenAt} /> <span className="muted small">{data.lastSeenAt ? formatDate(data.lastSeenAt) : ''}</span></KV>
            <KV label="Generation">{data.generation}</KV>
            <KV label="Data endpoint" mono>{data.dataEndpoint || 'Not registered'}</KV>
            <KV label="Capabilities">{(data.capabilities || []).join(', ') || '—'}</KV>
            <KV label="Labels">{(Object.entries(data.labels || {}).map(([k, v]) => `${k}=${v}`).join(', ')) || '—'}</KV>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>Resource snapshot</h2><p>Sampled values. Missing data is not zero.</p></div></div>
          {!snapshot ? <p className="muted pad">No resource snapshot has been observed.</p> : (
            <div className="resource-stack">
              <div><div className="resource-row"><span>CPU utilization</span><strong>{snapshot.cpuUtilization === null || snapshot.cpuUtilization === undefined ? 'No data' : `${(snapshot.cpuUtilization * 100).toFixed(0)}%`}</strong></div><ProgressBar percent={snapshot.cpuUtilization ?? null} /></div>
              <div><div className="resource-row"><span>Memory</span><strong>{formatBytes(snapshot.memoryUsedBytes)} / {formatBytes(snapshot.memoryTotalBytes)}</strong></div><ProgressBar percent={memoryPercent} /></div>
              <div><div className="resource-row"><span>Filesystem</span><strong>{formatBytes(snapshot.filesystemUsedBytes)} / {formatBytes(snapshot.filesystemTotalBytes)}</strong></div><ProgressBar percent={diskPercent} /></div>
              <p className="muted small">Sampled {formatDate(snapshot.sampledAt)}</p>
            </div>
          )}
        </section>
      </div>
      <section className="panel" data-testid="node-resource-history">
        <div className="panel-head"><div><h2>Resource history</h2><p>Persisted heartbeat samples. Gaps are shown as gaps, not zero.</p></div><div className="segmented" aria-label="History window">{[1, 6, 24].map((hours) => <button key={hours} className={`btn btn-small ${historyWindow === hours ? 'active' : ''}`} onClick={() => setHistoryWindow(hours)}>{hours}h</button>)}</div></div>
        {!history?.length ? <EmptyState icon="activity" title="No samples yet" description="Samples appear after the next authenticated node heartbeat." /> : (
          <div className="resource-history">
            <svg viewBox="0 0 400 80" role="img" aria-label="CPU utilization history; gaps are not zero" preserveAspectRatio="none">
              {historySegments(history).map((points, index) => <polyline key={index} fill="none" stroke="var(--accent, #4f8cff)" strokeWidth="2" points={points} />)}
            </svg>
            <p className="muted small">{history.length} sample{history.length === 1 ? '' : 's'}; latest {formatDate(history[0].sampledAt)} · generation {history[0].generation}</p>
            <table className="data-table"><thead><tr><th>Observed</th><th>CPU</th><th>Memory</th><th>Filesystem</th><th>Generation</th></tr></thead><tbody>{history.slice(0, 20).map((sample) => <tr key={sample.sampleId}><td data-label="Observed">{formatDate(sample.observedAt)}</td><td data-label="CPU">{sample.cpuUtilization === null ? 'No data' : `${(sample.cpuUtilization * 100).toFixed(0)}%`}</td><td data-label="Memory">{formatBytes(sample.memoryUsedBytes)} / {formatBytes(sample.memoryTotalBytes)}</td><td data-label="Filesystem">{formatBytes(sample.filesystemUsedBytes)} / {formatBytes(sample.filesystemTotalBytes)}</td><td data-label="Generation">{sample.generation}</td></tr>)}</tbody></table>
          </div>
        )}
      </section>
      <section className="panel table-panel">
        <div className="panel-head"><div><h2>Plugin instances</h2><p>Only instances the Kernel has placed on this node.</p></div></div>
        {!instances?.length ? <EmptyState icon="plugins" title="No instances on this node" description="Deploy a plugin with a selector that matches this node's labels." /> : (
          <table className="data-table"><thead><tr><th>Plugin</th><th>Version</th><th>Slot</th><th>State</th><th>Container</th><th>Restarts</th><th>Logs</th></tr></thead><tbody>
            {instances.map((instance) => <tr key={instance.id}><td data-label="Plugin"><span className="mono">{instance.pluginId}</span></td><td data-label="Version">{instance.version}</td><td data-label="Slot">#{instance.slot}</td><td data-label="State"><StatusBadge status={instance.state} /></td><td data-label="Container"><span className="mono small">{instance.containerId ? instance.containerId.slice(0, 12) : '—'}</span></td><td data-label="Restarts">{instance.restartCount}</td><td data-label="Logs"><Link className="text-link" to={`/instances/${instance.id}/logs`}><Icon name="logs" size={14} /> Live</Link></td></tr>)}
          </tbody></table>
        )}
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>Node events</h2><p>Enrollment, revocation and node-scoped audit.</p></div></div>
        {!events?.length ? <EmptyState icon="activity" title="No events" /> : <ul className="event-list">{events.map((event) => <li key={event.id}><div className="event-marker"><Icon name={event.result === 'REJECTED' ? 'warning' : 'check'} size={13} /></div><div className="event-copy"><div className="event-title"><strong>{event.eventType}</strong><StatusBadge status={event.result} /></div><p>{event.action}</p></div><TimeAgo value={event.occurredAt} /></li>)}</ul>}
      </section>
      <ConfirmDialog open={confirm} title={`Revoke ${data.name}?`} description={<>The node credential is invalidated immediately. New deployments and observations are rejected. Existing containers may keep running but the Gateway stops routing to them; no automatic data deletion occurs.</>} confirmLabel="Revoke node" danger busy={busy} onConfirm={() => void revoke()} onClose={() => setConfirm(false)} />
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
