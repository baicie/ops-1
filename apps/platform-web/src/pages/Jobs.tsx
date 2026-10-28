import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { newIdempotencyKey } from '../api';
import type { JobDiagnostics, JobList, JobResultView, JobView, PipelineDetail } from '../types';
import { Icon } from '../components/Icons';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';
import { useDocumentTitle } from '../hooks';
import { executionLabel as durationLabel, spanLabel } from './jobDuration';
import { useT } from '../i18n';

export function JobsPage() {
  const t = useT();
  useDocumentTitle(t('page.jobs'));
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
      <PageHeader title={t('page.jobs')} description={t('jobs.description')} actions={<button className="btn btn-secondary" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.refresh')}</button>} />
      <section className="toolbar">
        <div className="search-box"><Icon name="search" size={16} /><input aria-label={t('jobs.search.aria')} placeholder={t('jobs.search.placeholder')} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <select aria-label={t('jobs.filter.aria')} value={pipelineFilter} onChange={(event) => setPipelineFilter(event.target.value)} style={{ maxWidth: 240 }}><option value="ALL">{t('jobs.filter.allPipelines')}</option>{pipelines.map((pipeline) => <option key={pipeline} value={pipeline}>{pipeline}</option>)}</select>
        <div className="segmented">{['ALL', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'].map((value) => <button key={value} className={status === value ? 'active' : ''} onClick={() => { setStatus(value); setCursor(null); }}>{value === 'ALL' ? t('common.all') : value}</button>)}</div>
        <span className="toolbar-count">{t('jobs.count', { shown: visibleJobs.length, total: data?.items.length ?? 0 })}</span>
      </section>
      {loading && !data ? <Skeleton rows={6} /> : error ? <ErrorState error={error} onRetry={() => setReload((value) => value + 1)} /> : visibleJobs.length === 0 ? <EmptyState icon="clock" title={data?.items.length ? t('jobs.empty.filtered.title') : t('jobs.empty.none.title')} description={data?.items.length ? t('jobs.empty.filtered.description') : t('jobs.empty.none.description')} /> : (
        <section className="panel table-panel"><table className="data-table responsive-table jobs-table"><thead><tr><th>{t('table.job')}</th><th>{t('table.pipeline')}</th><th>{t('table.revision')}</th><th>{t('table.status')}</th><th>{t('table.attempts')}</th><th>{t('table.duration')}</th><th>{t('table.created')}</th><th /></tr></thead><tbody>
          {visibleJobs.map((job) => <tr key={job.jobId} className="clickable"><td data-label={t('table.job')} className="job-id-cell"><Link className="mono truncate" title={job.jobId} to={`/jobs/${job.jobId}`}>{job.jobId}</Link></td><td data-label={t('table.pipeline')}>{job.pipelineId}</td><td data-label={t('table.revision')}><span className="mono">r{job.pipelineRevision}</span></td><td data-label={t('table.status')}><StatusBadge status={job.status} /></td><td data-label={t('table.attempts')}>{job.attempts}/{job.maxAttempts}</td><td data-label={t('table.duration')}><span className="mono">{durationLabel(job)}</span></td><td data-label={t('table.created')}><TimeAgo value={job.createdAt} /></td><td className="row-action"><Icon name="chevron" size={16} /></td></tr>)}
        </tbody></table></section>
      )}
      <div className="pagination-row"><button className="btn btn-secondary" disabled={!cursor} onClick={() => setCursor(null)}>{t('pipelines.pagination.first')}</button><button className="btn btn-secondary" disabled={!data?.nextCursor} onClick={() => setCursor(data?.nextCursor || null)}>{t('pipelines.pagination.next')}</button></div>
    </div>
  );
}

export function JobDetailPage() {
  const t = useT();
  const { jobId = '' } = useParams();
  useDocumentTitle(t('page.jobDetail'));
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
      <PageHeader eyebrow={t('jobs.eyebrow')} title={job.pipelineId} description={<span className="job-subtitle"><StatusBadge status={job.status} /><span>{t('jobs.revision', { revision: job.pipelineRevision })}</span><span className="job-short-id" title={job.jobId}>{t('jobs.runShortId', { id: job.jobId.slice(0, 8) })}</span></span>} actions={<>{['QUEUED','CLAIMED','RUNNING'].includes(job.status) && <button className="btn btn-danger" onClick={() => void cancel()}><Icon name="pause" size={15} /> {t('action.cancel')}</button>}<button className="btn btn-secondary" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.refresh')}</button><Link className="btn btn-secondary" to="/jobs">{t('jobs.action.allJobs')}</Link></>} />
      <section className="summary-grid job-stats">
        <div className="panel metric-card"><span className="metric-label">{t('table.status')}</span><strong className="metric-value"><StatusBadge status={job.status} /></strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('jobs.metric.execution')}</span><strong className="metric-value mono">{durationLabel(job)}</strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('table.pipeline')}</span><strong className="metric-value mono">{job.pipelineId}</strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('table.revision')}</span><strong className="metric-value">r{job.pipelineRevision}</strong></div>
      </section>
      <details className="advanced panel"><summary>{t('jobs.advanced.summary')}</summary><div className="kv-grid"><div className="kv"><span className="kv-label">{t('jobs.field.jobId')}</span><button type="button" className="link-button mono" title={t('jobs.copyJobId')} onClick={() => void navigator.clipboard?.writeText(job.jobId)}>{job.jobId}</button></div><div className="kv"><span className="kv-label">{t('table.attempts')}</span><span className="kv-value mono">{job.attempts} / {job.maxAttempts}</span></div><div className="kv"><span className="kv-label">{t('jobs.field.fence')}</span><span className="kv-value mono">{job.currentFence}</span></div><div className="kv"><span className="kv-label">{t('jobs.field.lease')}</span><span className="kv-value mono">{job.currentLeaseId || '—'}</span></div><div className="kv"><span className="kv-label">{t('jobs.field.queueWait')}</span><span className="kv-value mono">{spanLabel(job.createdAt, job.startedAt)}</span></div><div className="kv"><span className="kv-label">{t('jobs.field.totalElapsed')}</span><span className="kv-value mono">{spanLabel(job.createdAt, job.finishedAt)}</span></div><div className="kv"><span className="kv-label">{t('table.updated')}</span><span className="kv-value mono">{new Date(job.updatedAt).toISOString()}</span></div></div></details>
      <section className="panel panel-pad"><h2>{t('jobs.lifecycle.title')}</h2><ul className="detail-list"><li><span>{t('table.created')}</span><TimeAgo value={job.createdAt} /></li><li><span>{t('table.updated')}</span><TimeAgo value={job.updatedAt} /></li><li><span>{t('jobs.field.errorCode')}</span><code>{job.lastErrorCode || '—'}</code></li></ul><p className="muted small">{t('jobs.lifecycle.note')}</p></section>
      <section className="panel panel-pad"><h2>{t('jobs.timeline.title')}</h2>{!diagnostics ? <p className="muted small">{t('jobs.timeline.unavailable')}</p> : diagnostics.events.length === 0 ? <p className="muted small">{t('jobs.timeline.empty')}</p> : <ol className="timeline">{diagnostics.events.map((event) => <li key={event.eventId}><span className="timeline-dot" /><div><strong>{event.eventType}</strong>{event.toStatus && <span className="tag">{event.toStatus}</span>}{event.fencingSequence != null && <span className="muted small">{t('jobs.timeline.fence', { fence: event.fencingSequence })}</span>}<TimeAgo value={event.occurredAt} /></div></li>)}</ol>}{diagnostics?.truncated && <p className="muted small">{t('jobs.timeline.truncated')}</p>}</section>
      {diagnostics && diagnostics.attempts.length > 0 && <section className="panel panel-pad"><h2>{t('table.attempts')}</h2><div className="table-panel"><table className="data-table"><thead><tr><th>{t('jobs.field.attempt')}</th><th>{t('table.status')}</th><th>{t('jobs.field.fence')}</th><th>{t('table.node')}</th><th>{t('table.started')}</th></tr></thead><tbody>{diagnostics.attempts.map((attempt) => <tr key={attempt.attemptNumber}><td>#{attempt.attemptNumber}</td><td><StatusBadge status={attempt.status} /></td><td className="mono">{attempt.fencingSequence}</td><td className="mono small">{attempt.nodeId}</td><td><TimeAgo value={attempt.startedAt} /></td></tr>)}</tbody></table></div></section>}
      {diagnostics && diagnostics.checkpoints.length > 0 && <section className="panel panel-pad"><h2>{t('jobs.checkpoints.title')}</h2><ul className="detail-list">{diagnostics.checkpoints.map((checkpoint) => <li key={checkpoint.checkpointId}><span>{t('jobs.checkpoints.entry', { attempt: checkpoint.attemptNumber, sequence: checkpoint.sequence })}</span><code className="mono small">{checkpoint.stateDigest}</code></li>)}</ul></section>}
      {result ? <section className="panel panel-pad"><h2>{t('table.result')}</h2><p className="small">{t('table.status')} <StatusBadge status={result.status} /></p>{result.errorCode && <div className="studio-banner studio-banner-error"><strong>{result.errorCode}</strong> {result.errorMessage}</div>}<pre className="result-json">{JSON.stringify(result.output, null, 2)}</pre><details className="advanced"><summary>{t('jobs.result.metadata')}</summary><p className="mono small">{result.resultDigest || t('jobs.result.noDigest')}</p></details></section> : resultError ? <p className="muted small">{t('jobs.result.error', { message: resultError })}</p> : null}
    </div>
  );
}

export function JobSubmitPage() {
  const t = useT();
  const { pipelineId = '' } = useParams();
  const navigate = useNavigate();
  useDocumentTitle(t('page.runPipeline'));
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
      try { parsed = JSON.parse(input); } catch { throw new Error(t('jobs.submit.invalidJson')); }
      const job = await api.post<JobView>('/api/v1/jobs', { pipelineId, pipelineRevision: revision, input: parsed }, newIdempotencyKey());
      navigate(`/jobs/${job.jobId}`);
    } catch (cause) { setError((cause as Error).message); } finally { setSubmitting(false); }
  };
  return (
    <div className="page-stack">
      <PageHeader eyebrow={t('jobs.eyebrow')} title={detail.name} description={t('jobs.submit.description', { pipelineId })} />
      {error && <div className="studio-banner studio-banner-error" role="alert">{error}</div>}
      <section className="panel panel-pad run-panel">
        <label><span>{t('jobs.submit.publishedRevision')}</span><select value={revision ?? ''} onChange={(event) => setRevision(Number(event.target.value))}>{detail.revisions.map((item) => <option key={item.revision} value={item.revision}>r{item.revision} · {item.status}</option>)}</select></label>
        <label><span>{t('jobs.submit.inputJson')}</span><textarea rows={10} value={input} onChange={(event) => setInput(event.target.value)} /></label>
        <button className="btn btn-primary" onClick={() => void submit()} disabled={submitting || revision === null}>{submitting ? t('jobs.submit.submitting') : t('pipelines.jobs.submit')}</button>
        <p className="muted small">{t('jobs.submit.note')}</p>
      </section>
    </div>
  );
}


