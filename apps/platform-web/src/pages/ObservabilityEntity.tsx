import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { useDocumentTitle } from '../hooks';
import { useI18n, useT } from '../i18n';
import type { AuditEvent, InstanceView, NodeView } from '../types';
import { Icon } from '../components/Icons';
import { Button, buttonVariants } from '../components/ui/button';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { CopyButton, EmptyState } from '../components/Ui';
import { AsyncBoundary, NoticeBar, isStale, useObservedPolling } from '../components/app/async-boundary';
import { MetricCard } from '../components/app/metric-card';
import { PageHeader } from '../components/app/page-header';
import { NoData, StatusIndicator, UnknownValue, indicatorStateForCode } from '../components/app/status-indicator';
import { formatBytes } from '../format';
import { ageMessage } from '../lib/age';
import {
  IdentityCell,
  StackCell,
  cardCellClass,
  cardLineAfter,
  cardTwoLineRow,
  formatIdentity,
  stackBody,
  stackHead,
  stackRow,
  stackTable,
} from './table-kit';
import {
  HISTORY_WINDOWS,
  indicatorForEntityState,
  METRIC_KEYS,
  METRIC_LABEL_KEYS,
  UNKNOWN,
  buildSeries,
  entityState,
  foldEvents,
  maxGapFor,
  nodeReadings,
  resolutionFor,
  sampleIsStale,
  segmentPath,
  type HistorySample,
  type HistoryWindowHours,
  type MetricKey,
  type Reading,
  type Series,
} from './observability-model';

/**
 * `/app/observability/nodes/{id}` - one observed entity, over time.
 *
 * Three questions, in the order an operator asks them: what has this node been doing (the
 * series), what is running on it (its instances), and what happened to it (its events). The
 * page template's fixed order puts them in exactly that sequence, and the secondary-panel
 * budget (<= 2) is why the instances and the events are the last two regions on the page.
 *
 * The chart is hand-drawn SVG. That is not a preference: a charting library interpolates
 * between the points it is given, and interpolation is precisely the lie this page may not
 * tell - a line drawn across a 40-minute silence asserts readings nobody took. `buildSeries`
 * returns SEGMENTS, the plot renders one polyline per segment, and the hole stays a hole.
 */

/* ── the plot ────────────────────────────────────────────────────────────────── */

/** The viewBox the path helper maps into. Width is arbitrary (the SVG scales); height is not. */
const PLOT_W = 600;
const PLOT_H = 120;

/**
 * One metric's history.
 *
 * Reading order inside the panel: the metric and its newest value, then the plot, then what the
 * plot could not draw. The last line is the one a chart usually omits - "12 of 60 samples
 * carried no reading" is the difference between a sparse line and a broken collector, and the
 * reader cannot infer it from the picture.
 */
