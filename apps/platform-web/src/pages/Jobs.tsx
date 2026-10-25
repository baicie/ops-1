import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { newIdempotencyKey } from '../api';
import type { JobList, JobView, PipelineDetail } from '../types';
import { Icon } from '../components/Icons';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';
import { useDocumentTitle } from '../hooks';

export function JobsPage() {
  useDocumentTitle('Jobs');
  const [data, setData] = useState<JobList | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [status, setStatus] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ limit: '20' });
    if (status !== 'ALL') params.set('status', status);
    if (cursor) params.set('cursor', cursor);
    api.get<JobList>(`/api/v1/jobs?${params}`)
      .then((result) => { if (!cancelled) { setData(result); setError(null); } })
      .catch((cause) => { if (!cancelled) setError(cause as Error); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [status, cursor, reload]);
  return (
    <div className="page-stack">
      <PageHeader title="Jobs" description="Durable typed-pipeline executions and their current lifecycle state." actions={<button className="btn btn-secondary" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> Refresh</button>} />
      <section className="toolbar">
        <div className="segmented">{['ALL', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].map((value) => <button key={value} className={status === value ? 'active' : ''} onClick={() => { setStatus(value); setCursor(null); }}>{value === 'ALL' ? 'All' : value}</button>)}</div>
        <span className="toolbar-count">{data?.items.length ?? 0} shown</span>
      </section>
      {loading && !data ? <Skeleton rows={6} /> : error ? <ErrorState error={error} onRetry={() => setReload((value) => value + 1)} /> : (data?.items.length ?? 0) === 0 ? <EmptyState icon="clock" title="No jobs" description="Publish a revision and submit a run from its Pipeline detail page." /> : (
        <section className="panel table-panel"><table className="data-table"><thead><tr><th>Job</th><th>Pipeline</th><th>Revision</th><th>Status</th><th>Attempts</th><th>Created</th><th /></tr></thead><tbody>
          {data?.items.map((job) => <tr key={job.jobId} className="clickable"><td><Link className="mono" to={`/jobs/${job.jobId}`}>{job.jobId}</Link></td><td>{job.pipelineId}</td><td><span className="mono">r{job.pipelineRevision}</span></td><td><StatusBadge status={job.status} /></td><td>{job.attempts}/{job.maxAttempts}</td><td><TimeAgo value={job.createdAt} /></td><td className="row-action"><Icon name="chevron" size={16} /></td></tr>)}
        </tbody></table></section>
      )}
      <div className="pagination-row"><button className="btn btn-secondary" disabled={!cursor} onClick={() => setCursor(null)}>First page</button><button className="btn btn-secondary" disabled={!data?.nextCursor} onClick={() => setCursor(data?.nextCursor || null)}>Next page</button></div>
    </div>
  );
}

export function JobDetailPage() {
  const { jobId = '' } = useParams();
  useDocumentTitle('Job detail');
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => api.get<JobView>(`/api/v1/jobs/${encodeURIComponent(jobId)}`)
      .then((result) => {
        if (cancelled) return;
        setJob(result); setError(null);
        if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(result.status)) {
          window.setTimeout(load, 3000);
        }
      })
      .catch((cause) => { if (!cancelled) setError(cause as Error); });
    void load();
    return () => { cancelled = true; };
  }, [jobId, refresh]);

  const cancel = async () => {
    try {
      await api.post(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {}, newIdempotencyKey());
      setRefresh((value) => value + 1);
    } catch (cause) { setError(cause as Error); }
  };
  if (error) return <ErrorState error={error} onRetry={() => setRefresh((value) => value + 1)} />;
  if (!job) return <Skeleton rows={6} />;
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Job" title={<span className="mono">{job.jobId}</span>} description={`${job.pipelineId} · r${job.pipelineRevision}`} actions={<>{['QUEUED','CLAIMED','RUNNING'].includes(job.status) && <button className="btn btn-danger" onClick={() => void cancel()}><Icon name="pause" size={15} /> Cancel</button>}<button className="btn btn-secondary" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" size={15} /> Refresh</button><Link className="btn btn-secondary" to="/jobs">All jobs</Link></>} />
      <section className="summary-grid">
        <div className="panel metric-card"><span className="metric-label">Status</span><strong className="metric-value"><StatusBadge status={job.status} /></strong></div>
        <div className="panel metric-card"><span className="metric-label">Attempts</span><strong className="metric-value">{job.attempts} / {job.maxAttempts}</strong></div>
        <div className="panel metric-card"><span className="metric-label">Fence</span><strong className="metric-value mono">{job.currentFence}</strong></div>
        <div className="panel metric-card"><span className="metric-label">Lease</span><strong className="metric-value mono small">{job.currentLeaseId || '—'}</strong></div>
      </section>
      <section className="panel panel-pad"><h2>Lifecycle</h2><ul className="detail-list"><li><span>Created</span><TimeAgo value={job.createdAt} /></li><li><span>Updated</span><TimeAgo value={job.updatedAt} /></li><li><span>Error code</span><code>{job.lastErrorCode || '—'}</code></li></ul><p className="muted small">Attempt and checkpoint diagnostics require the dedicated diagnostics API; this page shows only durable Job fields returned by the Kernel.</p></section>
    </div>
  );
}

export function JobSubmitPage() {
  const { pipelineId = '' } = useParams();
  const navigate = useNavigate();
  useDocumentTitle('Run pipeline');
  const [detail, setDetail] = useState<PipelineDetail | null>(null);
  const [input, setInput] = useState('{}');
  const [revision, setRevision] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { api.get<PipelineDetail>(`/api/v1/pipelines/${encodeURIComponent(pipelineId)}`).then((value) => { setDetail(value); setRevision(value.latestRevision); }).catch((cause) => setError((cause as Error).message)); }, [pipelineId]);
  if (!detail) return error ? <ErrorState error={new Error(error)} /> : <Skeleton rows={5} />;
  const submit = async () => {
    setSubmitting(true); setError(null);
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(input); } catch { throw new Error('Input must be valid JSON'); }
      const job = await api.post<JobView>('/api/v1/jobs', { pipelineId, pipelineRevision: revision, input: parsed }, newIdempotencyKey());
      navigate(`/jobs/${job.jobId}`);
    } catch (cause) { setError((cause as Error).message); } finally { setSubmitting(false); }
  };
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Run" title={detail.name} description={`${pipelineId} · choose a published revision`} />
      {error && <div className="studio-banner studio-banner-error" role="alert">{error}</div>}
      <section className="panel panel-pad run-panel">
        <label><span>Published revision</span><select value={revision ?? ''} onChange={(event) => setRevision(Number(event.target.value))}>{detail.revisions.map((item) => <option key={item.revision} value={item.revision}>r{item.revision} · {item.status}</option>)}</select></label>
        <label><span>Input JSON</span><textarea rows={10} value={input} onChange={(event) => setInput(event.target.value)} /></label>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={submitting || revision === null}>{submitting ? 'Submitting…' : 'Submit job'}</button>
        <p className="muted small">Drafts cannot be executed. Only immutable published revisions can be submitted.</p>
      </section>
    </div>
  );
}


