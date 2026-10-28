import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { NodeView } from '../types';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge } from '../components/Ui';
import { useT } from '../i18n';
import { formatDate } from '../format';

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
    <PageHeader title={t('page.governance')} description={t('governance.description')} actions={<button className="btn btn-secondary" onClick={() => { void load(); void reloadNodes(); }}>{t('action.refresh')}</button>} />
    {(loading || nodeLoading) && !datasets.length ? <Skeleton rows={5} /> : error ? <ErrorState error={error} onRetry={() => void load()} /> : <>
      <div className="metric-grid">
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.datasets')}</span><strong>{summary?.datasetCount ?? '—'}</strong><span className="muted small">{t('governance.metric.datasets.detail')}</span></div>
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.qualityPassed')}</span><strong>{passed}</strong><span className="muted small">{t('governance.metric.qualityPassed.detail', { failed, errored, unknown, pending: summary?.latestQuality.pending ?? 0 })}</span></div>
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.lineageBatches')}</span><strong>{lineageBatches}</strong><span className="muted small">{t('governance.metric.lineageBatches.detail', { window: summary?.lineageWindow || '24h' })}</span></div>
        <div className="panel metric-card"><span className="metric-label">{t('governance.metric.nodesReady')}</span><strong>{ready}</strong><span className="muted small">{t('governance.metric.nodesReady.detail', { unreachable, enrolled: nodeList.length })}</span></div>
      </div>
      <section className="panel table-panel">
        <div className="panel-head"><div><h2>{t('governance.quality.title')}</h2><p>{t('governance.quality.description')}</p></div><Link className="text-link" to="/ext/trusted-team/data-catalog">{t('governance.quality.openCatalog')}</Link></div>
        {datasets.length === 0 ? <EmptyState icon="catalog" title={t('governance.quality.empty.title')} description={t('governance.quality.empty.description')} /> : <table className="data-table"><thead><tr><th>{t('table.dataset')}</th><th>{t('table.schema')}</th><th>{t('table.quality')}</th><th>{t('table.examined')}</th><th>{t('table.failed')}</th><th>{t('table.latestRun')}</th></tr></thead><tbody>{datasets.map((dataset) => <tr key={dataset.datasetId}><td data-label={t('table.dataset')}><strong>{dataset.name}</strong><div className="muted small mono">{dataset.datasetId.slice(0, 13)}…</div></td><td data-label={t('table.schema')}>r{dataset.schemaRevision}</td><td data-label={t('table.quality')}>{dataset.latest ? <StatusBadge status={dataset.latest.status} /> : <StatusBadge status="UNKNOWN" />}</td><td data-label={t('table.examined')}>{dataset.latest?.recordsExamined ?? '—'}</td><td data-label={t('table.failed')}>{dataset.latest?.recordsFailed ?? '—'}</td><td data-label={t('table.latestRun')}>{dataset.latest ? <Link className="text-link" to="/ext/trusted-team/data-catalog"><span className="mono">{dataset.latest.runId.slice(0, 8)}</span></Link> : <span className="muted">{t('common.noRuns')}</span>}</td></tr>)}</tbody></table>}
      </section>
      <div className="governance-grid">
        <section className="panel table-panel"><div className="panel-head"><div><h2>{t('governance.failures.title')}</h2><p>{t('governance.failures.description')}</p></div></div>{recentFailures.length === 0 ? <EmptyState icon="check" title={t('governance.failures.empty.title')} /> : <table className="data-table"><thead><tr><th>{t('table.dataset')}</th><th>{t('table.status')}</th><th>{t('table.when')}</th></tr></thead><tbody>{recentFailures.map((run) => <tr key={run.runId}><td data-label={t('table.dataset')}>{run.datasetName}</td><td data-label={t('table.status')}><StatusBadge status={run.status} /></td><td data-label={t('table.when')}>{run.completedAt ? formatDate(run.completedAt) : formatDate(run.createdAt)}</td></tr>)}</tbody></table>}</section>
        <section className="panel table-panel"><div className="panel-head"><div><h2>{t('governance.nodes.title')}</h2><p>{t('governance.nodes.description')}</p></div>{nodeError && <span className="muted small">{t('governance.nodes.unavailable')}</span>}</div>{nodeList.length === 0 ? <EmptyState icon="nodes" title={t('common.noNodes')} /> : <table className="data-table"><thead><tr><th>{t('table.node')}</th><th>{t('table.status')}</th><th>{t('table.generation')}</th></tr></thead><tbody>{nodeList.map((node) => <tr key={node.id}><td data-label={t('table.node')}><Link className="text-link" to={`/nodes/${node.id}`}>{node.name}</Link></td><td data-label={t('table.status')}><StatusBadge status={node.stale ? 'UNREACHABLE' : node.status} /></td><td data-label={t('table.generation')}>{node.generation}</td></tr>)}</tbody></table>}</section>
      </div>
      <div className="info-grid"><div className="callout"><p>{t('governance.footnote.before')} <strong>UNKNOWN</strong>{t('governance.footnote.after')}</p></div></div>
    </>}
  </div>;
}
