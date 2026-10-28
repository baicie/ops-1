import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import type { Overview } from '../types';
import { Icon } from '../components/Icons';
import { Button, buttonVariants } from '../components/ui/button';
import { EmptyState, TimeAgo } from '../components/Ui';
import { formatDate } from '../format';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n';
import { AsyncBoundary, NoticeBar, useObservedPolling } from '../components/app/async-boundary';
import { MetricCard } from '../components/app/metric-card';
import { PageHeader } from '../components/app/page-header';
import { StatusIndicator, indicatorStateForCode, type IndicatorState } from '../components/app/status-indicator';

/** Only the fields this view reads; /api/v1/diagnostics is a plain object payload. */
interface DiagnosticsView {
  kernel: { version: string; database: string; uptimeSeconds: number };
}

const SEVERITY_STATE: Record<string, IndicatorState> = { critical: 'error', warning: 'attention', info: 'notConfigured' };

/** Severity is its own vocabulary: an INFO notice is not a permission wall. */
const SEVERITY_LABEL: Record<string, MessageKey> = {
  critical: 'overview.severity.critical',
  warning: 'overview.severity.warning',
  info: 'overview.severity.info',
};

/**
 * §4.5 A. Three layers, in this order: can the platform serve, what must an operator do,
 * what changed lately. Every number comes from the Kernel; a module the Kernel does not
 * report is UNKNOWN — never 0, never green.
 */
