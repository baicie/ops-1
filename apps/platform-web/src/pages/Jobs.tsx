import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { newIdempotencyKey } from '../api';
import type { JobDiagnostics, JobList, JobResultView, JobView, PipelineDetail } from '../types';
import { Icon } from '../components/Icons';
import { Button, buttonVariants } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { EmptyState, TimeAgo } from '../components/Ui';
import { AsyncBoundary } from '../components/app/async-boundary';
import { ConfirmAction } from '../components/app/confirm-action';
import { PageHeader } from '../components/app/page-header';
import { useDocumentTitle } from '../hooks';
import { executionLabel as durationLabel, spanLabel } from './jobDuration';
import { useI18n, useT } from '../i18n';
import { cn } from '../lib/utils';
import { identityDisambiguator } from '../lib/identity';
import { shortDigest } from '../format';
import { verifiedWriteFailure, verifyAfterWrite } from '../lib/verify-after-write';
import { describeJobStatus, jobCancelledLanded } from '../lib/verified-writes';
import { IdentityCell, LongId, RowActions, StackCell, StatusPill, cardActionCell, cardCellClass, cardLineAfter, cardTwoLineRow, copyIdAction, formatIdentity, rankCardFacts, relativeAge, stackBody, stackHead, stackRow, stackTable } from './table-kit';
import { useStatusText } from '../components/app/status';

const STATUS_FILTERS = ['ALL', 'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'];

