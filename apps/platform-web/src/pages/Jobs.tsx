import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { newIdempotencyKey } from '../api';
import type { JobDiagnostics, JobList, JobResultView, JobView, PipelineDetail } from '../types';
import { Icon } from '../components/Icons';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';
import { useDocumentTitle } from '../hooks';

function durationLabel(job: JobView) {
  const ms = Math.max(0, new Date(job.updatedAt).getTime() - new Date(job.createdAt).getTime());
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function JobsPage() {
  useDocumentTitle('Jobs');
  const [data, setData] = useState<JobList | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [status, setStatus] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const [pipelineFilter, setPipelineFilter] = useState('ALL');
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
  const visibleJobs = (data?.items || []).filter((job) => (pipelineFilter === 'ALL' || job.pipelineId === pipelineFilter) && `${job.jobId} ${job.pipelineId}`.toLowerCase().includes(query.toLowerCase()));
  const pipelines = Array.from(new Set((data?.items || []).map((job) => job.pipelineId))).sort();
  return (
    <div className="page-stack">
      <PageHeader title="Jobs" description="Durable typed-pipeline executions and their current lifecycle state." actions={<button className="btn btn-secondary" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> Refresh</button>} />
      <section className="toolbar">
        <div className="search-box"><Icon name="search" size={16} /><input aria-label="Search jobs" placeholder="Search job ID or pipeline" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <select aria-label="Filter by pipeline" value={pipelineFilter} onChange={(event) => setPipelineFilter(event.target.value)} style={{ maxWidth: 240 }}><option value="ALL">All pipelines</option>{pipelines.map((pipeline) => <option key={pipeline} value={pipeline}>{pipeline}</option>)}</select>
        <div className="segmented">{['ALL', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].map((value) => <button key={value} className={status === value ? 'active' : ''} onClick={() => { setStatus(value); setCursor(null); }}>{value === 'ALL' ? 'All' : value}</button>)}</div>
        <span className="toolbar-count">{visibleJobs.length} of {data?.items.length ?? 0} shown</span>
      </section>
      {loading && !data ? <Skeleton rows={6} /> : error ? <ErrorState error={error} onRetry={() => setReload((value) => value + 1)} /> : visibleJobs.length === 0 ? <EmptyState icon="clock" title={data?.items.length ? 'No jobs match this filter' : 'No jobs'} description={data?.items.length ? 'Clear search or choose another pipeline/status.' : 'Publish a revision and submit a run from its Pipeline detail page.'} /> : (
        <section className="panel table-panel"><table className="data-table responsive-table"><thead><tr><th>Job</th><th>Pipeline</th><th>Revision</th><th>Status</th><th>Attempts</th><th>Duration</th><th>Created</th><th /></tr></thead><tbody>
          {visibleJobs.map((job) => <tr key={job.jobId} className="clickable"><td data-label="Job" className="job-id-cell"><Link className="mono truncate" title={job.jobId} to={`/jobs/${job.jobId}`}>{job.jobId}</Link></td><td data-label="Pipeline">{job.pipelineId}</td><td data-label="Revision"><span className="mono">r{job.pipelineRevision}</span></td><td data-label="Status"><StatusBadge status={job.status} /></td><td data-label="Attempts">{job.attempts}/{job.maxAttempts}</td><td data-label="Duration"><span className="mono">{durationLabel(job)}</span></td><td data-label="Created"><TimeAgo value={job.createdAt} /></td><td className="row-action"><Icon name="chevron" size={16} /></td></tr>)}
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
  const [result, setResult] = useState<JobResultView | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<JobDiagnostics | null>(null);
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
        } else {
          api.get<JobResultView>(`/api/v1/jobs/${encodeURIComponent(jobId)}/result`)
            .then(setResult)
            .catch((cause) => setResultError((cause as Error).message));
        }
        api.get<JobDiagnostics>(`/api/v1/jobs/${encodeURIComponent(jobId)}/diagnostics`)
          .then(setDiagnostics)
          .catch(() => undefined);
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
      <PageHeader eyebrow="Run" title={job.pipelineId} description={<span className="job-subtitle"><StatusBadge status={job.status} /><span>Revision r{job.pipelineRevision}</span><span className="job-short-id" title={job.jobId}>Run {job.jobId.slice(0, 8)}</span></span>} actions={<>{['QUEUED','CLAIMED','RUNNING'].includes(job.status) && <button className="btn btn-danger" onClick={() => void cancel()}><Icon name="pause" size={15} /> Cancel</button>}<button className="btn btn-secondary" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" size={15} /> Refresh</button><Link className="btn btn-secondary" to="/jobs">All jobs</Link></>} />
      <section className="summary-grid job-stats">
        <div className="panel metric-card"><span className="metric-label">Status</span><strong className="metric-value"><StatusBadge status={job.status} /></strong></div>
        <div className="panel metric-card"><span className="metric-label">Attempts</span><strong className="metric-value">{job.attempts} / {job.maxAttempts}</strong></div>
        <div className="panel metric-card"><span className="metric-label">Pipeline</span><strong className="metric-value mono">{job.pipelineId}</strong></div>
        <div className="panel metric-card"><span className="metric-label">Revision</span><strong className="metric-value">r{job.pipelineRevision}</strong></div>
      </section>
      <details className="advanced panel"><summary>Advanced · full Job ID, fence and lease</summary><div className="kv-grid"><div className="kv"><span className="kv-label">Job ID</span><span className="kv-value mono copyable" onClick={() => void navigator.clipboard?.writeText(job.jobId)} title="Click to copy">{job.jobId}</span></div><div className="kv"><span className="kv-label">Fence</span><span className="kv-value mono">{job.currentFence}</span></div><div className="kv"><span className="kv-label">Lease</span><span className="kv-value mono">{job.currentLeaseId || '—'}</span></div></div></details>
      <section className="panel panel-pad"><h2>Lifecycle</h2><ul className="detail-list"><li><span>Created</span><TimeAgo value={job.createdAt} /></li><li><span>Updated</span><TimeAgo value={job.updatedAt} /></li><li><span>Error code</span><code>{job.lastErrorCode || '—'}</code></li></ul><p className="muted small">Attempt counts and the durable result are shown from Kernel records; checkpoint diagnostics require a dedicated diagnostics API.</p></section>
      <section className="panel panel-pad"><h2>Timeline</h2>{!diagnostics ? <p className="muted small">Diagnostics unavailable.</p> : diagnostics.events.length === 0 ? <p className="muted small">No events recorded.</p> : <ol className="timeline">{diagnostics.events.map((event) => <li key={event.eventId}><span className="timeline-dot" /><div><strong>{event.eventType}</strong>{event.toStatus && <span className="tag">{event.toStatus}</span>}{event.fencingSequence != null && <span className="muted small">fence {event.fencingSequence}</span>}<TimeAgo value={event.occurredAt} /></div></li>)}</ol>}{diagnostics?.truncated && <p className="muted small">Timeline truncated at 500 events.</p>}</section>
      {diagnostics && diagnostics.attempts.length > 0 && <section className="panel panel-pad"><h2>Attempts</h2><div className="table-panel"><table className="data-table"><thead><tr><th>Attempt</th><th>Status</th><th>Fence</th><th>Node</th><th>Started</th></tr></thead><tbody>{diagnostics.attempts.map((attempt) => <tr key={attempt.attemptNumber}><td>#{attempt.attemptNumber}</td><td><StatusBadge status={attempt.status} /></td><td className="mono">{attempt.fencingSequence}</td><td className="mono small">{attempt.nodeId}</td><td><TimeAgo value={attempt.startedAt} /></td></tr>)}</tbody></table></div></section>}
      {diagnostics && diagnostics.checkpoints.length > 0 && <section className="panel panel-pad"><h2>Checkpoints</h2><ul className="detail-list">{diagnostics.checkpoints.map((checkpoint) => <li key={checkpoint.checkpointId}><span>Attempt {checkpoint.attemptNumber} · sequence {checkpoint.sequence}</span><code className="mono small">{checkpoint.stateDigest}</code></li>)}</ul></section>}
      {result ? <section className="panel panel-pad"><h2>Result</h2><p className="small">Status <StatusBadge status={result.status} /> · Digest <code className="mono">{result.resultDigest || '—'}</code></p>{result.errorCode && <div className="studio-banner studio-banner-error"><strong>{result.errorCode}</strong> {result.errorMessage}</div>}<pre className="result-json">{JSON.stringify(result.output, null, 2)}</pre></section> : resultError ? <p className="muted small">Result: {resultError}</p> : null}
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


