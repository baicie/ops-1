import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { NodeView, Overview, PluginSummary } from '../types';
import { Icon } from '../components/Icons';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';
import { formatBytes } from '../format';

export function OpsCenterPage() {
  const overview = usePolling(() => api.get<Overview>('/api/v1/overview'), 8000);
  const nodes = usePolling(() => api.get<NodeView[]>('/api/v1/nodes'), 8000);
  const plugins = usePolling(() => api.get<PluginSummary[]>('/api/v1/plugins'), 8000);
  if (overview.loading && !overview.data) return <><PageHeader title="Ops Center" /><Skeleton rows={6} /></>;
  if (overview.error) return <><PageHeader title="Ops Center" /><ErrorState error={overview.error} onRetry={() => void overview.reload()} /></>;
  const data = overview.data!;
  const nodeList = nodes.data || [];
  const pluginList = (plugins.data || []).filter((plugin) => !plugin.isSystem);
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Official system plugin · host-owned screens"
        title="Ops Center"
        description="Node, instance and recovery operations. This page is rendered by the Shell so Bootstrap-style operations survive a broken business plugin."
        actions={<Link className="btn btn-secondary" to="/settings/diagnostics"><Icon name="terminal" size={15} /> Bootstrap diagnostics</Link>}
      />
      <section className={`attention-banner tone-${data.health === 'READY' ? 'ok' : data.health === 'DEGRADED' ? 'danger' : 'warn'}`}>
        <div className="attention-icon"><Icon name={data.health === 'READY' ? 'check' : 'warning'} size={20} /></div>
        <div className="attention-copy"><h2>{data.health === 'READY' ? 'All observed systems healthy' : 'Operational attention required'}</h2><p>{data.attention[0]?.detail || 'All enrolled nodes healthy and every desired replica READY.'}</p></div>
        <Link className="btn btn-secondary" to="/activity">Audit timeline</Link>
      </section>
      <div className="summary-grid">
        <section className="panel">
          <div className="panel-head"><div><h2>Node fleet</h2><p>Control channel and resource snapshots.</p></div><Link className="text-link" to="/nodes">All nodes <Icon name="arrowRight" size={14} /></Link></div>
          {nodeList.length === 0 ? <EmptyState icon="nodes" title="No nodes" description="Join a node to place plugin replicas." /> : <div className="ops-node-list">{nodeList.map((node) => <Link to={`/nodes/${node.id}`} className="ops-node" key={node.id}><span className="ops-node-name"><strong>{node.name}</strong><span className="muted small">{node.os}/{node.arch} · gen {node.generation}</span></span><StatusBadge status={node.status} /><span className="ops-node-metric">{node.resourceSnapshot?.memoryUsedBytes ? `${formatBytes(node.resourceSnapshot.memoryUsedBytes)} / ${formatBytes(node.resourceSnapshot.memoryTotalBytes)}` : 'Memory: no data'}</span><span className="muted small"><TimeAgo value={node.lastSeenAt} /></span></Link>)}</div>}
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>Plugin runtime</h2><p>READY replicas and effective revisions.</p></div><Link className="text-link" to="/plugins">All plugins <Icon name="arrowRight" size={14} /></Link></div>
          {pluginList.length === 0 ? <EmptyState icon="plugins" title="No business plugins" description="Install the signed Hello Ops package." /> : <div className="ops-plugin-list">{pluginList.map((plugin) => <Link to={`/plugins/${plugin.id}`} className="ops-plugin" key={plugin.id}><span><strong>{plugin.name}</strong><span className="muted small mono">{plugin.activeVersion || plugin.latestVersion}</span></span><span className="ops-readiness">{plugin.readyInstances}/{plugin.totalInstances} ready</span><StatusBadge status={plugin.state} /></Link>)}</div>}
        </section>
      </div>
      <section className="panel">
        <div className="panel-head"><div><h2>Operational shortcuts</h2><p>Every action goes through the same authorized API and audit path.</p></div></div>
        <div className="quick-grid">
          <Link to="/nodes" className="quick-card"><Icon name="key" /><div><strong>Join a node</strong><span>One-time enrollment, short-lived token, revocable identity.</span></div><Icon name="arrowRight" size={15} /></Link>
          <Link to="/activity" className="quick-card"><Icon name="activity" /><div><strong>Inspect failures</strong><span>Search audit events and failed lifecycle transitions.</span></div><Icon name="arrowRight" size={15} /></Link>
          <Link to="/plugins/install" className="quick-card"><Icon name="plugins" /><div><strong>Deploy a signed plugin</strong><span>Verify, review permissions, deploy, then activate.</span></div><Icon name="arrowRight" size={15} /></Link>
        </div>
      </section>
      <div className="callout"><Icon name="alert" size={16} /><p>Ops Center is replaceable; Bootstrap Diagnostics and <code>opsctl</code> remain available even if this plugin UI fails. Historical telemetry storage is intentionally out of scope for 0.0.1.</p></div>
    </div>
  );
}