export function JobsPage() {
  const t = useT();
  const { locale } = useI18n();
  const navigate = useNavigate();
  // The status chips are the one place this page printed a wire code instead of copy: "QUEUED
  // RUNNING SUCCEEDED…" at the body tier was the loudest thing above the fold, and in zh-CN it was
  // English. Same vocabulary as the pill in each row, from the same table.
  const statusText = useStatusText();
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
  /** §2.1: the disambiguator appears only when the page carries the same name twice. */
  const pipelineCount = new Set(visibleJobs.map((job) => job.pipelineId)).size;
  /** The status tab is a Kernel query, so an empty answer under it is a filtered miss. */
  const filtering = query !== '' || pipelineFilter !== 'ALL' || status !== 'ALL';
  const clearFilters = () => { setQuery(''); setPipelineFilter('ALL'); setStatus('ALL'); setCursor(null); };
  return (
    <div className="page-stack">
      <PageHeader title={t('page.jobs')} description={t('jobs.description')} actions={<Button variant="secondary" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>} />
      <section className="toolbar">
        <div className="relative flex min-w-[260px] max-w-[460px] flex-1 items-center">
          <Icon name="search" size={16} className="absolute left-[10px] text-muted-foreground" />
          <Input aria-label={t('jobs.search.aria')} placeholder={t('jobs.search.placeholder')} value={query} onChange={(event) => setQuery(event.target.value)} className="pl-[33px]" />
        </div>
        <Select value={pipelineFilter} onValueChange={setPipelineFilter}>
          <SelectTrigger aria-label={t('jobs.filter.aria')} className="w-[240px] max-w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">{t('jobs.filter.allPipelines')}</SelectItem>
            {pipelines.map((pipeline) => <SelectItem key={pipeline} value={pipeline}>{pipeline}</SelectItem>)}
          </SelectContent>
        </Select>
        <Tabs value={status} onValueChange={(value) => { setStatus(value); setCursor(null); }}>
          <TabsList className="h-auto max-w-full flex-wrap justify-start">
            {STATUS_FILTERS.map((value) => <TabsTrigger key={value} value={value}>{value === 'ALL' ? t('common.all') : statusText(value)}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <span className="toolbar-count">{t('jobs.count', { shown: visibleJobs.length, total: data?.items.length ?? 0 })}</span>
      </section>
      <AsyncBoundary
        loading={loading}
        // A page that already shows rows keeps them when a later refresh fails; only a first
        // load with nothing to show becomes the error panel.
        error={data ? null : error}
        hasData={Boolean(data)}
        skeletonRows={6}
        onRetry={() => setReload((value) => value + 1)}
      >
        {visibleJobs.length === 0 ? (
          <div data-empty-state={filtering ? 'filtered' : 'none'}>
            <EmptyState
              icon="clock"
              title={filtering ? t('jobs.empty.filtered.title') : t('jobs.empty.none.title')}
              description={filtering ? t('jobs.empty.filtered.description') : t('jobs.empty.none.description')}
              action={filtering ? <Button variant="secondary" onClick={clearFilters}>{t('ui.clearFilters')}</Button> : undefined}
            />
          </div>
        ) : (
          <section className="panel table-panel">
            <Table className={stackTable}>
              {/* table-spec §2.2: pipeline and revision are the same value in 14/14 rows here
                  (ratio 0.00 and 0.07), so they stop being columns. 7 -> 4 data columns. */}
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('table.job')}</TableHead>
                  <TableHead>{t('table.status')}</TableHead>
                  <TableHead>{t('table.duration')}</TableHead>
                  <TableHead>{t('table.created')}</TableHead>
                  <TableHead aria-label={t('table.actions')} />
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {visibleJobs.map((job) => {
                  const identity = formatIdentity({
                    name: job.pipelineId,
                    id: job.jobId,
                    at: job.startedAt || job.createdAt,
                    locale,
                    nameIsUnique: pipelineCount === visibleJobs.length,
                    rowsOnPage: visibleJobs.length,
                  });
                  const cardFacts = rankCardFacts({
                    status: visibleJobs.map((row) => row.status),
                    duration: visibleJobs.map((row) => durationLabel(row)),
                    created: visibleJobs.map((row) => row.createdAt),
                  });
                  // §2.5 at 390: two lines, not five. The identity, the status and the menu share the
                  // first one; the qualifier line continues into duration and age on the second.
                  return (
                    <TableRow key={job.jobId} className={cn('cursor-pointer max-[768px]:relative', cardTwoLineRow, stackRow)} data-job-row={job.jobId} onClick={() => navigate('/admin/jobs/' + job.jobId)} tabIndex={0} onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter') navigate('/admin/jobs/' + job.jobId); }}>
                      <IdentityCell label={t('table.job')} identity={identity} cardFact className="job-id-cell">
                        {/* §2.2 demotion, not deletion: the two constants live on the qualifier line. */}
                        <span className="ow-key">r{job.pipelineRevision}</span>
                        <span className="ow-key">{t('table.attempts')} {job.attempts}/{job.maxAttempts}</span>
                      </IdentityCell>
                      <StackCell label={t('table.status')} className={cardCellClass(cardFacts.includes('status'))}><StatusPill status={job.status} /></StackCell>
                      {/* The column name is not printed on the card (the line above it is the heading) but it
                          is not deleted either: data-label, the desktop header, and this tooltip keep it. */}
                      <StackCell label={t('table.duration')} className={cn('whitespace-nowrap max-[768px]:whitespace-normal', cardLineAfter, cardCellClass(cardFacts.includes('duration')))}><span className="mono" title={t('table.duration')}>{durationLabel(job)}</span></StackCell>
                      <StackCell label={t('table.created')} className={cn(cardLineAfter, cardCellClass(cardFacts.includes('created')))}><span title={job.createdAt}>{relativeAge(locale, job.createdAt)}</span></StackCell>
                      {/* §2.5: the row menu rides the identity line at 390 instead of taking a row. */}
                      <TableCell className={cardActionCell}>
                        <RowActions label={t('jobs.action.menu', { id: identity.key })} actions={[copyIdAction(job.jobId, t('table.copyIdentifier')), { id: 'open', label: t('table.open'), icon: 'chevron', onSelect: () => navigate('/admin/jobs/' + job.jobId) }]} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </section>
        )}
      </AsyncBoundary>
      <div className="pagination-row"><Button variant="secondary" disabled={!cursor} onClick={() => setCursor(null)}>{t('pipelines.pagination.first')}</Button><Button variant="secondary" disabled={!data?.nextCursor} onClick={() => setCursor(data?.nextCursor || null)}>{t('pipelines.pagination.next')}</Button></div>
    </div>
  );
}

/** The title block of every state of a job detail page, including the ones with no payload yet. */
function JobDetailHeader({ jobId, subtitle, actions }: { jobId: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  const t = useT();
  return (
    <PageHeader
      eyebrow={t('jobs.eyebrow')}
      title={t('page.jobDetail')}
      description={<span className="job-subtitle"><span className="job-short-id" title={jobId} data-testid="job-short-id">{t('jobs.runShortId', { id: identityDisambiguator(jobId) })}</span>{subtitle}</span>}
      actions={actions}
    />
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
  const [cancelOpen, setCancelOpen] = useState(false);
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

  /**
   * Cancelling ends the run for good: confirmation, one in-flight request, retry on failure.
   *
   * The 200 from /cancel is the Kernel accepting the request, not the job being cancelled - a
   * job whose worker just took a lease can answer 200 and keep running. Only the job route
   * reporting CANCELLED is the cancellation, and anything else is printed as what it is.
   */
  const cancelJob = async () => {
    const result = await verifyAfterWrite<JobView>({
      write: () => api.post(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {}, newIdempotencyKey()),
      read: () => api.get<JobView>(`/api/v1/jobs/${encodeURIComponent(jobId)}`),
      expected: jobCancelledLanded,
      describe: describeJobStatus,
    });
    const failure = verifiedWriteFailure(result, t);
    setRefresh((value) => value + 1);
    // ConfirmAction keeps the dialog open on a rejection, so the operator reads the state that
    // is really there instead of a closed dialog and a job that is still running.
    if (failure) throw failure;
  };
  if (error) return (
    <div className="page-stack">
      <JobDetailHeader jobId={jobId} actions={<Link className={buttonVariants({ variant: 'secondary' })} to="/admin/jobs">{t('jobs.action.allJobs')}</Link>} />
      <AsyncBoundary loading={false} error={error} hasData={false} onRetry={() => setRefresh((value) => value + 1)}>{null}</AsyncBoundary>
    </div>
  );
  if (!job) return (
    <div className="page-stack">
      <JobDetailHeader jobId={jobId} actions={<Link className={buttonVariants({ variant: 'secondary' })} to="/admin/jobs">{t('jobs.action.allJobs')}</Link>} />
      <AsyncBoundary loading hasData={false} error={null}>{null}</AsyncBoundary>
    </div>
  );
  const cancellable = ['QUEUED', 'CLAIMED', 'RUNNING'].includes(job.status);
  return (
    <div className="page-stack">
      <PageHeader eyebrow={t('jobs.eyebrow')} title={job.pipelineId} description={<span className="job-subtitle"><StatusPill status={job.status} /><span>{t('jobs.revision', { revision: job.pipelineRevision })}</span><span className="job-short-id" title={job.jobId} data-testid="job-short-id">{t('jobs.runShortId', { id: identityDisambiguator(job.jobId) })}</span></span>} actions={<>{cancellable && <Button variant="destructive" onClick={() => setCancelOpen(true)}><Icon name="pause" size={15} /> {t('action.cancel')}</Button>}<Button variant="secondary" onClick={() => setRefresh((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button><Link className={buttonVariants({ variant: 'secondary' })} to="/admin/jobs">{t('jobs.action.allJobs')}</Link></>} />
      <section className="summary-grid job-stats">
        <div className="panel metric-card"><span className="metric-label">{t('table.status')}</span><strong className="metric-value"><StatusPill status={job.status} /></strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('jobs.metric.execution')}</span><strong className="metric-value mono">{durationLabel(job)}</strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('table.pipeline')}</span><strong className="metric-value mono"><span className="metric-token" title={job.pipelineId}>{job.pipelineId}</span></strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('table.revision')}</span><strong className="metric-value">r{job.pipelineRevision}</strong></div>
      </section>
      <details className="advanced panel"><summary>{t('jobs.advanced.summary')}</summary><div className="kv-grid"><div className="kv"><span className="kv-label">{t('jobs.field.jobId')}</span><span className="kv-value"><LongId value={job.jobId} label={t('jobs.copyJobId')} scroll testId="job-id-full" /></span></div><div className="kv"><span className="kv-label">{t('table.attempts')}</span><span className="kv-value mono">{job.attempts} / {job.maxAttempts}</span></div><div className="kv"><span className="kv-label">{t('jobs.field.fence')}</span><span className="kv-value mono">{job.currentFence}</span></div><div className="kv"><span className="kv-label">{t('jobs.field.lease')}</span><span className="kv-value"><LongId value={job.currentLeaseId} label={t('table.copyIdentifier')} scroll /></span></div><div className="kv"><span className="kv-label">{t('jobs.field.queueWait')}</span><span className="kv-value mono">{spanLabel(job.createdAt, job.startedAt)}</span></div><div className="kv"><span className="kv-label">{t('jobs.field.totalElapsed')}</span><span className="kv-value mono">{spanLabel(job.createdAt, job.finishedAt)}</span></div><div className="kv"><span className="kv-label">{t('table.updated')}</span><span className="kv-value mono">{new Date(job.updatedAt).toISOString()}</span></div></div></details>
      <section className="panel panel-pad"><h2>{t('jobs.lifecycle.title')}</h2><ul className="detail-list"><li><span>{t('table.created')}</span><TimeAgo value={job.createdAt} /></li><li><span>{t('table.updated')}</span><TimeAgo value={job.updatedAt} /></li><li><span>{t('jobs.field.errorCode')}</span><code>{job.lastErrorCode || '—'}</code></li></ul><p className="muted small">{t('jobs.lifecycle.note')}</p></section>
      <section className="panel panel-pad"><h2>{t('jobs.timeline.title')}</h2>{!diagnostics ? <p className="muted small">{t('jobs.timeline.unavailable')}</p> : diagnostics.events.length === 0 ? <p className="muted small">{t('jobs.timeline.empty')}</p> : <ol className="timeline">{diagnostics.events.map((event) => <li key={event.eventId}><span className="timeline-dot" /><div><strong>{event.eventType}</strong>{event.toStatus && <span className="tag">{event.toStatus}</span>}{event.fencingSequence != null && <span className="muted small">{t('jobs.timeline.fence', { fence: event.fencingSequence })}</span>}<TimeAgo value={event.occurredAt} /></div></li>)}</ol>}{diagnostics?.truncated && <p className="muted small">{t('jobs.timeline.truncated')}</p>}</section>
      {diagnostics && diagnostics.attempts.length > 0 && <section className="panel panel-pad"><h2>{t('table.attempts')}</h2><div className="table-panel"><Table><TableHeader><TableRow className="hover:bg-transparent"><TableHead>{t('jobs.field.attempt')}</TableHead><TableHead>{t('table.status')}</TableHead><TableHead>{t('jobs.field.fence')}</TableHead><TableHead>{t('table.node')}</TableHead><TableHead>{t('table.started')}</TableHead></TableRow></TableHeader><TableBody>{diagnostics.attempts.map((attempt) => <TableRow key={attempt.attemptNumber}><TableCell>#{attempt.attemptNumber}</TableCell><TableCell><StatusPill status={attempt.status} /></TableCell><TableCell className="mono">{attempt.fencingSequence}</TableCell><TableCell><LongId value={attempt.nodeId} display={identityDisambiguator(attempt.nodeId)} label={t('table.copyIdentifier')} /></TableCell><TableCell><TimeAgo value={attempt.startedAt} /></TableCell></TableRow>)}</TableBody></Table></div></section>}
      {diagnostics && diagnostics.checkpoints.length > 0 && <section className="panel panel-pad"><h2>{t('jobs.checkpoints.title')}</h2><ul className="detail-list">{diagnostics.checkpoints.map((checkpoint) => <li key={checkpoint.checkpointId}><span>{t('jobs.checkpoints.entry', { attempt: checkpoint.attemptNumber, sequence: checkpoint.sequence })}</span><LongId value={checkpoint.stateDigest} display={shortDigest(checkpoint.stateDigest, 20)} label={t('table.copyIdentifier')} /></li>)}</ul></section>}
      {result ? <section className="panel panel-pad"><h2>{t('table.result')}</h2><p className="small">{t('table.status')} <StatusPill status={result.status} /></p>{result.errorCode && <div className="studio-banner studio-banner-error"><strong>{result.errorCode}</strong> {result.errorMessage}</div>}<pre className="result-json ow-scroll-x">{JSON.stringify(result.output, null, 2)}</pre><details className="advanced"><summary>{t('jobs.result.metadata')}</summary><p className="small">{result.resultDigest ? <LongId value={result.resultDigest} display={shortDigest(result.resultDigest, 20)} label={t('table.copyIdentifier')} /> : t('jobs.result.noDigest')}</p></details></section> : resultError ? <p className="muted small">{t('jobs.result.error', { message: resultError })}</p> : null}
      <ConfirmAction
        open={cancelOpen}
        title={t('jobs.cancelConfirm.title', { id: identityDisambiguator(job.jobId) })}
        description={t('jobs.cancelConfirm.description')}
        confirmLabel={t('jobs.cancelConfirm.confirm')}
        onConfirm={cancelJob}
        onClose={() => setCancelOpen(false)}
      />
    </div>
  );
}

export function JobSubmitPage() {
  const t = useT();
  const statusText = useStatusText();
  const { pipelineId = '' } = useParams();
  const navigate = useNavigate();
  useDocumentTitle(t('page.runPipeline'));
  const [detail, setDetail] = useState<PipelineDetail | null>(null);
  const [input, setInput] = useState('{}');
  const [revision, setRevision] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { api.get<PipelineDetail>(`/api/v1/pipelines/${encodeURIComponent(pipelineId)}`).then((value) => { setDetail(value); setRevision(value.latestRevision); }).catch((cause) => setError((cause as Error).message)); }, [pipelineId]);
  if (!detail) return (
    <div className="page-stack">
      <PageHeader eyebrow={t('jobs.eyebrow')} title={t('page.runPipeline')} description={t('jobs.submit.description', { pipelineId })} />
      <AsyncBoundary loading={!error} error={error ? new Error(error) : null} hasData={false}>{null}</AsyncBoundary>
    </div>
  );
  const submit = async () => {
    setSubmitting(true); setError(null);
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(input); } catch { throw new Error(t('jobs.submit.invalidJson')); }
      const job = await api.post<JobView>('/api/v1/jobs', { pipelineId, pipelineRevision: revision, input: parsed }, newIdempotencyKey());
      navigate(`/admin/jobs/${job.jobId}`);
    } catch (cause) { setError((cause as Error).message); } finally { setSubmitting(false); }
  };
  return (
    <div className="page-stack">
      <PageHeader eyebrow={t('jobs.eyebrow')} title={detail.name} description={t('jobs.submit.description', { pipelineId })} />
      {error && <div className="studio-banner studio-banner-error" role="alert">{error}</div>}
      <section className="panel panel-pad run-panel">
        <label><span>{t('jobs.submit.publishedRevision')}</span>
          <Select value={revision === null ? '' : String(revision)} onValueChange={(value) => setRevision(Number(value))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {detail.revisions.map((item) => <SelectItem key={item.revision} value={String(item.revision)}>r{item.revision} · {statusText(item.status)}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label><span>{t('jobs.submit.inputJson')}</span><textarea rows={10} value={input} onChange={(event) => setInput(event.target.value)} /></label>
        <Button onClick={() => void submit()} disabled={submitting || revision === null}>{submitting ? t('jobs.submit.submitting') : t('pipelines.jobs.submit')}</Button>
        <p className="muted small">{t('jobs.submit.note')}</p>
      </section>
    </div>
  );
}
