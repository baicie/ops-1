import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { Overview } from '../types';
import { Icon } from '../components/Icons';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';

function Kpi({ label, value, detail, tone = '' }: { label: string; value: React.ReactNode; detail?: string; tone?: string }) {
  return (
    <article className={`kpi ${tone}`}>
      <p className="kpi-label">{label}</p>
      <p className="kpi-value">{value}</p>
      {detail && <p className="kpi-detail">{detail}</p>}
    </article>
  );
}

export function OverviewPage() {
  const { data, error, loading, reload } = usePolling(() => api.get<Overview>('/api/v1/overview'), 10000);
  if (loading && !data) return <><PageHeader title="Overview" description="Platform health and the next decision." /><Skeleton rows={6} /></>;
  if (error) return <><PageHeader title="Overview" /><ErrorState error={error} onRetry={() => void reload()} /></>;
  if (!data) return null;
  const critical = data.attention.filter((item) => item.severity === 'critical');
  const healthTone = data.health === 'READY' ? 'ok' : data.health === 'DEGRADED' ? 'danger' : 'warn';
  return (
    <div className="page-stack">
      <PageHeader
        title="Overview"
        description="What needs attention now — not a wall of metrics."
        actions={<><button className="btn btn-secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> Refresh</button><Link className="btn btn-primary" to="/plugins/install"><Icon name="plus" size={15} /> Install plugin</Link></>}
      />
      <section className={`attention-banner tone-${healthTone}`} aria-label="Platform health summary">
        <div className="attention-icon"><Icon name={data.health === 'READY' ? 'check' : 'warning'} size={20} /></div>
        <div className="attention-copy">
          <h2>{data.health === 'READY' ? 'Platform is ready' : data.health === 'DEGRADED' ? `${critical.length} critical issue${critical.length === 1 ? '' : 's'} need attention` : 'Platform attention needed'}</h2>
          <p>{data.attention.length ? data.attention[0].detail : 'Every enrolled node is reachable, every desired replica is READY and no activation is blocked.'}</p>
        </div>
        {data.attention.length > 0 && <a className="btn btn-secondary" href="#attention">Review issues</a>}
      </section>
      <section className="kpi-grid" aria-label="Platform counts">
        <Kpi label="Healthy nodes" value={`${data.nodesReady} / ${data.nodesTotal}`} detail={data.nodesReady === data.nodesTotal ? 'All enrolled nodes observed' : 'Node heartbeat stale or unreachable'} />
        <Kpi label="Installed plugins" value={data.pluginsInstalled} detail={`${data.pluginsAvailable} plugin artifact${data.pluginsAvailable === 1 ? '' : 's'} in the local store`} />
        <Kpi label="READY instances" value={`${data.instancesReady} / ${data.instancesTotal}`} detail="Observed readiness; not inferred from heartbeats" tone={data.instancesReady < data.instancesTotal ? 'kpi-warn' : ''} />
        <Kpi label="Active deployments" value={data.activeDeployments} detail="Activation revisions currently effective" />
      </section>
      <div className="overview-grid">
        <section className="panel" id="attention">
          <div className="panel-head"><div><h2>Attention</h2><p>Ordered by operational impact. Unknown is not shown as healthy.</p></div></div>
          {data.attention.length === 0 ? (
            <EmptyState icon="check" title="Nothing needs action" description="No stale nodes, failed deployments or uninstalled plugins." />
          ) : (
            <ul className="attention-list">
              {data.attention.map((item, index) => (
                <li key={`${item.title}-${index}`} className={`attention-item severity-${item.severity}`}>
                  <span className="severity-dot" aria-hidden="true" />
                  <div className="attention-item-copy"><strong>{item.title}</strong><p>{item.detail}</p></div>
                  <Link className="text-link" to={item.link}>Inspect <Icon name="arrowRight" size={14} /></Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>Recent events</h2><p>Audited lifecycle activity from the Kernel.</p></div><Link className="text-link" to="/activity">View all <Icon name="arrowRight" size={14} /></Link></div>
          {data.recentEvents.length === 0 ? (
            <EmptyState icon="activity" title="No events yet" description="Install a signed plugin or join a node to begin." />
          ) : (
            <ul className="event-list">
              {data.recentEvents.map((event) => (
                <li key={event.id}>
                  <div className="event-marker"><Icon name={event.result === 'REJECTED' ? 'warning' : 'check'} size={13} /></div>
                  <div className="event-copy">
                    <div className="event-title"><strong>{event.eventType}</strong><StatusBadge status={event.result} /></div>
                    <p>{event.subjectType} <span className="mono">{event.subjectId}</span></p>
                  </div>
                  <TimeAgo value={event.occurredAt} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="panel quick-panel">
        <div className="panel-head"><div><h2>Next steps</h2><p>Common operator paths for this environment.</p></div></div>
        <div className="quick-grid">
          <Link to="/nodes" className="quick-card"><Icon name="nodes" /><div><strong>Join a node</strong><span>Create a one-time enrollment token and verify the data proxy.</span></div><Icon name="arrowRight" size={15} /></Link>
          <Link to="/plugins/install" className="quick-card"><Icon name="plugins" /><div><strong>Install a signed plugin</strong><span>Verify publisher signature, review permissions, deploy and activate.</span></div><Icon name="arrowRight" size={15} /></Link>
          <Link to="/settings/diagnostics" className="quick-card"><Icon name="terminal" /><div><strong>Open Bootstrap Diagnostics</strong><span>Kernel-owned recovery that does not load plugin JavaScript.</span></div><Icon name="arrowRight" size={15} /></Link>
        </div>
      </section>
    </div>
  );
}
