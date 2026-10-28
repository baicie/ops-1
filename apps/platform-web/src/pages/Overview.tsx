import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { Overview } from '../types';
import { Icon } from '../components/Icons';
import { Badge, type BadgeVariant } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { cn } from '../lib/utils';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';
import { useT } from '../i18n';

function Kpi({ label, value, detail, tone = '' }: { label: string; value: React.ReactNode; detail?: string; tone?: string }) {
  return (
    <Card className={cn('min-w-0', tone)}>
      <CardContent className="p-3 sm:p-4">
        <p className="kpi-label">{label}</p>
        <p className="kpi-value">{value}</p>
        {detail && <p className="kpi-detail">{detail}</p>}
      </CardContent>
    </Card>
  );
}

export function OverviewPage() {
  const t = useT();
  const { data, error, loading, reload } = usePolling(() => api.get<Overview>('/api/v1/overview'), 10000);
  if (loading && !data) return <><PageHeader title={t('page.overview')} description={t('overview.description.short')} /><Skeleton rows={6} /></>;
  if (error) return <><PageHeader title={t('page.overview')} /><ErrorState error={error} onRetry={() => void reload()} /></>;
  if (!data) return null;
  const critical = data.attention.filter((item) => item.severity === 'critical');
  const healthTone = data.health === 'READY' ? 'ok' : data.health === 'DEGRADED' ? 'danger' : 'warn';
  const healthBadge: BadgeVariant = healthTone === 'ok' ? 'success' : healthTone === 'danger' ? 'destructive' : 'warning';
  return (
    <div className="page-stack">
      <PageHeader
        title={t('page.overview')}
        description={t('overview.description')}
        actions={<><Button variant="outline" onClick={() => void reload()}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button><Link className="btn btn-primary" to="/plugins/install"><Icon name="plus" size={15} /> {t('overview.action.installPlugin')}</Link></>}
      />
      <section className={`attention-banner tone-${healthTone}`} aria-label={t('overview.health.aria')}>
        <div className="attention-icon"><Icon name={data.health === 'READY' ? 'check' : 'warning'} size={20} /></div>
        <div className="attention-copy">
          <h2>{data.health === 'READY' ? t('overview.health.ready') : data.health === 'DEGRADED' ? t(critical.length === 1 ? 'overview.health.criticalIssue' : 'overview.health.criticalIssues', { count: critical.length }) : t('overview.health.attention')}</h2>
          <p>{data.attention.length ? data.attention[0].detail : t('overview.health.allClearDetail')}</p>
        </div>
        <Badge variant={healthBadge} className="ml-auto shrink-0">{data.health}</Badge>
        {data.attention.length > 0 && <a className="btn btn-secondary" href="#attention">{t('overview.action.reviewIssues')}</a>}
      </section>
      <section className="kpi-grid" aria-label={t('overview.kpi.aria')}>
        <Kpi label={t('overview.kpi.healthyNodes')} value={`${data.nodesReady} / ${data.nodesTotal}`} detail={data.nodesReady === data.nodesTotal ? t('overview.kpi.healthyNodes.allObserved') : t('overview.kpi.healthyNodes.stale')} />
        <Kpi label={t('overview.kpi.installedPlugins')} value={data.pluginsInstalled} detail={t(data.pluginsAvailable === 1 ? 'overview.kpi.installedPlugins.one' : 'overview.kpi.installedPlugins.many', { count: data.pluginsAvailable })} />
        <Kpi label={t('common.readyInstances')} value={`${data.instancesReady} / ${data.instancesTotal}`} detail={t('overview.kpi.readyInstances.detail')} tone={data.instancesReady < data.instancesTotal ? 'kpi-warn' : ''} />
        <Kpi label={t('overview.kpi.activeDeployments')} value={data.activeDeployments} detail={t('overview.kpi.activeDeployments.detail')} />
      </section>
      <div className="overview-grid">
        <section className="panel" id="attention">
          <div className="panel-head"><div><h2>{t('overview.attention.title')}</h2><p>{t('overview.attention.description')}</p></div></div>
          {data.attention.length === 0 ? (
            <EmptyState icon="check" title={t('overview.attention.empty.title')} description={t('overview.attention.empty.description')} />
          ) : (
            <ul className="attention-list">
              {data.attention.map((item, index) => (
                <li key={`${item.title}-${index}`} className={`attention-item severity-${item.severity}`}>
                  <span className="severity-dot" aria-hidden="true" />
                  <div className="attention-item-copy"><strong>{item.title}</strong><p>{item.detail}</p></div>
                  <Link className="text-link" to={item.link}>{t('overview.attention.inspect')} <Icon name="arrowRight" size={14} /></Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>{t('overview.events.title')}</h2><p>{t('overview.events.description')}</p></div><Link className="text-link" to="/activity">{t('overview.events.viewAll')} <Icon name="arrowRight" size={14} /></Link></div>
          {data.recentEvents.length === 0 ? (
            <EmptyState icon="activity" title={t('overview.events.empty.title')} description={t('overview.events.empty.description')} />
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
        <div className="panel-head"><div><h2>{t('overview.nextSteps.title')}</h2><p>{t('overview.nextSteps.description')}</p></div></div>
        <div className="quick-grid">
          <Link to="/nodes" className="quick-card"><Icon name="nodes" /><div><strong>{t('common.joinNode')}</strong><span>{t('overview.nextSteps.joinNode.description')}</span></div><Icon name="arrowRight" size={15} /></Link>
          <Link to="/plugins/install" className="quick-card"><Icon name="plugins" /><div><strong>{t('overview.nextSteps.installPlugin.title')}</strong><span>{t('overview.nextSteps.installPlugin.description')}</span></div><Icon name="arrowRight" size={15} /></Link>
          <Link to="/settings/diagnostics" className="quick-card"><Icon name="terminal" /><div><strong>{t('overview.nextSteps.diagnostics.title')}</strong><span>{t('overview.nextSteps.diagnostics.description')}</span></div><Icon name="arrowRight" size={15} /></Link>
        </div>
      </section>
    </div>
  );
}