export function OverviewPage() {
  const t = useT();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const overview = useObservedPolling(() => api.get<Overview>('/api/v1/overview'), 10000);
  // Kernel identity/database comes from the admin-only diagnostics route; a non-admin session
  // simply cannot observe it, which is UNKNOWN with a reason, not a green tick.
  const diagnostics = useObservedPolling(
    async () => (isAdmin ? api.get<DiagnosticsView>('/api/v1/diagnostics') : null),
    30000,
  );
  const data = overview.data;
  const observedAt = overview.observedAt;

  const modules = buildModules(t, data, diagnostics.data, diagnostics.error, isAdmin, observedAt);
  const partialSource = isAdmin && (diagnostics.error || diagnostics.data === null);

  return (
    <div className="page-stack">
      <PageHeader
        title={t('page.overview')}
        description={t('overview.description')}
        actions={<Button variant="secondary" onClick={() => { void overview.reload(); void diagnostics.reload(); }}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>}
        primary={<Link className={buttonVariants()} to="/admin/plugins/install"><Icon name="plus" size={15} /> {t('overview.action.installPlugin')}</Link>}
      />
      <AsyncBoundary
        loading={overview.loading}
        error={overview.error}
        hasData={Boolean(data)}
        onRetry={() => void overview.reload()}
        skeletonRows={6}
      >
        {data ? (
          <>
            <section className={`attention-banner tone-${data.health === 'READY' ? 'ok' : data.health === 'DEGRADED' ? 'danger' : 'warn'}`} aria-label={t('overview.health.aria')}>
              <div className="attention-icon"><Icon name={data.health === 'READY' ? 'check' : 'warning'} size={20} /></div>
              <div className="attention-copy">
                <h2>{data.health === 'READY' ? t('overview.health.ready') : data.health === 'DEGRADED' ? t(data.attention.filter((item) => item.severity === 'critical').length === 1 ? 'overview.health.criticalIssue' : 'overview.health.criticalIssues', { count: data.attention.filter((item) => item.severity === 'critical').length }) : t('overview.health.attention')}</h2>
                <p>{data.attention.length ? data.attention[0].detail : t('overview.health.allClearDetail')}</p>
              </div>
              <StatusIndicator state={indicatorStateForCode(data.health)} label={data.health} className="ml-auto shrink-0" />
              {data.attention.length > 0 && <a className={buttonVariants({ variant: 'secondary' })} href="#attention">{t('overview.action.reviewIssues')}</a>}
            </section>

            <section className="panel" aria-labelledby="overview-modules-title" data-testid="overview-modules">
              <div className="panel-head">
                <div><h2 id="overview-modules-title">{t('overview.modules.title')}</h2><p>{t('overview.modules.description')}</p></div>
              </div>
              <ul className="module-strip" aria-label={t('overview.modules.aria')}>
                {modules.map((module) => (
                  <li key={module.id} className="module-card" data-module={module.id} data-indicator={module.state}>
                    <div className="module-card-head">
                      <span className="module-card-name">{t(module.labelKey)}</span>
                      <StatusIndicator state={module.state} />
                    </div>
                    <p className="module-card-detail">{module.detail}</p>
                    <div className="module-card-foot">
                      <span className="module-card-observed">{module.observedAt ? t('ui.observedAt', { at: formatDate(module.observedAt) }) : t('ui.notObserved')}</span>
                      {module.href ? <Link className="text-link" to={module.href}>{t('overview.module.open')} <Icon name="arrowRight" size={13} /></Link> : null}
                    </div>
                  </li>
                ))}
              </ul>
              {partialSource ? <NoticeBar state="partial" title={t('state.partial')} detail={t('ui.partial.sources', { ok: 1, total: 2 })} /> : null}
            </section>

            <section className="metric-grid" aria-label={t('overview.kpi.aria')}>
              <MetricCard
                label={t('overview.kpi.healthyNodes')}
                value={`${data.nodesReady} / ${data.nodesTotal}`}
                detail={data.nodesReady === data.nodesTotal ? t('overview.kpi.healthyNodes.allObserved') : t('overview.kpi.healthyNodes.stale')}
                sampledAt={observedAt}
                href="/admin/nodes"
              />
              <MetricCard
                label={t('overview.kpi.installedPlugins')}
                value={data.pluginsInstalled}
                detail={t(data.pluginsAvailable === 1 ? 'overview.kpi.installedPlugins.one' : 'overview.kpi.installedPlugins.many', { count: data.pluginsAvailable })}
                sampledAt={observedAt}
                href="/admin/plugins"
              />
              <MetricCard
                label={t('common.readyInstances')}
                value={`${data.instancesReady} / ${data.instancesTotal}`}
                detail={t('overview.kpi.readyInstances.detail')}
                sampledAt={observedAt}
                href="/admin/plugins"
              />
              <MetricCard
                label={t('overview.kpi.activeDeployments')}
                value={data.activeDeployments}
                detail={t('overview.kpi.activeDeployments.detail')}
                sampledAt={observedAt}
                href="/admin/plugins"
              />
            </section>

            <div className="overview-grid">
              <section className="panel" id="attention">
                <div className="panel-head">
                  <div><h2>{t('overview.attention.title')}</h2><p>{t('overview.attention.description')}</p></div>
                  <span className="panel-count">{t('overview.attention.count', { count: data.attention.length })}</span>
                </div>
                {data.attention.length === 0 ? (
                  <EmptyState icon="check" title={t('overview.attention.empty.title')} description={t('overview.attention.empty.description')} />
                ) : (
                  <ul className="attention-list">
                    {data.attention.map((item, index) => (
                      <li key={`${item.title}-${index}`} className={`attention-item severity-${item.severity}`} data-severity={item.severity}>
                        <StatusIndicator state={SEVERITY_STATE[item.severity] ?? 'attention'} label={t(SEVERITY_LABEL[item.severity] ?? 'overview.severity.warning')} />
                        <div className="attention-item-copy"><strong>{item.title}</strong><p>{item.detail}</p></div>
                        <Link className="text-link" to={item.link}>{t('overview.attention.inspect')} <Icon name="arrowRight" size={14} /></Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="panel" data-testid="overview-audit">
                <div className="panel-head"><div><h2>{t('overview.events.title')}</h2><p>{t('overview.events.description')}</p></div><Link className="text-link" to="/admin/activity">{t('overview.events.viewAll')} <Icon name="arrowRight" size={14} /></Link></div>
                {data.recentEvents.length === 0 ? (
                  <EmptyState icon="activity" title={t('overview.events.empty.title')} description={t('overview.events.empty.description')} />
                ) : (
                  <ul className="event-list">
                    {data.recentEvents.map((event) => {
                      const state = indicatorStateForCode(event.result);
                      return (
                        <li key={event.id}>
                          <StatusIndicator state={state} label={state === 'unknown' ? event.result : undefined} />
                          <div className="event-copy">
                            <div className="event-title"><strong>{event.eventType}</strong></div>
                            <p>{event.subjectType} <span className="mono">{event.subjectId}</span></p>
                          </div>
                          <TimeAgo value={event.occurredAt} />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          </>
        ) : null}
      </AsyncBoundary>
    </div>
  );
}

type ModuleRow = {
  id: string;
  labelKey: MessageKey;
  state: IndicatorState;
  detail: string;
  observedAt: string | null;
  href?: string;
};

/**
 * The first layer: four modules, each with the time this client observed it. Nothing is
 * inferred across modules — a READY node count says nothing about the Catalog.
 */
function buildModules(
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  data: Overview | null,
  diagnostics: DiagnosticsView | null,
  diagnosticsError: Error | null,
  isAdmin: boolean,
  observedAt: string | null,
): ModuleRow[] {
  const kernel: ModuleRow = (() => {
    if (!isAdmin) return { id: 'kernel', labelKey: 'overview.module.kernel', state: 'unknown', detail: t('overview.module.kernel.denied'), observedAt: null };
    if (diagnosticsError) return { id: 'kernel', labelKey: 'overview.module.kernel', state: 'unknown', detail: t('overview.module.kernel.error'), observedAt: null };
    if (!diagnostics) return { id: 'kernel', labelKey: 'overview.module.kernel', state: 'loading', detail: t('ui.notObserved'), observedAt: null };
    const database = diagnostics.kernel.database === 'connected' ? t('overview.module.kernel.dbConnected') : t('overview.module.kernel.dbUnavailable');
    return {
      id: 'kernel',
      labelKey: 'overview.module.kernel',
      state: diagnostics.kernel.database === 'connected' ? 'ready' : 'degraded',
      detail: t('overview.module.kernel.detail', { version: diagnostics.kernel.version, database }),
      observedAt,
    };
  })();
  const nodes: ModuleRow = !data
    ? { id: 'nodes', labelKey: 'overview.module.nodes', state: 'unknown', detail: t('ui.notObserved'), observedAt: null, href: '/admin/nodes' }
    : data.nodesTotal === 0
      ? { id: 'nodes', labelKey: 'overview.module.nodes', state: 'notConfigured', detail: t('overview.module.nodes.none'), observedAt, href: '/admin/nodes' }
      : {
          id: 'nodes',
          labelKey: 'overview.module.nodes',
          state: data.nodesReady === data.nodesTotal ? 'ready' : 'degraded',
          detail: t('overview.module.nodes.detail', { ready: data.nodesReady, total: data.nodesTotal }),
          observedAt,
          href: '/admin/nodes',
        };
  const runtime: ModuleRow = !data
    ? { id: 'runtime', labelKey: 'overview.module.runtime', state: 'unknown', detail: t('ui.notObserved'), observedAt: null, href: '/admin/plugins' }
    : data.instancesTotal === 0
      ? { id: 'runtime', labelKey: 'overview.module.runtime', state: 'notConfigured', detail: t('overview.module.runtime.none'), observedAt, href: '/admin/plugins' }
      : {
          id: 'runtime',
          labelKey: 'overview.module.runtime',
          state: data.instancesReady === data.instancesTotal ? 'ready' : 'degraded',
          detail: t('overview.module.runtime.detail', { ready: data.instancesReady, total: data.instancesTotal, deployments: data.activeDeployments }),
          observedAt,
          href: '/admin/plugins',
        };
  // The Kernel exposes no Catalog health source. Marking it READY because plugins exist would
  // be exactly the inference §4.5 A forbids, so it stays UNKNOWN with the reason attached.
  const catalog: ModuleRow = { id: 'catalog', labelKey: 'overview.module.catalog', state: 'unknown', detail: t('overview.module.catalog.unavailable'), observedAt: null };
  return [kernel, nodes, runtime, catalog];
}
