import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { NodeView } from '../types';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge } from '../components/Ui';
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
    <PageHeader title="Governance" description="Authoritative catalog coverage, quality outcomes and node health. Unknown is shown as UNKNOWN, never inferred as healthy." actions={<button className="btn btn-secondary" onClick={() => { void load(); void reloadNodes(); }}>Refresh</button>} />
    {(loading || nodeLoading) && !datasets.length ? <Skeleton rows={5} /> : error ? <ErrorState error={error} onRetry={() => void load()} /> : <>
      <div className="metric-grid">
        <div className="panel metric-card"><span className="metric-label">Datasets</span><strong>{summary?.datasetCount ?? '—'}</strong><span className="muted small">authoritative catalog count</span></div>
        <div className="panel metric-card"><span className="metric-label">Quality passed</span><strong>{passed}</strong><span className="muted small">{failed} failed · {errored} error · {unknown} unknown · {summary?.latestQuality.pending ?? 0} pending</span></div>
        <div className="panel metric-card"><span className="metric-label">Lineage batches</span><strong>{lineageBatches}</strong><span className="muted small">last {summary?.lineageWindow || '24h'}, authoritative window count</span></div>
        <div className="panel metric-card"><span className="metric-label">Nodes ready</span><strong>{ready}</strong><span className="muted small">{unreachable} unreachable · {nodeList.length} enrolled</span></div>
      </div>
      <section className="panel table-panel">
        <div className="panel-head"><div><h2>Dataset quality status</h2><p>Latest persisted run per dataset; a missing run is UNKNOWN, not PASSED. Showing up to 50; metrics above use the full summary.</p></div><Link className="text-link" to="/ext/trusted-team/data-catalog">Open catalog</Link></div>
        {datasets.length === 0 ? <EmptyState icon="catalog" title="No datasets" description="Create a dataset in Data Catalog, then add quality rules." /> : <table className="data-table"><thead><tr><th>Dataset</th><th>Schema</th><th>Quality</th><th>Examined</th><th>Failed</th><th>Latest run</th></tr></thead><tbody>{datasets.map((dataset) => <tr key={dataset.datasetId}><td data-label="Dataset"><strong>{dataset.name}</strong><div className="muted small mono">{dataset.datasetId.slice(0, 13)}…</div></td><td data-label="Schema">r{dataset.schemaRevision}</td><td data-label="Quality">{dataset.latest ? <StatusBadge status={dataset.latest.status} /> : <StatusBadge status="UNKNOWN" />}</td><td data-label="Examined">{dataset.latest?.recordsExamined ?? '—'}</td><td data-label="Failed">{dataset.latest?.recordsFailed ?? '—'}</td><td data-label="Latest run">{dataset.latest ? <Link className="text-link" to="/ext/trusted-team/data-catalog"><span className="mono">{dataset.latest.runId.slice(0, 8)}</span></Link> : <span className="muted">No runs</span>}</td></tr>)}</tbody></table>}
      </section>
      <div className="governance-grid">
        <section className="panel table-panel"><div className="panel-head"><div><h2>Recent quality failures</h2><p>Only terminal FAILED or ERROR runs.</p></div></div>{recentFailures.length === 0 ? <EmptyState icon="check" title="No recent failures" /> : <table className="data-table"><thead><tr><th>Dataset</th><th>Status</th><th>When</th></tr></thead><tbody>{recentFailures.map((run) => <tr key={run.runId}><td data-label="Dataset">{run.datasetName}</td><td data-label="Status"><StatusBadge status={run.status} /></td><td data-label="When">{run.completedAt ? formatDate(run.completedAt) : formatDate(run.createdAt)}</td></tr>)}</tbody></table>}</section>
        <section className="panel table-panel"><div className="panel-head"><div><h2>Node health</h2><p>Heartbeat reachability, not plugin health.</p></div>{nodeError && <span className="muted small">Node data unavailable</span>}</div>{nodeList.length === 0 ? <EmptyState icon="nodes" title="No nodes" /> : <table className="data-table"><thead><tr><th>Node</th><th>Status</th><th>Generation</th></tr></thead><tbody>{nodeList.map((node) => <tr key={node.id}><td data-label="Node"><Link className="text-link" to={`/nodes/${node.id}`}>{node.name}</Link></td><td data-label="Status"><StatusBadge status={node.stale ? 'UNREACHABLE' : node.status} /></td><td data-label="Generation">{node.generation}</td></tr>)}</tbody></table>}</section>
      </div>
      <div className="info-grid"><div className="callout"><p>Coverage is computed only from persisted Catalog lineage pages and quality runs. Empty datasets are <strong>UNKNOWN</strong>, not 100% healthy.</p></div></div>
    </>}
  </div>;
}