function SeriesPlot({ series, window: hours }: { series: Series; window: HistoryWindowHours }) {
  const t = useT();
  const { locale } = useI18n();
  const label = t(METRIC_LABEL_KEYS[series.metric]);
  const titleId = `ow-series-${series.metric}`;

  // §2.7 / M1: when nothing in the window could be plotted, the answer is an empty state and
  // not a dashed token - a token in an empty box reads as "a value is coming", and here there
  // is no value to come. The panel still says how many samples it looked at.
  if (series.plotted === 0) {
    return (
      <div className="ow-series" data-series={series.metric} data-series-state="empty">
        <div className="ow-series-head">
          <span className="ow-series-label">{label}</span>
          <span className="ow-series-now">
            {series.missing > 0
              ? <NoData detail={t('observabilityEntity.series.allMissing', { count: series.missing })} />
              : <UnknownValue detail={t('observabilityEntity.series.noSamples')} />}
          </span>
        </div>
        <p className="ow-series-note">
          {series.missing > 0
            ? t('observabilityEntity.series.allMissing', { count: series.missing })
            : t('observabilityEntity.series.noSamples')}
        </p>
      </div>
    );
  }

  const peak = series.peak;
  const newest = series.newest;
  return (
    <div className="ow-series" data-series={series.metric} data-series-state="plotted">
      <div className="ow-series-head">
        <span className="ow-series-label" id={titleId}>{label}</span>
        <span className="ow-series-now ow-tnum">
          {newest ? `${Math.round(newest.value * 100)}%` : null}
          {peak ? <span className="ow-series-peak">{t('observabilityEntity.series.peak', { percent: Math.round(peak.value * 100) })}</span> : null}
        </span>
      </div>
      <div className="ow-series-plot">
        {/* The scale is printed, because a line with no axis makes 3% and 100% the same
            picture. Three labels, three gridlines, same three values. */}
        <div className="ow-series-axis" aria-hidden="true">
          <span>100%</span>
          <span>50%</span>
          <span>0%</span>
        </div>
        <svg
          viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-labelledby={titleId}
          aria-describedby={`${titleId}-desc`}
        >
          <g className="ow-series-grid" aria-hidden="true">
            <line x1="0" y1="0.5" x2={PLOT_W} y2="0.5" />
            <line x1="0" y1={PLOT_H / 2} x2={PLOT_W} y2={PLOT_H / 2} />
            <line x1="0" y1={PLOT_H - 0.5} x2={PLOT_W} y2={PLOT_H - 0.5} />
          </g>
          {/* One polyline per segment: the line ENDS at a gap. */}
          {series.segments.map((segment, index) => (
            <path
              key={index}
              className="ow-series-line"
              d={segmentPath(segment, PLOT_W, PLOT_H)}
              fill="none"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {/* A segment of one point draws no line, so every point is also a dot: a window
              holding a single lone sample must be visible as that sample. */}
          {series.segments.map((segment, index) => segment.map((point, at) => (
            <circle
              key={`${index}-${at}`}
              className="ow-series-dot"
              cx={(point.x * PLOT_W).toFixed(2)}
              cy={((1 - point.y) * PLOT_H).toFixed(2)}
              r={segment.length === 1 ? 3 : 1.5}
            />
          )))}
        </svg>
      </div>
      <p className="ow-series-time ow-tnum" aria-hidden="true">
        <span>{t('observabilityEntity.window.start', { hours })}</span>
        <span>{t('observabilityEntity.window.now')}</span>
      </p>
      {/* The accessible reading of the picture, and the honest one: a sighted reader sees the
          breaks, so a screen-reader user is told how many there are. */}
      {/* Each clause is its own `t()` call rather than a template literal around one: a key
          interpolated into a backtick string is invisible to scripts/check-i18n.mjs, which reads
          string literals, so the catalog would report four live keys as unused. */}
      <p className="ow-series-note" id={`${titleId}-desc`}>
        {t('observabilityEntity.series.summary', { plotted: series.plotted })}
        {series.gaps > 0 ? <> · {t('observabilityEntity.series.gaps', { count: series.gaps })}</> : null}
        {series.missing > 0 ? <> · {t('observabilityEntity.series.missing', { count: series.missing })}</> : null}
        {newest ? <> · {t('observabilityEntity.series.newest', { at: ageMessage(locale, newest.at) })}</> : null}
      </p>
    </div>
  );
}

/* ── the page ────────────────────────────────────────────────────────────────── */

/** A ratio as a localized percentage: `Intl`, so zh-CN never reads an English unit. */
function percent(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(value);
}

const POLL_MS = 10_000;

export function ObservabilityEntityPage() {
  const t = useT();
  const { locale } = useI18n();
  const { nodeId = '' } = useParams();
  const [hours, setHours] = React.useState<HistoryWindowHours>(1);

  const { data: node, error, loading, reload, observedAt } = useObservedPolling(
    () => api.get<NodeView>(`/api/v1/nodes/${nodeId}`),
    POLL_MS,
  );
  const { data: instances } = useObservedPolling(
    () => api.get<InstanceView[]>(`/api/v1/nodes/${nodeId}/instances`),
    POLL_MS,
  );
  // The audit log is not polled: an event that already happened does not change, and a 10s
  // poll on an append-only log is traffic for nothing. It reloads with the node.
  const { data: events } = useObservedPolling(
    () => api.get<AuditEvent[]>(`/api/v1/audit?subjectType=node&subjectId=${nodeId}&limit=40`),
    0,
  );

  // The history window is a query, so it is re-fetched when the window changes - and the
  // request carries the window's own bounds, which is also what the series is drawn against.
  const [history, setHistory] = React.useState<{ samples: HistorySample[]; failed: boolean } | null>(null);
  const [windowBounds, setWindowBounds] = React.useState<{ fromMs: number; toMs: number } | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    const toMs = Date.now();
    const fromMs = toMs - hours * 3600_000;
    setWindowBounds({ fromMs, toMs });
    setHistory(null);
    const query = `limit=500&resolution=${resolutionFor(hours)}&from=${encodeURIComponent(new Date(fromMs).toISOString())}`;
    void api.get<HistorySample[]>(`/api/v1/nodes/${nodeId}/resource-history?${query}`)
      .then((items) => { if (!cancelled) setHistory({ samples: items || [], failed: false }); })
      // A failed history request is not an empty history. The panel says which one it is.
      .catch(() => { if (!cancelled) setHistory({ samples: [], failed: true }); });
    return () => { cancelled = true; };
  }, [nodeId, hours]);

  useDocumentTitle(node?.name || t('observabilityEntity.title'));

  const state = node ? entityState(node) : 'unknown';
  const readings = React.useMemo(() => (node ? nodeReadings(node) : null), [node]);
  const snapshot = node?.resourceSnapshot ?? null;
  const snapshotStale = sampleIsStale(snapshot?.sampledAt);

  const series = React.useMemo(() => {
    if (!history || !windowBounds) return null;
    return METRIC_KEYS.map((metric) => buildSeries(history.samples, metric, windowBounds, maxGapFor(hours)));
  }, [history, windowBounds, hours]);

  const runs = React.useMemo(() => foldEvents(events || []), [events]);

  const capacityFor = (metric: MetricKey): string | null => {
    if (!snapshot) return null;
    if (metric === 'memory' && snapshot.memoryTotalBytes) {
      return `${formatBytes(snapshot.memoryUsedBytes)} / ${formatBytes(snapshot.memoryTotalBytes)}`;
    }
    if (metric === 'filesystem' && snapshot.filesystemTotalBytes) {
      return `${formatBytes(snapshot.filesystemUsedBytes)} / ${formatBytes(snapshot.filesystemTotalBytes)}`;
    }
    if (metric === 'cpu') {
      const cores = (snapshot as { cpuCores?: number | null }).cpuCores;
      return typeof cores === 'number' && cores > 0 ? t('observabilityEntity.reading.cores', { count: cores }) : null;
    }
    return null;
  };

  return (
    <div className="page-stack" data-testid="observability-entity">
      <PageHeader
        eyebrow={t('observabilityEntity.eyebrow')}
        title={node?.name || t('observabilityEntity.title')}
        description={node
          ? t('observabilityEntity.description', { os: node.os, arch: node.arch, generation: node.generation })
          : t('observabilityEntity.descriptionLoading')}
        actions={
          <>
            <Button variant="secondary" onClick={() => void reload()}>
              <Icon name="refresh" size={15} /> {t('action.refresh')}
            </Button>
            {/* A Link wearing the button's classes, not a Button wrapping a Link: this
                Button is a plain <button> with no asChild slot, and nesting an <a> inside it
                would be invalid HTML that a keyboard user reaches twice. */}
            <Link className={buttonVariants({ variant: 'secondary' })} to="/app/observability">
              <Icon name="arrowLeft" size={15} /> {t('observabilityEntity.action.back')}
            </Link>
          </>
        }
      />

      <AsyncBoundary
        loading={loading}
        error={node ? null : error}
        hasData={Boolean(node)}
        skeletonRows={8}
        onRetry={() => void reload()}
      >
        {!node ? null : (
          <>
            {/* The state of the entity, before any number it reported. A reader who skips this
                line and reads the plot below would be reading the last thing a dead node said
                as though it were current. */}
            <section className="ow-entity-state" data-entity-state={state}>
              <StatusIndicator state={indicatorForEntityState(state)} />
              <span className="ow-entity-fact">
                {t('observability.table.observedAt', { at: node.lastSeenAt ? ageMessage(locale, node.lastSeenAt) : t('time.never') })}
              </span>
              <span className="ow-entity-fact ow-entity-id">
                <code className="mono">{node.id}</code>
                <CopyButton value={node.id} label={t('observabilityEntity.copyId')} />
              </span>
            </section>

            {state === 'revoked' ? (
              <NoticeBar
                state="revoked"
                title={t('observability.notice.revoked.title')}
                detail={t('observabilityEntity.notice.revoked.detail')}
              />
            ) : state === 'unreachable' || state === 'unknown' ? (
              <NoticeBar
                state="unreachable"
                title={t('observability.notice.unreachable.title')}
                detail={t('observabilityEntity.notice.unreachable.detail')}
              />
            ) : snapshotStale ? (
              <NoticeBar
                state="stale"
                title={t('observability.notice.staleSamples.title')}
                detail={t('observabilityEntity.notice.stale.detail', {
                  at: snapshot?.sampledAt ? ageMessage(locale, snapshot.sampledAt) : '',
                })}
              />
            ) : isStale(observedAt, POLL_MS) ? (
              <NoticeBar state="stale" title={t('ui.stale.title')} detail={t('ui.stale.detail', { at: observedAt ?? '' })} />
            ) : null}

            {/* The newest sample, as the page's one KPI band (page-template §2.3: one band, and
                4 columns - never 3, which is why the three metrics are joined by the instance
                count rather than padded or squeezed into a ragged row). Each card carries the
                sample's own time, and a card with no sample renders the token instead of 0%. */}
            <section className="metric-grid" aria-label={t('observabilityEntity.current.title')} data-region="current">
              {METRIC_KEYS.map((metric) => {
                const reading = readings ? readings[metric] : UNKNOWN;
                return (
                  <MetricCard
                    key={metric}
                    metricId={`obs-entity-${metric}`}
                    label={t(METRIC_LABEL_KEYS[metric])}
                    value={reading.kind === 'reading' ? percent(locale, reading.value) : undefined}
                    state={reading.kind === 'reading' ? 'ready' : reading.kind}
                    detail={capacityFor(metric) ?? t('observabilityEntity.reading.noCapacity')}
                    sampledAt={reading.kind === 'reading' ? reading.observedAt : null}
                  />
                );
              })}
              <MetricCard
                metricId="obs-entity-instances"
                label={t('observabilityEntity.instances.title')}
                value={<span className="ow-tnum">{node.instancesReady}</span>}
                denominator={node.instancesTotal}
                detail={t('observabilityEntity.instances.detail')}
                showSampled={false}
              />
            </section>

            {/* The series. One panel, three plots, one window control. */}
            <section className="panel" data-testid="observability-history" aria-labelledby="ow-history">
              <div className="panel-head">
                <div>
                  <h2 id="ow-history">{t('observabilityEntity.history.title')}</h2>
                  <p>{t('observabilityEntity.history.description')}</p>
                </div>
                <Tabs value={String(hours)} onValueChange={(value: string) => setHours(Number(value) as HistoryWindowHours)}>
                  <TabsList aria-label={t('observabilityEntity.history.windowAria')}>
                    {HISTORY_WINDOWS.map((option) => (
                      <TabsTrigger key={option} value={String(option)}>
                        {t('observabilityEntity.history.window', { hours: option })}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>
              {history === null ? (
                <p className="stat-note ow-series-pending" role="status">{t('observabilityEntity.history.loading')}</p>
              ) : history.failed ? (
                // A query that failed is not a node with no history: saying "no samples" here
                // would be the page inventing an answer the kernel never gave.
                <div className="ow-series-failed" role="alert">
                  <StatusIndicator state="error" />
                  <p>{t('observabilityEntity.history.failed')}</p>
                </div>
              ) : !series ? null : (
                <div className="ow-series-stack">
                  {series.map((entry) => <SeriesPlot key={entry.metric} series={entry} window={hours} />)}
                </div>
              )}
            </section>

            {/* Secondary panel 1 of 2: what runs here. */}
            <section className="panel table-panel" data-testid="observability-instances" aria-labelledby="ow-instances">
              <div className="panel-head">
                <div>
                  <h2 id="ow-instances">{t('observabilityEntity.instances.title')}</h2>
                  <p>{t('observabilityEntity.instances.description')}</p>
                </div>
              </div>
              {!instances?.length ? (
                <EmptyState
                  icon="box"
                  title={t('observabilityEntity.instances.empty.title')}
                  description={t('observabilityEntity.instances.empty.description')}
                />
              ) : (
                <Table className={stackTable}>
                  <TableHeader className={stackHead}>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>{t('table.instance')}</TableHead>
                      <TableHead>{t('table.status')}</TableHead>
                      <TableHead>{t('observabilityEntity.table.restarts')}</TableHead>
                      <TableHead>{t('table.lastObserved')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className={stackBody}>
                    {instances.map((instance) => (
                      <TableRow key={instance.id} className={`${cardTwoLineRow} ${stackRow}`}>
                        <IdentityCell
                          label={t('table.instance')}
                          identity={formatIdentity({
                            name: instance.nodeName || `slot ${instance.slot}`,
                            id: instance.id,
                            at: instance.observedAt,
                            locale,
                            nameIsUnique: false,
                            rowsOnPage: instances.length,
                          })}
                          href={`/admin/instances/${instance.id}/logs`}
                          cardFact
                        >
                          <span className="ow-key">{t('observabilityEntity.table.slot', { slot: instance.slot })}</span>
                        </IdentityCell>
                        <StackCell label={t('table.status')} className={cardCellClass(true)}>
                          <StatusIndicator state={indicatorStateForCode(instance.state)} />
                        </StackCell>
                        <StackCell label={t('observabilityEntity.table.restarts')} className={`${cardLineAfter} ${cardCellClass(true)}`}>
                          <span className="ow-tnum">{instance.restartCount}</span>
                        </StackCell>
                        <StackCell label={t('table.lastObserved')} className={cardCellClass(false)}>
                          {instance.observedAt
                            ? <span className="ow-tnum">{ageMessage(locale, instance.observedAt)}</span>
                            : <UnknownValue detail={t('observabilityEntity.table.neverObserved')} />}
                        </StackCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>

            {/* Secondary panel 2 of 2: what happened to it. §2.4 folds a run of >= 3. */}
            <section className="panel table-panel" data-testid="observability-events" aria-labelledby="ow-events">
              <div className="panel-head">
                <div>
                  <h2 id="ow-events">{t('observabilityEntity.events.title')}</h2>
                  <p>{t('observabilityEntity.events.description')}</p>
                </div>
              </div>
              {!runs.length ? (
                <EmptyState
                  icon="activity"
                  title={t('observabilityEntity.events.empty.title')}
                  description={t('observabilityEntity.events.empty.description')}
                />
              ) : (
                <Table className={stackTable}>
                  <TableHeader className={stackHead}>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>{t('table.event')}</TableHead>
                      <TableHead>{t('table.result')}</TableHead>
                      <TableHead>{t('table.occurred')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className={stackBody}>
                    {runs.map((run) => (
                      <TableRow key={run.event.id} className={`${cardTwoLineRow} ${stackRow}`}>
                        <IdentityCell
                          label={t('table.event')}
                          identity={formatIdentity({
                            name: run.event.eventType,
                            id: run.event.id,
                            at: run.firstAt,
                            locale,
                            nameIsUnique: false,
                            rowsOnPage: runs.length,
                          })}
                          cardFact
                        >
                          <span className="ow-key">{run.event.action}</span>
                          {run.count > 1 ? (
                            <span className="ow-run-count">{t('observabilityEntity.events.run', { count: run.count })}</span>
                          ) : null}
                        </IdentityCell>
                        <StackCell label={t('table.result')} className={cardCellClass(true)}>
                          <StatusIndicator state={indicatorStateForCode(run.event.result)} label={run.event.result} />
                        </StackCell>
                        <StackCell label={t('table.occurred')} className={`${cardLineAfter} ${cardCellClass(true)}`}>
                          <span className="ow-tnum">{ageMessage(locale, run.firstAt)}</span>
                          {run.count > 1 && run.lastAt !== run.firstAt ? (
                            <span className="ow-cell-meta ms-1">{t('observabilityEntity.events.span', { at: ageMessage(locale, run.lastAt) })}</span>
                          ) : null}
                        </StackCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </section>
          </>
        )}
      </AsyncBoundary>
    </div>
  );
}
