import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import type { JobList, PipelineDefinition, PipelineDetail, PipelineList, PipelineRevision } from '../types';
import { Icon } from '../components/Icons';
import { STATUS_MAP, badgeVariantForTone, glyphForTone } from '../components/status-tone';
import type { StatusTone } from '../components/status-tone';
import { Badge } from '../components/ui/badge';
import { Button, buttonVariants } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { EmptyState, TimeAgo } from '../components/Ui';
import { AsyncBoundary } from '../components/app/async-boundary';
import { PageHeader } from '../components/app/page-header';
import { MetricCard } from '../components/app/metric-card';
import { useDocumentTitle } from '../hooks';
import { getPipelineExecutionOrder, type TopologyStatus } from '../studio/ir/topology';
import { shortDigest } from '../format';
import { useI18n, useT, type MessageKey } from '../i18n';
import { cn } from '../lib/utils';
import { IdentityCell, LongId, RowActions, StackCell, StatusPill, cardActionCell, cardCellClass, cardLineAfter, cardTwoLineRow, colFit, colGrow, colNum, colTime, copyIdAction, formatIdentity, stackBody, stackHead, stackRow, stackTable } from './table-kit';

/**
 * The revision pill paints through the shared tone map, and its label comes from the same
 * STATUS_MAP entry the rest of the shell uses. The raw wire code stays in `data-status`, so a
 * reader of the DOM can still see exactly what the Kernel sent. (The old comment here said the
 * wire text stayed verbatim, which meant a zh-CN page printed "PUBLISHED" in English.)
 *
 * A revision
 * the shell cannot classify is painted neutral instead of borrowing the "ok" colour.
 */
function TonePill({ tone, label, className }: { tone: StatusTone; label: string; className?: string }) {
  return (
    <Badge variant={badgeVariantForTone(tone)} className={className}>
      <Icon name={glyphForTone(tone)} size={12} />
      {label}
    </Badge>
  );
}

function RevisionPill({ status }: { status: string }) {
  const t = useT();
  const code = (status || '').toUpperCase();
  const entry = STATUS_MAP[code] ?? null;
  const tone = entry?.tone || 'unknown';
  return (
    <Badge variant={badgeVariantForTone(tone)} data-status={code || undefined}>
      <Icon name={glyphForTone(tone)} size={12} />
      {entry ? t(entry.labelKey) : status}
    </Badge>
  );
}

/**
 * Topology diagnostics are produced by the client analyzer in English. The stable status code is
 * the machine token; the sentence the reader acts on is localized here. The analyzer's raw
 * detail is kept behind a disclosure and attributed, never used as the primary sentence.
 */
const TOPOLOGY_MESSAGE: Record<Exclude<TopologyStatus, 'VALID'>, MessageKey> = {
  CYCLE: 'pipelines.topology.diagnostic.cycle',
  DISCONNECTED: 'pipelines.topology.diagnostic.disconnected',
  INVALID_EDGE: 'pipelines.topology.diagnostic.invalidEdge',
  MULTIPLE_SINKS: 'pipelines.topology.diagnostic.multipleSinks',
  MULTIPLE_SOURCES: 'pipelines.topology.diagnostic.multipleSources',
  NON_LINEAR: 'pipelines.topology.diagnostic.nonLinear',
};

