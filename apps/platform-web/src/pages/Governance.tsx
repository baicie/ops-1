import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { NodeView } from '../types';
import { Icon } from '../components/Icons';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { EmptyState } from '../components/Ui';
import { AsyncBoundary } from '../components/app/async-boundary';
import { PageHeader } from '../components/app/page-header';
import { NoData, StatusIndicator, UnknownValue, indicatorStateForCode } from '../components/app/status-indicator';
import { useT } from '../i18n';
import { formatDate } from '../format';
import { StackCell, StatusPill, stackBody, stackHead, stackRow, stackTable } from './table-kit';

type Dataset = { datasetId: string; name: string; schemaRevision: number; updatedAt: string };
type QualityRun = { runId: string; datasetId: string; status: string; recordsExamined: number; recordsFailed: number; completedAt: string | null; createdAt: string };
type DatasetQuality = Dataset & { latest: QualityRun | null; runs: QualityRun[]; lineageCount: number };
type Summary = {
  datasetCount: number; datasetsWithQualityRuns: number;
  latestQuality: { passed: number; failed: number; error: number; pending: number; unknown: number };
  lineageWindowCount: number; lineageWindow: string;
  recentFailures: { runId: string; datasetId: string; datasetName: string; status: string; createdAt: string; completedAt: string | null; errorCode: string | null }[];
};

