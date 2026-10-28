import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { NodeView, Overview, PluginSummary } from '../types';
import { Icon } from '../components/Icons';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';
import { formatBytes } from '../format';
import { useT } from '../i18n';

export function OpsCenterPage() {
  const t = useT();
  const overview = usePolling(() => api.get<Overview>('/api/v1/overview'), 8000);
  const nodes = usePolling(() => api.get<NodeView[]>('/api/v1/nodes'), 8000);
  const plugins = usePolling(() => api.get<PluginSummary[]>('/api/v1/plugins'), 8000);
  if (overview.loading && !overview.data) return <><PageHeader title={t('page.opsCenter')} /><Skeleton rows={6} /></>;
  if (overview.error) return <><PageHeader title={t('page.opsCenter')} /><ErrorState error={overview.error} onRetry={() => void overview.reload()} /></>;
  const data = overview.data!;
  const nodeList = nodes.data || [];
  const pluginList = (plugins.data || []).filter((plugin) => !plugin.isSystem);
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t('opsCenter.eyebrow')}
        title={t('page.opsCenter')}
        description={t('opsCenter.description')}
        actions={<Link className="btn btn-secondary" to="/settings/diagnostics"><Icon name="terminal" size={15} /> {t('common.bootstrapDiagnostics')}</Link>}
      />
      <section className={`attention-banner tone-${data.health === 'READY' ? 'ok' : data.health === 'DEGRADED' ? 'danger' : 'warn'}`}>
        <div className="attention-icon"><Icon name={data.health === 'READY' ? 'check' : 'warning'} size={20} /></div>
        <div className="attention-copy"><h2>{data.health === 'READY' ? t('opsCenter.health.ok.title') : t('opsCenter.health.attention.title')}</h2><p>{data.attention[0]?.detail || t('opsCenter.health.ok.detail')}</p></div>
        <Link className="btn btn-secondary" to="/activity">{t('opsCenter.action.auditTimeline')}</Link>
      </section>
      <div className="summary-grid">
        <section className="panel">
          <div className="panel-head"><div><h2>{t('opsCenter.nodes.title')}</h2><p>{t('opsCenter.nodes.description')}</p></div><Link className="text-link" to="/nodes">{t('opsCenter.nodes.all')} <Icon name="arrowRight" size={14} /></Link></div>
          {nodeList.length === 0 ? <EmptyState icon="nodes" title={t('common.noNodes')} description={t('opsCenter.nodes.empty.description')} /> : <div className="ops-node-list">{nodeList.map((node) => <Link to={`/nodes/${node.id}`} className="ops-node" key={node.id}><span className="ops-node-name"><strong>{node.name}</strong><span className="muted small">{node.os}/{node.arch} · gen {node.generation}</span></span><StatusBadge status={node.status} /><span className="ops-node-metric">{node.resourceSnapshot?.memoryUsedBytes ? `${formatBytes(node.resourceSnapshot.memoryUsedBytes)} / ${formatBytes(node.resourceSnapshot.memoryTotalBytes)}` : t('opsCenter.nodes.memoryNoData')}</span><span className="muted small"><TimeAgo value={node.lastSeenAt} /></span></Link>)}</div>}
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>{t('opsCenter.plugins.title')}</h2><p>{t('opsCenter.plugins.description')}</p></div><Link className="text-link" to="/plugins">{t('opsCenter.plugins.all')} <Icon name="arrowRight" size={14} /></Link></div>
          {pluginList.length === 0 ? <EmptyState icon="plugins" title={t('opsCenter.plugins.empty.title')} description={t('opsCenter.plugins.empty.description')} /> : <div className="ops-plugin-list">{pluginList.map((plugin) => <Link to={`/plugins/${plugin.id}`} className="ops-plugin" key={plugin.id}><span><strong>{plugin.name}</strong><span className="muted small mono">{plugin.activeVersion || plugin.latestVersion}</span></span><span className="ops-readiness">{t('opsCenter.plugins.readyCount', { ready: plugin.readyInstances, total: plugin.totalInstances })}</span><StatusBadge status={plugin.state} /></Link>)}</div>}
        </section>
      </div>
      <section className="panel">
        <div className="panel-head"><div><h2>{t('opsCenter.shortcuts.title')}</h2><p>{t('opsCenter.shortcuts.description')}</p></div></div>
        <div className="quick-grid">
          <Link to="/nodes" className="quick-card"><Icon name="key" /><div><strong>{t('common.joinNode')}</strong><span>{t('opsCenter.shortcuts.joinNode.description')}</span></div><Icon name="arrowRight" size={15} /></Link>
          <Link to="/activity" className="quick-card"><Icon name="activity" /><div><strong>{t('opsCenter.shortcuts.failures.title')}</strong><span>{t('opsCenter.shortcuts.failures.description')}</span></div><Icon name="arrowRight" size={15} /></Link>
          <Link to="/plugins/install" className="quick-card"><Icon name="plugins" /><div><strong>{t('opsCenter.shortcuts.deploy.title')}</strong><span>{t('opsCenter.shortcuts.deploy.description')}</span></div><Icon name="arrowRight" size={15} /></Link>
        </div>
      </section>
      <div className="callout"><Icon name="alert" size={16} /><p>{t('opsCenter.footnote.before')} <code>opsctl</code> {t('opsCenter.footnote.after')}</p></div>
    </div>
  );
}
