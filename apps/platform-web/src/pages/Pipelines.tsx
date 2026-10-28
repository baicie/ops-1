import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { JobList, PipelineDefinition, PipelineDetail, PipelineList, PipelineRevision } from '../types';
import { Icon } from '../components/Icons';
import { badgeVariantForTone, glyphForTone } from '../components/status-tone';
import type { StatusTone } from '../components/status-tone';
import { Badge } from '../components/ui/badge';
import { Button, buttonVariants } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { EmptyState, ErrorState, PageHeader, Skeleton, TimeAgo } from '../components/Ui';
import { useDocumentTitle } from '../hooks';
import { getPipelineExecutionOrder } from '../studio/ir/topology';
import { useT } from '../i18n';
import { cn } from '../lib/utils';
import { StackCell, StatusPill, stackBody, stackHead, stackRow, stackTable } from './table-kit';

/**
 * The revision panels show a fixed copy line (and, for revisions, the wire status verbatim),
 * not a status code StatusPill could map on its own — so the pill is painted here through the
 * same shared tone map instead of growing a second label vocabulary.
 */
function TonePill({ tone, label, className }: { tone: StatusTone; label: string; className?: string }) {
  return (
    <Badge variant={badgeVariantForTone(tone)} className={className}>
      <Icon name={glyphForTone(tone)} size={12} />
      {label}
    </Badge>
  );
}

