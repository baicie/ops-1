import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { NodeView } from '../types';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '../components/Ui';
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

  const passed = summary?.latestQuality.passed ?? 0;
  const failed = summary?.latestQuality.failed ?? 0;
  const errored = summary?.latestQuality.error ?? 0;
  const unknown = summary?.latestQuality.unknown ?? 0;
  const nodeList = nodes || [];
  const ready = nodeList.filter((node) => node.status === 'READY' && !node.stale).length;
  const unreachable = nodeList.filter((node) => node.status === 'UNREACHABLE' || node.stale).length;
  const recentFailures = summary?.recentFailures || [];
  const lineageBatches = summary?.lineageWindowCount ?? 0;

  return <div className="page-stack">
    <PageHeader title={t('page.governance')} description={t('governance.description')} actions={<Button variant="secondary" onClick={() => { void load(); void reloadNodes(); }}>{t('action.refresh')}</Button>} />
    {(loading || nodeLoading) && !datasets.length ? <Skeleton rows={5} /> : error ? <ErrorState error={error} onRetry={() => void load()} /> : <>
      <div className="metric-grid">
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.datasets')}</span><strong>{summary?.datasetCount ?? '—'}</strong><span className="text-sm text-muted-foreground">{t('governance.metric.datasets.detail')}</span></div>
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.qualityPassed')}</span><strong>{passed}</strong><span className="text-sm text-muted-foreground">{t('governance.metric.qualityPassed.detail', { failed, errored, unknown, pending: summary?.latestQuality.pending ?? 0 })}</span></div>
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.lineageBatches')}</span><strong>{lineageBatches}</strong><span className="text-sm text-muted-foreground">{t('governance.metric.lineageBatches.detail', { window: summary?.lineageWindow || '24h' })}</span></div>
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.nodesReady')}</span><strong>{ready}</strong><span className="text-sm text-muted-foreground">{t('governance.metric.nodesReady.detail', { unreachable, enrolled: nodeList.length })}</span></div>
      </div>
      <section className="panel table-panel">
        <div className="panel-head"><div><h2>{t('governance.quality.title')}</h2><p>{t('governance.quality.description')}</p></div><Link className="text-link" to="/ext/trusted-team/data-catalog">{t('governance.quality.openCatalog')}</Link></div>
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
                <TableRow key={dataset.datasetId} className={stackRow}>
                  <StackCell label={t('table.dataset')}>
                    <strong>{dataset.name}</strong>
                    <div className="mono text-sm text-muted-foreground">{dataset.datasetId.slice(0, 13)}…</div>
                  </StackCell>
                  <StackCell label={t('table.schema')}>r{dataset.schemaRevision}</StackCell>
                  <StackCell label={t('table.quality')}>{dataset.latest ? <StatusPill status={dataset.latest.status} /> : <StatusPill status="UNKNOWN" />}</StackCell>
                  <StackCell label={t('table.examined')}>{dataset.latest?.recordsExamined ?? '—'}</StackCell>
                  <StackCell label={t('table.failed')}>{dataset.latest?.recordsFailed ?? '—'}</StackCell>
                  <StackCell label={t('table.latestRun')}>{dataset.latest ? <Link className="text-link" to="/ext/trusted-team/data-catalog"><span className="mono">{dataset.latest.runId.slice(0, 8)}</span></Link> : <span className="text-muted-foreground">{t('common.noRuns')}</span>}</StackCell>
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
                  <StackCell label={t('table.node')}><Link className="text-link" to={`/nodes/${node.id}`}>{node.name}</Link></StackCell>
                  <StackCell label={t('table.status')}><StatusPill status={node.stale ? 'UNREACHABLE' : node.status} /></StackCell>
                  <StackCell label={t('table.generation')}>{node.generation}</StackCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}</section>
      </div>
      <div className="info-grid"><div className="callout"><p>{t('governance.footnote.before')} <strong>UNKNOWN</strong>{t('governance.footnote.after')}</p></div></div>
    </>}
  </div>;
}