export function GovernancePage() {
  const t = useT();
  const { data: nodes, error: nodeError, loading: nodeLoading, reload: reloadNodes } = usePolling(() => api.get<NodeView[]>('/api/v1/nodes'), 10000);
  const [datasets, setDatasets] = useState<DatasetQuality[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  async function load() {
    setLoading(true); setError(null);
    try {
      const [catalog, governance] = await Promise.all([
        api.gatewayGet<{ items: Dataset[] }>('opsweave.data-catalog', '/api/data-catalog/datasets'),
        api.gatewayGet<Summary>('opsweave.data-catalog', '/api/data-catalog/governance-summary'),
      ]);
      setSummary(governance);
      const enriched = await Promise.all((catalog.items || []).slice(0, 50).map(async (dataset) => {
        const [runs, lineage] = await Promise.all([
          api.gatewayGet<{ items: QualityRun[] }>('opsweave.data-catalog', `/api/data-catalog/datasets/${dataset.datasetId}/quality-runs?limit=20`),
          api.gatewayGet<{ items: unknown[] }>('opsweave.data-catalog', `/api/data-catalog/datasets/${dataset.datasetId}/lineage?limit=200`),
        ]);
        const items = runs.items || [];
        return { ...dataset, latest: items[0] || null, runs: items, lineageCount: (lineage.items || []).length };
      }));
      setDatasets(enriched);
    } catch (cause: any) { setError(cause); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  const nodeList = nodes || [];
  const ready = nodeList.filter((node) => node.status === 'READY' && !node.stale).length;
  const unreachable = nodeList.filter((node) => node.status === 'UNREACHABLE' || node.stale).length;
  const recentFailures = summary?.recentFailures || [];
  const quality = summary?.latestQuality;

  return <div className="page-stack">
    <PageHeader title={t('page.governance')} description={t('governance.description')} actions={<Button variant="secondary" onClick={() => { void load(); void reloadNodes(); }}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>} />
    {/* A policy summary is a count over observed runs: while no run has answered, the card says
        UNKNOWN instead of printing a 0 that reads like "zero failures". */}
    <AsyncBoundary
      loading={loading || nodeLoading}
      error={error}
      hasData={Boolean(summary) || datasets.length > 0}
      skeletonRows={5}
      onRetry={() => { void load(); void reloadNodes(); }}
    >
      {/* .metric-grid never had a rule in styles.css, so these cards stacked full width at
          every viewport. The grid lives here now, where this page's layout belongs. */}
      <div className="metric-grid grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.datasets')}</span><strong>{Number.isFinite(summary?.datasetCount) ? summary!.datasetCount : <UnknownValue detail={t('ui.unknown.detail')} />}</strong><span className="text-sm text-muted-foreground">{t('governance.metric.datasets.detail')}</span></div>
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.qualityPassed')}</span><strong>{quality ? quality.passed : <UnknownValue detail={t('ui.unknown.detail')} />}</strong><span className="text-sm text-muted-foreground">{quality ? t('governance.metric.qualityPassed.detail', { failed: quality.failed, errored: quality.error, unknown: quality.unknown, pending: quality.pending }) : t('ui.notObserved')}</span></div>
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.lineageBatches')}</span><strong>{Number.isFinite(summary?.lineageWindowCount) ? summary!.lineageWindowCount : <UnknownValue detail={t('ui.unknown.detail')} />}</strong>{/* The window is the server's answer; a missing one is UNKNOWN, never a "24h" of our own. */}<span className="text-sm text-muted-foreground">{summary?.lineageWindow ? t('governance.metric.lineageBatches.detail', { window: summary.lineageWindow }) : <UnknownValue detail={t('ui.unknown.detail')} />}</span></div>
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.nodesReady')}</span><strong>{nodes ? ready : <UnknownValue detail={t('ui.unknown.detail')} />}</strong><span className="text-sm text-muted-foreground">{nodes ? t('governance.metric.nodesReady.detail', { unreachable, enrolled: nodeList.length }) : t('ui.notObserved')}</span></div>
      </div>
      <section className="panel table-panel">
        <div className="panel-head"><div><h2>{t('governance.quality.title')}</h2><p>{t('governance.quality.description')}</p></div><Link className="text-link" to="/admin/ext/trusted-team/data-catalog">{t('governance.quality.openCatalog')}</Link></div>
        {datasets.length === 0 ? <EmptyState icon="catalog" title={t('governance.quality.empty.title')} description={t('governance.quality.empty.description')} /> : (
          <Table className={stackTable}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('table.dataset')}</TableHead>
                <TableHead>{t('table.schema')}</TableHead>
                <TableHead>{t('table.quality')}</TableHead>
                <TableHead>{t('table.examined')}</TableHead>
                <TableHead>{t('table.failed')}</TableHead>
                <TableHead>{t('table.latestRun')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {datasets.map((dataset) => (
                <TableRow key={dataset.datasetId} className={stackRow} data-dataset={dataset.datasetId}>
                  <StackCell label={t('table.dataset')}>
                    <strong>{dataset.name}</strong>
                    <div className="mono text-sm text-muted-foreground">{dataset.datasetId.slice(0, 13)}…</div>
                  </StackCell>
                  <StackCell label={t('table.schema')}>r{dataset.schemaRevision}</StackCell>
                  <StackCell label={t('table.quality')}>{dataset.latest ? <StatusPill status={dataset.latest.status} /> : <StatusPill status="UNKNOWN" />}</StackCell>
                  {/* A run that examined no records reported nothing: NO_DATA, not a 0 count. */}
                  <StackCell label={t('table.examined')}>{dataset.latest ? dataset.latest.recordsExamined : <NoData detail={t('ui.noData.detail')} />}</StackCell>
                  <StackCell label={t('table.failed')}>{dataset.latest ? dataset.latest.recordsFailed : <NoData detail={t('ui.noData.detail')} />}</StackCell>
                  <StackCell label={t('table.latestRun')}>{dataset.latest ? <Link className="text-link" to="/admin/ext/trusted-team/data-catalog"><span className="mono">{dataset.latest.runId.slice(0, 8)}</span></Link> : <span className="text-muted-foreground">{t('common.noRuns')}</span>}</StackCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <div className="governance-grid">
        <section className="panel table-panel"><div className="panel-head"><div><h2>{t('governance.failures.title')}</h2><p>{t('governance.failures.description')}</p></div></div>{recentFailures.length === 0 ? <EmptyState icon="check" title={t('governance.failures.empty.title')} /> : (
          <Table className={stackTable}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('table.dataset')}</TableHead>
                <TableHead>{t('table.status')}</TableHead>
                <TableHead>{t('table.when')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {recentFailures.map((run) => (
                <TableRow key={run.runId} className={stackRow}>
                  <StackCell label={t('table.dataset')}>{run.datasetName}</StackCell>
                  <StackCell label={t('table.status')}><StatusPill status={run.status} /></StackCell>
                  <StackCell label={t('table.when')}>{run.completedAt ? formatDate(run.completedAt) : formatDate(run.createdAt)}</StackCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}</section>
        <section className="panel table-panel"><div className="panel-head"><div><h2>{t('governance.nodes.title')}</h2><p>{t('governance.nodes.description')}</p></div>{nodeError && <span className="text-sm text-muted-foreground">{t('governance.nodes.unavailable')}</span>}</div>{nodeList.length === 0 ? <EmptyState icon="nodes" title={t('common.noNodes')} /> : (
          <Table className={stackTable}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('table.node')}</TableHead>
                <TableHead>{t('table.status')}</TableHead>
                <TableHead>{t('table.generation')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {nodeList.map((node) => (
                <TableRow key={node.id} className={stackRow}>
                  <StackCell label={t('table.node')}><Link className="text-link" to={`/admin/nodes/${node.id}`}>{node.name}</Link></StackCell>
                  {/* docs/04 §4.5 C: a node that stopped reporting is STALE, which is a different
                      answer from UNREACHABLE and from a green READY. */}
                  <StackCell label={t('table.status')}><StatusIndicator state={indicatorStateForCode(node.status, { stale: node.stale, revoked: Boolean(node.revokedAt) })} /></StackCell>
                  <StackCell label={t('table.generation')}>{node.generation}</StackCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}</section>
      </div>
      <div className="info-grid"><div className="callout"><p>{t('governance.footnote.before')} <strong>UNKNOWN</strong>{t('governance.footnote.after')}</p></div></div>
    </AsyncBoundary>
  </div>;
}