export function PipelinesPage() {
  const t = useT();
  const { locale } = useI18n();
  const navigate = useNavigate();
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
        actions={<Button variant="ghost" className="text-muted-foreground" onClick={() => setReloadToken((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>}
      />
      <section className="toolbar">
        <div className="toolbar-search relative flex items-center">
          <Icon name="search" size={16} className="absolute left-[10px] text-muted-foreground" />
          <Input aria-label={t('pipelines.search.aria')} placeholder={t('pipelines.search.placeholder')} value={query} onChange={(event) => setQuery(event.target.value)} className="pl-[33px]" />
        </div>
        <span className="toolbar-count">{t('pipelines.count', { count: items.length })}</span>
      </section>
      <AsyncBoundary
        loading={loading}
        error={data ? null : error}
        hasData={Boolean(data)}
        skeletonRows={5}
        onRetry={() => setReloadToken((value) => value + 1)}
      >
        {items.length === 0 ? (
          <div data-empty-state={hasServerPage ? 'filtered' : 'none'}>
            <EmptyState
              icon="file"
              title={hasServerPage ? t('pipelines.empty.filtered.title') : t('pipelines.empty.none.title')}
              description={hasServerPage ? t('pipelines.empty.filtered.description') : t('pipelines.empty.none.description')}
              action={hasServerPage ? <Button variant="secondary" onClick={() => setQuery('')}>{t('ui.clearFilters')}</Button> : undefined}
            />
          </div>
        ) : (
          <section className="panel table-panel">
            <Table className={stackTable}>
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={colGrow}>{t('table.pipeline')}</TableHead>
                  <TableHead className={colNum}>{t('table.revision')}</TableHead>
                  <TableHead className={colTime}>{t('table.created')}</TableHead>
                  <TableHead className={colTime}>{t('table.updated')}</TableHead>
                  <TableHead className="ow-col-action" aria-hidden="true" />
                  {/* A row-menu slot, not a column: 44px of empty header above the chevron was a hole,
                      and titling it would put a constant column under the audit's min(distinctRatio). */}
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {items.map((pipeline) => {
                  const nameIsUnique = items.filter((item) => item.name === pipeline.name).length === 1;
                  const identity = formatIdentity({ name: pipeline.name, id: pipeline.pipelineId, at: pipeline.updatedAt, locale, nameIsUnique, rowsOnPage: items.length });
                  return (
                    // This row carried tabIndex=0 with no onClick and no key handler: a Tab stop
                    // that did nothing at all, on a row that painted cursor:pointer anyway. The
                    // name is the link and the menu is the row's one control, so the row itself
                    // is not a control.
                    <TableRow key={pipeline.pipelineId} className={cn(cardTwoLineRow, stackRow)}>
                      <IdentityCell label={t('table.pipeline')} identity={identity} href={`/admin/pipelines/${encodeURIComponent(pipeline.pipelineId)}`} cardFact />
                      <StackCell label={t('table.revision')} className={cn(cardCellClass(true), colNum)}><span className="mono">r{pipeline.latestRevision}</span></StackCell>
                      <StackCell label={t('table.created')} className={cn(cardLineAfter, cardCellClass(true), colTime)}><TimeAgo value={pipeline.createdAt} /></StackCell>
                      <StackCell label={t('table.updated')} className={cn(cardLineAfter, cardCellClass(true), colTime)}><TimeAgo value={pipeline.updatedAt} /></StackCell>
                      <TableCell className={cardActionCell}><RowActions label={t('table.open')} actions={[copyIdAction(pipeline.pipelineId, t('table.copyIdentifier')), { id: 'open', label: t('table.open'), icon: 'chevron', onSelect: () => navigate(`/admin/pipelines/${encodeURIComponent(pipeline.pipelineId)}`) }]} /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {(!cursor && !cursorHistory.length && !data?.nextCursor) ? null : <div className="pagination-row">
              <Button variant="ghost" size="sm" disabled={!cursor} onClick={() => { setCursor(null); setCursorHistory([]); }}>{t('pipelines.pagination.first')}</Button>
              <Button variant="ghost" size="sm" disabled={!cursorHistory.length} onClick={() => {
                const previous = cursorHistory[cursorHistory.length - 1];
                setCursor(previous);
                setCursorHistory((items) => items.slice(0, -1));
              }}>{t('pipelines.pagination.previous')}</Button>
              <Button variant="ghost" size="sm" disabled={!data?.nextCursor} onClick={() => {
                setCursorHistory((items) => [...items, cursor]);
                setCursor(data?.nextCursor || null);
              }}>{t('pipelines.pagination.next')} <Icon name="arrowRight" size={14} /></Button>
            </div>}
          </section>
        )}
      </AsyncBoundary>
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
    return (
      <div className="inline-error topology-notice" role="alert" data-topology={execution.topologyStatus}>
        <div>
          <strong>{execution.topologyStatus}</strong>
          <span>{t(TOPOLOGY_MESSAGE[execution.topologyStatus])}</span>
          {execution.diagnostics.length > 0 ? (
            <details className="topology-detail">
              <summary>{t('pipelines.topology.diagnostics')}</summary>
              <p className="server-quote" data-testid="analyzer-message" data-source="analyzer">
                <span className="server-source">{t('ui.textSource.analyzer')}</span>
                {execution.diagnostics.join(' · ')}
              </p>
            </details>
          ) : null}
        </div>
      </div>
    );
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

function PipelineDetailHeader({ pipelineId, name, description, actions }: { pipelineId: string; name?: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  const t = useT();
  return (
    <PageHeader
      eyebrow={t('pipelines.eyebrow')}
      title={name || t('page.pipelineDetail')}
      description={description ?? <span className="mono">{pipelineId}</span>}
      actions={actions}
    />
  );
}

export function PipelineDetailPage() {
  const t = useT();
  const { locale } = useI18n();
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
  const allPipelines = <Link className={buttonVariants({ variant: 'secondary' })} to="/admin/pipelines"><Icon name="arrowRight" size={15} /> {t('pipelines.action.all')}</Link>;
  if (error) return (
    <div className="page-stack">
      <PipelineDetailHeader pipelineId={pipelineId} actions={allPipelines} />
      <AsyncBoundary loading={false} error={error} hasData={false}>{null}</AsyncBoundary>
    </div>
  );
  if (!detail) return (
    <div className="page-stack">
      <PipelineDetailHeader pipelineId={pipelineId} actions={allPipelines} />
      <AsyncBoundary loading hasData={false} error={null}>{null}</AsyncBoundary>
    </div>
  );
  const latest = detail.latest;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t('pipelines.eyebrow')}
        title={t('page.pipelineDetail')}
        description={<span className="pipeline-identity"><strong>{detail.name}</strong><span className="mono">{detail.pipelineId}</span></span>}
        actions={<>{allPipelines}<Link className={buttonVariants({ variant: 'secondary' })} to={`/admin/pipelines/${encodeURIComponent(detail.pipelineId)}/editor`}><Icon name="ops" size={15} /> {t('pipelines.action.openStudio')}</Link></>}
        primary={<Link className={buttonVariants()} to={`/admin/pipelines/${encodeURIComponent(detail.pipelineId)}/run`}><Icon name="activity" size={15} /> {t('pipelines.action.run')}</Link>}
      />
      <section className="summary-grid pipeline-stats">
        <MetricCard label={t('pipelines.metric.latestRevision')} value={`r${detail.latestRevision}`} showSampled={false} />
        {/* A missing published definition is NO_DATA; printing 0 nodes would claim a real count of zero. */}
        <MetricCard label={t('pipelines.metric.nodes')} value={latest ? latest.definition.nodes.length : undefined} state={latest ? 'ready' : 'noData'} showSampled={false} />
        {/* An unloaded job list is not "no runs": noRuns is only a fact once the list answered. */}
        <MetricCard label={t('pipelines.metric.latestRun')} value={jobs?.items[0] ? <StatusPill status={jobs.items[0].status} /> : t('common.noRuns')} state={jobs ? 'ready' : 'noData'} size="small" showSampled={false} />
        <MetricCard label={t('pipelines.metric.updated')} value={latest?.publishedAt ? <TimeAgo value={latest.publishedAt} /> : undefined} state={latest?.publishedAt ? 'ready' : 'noData'} size="small" showSampled={false} />
      </section>
      {latest ? <section className="panel"><div className="panel-head"><div><h2>{t('pipelines.latestRevision.title')}</h2>{/* The 64-char digest is unbreakable text: at 390 it forced a 122px page-level
              horizontal overflow on this panel before (the same markup pre-dated the migration).
              Breaking the hash only where it needs to wrap keeps the page inside the viewport. */}
            {/* The digest is a copyable identity, not a paragraph: `break-all` wrapped it over four
                lines at 390, so the panel grew a 71-character column of noise. LongId ellipsises it
                and keeps the full value on the title and the copy button. */}
            <p className="muted small">{latest.definition.name} · <LongId value={latest.digest} display={shortDigest(latest.digest, 18)} label={t('table.copyIdentifier')} /></p></div><TonePill tone="ok" label={t('pipelines.badge.immutable')} /></div><div className="panel-pad"><NodeSummary definition={latest.definition} /></div></section> : <EmptyState icon="file" title={t('pipelines.empty.noPublishedRevision')} />}
      <section className="panel">
        <div className="panel-head"><div><h2>{t('pipelines.history.title')}</h2><p className="muted small">{t('pipelines.history.description')}</p></div></div>
        {detail.revisions.length === 0 ? <EmptyState icon="clock" title={t('pipelines.history.empty')} /> : (
          <div className="panel-pad"><ul className="revision-list">{detail.revisions.map((revision) => (
            <li key={revision.revision}><span className="mono">r{revision.revision}</span><span className="muted small"><LongId value={revision.digest} display={shortDigest(revision.digest, 18)} label={t('table.copyIdentifier')} /></span><RevisionPill status={revision.status} /><TimeAgo value={revision.publishedAt} /></li>
          ))}</ul></div>
        )}
      </section>
      <section className="panel table-panel">
        <div className="panel-head"><div><h2>{t('pipelines.jobs.title')}</h2><p className="muted small">{t('pipelines.jobs.description')}</p></div><Link className={buttonVariants({ variant: 'secondary', size: 'sm' })} to={`/admin/pipelines/${encodeURIComponent(detail.pipelineId)}/run`}><Icon name="activity" size={14} /> {t('pipelines.jobs.submit')}</Link></div>
        {!jobs || jobs.items.length === 0 ? <p className="muted small panel-pad">{t('pipelines.jobs.empty')}</p> : (
          <Table className={cn('job-mini-table', stackTable)}><TableHeader className={stackHead}><TableRow className="hover:bg-transparent"><TableHead className={colGrow}>{t('table.job')}</TableHead><TableHead className={colFit}>{t('table.status')}</TableHead><TableHead className={colTime}>{t('table.created')}</TableHead></TableRow></TableHeader><TableBody className={stackBody}>{jobs.items.map((job) => {
            // table-spec §2.1/§2.5: the row opens with a name and four hex characters, not a
            // 36-character UUID that wraps over two lines on every card. The revision is constant
            // for a pipeline, so it is a qualifier on the identity line, not a column of its own.
            const identity = formatIdentity({ name: detail.name, id: job.jobId, at: job.createdAt, locale, nameIsUnique: false, rowsOnPage: jobs.items.length });
            return <TableRow key={job.jobId} className={cn('cursor-pointer max-[768px]:relative', cardTwoLineRow, stackRow)}><IdentityCell label={t('table.job')} identity={identity} href={`/admin/jobs/${job.jobId}`} cardFact><span className="ow-key">r{job.pipelineRevision}</span></IdentityCell><StackCell label={t('table.status')} className={colFit}><StatusPill status={job.status} /></StackCell><StackCell label={t('table.created')} className={cn(cardLineAfter, colTime)}><TimeAgo value={job.createdAt} /></StackCell></TableRow>;
          })}</TableBody></Table>
        )}
      </section>
      <p className="table-footnote"><Icon name="alert" size={13} /> {t('pipelines.footnote')}</p>
    </div>
  );
}

export { PipelineEditorPage } from '../studio/PipelineEditor';