export function PipelinesPage() {
  const t = useT();
  useDocumentTitle(t('page.pipelines'));
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
        title={t('page.pipelines')}
        description={t('pipelines.description')}
        actions={<Button variant="secondary" onClick={() => setReloadToken((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>}
      />
      <section className="toolbar">
        <div className="relative flex min-w-[260px] max-w-[460px] flex-1 items-center">
          <Icon name="search" size={16} className="absolute left-[10px] text-muted-foreground" />
          <Input aria-label={t('pipelines.search.aria')} placeholder={t('pipelines.search.placeholder')} value={query} onChange={(event) => setQuery(event.target.value)} className="pl-[33px]" />
        </div>
        <span className="toolbar-count">{t('pipelines.count', { count: items.length })}</span>
      </section>
      {loading && !data ? <Skeleton rows={5} /> : error ? <ErrorState error={error} onRetry={() => setReloadToken((value) => value + 1)} /> : items.length === 0 ? (
        <EmptyState icon="file" title={hasServerPage ? t('pipelines.empty.filtered.title') : t('pipelines.empty.none.title')} description={hasServerPage ? t('pipelines.empty.filtered.description') : t('pipelines.empty.none.description')} />
      ) : (
        <section className="panel table-panel">
          <Table className={stackTable}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('table.pipeline')}</TableHead>
                <TableHead>{t('table.revision')}</TableHead>
                <TableHead>{t('table.created')}</TableHead>
                <TableHead>{t('table.updated')}</TableHead>
                <TableHead aria-label={t('table.open')} />
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {items.map((pipeline) => (
                <TableRow key={pipeline.pipelineId} className={cn('cursor-pointer focus-visible:outline-offset-[-2px]', stackRow)} tabIndex={0}>
                  <StackCell label={t('table.pipeline')}><Link to={`/admin/pipelines/${encodeURIComponent(pipeline.pipelineId)}`}><strong>{pipeline.name}</strong><span className="mono block">{pipeline.pipelineId}</span></Link></StackCell>
                  <StackCell label={t('table.revision')}><span className="mono">r{pipeline.latestRevision}</span></StackCell>
                  <StackCell label={t('table.created')}><TimeAgo value={pipeline.createdAt} /></StackCell>
                  <StackCell label={t('table.updated')}><TimeAgo value={pipeline.updatedAt} /></StackCell>
                  <TableCell className="w-8 text-right text-muted-foreground max-[760px]:hidden"><Icon name="chevron" size={16} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      <div className="pagination-row">
        <Button variant="secondary" disabled={!cursor} onClick={() => { setCursor(null); setCursorHistory([]); }}>{t('pipelines.pagination.first')}</Button>
        <Button variant="secondary" disabled={!cursorHistory.length} onClick={() => {
          const previous = cursorHistory[cursorHistory.length - 1];
          setCursor(previous);
          setCursorHistory((items) => items.slice(0, -1));
        }}>{t('pipelines.pagination.previous')}</Button>
        <Button variant="secondary" disabled={!data?.nextCursor} onClick={() => {
          setCursorHistory((items) => [...items, cursor]);
          setCursor(data?.nextCursor || null);
        }}>{t('pipelines.pagination.next')} <Icon name="arrowRight" size={14} /></Button>
      </div>
    </div>
  );
}

function NodeSummary({ definition }: { definition: PipelineDefinition }) {
  const t = useT();
  const meta: Record<string, string> = {
    'builtin.source.http_json': t('pipelines.nodeType.httpSource'),
    'builtin.parse.json': t('pipelines.nodeType.parseJson'),
    'builtin.map.fields': t('pipelines.nodeType.mapFields'),
    'builtin.filter.predicate': t('pipelines.nodeType.filter'),
    'builtin.validate.schema': t('pipelines.nodeType.validate'),
    'builtin.sink.dataset': t('pipelines.nodeType.datasetSink'),
  };
  const execution = getPipelineExecutionOrder(definition);
  if (execution.topologyStatus !== 'VALID') {
    return <div className="inline-error" role="alert"><strong>{execution.topologyStatus}</strong><span>{execution.diagnostics.join(' · ') || t('pipelines.topology.notLinear')}</span></div>;
  }
  return (
    <div className="pipeline-flow" aria-label={t('pipelines.topology.aria')}>
      {execution.orderedNodes.map((node, index) => (
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
  const t = useT();
  const { pipelineId = '' } = useParams();
  useDocumentTitle(t('page.pipelineDetail'));
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
        eyebrow={t('pipelines.eyebrow')}
        title={detail.name}
        description={<span className="mono">{detail.pipelineId}</span>}
        actions={<><Link className={buttonVariants({ variant: 'secondary' })} to="/admin/pipelines"><Icon name="arrowRight" size={15} /> {t('pipelines.action.all')}</Link><Link className={buttonVariants()} to={`/admin/pipelines/${encodeURIComponent(detail.pipelineId)}/run`}><Icon name="activity" size={15} /> {t('pipelines.action.run')}</Link><Link className={buttonVariants({ variant: 'secondary' })} to={`/admin/pipelines/${encodeURIComponent(detail.pipelineId)}/editor`}><Icon name="ops" size={15} /> {t('pipelines.action.openStudio')}</Link></>}
      />
      <section className="summary-grid pipeline-stats">
        <div className="panel metric-card"><span className="metric-label">{t('pipelines.metric.latestRevision')}</span><strong className="metric-value">r{detail.latestRevision}</strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('pipelines.metric.nodes')}</span><strong className="metric-value">{latest?.definition.nodes.length ?? 0}</strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('pipelines.metric.latestRun')}</span><strong className="metric-value small">{jobs?.items[0] ? <StatusPill status={jobs.items[0].status} /> : t('common.noRuns')}</strong></div>
        <div className="panel metric-card"><span className="metric-label">{t('pipelines.metric.updated')}</span><strong className="metric-value small"><TimeAgo value={latest?.publishedAt} /></strong></div>
      </section>
      {latest ? <section className="panel panel-pad"><div className="panel-head"><div><h2>{t('pipelines.latestRevision.title')}</h2>{/* The 64-char digest is unbreakable text: at 390 it forced a 122px page-level
              horizontal overflow on this panel before (the same markup pre-dated the migration).
              Breaking the hash only where it needs to wrap keeps the page inside the viewport. */}
            <p className="muted small">{latest.definition.name} · <span className="break-all">{latest.digest}</span></p></div><TonePill tone="ok" label={t('pipelines.badge.immutable')} /></div><NodeSummary definition={latest.definition} /></section> : <EmptyState icon="file" title={t('pipelines.empty.noPublishedRevision')} />}
      <section className="panel panel-pad">
        <div className="panel-head"><div><h2>{t('pipelines.history.title')}</h2><p className="muted small">{t('pipelines.history.description')}</p></div></div>
        {detail.revisions.length === 0 ? <EmptyState icon="clock" title={t('pipelines.history.empty')} /> : (
          <ul className="revision-list">{detail.revisions.map((revision) => (
            <li key={revision.revision}><span className="mono">r{revision.revision}</span><span className="mono muted small">{revision.digest}</span><TonePill tone="ok" label={revision.status} className="max-[700px]:col-start-2" /><TimeAgo value={revision.publishedAt} /></li>
          ))}</ul>
        )}
      </section>
      <section className="panel panel-pad">
        <div className="panel-head"><div><h2>{t('pipelines.jobs.title')}</h2><p className="muted small">{t('pipelines.jobs.description')}</p></div><Link className={buttonVariants({ variant: 'secondary', size: 'sm' })} to={`/admin/pipelines/${encodeURIComponent(detail.pipelineId)}/run`}><Icon name="activity" size={14} /> {t('pipelines.jobs.submit')}</Link></div>
        {!jobs || jobs.items.length === 0 ? <p className="muted small">{t('pipelines.jobs.empty')}</p> : (
          <div className="table-panel"><Table className={cn('job-mini-table', stackTable)}><TableHeader className={stackHead}><TableRow className="hover:bg-transparent"><TableHead>{t('table.job')}</TableHead><TableHead>{t('table.revision')}</TableHead><TableHead>{t('table.status')}</TableHead><TableHead>{t('table.created')}</TableHead></TableRow></TableHeader><TableBody className={stackBody}>{jobs.items.map((job) => <TableRow key={job.jobId} className={stackRow}><StackCell label={t('table.job')} className="max-[760px]:!w-auto max-[760px]:!max-w-none"><Link className="mono truncate" title={job.jobId} to={`/admin/jobs/${job.jobId}`}>{job.jobId}</Link></StackCell><StackCell label={t('table.revision')}><span className="mono">r{job.pipelineRevision}</span></StackCell><StackCell label="Status"><StatusPill status={job.status} /></StackCell><StackCell label={t('table.created')}><TimeAgo value={job.createdAt} /></StackCell></TableRow>)}</TableBody></Table></div>
        )}
      </section>
      <p className="table-footnote"><Icon name="alert" size={13} /> {t('pipelines.footnote')}</p>
    </div>
  );
}

export { PipelineEditorPage } from '../studio/PipelineEditor';
