import React, { useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { Diagnostics } from '../types';
import { Icon } from '../components/Icons';
import { CopyButton, ErrorState, KV, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';
import { formatDuration } from '../format';

export function DiagnosticsPage() {
  const { data, error, loading, reload } = usePolling(() => api.get<Diagnostics>('/api/v1/diagnostics'), 8000);
  const [raw, setRaw] = useState(false);
  if (loading && !data) return <><PageHeader title="Bootstrap Diagnostics" /><Skeleton rows={6} /></>;
  if (error) return <><PageHeader title="Bootstrap Diagnostics" /><ErrorState error={error} onRetry={() => void reload()} /></>;
  if (!data) return null;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Kernel-owned · cannot be uninstalled by a plugin"
        title="Bootstrap Diagnostics"
        description="The recovery surface stays available when business plugins fail. It never loads remote plugin JavaScript."
        actions={<><button className="btn btn-secondary" onClick={() => setRaw(!raw)}>{raw ? 'Visual view' : 'Raw JSON'}</button><button className="btn btn-secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> Refresh</button></>}
      />
      <section className="health-strip">
        <div className="health-strip-item"><span className="health-strip-label">Kernel</span><strong>{data.kernel.version}</strong><span className="muted">API v{data.kernel.apiMajor}</span></div>
        <div className="health-strip-item"><span className="health-strip-label">Database</span><StatusBadge status={data.kernel.database === 'connected' ? 'READY' : 'FAILED'} label={data.kernel.database} /></div>
        <div className="health-strip-item"><span className="health-strip-label">Uptime</span><strong>{formatDuration(data.kernel.uptimeSeconds)}</strong></div>
        <div className="health-strip-item"><span className="health-strip-label">Packages</span><strong>{data.counts.packages}</strong></div>
        <div className="health-strip-item"><span className="health-strip-label">READY instances</span><strong>{data.counts.readyInstances}</strong></div>
        <div className="health-strip-item"><span className="health-strip-label">Deployments</span><strong>{data.counts.deployments}</strong></div>
      </section>
      {raw ? <section className="panel"><div className="panel-head"><div><h2>Raw diagnostics</h2><p>Contains no secrets or session tokens.</p></div></div><pre className="json-view">{JSON.stringify(data, null, 2)}</pre></section> : (
        <>
          <div className="summary-grid">
            <section className="panel">
              <div className="panel-head"><div><h2>Kernel facts</h2><p>Minimum components for recovery.</p></div><CopyButton value={JSON.stringify(data)} label="Copy diagnostics" /></div>
              <div className="kv-grid">
                <KV label="Version">{data.kernel.version}</KV>
                <KV label="API major">{data.kernel.apiMajor}</KV>
                <KV label="Runtime protocol" mono>{data.kernel.runtimeProtocol}</KV>
                <KV label="Database">{data.kernel.database}</KV>
                <KV label="Data directory" mono>{data.kernel.dataDir}</KV>
                <KV label="Web distribution" mono>{data.kernel.webDist}</KV>
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><div><h2>Recovery commands</h2><p>CLI uses the same authorization and audit path.</p></div></div>
              <div className="command-block"><pre>{`opsctl status
opsctl doctor
opsctl nodes
opsctl plugins
opsctl plugin disable <plugin-id>`}</pre><CopyButton value={`opsctl status\nopsctl doctor\nopsctl nodes\nopsctl plugins\nopsctl plugin disable <plugin-id>`} /></div>
              <div className="callout"><Icon name="terminal" size={16} /><p>{data.bootstrap.note}</p></div>
            </section>
          </div>
          <section className="panel"><div className="panel-head"><div><h2>Node observations</h2><p>Last authenticated heartbeat; stale is not stopped.</p></div></div>
            <table className="data-table"><thead><tr><th>Node</th><th>Status</th><th>Last observed</th></tr></thead><tbody>{data.nodes.map((node) => <tr key={node.id}><td data-label="Node"><strong>{node.name}</strong><div className="mono small">{node.id}</div></td><td data-label="Status"><StatusBadge status={node.status} /></td><td data-label="Last observed"><TimeAgo value={node.lastSeenAt} /></td></tr>)}</tbody></table>
          </section>
          <section className="panel"><div className="panel-head"><div><h2>Runtime policies</h2><p>Starting defaults for this experimental environment.</p></div></div><div className="kv-grid">{Object.entries(data.policies).map(([key, value]) => <KV key={key} label={key}>{value}</KV>)}</div></section>
          <section className="panel"><div className="panel-head"><div><h2>Recent audit</h2><p>Last events including failures.</p></div></div><ul className="event-list">{data.recentEvents.map((event) => <li key={event.id}><div className="event-marker"><Icon name={event.result === 'REJECTED' ? 'warning' : 'check'} size={13} /></div><div className="event-copy"><div className="event-title"><strong>{event.eventType}</strong><StatusBadge status={event.result} /></div><p>{event.subjectType} <span className="mono">{event.subjectId}</span></p></div><TimeAgo value={event.occurredAt} /></li>)}</ul></section>
        </>
      )}
    </div>
  );
}
