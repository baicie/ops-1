import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { JobList, PipelineDefinition, PipelineDetail, PipelineList, PipelineRevision } from '../types';
import { Icon } from '../components/Icons';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';
import { useDocumentTitle } from '../hooks';

export function PipelinesPage() {
  useDocumentTitle('Pipelines');
  const [data, setData] = useState<PipelineList | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const path = `/api/v1/pipelines?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    api.get<PipelineList>(path)
      .then((result) => { if (!cancelled) { setData(result); setError(null); } })
      .catch((cause) => { if (!cancelled) setError(cause as Error); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cursor, reloadToken]);

  const items = (data?.items || []).filter((item) =>
    `${item.name} ${item.pipelineId}`.toLowerCase().includes(query.toLowerCase()));
  const hasServerPage = Boolean(data?.items.length);

  return (
    <div className="page-stack">
      <PageHeader
        title="Pipelines"
        description="Published typed pipelines and their immutable revisions. Editing is the next Studio milestone."
        actions={<button className="btn btn-secondary" onClick={() => setReloadToken((value) => value + 1)}><Icon name="refresh" size={15} /> Refresh</button>}
      />
      <section className="toolbar">
        <div className="search-box"><Icon name="search" size={16} /><input aria-label="Search pipelines" placeholder="Search by name or pipeline id" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <span className="toolbar-count">{items.length} shown on this page · search is page-local</span>
      </section>
      {loading && !data ? <Skeleton rows={5} /> : error ? <ErrorState error={error} onRetry={() => setReloadToken((value) => value + 1)} /> : items.length === 0 ? (
        <EmptyState icon="file" title={hasServerPage ? 'No pipelines match this page filter' : 'No pipelines yet'} description={hasServerPage ? 'Search is applied to the current server page. Clear the search, change pages, or refresh.' : 'Create a pipeline through the typed-pipeline API. The Studio editor is the next milestone.'} />
      ) : (
        <section className="panel table-panel">
          <table className="data-table">
            <thead><tr><th>Pipeline</th><th>Revision</th><th>Created</th><th>Updated</th><th aria-label="Open" /></tr></thead>
            <tbody>
              {items.map((pipeline) => (
                <tr key={pipeline.pipelineId} className="clickable" tabIndex={0}>
                  <td><Link to={`/pipelines/${encodeURIComponent(pipeline.pipelineId)}`}><strong>{pipeline.name}</strong><span className="mono block">{pipeline.pipelineId}</span></Link></td>
                  <td><span className="mono">r{pipeline.latestRevision}</span></td>
                  <td><TimeAgo value={pipeline.createdAt} /></td>
                  <td><TimeAgo value={pipeline.updatedAt} /></td>
                  <td className="row-action"><Icon name="chevron" size={16} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <div className="pagination-row">
        <button className="btn btn-secondary" disabled={!cursor} onClick={() => { setCursor(null); setCursorHistory([]); }}>First page</button>
        <button className="btn btn-secondary" disabled={!cursorHistory.length} onClick={() => {
          const previous = cursorHistory[cursorHistory.length - 1];
          setCursor(previous);
          setCursorHistory((items) => items.slice(0, -1));
        }}>Previous page</button>
        <button className="btn btn-secondary" disabled={!data?.nextCursor} onClick={() => {
          setCursorHistory((items) => [...items, cursor]);
          setCursor(data?.nextCursor || null);
        }}>Next page <Icon name="arrowRight" size={14} /></button>
      </div>
    </div>
  );
}

function NodeSummary({ definition }: { definition: PipelineDefinition }) {
  const meta: Record<string, string> = {
    'builtin.source.http_json': 'HTTP Source',
    'builtin.parse.json': 'Parse JSON',
    'builtin.map.fields': 'Map Fields',
    'builtin.filter.predicate': 'Filter',
    'builtin.validate.schema': 'Validate',
    'builtin.sink.dataset': 'Dataset Sink',
  };
  return (
    <div className="pipeline-flow" aria-label="Execution path">
      {definition.nodes.map((node, index) => (
        <React.Fragment key={node.nodeId}>
          <div className="flow-step">
            <span className="flow-index">{index + 1}</span>
            <strong>{meta[node.type] || node.type.split('.').slice(-1)[0]}</strong>
            <small>{node.nodeId}</small>
          </div>
          {index < definition.nodes.length - 1 && <span className="flow-arrow">→</span>}
        </React.Fragment>
      ))}
    </div>
  );
}

export function PipelineDetailPage() {
  const { pipelineId = '' } = useParams();
  useDocumentTitle('Pipeline detail');
  const [detail, setDetail] = useState<PipelineDetail | null>(null);
  const [jobs, setJobs] = useState<JobList | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<PipelineDetail>(`/api/v1/pipelines/${encodeURIComponent(pipelineId)}`),
      api.get<JobList>(`/api/v1/jobs?pipelineId=${encodeURIComponent(pipelineId)}&limit=5`).catch(() => ({ items: [], nextCursor: null })),
    ])
      .then(([result, jobResult]) => { if (!cancelled) { setDetail(result); setJobs(jobResult); setError(null); } })
      .catch((cause) => { if (!cancelled) setError(cause as Error); });
    return () => { cancelled = true; };
  }, [pipelineId]);
  if (error) return <ErrorState error={error} />;
  if (!detail) return <Skeleton rows={6} />;
  const latest = detail.latest;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Pipeline"
        title={detail.name}
        description={<span className="mono">{detail.pipelineId}</span>}
        actions={<><Link className="btn btn-secondary" to="/pipelines"><Icon name="arrowRight" size={15} /> All pipelines</Link><Link className="btn btn-primary" to={`/pipelines/${encodeURIComponent(detail.pipelineId)}/run`}><Icon name="activity" size={15} /> Run pipeline</Link><Link className="btn btn-secondary" to={`/pipelines/${encodeURIComponent(detail.pipelineId)}/editor`}><Icon name="ops" size={15} /> Open Studio</Link></>}
      />
      <section className="summary-grid pipeline-stats">
        <div className="panel metric-card"><span className="metric-label">Latest revision</span><strong className="metric-value">r{detail.latestRevision}</strong></div>
        <div className="panel metric-card"><span className="metric-label">Nodes</span><strong className="metric-value">{latest?.definition.nodes.length ?? 0}</strong></div>
        <div className="panel metric-card"><span className="metric-label">Latest run</span><strong className="metric-value small">{jobs?.items[0] ? <StatusBadge status={jobs.items[0].status} /> : 'No runs'}</strong></div>
        <div className="panel metric-card"><span className="metric-label">Updated</span><strong className="metric-value small"><TimeAgo value={latest?.publishedAt} /></strong></div>
      </section>
      {latest ? <section className="panel panel-pad"><div className="panel-head"><div><h2>Latest revision</h2><p className="muted small">{latest.definition.name} · {latest.digest}</p></div><StatusBadge status="READY" label="IMMUTABLE" /></div><NodeSummary definition={latest.definition} /></section> : <EmptyState icon="file" title="No published revision" />}
      <section className="panel panel-pad">
        <div className="panel-head"><div><h2>Revision history</h2><p className="muted small">Published revisions are immutable.</p></div></div>
        {detail.revisions.length === 0 ? <EmptyState icon="clock" title="No revisions" /> : (
          <ul className="revision-list">{detail.revisions.map((revision) => (
            <li key={revision.revision}><span className="mono">r{revision.revision}</span><span className="mono muted small">{revision.digest}</span><StatusBadge status="READY" label={revision.status} /><TimeAgo value={revision.publishedAt} /></li>
          ))}</ul>
        )}
      </section>
      <section className="panel panel-pad">
        <div className="panel-head"><div><h2>Recent jobs</h2><p className="muted small">Latest durable executions for this pipeline.</p></div><Link className="btn btn-secondary btn-small" to={`/pipelines/${encodeURIComponent(detail.pipelineId)}/run`}><Icon name="activity" size={14} /> Submit job</Link></div>
        {!jobs || jobs.items.length === 0 ? <p className="muted small">No jobs submitted for this pipeline.</p> : (
          <div className="table-panel"><table className="data-table job-mini-table"><thead><tr><th>Job</th><th>Revision</th><th>Status</th><th>Created</th></tr></thead><tbody>{jobs.items.map((job) => <tr key={job.jobId}><td><Link className="mono truncate" title={job.jobId} to={`/jobs/${job.jobId}`}>{job.jobId}</Link></td><td><span className="mono">r{job.pipelineRevision}</span></td><td><StatusBadge status={job.status} /></td><td><TimeAgo value={job.createdAt} /></td></tr>)}</tbody></table></div>
        )}
      </section>
      <p className="table-footnote"><Icon name="alert" size={13} /> Published revisions are immutable. Draft editing and publishing are a separate gate.</p>
    </div>
  );
}

export { PipelineEditorPage } from '../studio/PipelineEditor';
