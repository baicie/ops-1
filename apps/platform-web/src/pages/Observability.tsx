import * as React from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useDocumentTitle } from '../hooks';
import { useI18n, useT } from '../i18n';
import type { NodeView } from '../types';
import { Icon } from '../components/Icons';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { EmptyState } from '../components/Ui';
import { AsyncBoundary, NoticeBar, isStale, useObservedPolling } from '../components/app/async-boundary';
import { MetricCard } from '../components/app/metric-card';
import { PageHeader } from '../components/app/page-header';
import { NoData, StatusIndicator, UnknownValue } from '../components/app/status-indicator';
import { formatBytes } from '../format';
import { ageMessage } from '../lib/age';
import { apiFailureCopy } from '../lib/kernel-messages';
import {
  IdentityCell,
  RowActions,
  StackCell,
  cardActionCell,
  cardCellClass,
  cardLineAfter,
  cardTwoLineRow,
  copyIdAction,
  formatIdentity,
  rankCardFacts,
  stackBody,
  stackHead,
  stackRow,
  stackTable,
} from './table-kit';
import {
  METRIC_KEYS,
  entityRows,
  indicatorForEntityState,
  filterRows,
  loadColumnEarnsWidth,
  sortRows,
  stateCanReport,
  summarise,
  type EntityFilter,
  type EntityRow,
  type Reading,
} from './observability-model';

/**
 * `/app/observability` — what the platform can currently observe, and what it cannot.
 *
 * The only telemetry this build has is node resource sampling (`GET /api/v1/nodes`, backed by
 * `kernel.node_resource_samples`): CPU, memory and filesystem. There is no metric explorer here
 * because there are no other metrics; a chart whose series this platform cannot fill would be a
 * drawing, not an instrument.
 *
 * The page's whole job is to keep three facts apart that a dashboard usually merges:
 *
 *   READING      the node answered and the sample is a number
 *   NO_DATA      the node answered and this sample is absent
 *   UNKNOWN      the node did not answer, so its load cannot be claimed at all
 *
 * None of them is 0%. `observability-model.ts` makes that a type rather than a convention, and
 * every number below carries the `observedAt` it came from.
 *
 * Layout is `docs/design/ui-visual-v3/spec/page-template.md` §2.1 in its fixed order: header 80,
 * one KPI band, one toolbar row, the entity table, then two secondary panels.
 */

/** Poll cadence. The kernel's own heartbeat is 5s, so a faster poll would only re-read one row. */
const POLL_MS = 5000;

const FILTERS: readonly EntityFilter[] = ['all', 'attention', 'reporting', 'stale', 'unobservable'];

/**
 * The filter named by the URL, or `all`.
 *
 * The filter lives in the query string rather than in component state so that the KPI band's
 * "reporting" card can link to the subset it counts, and so a reader who has narrowed the fleet
 * to the nodes nobody can see has a link they can paste into an incident. An unrecognised value
 * degrades to `all` instead of showing an empty table for a filter that does not exist.
 */
function parseFilter(value: string | null): EntityFilter {
  return FILTERS.includes(value as EntityFilter) ? (value as EntityFilter) : 'all';
}

/** A ratio as a localized percentage. `Intl`, so zh-CN does not read an English unit. */
function percent(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value);
}

/**
 * One utilisation figure inside a table cell.
 *
 * The missing branches are deliberately NOT the dashed token here: §2.7 allows one NO_DATA box
 * per table, and a utilisation column over fourteen rows would spend fourteen. The row says the
 * same thing in muted words and the dashed token is spent once, above the table, where the
 * coverage sentence is.
 */
function Utilisation({ reading, locale }: { reading: Reading; locale: string }) {
  const t = useT();
  if (reading.kind === 'reading') {
    return <span className="ow-utilization ow-tnum">{percent(locale, reading.value)}</span>;
  }
  return (
    <span className="ow-obs-absent" data-reading={reading.kind}>
      {t(reading.kind === 'noData' ? 'observability.reading.noSample' : 'observability.reading.unreachable')}
    </span>
  );
}

/**
 * The fleet load cell: three metrics as one reading, which is what they are — one sample from
 * one collector at one instant. Three columns would have been three headings, three widths and
 * three borders for a single observation (table-spec §2.2).
 */
function LoadCell({ row, locale }: { row: EntityRow; locale: string }) {
  const t = useT();
  const memory = row.readings.memory;
  const filesystem = row.readings.filesystem;
  return (
    <div className="ow-cell">
      <span className="ow-cell-value ow-tnum">
        <Utilisation reading={row.readings.cpu} locale={locale} />
        <span className="ow-obs-sep" aria-hidden="true"> · </span>
        <Utilisation reading={memory} locale={locale} />
      </span>
      <span className="ow-cell-meta ow-tnum">
        {/* The absolute pair is what makes a percentage actionable: 80% of 2 GiB and 80% of
            512 GiB are different operational facts. Printed only when the sample carries it. */}
        {memory.kind === 'reading' && row.node.resourceSnapshot?.memoryTotalBytes
          ? `${formatBytes(row.node.resourceSnapshot.memoryUsedBytes)} / ${formatBytes(row.node.resourceSnapshot.memoryTotalBytes)}`
          : t('observability.cell.capacityUnknown')}
        {filesystem.kind === 'reading' ? (
          <>
            <span aria-hidden="true"> · </span>
            {t('observability.cell.disk', { value: percent(locale, filesystem.value) })}
          </>
        ) : null}
      </span>
    </div>
  );
}

export function ObservabilityPage() {
  const t = useT();
  const { locale } = useI18n();
  const navigate = useNavigate();
  useDocumentTitle(t('observability.title'));

  const { data, error, loading, reload, observedAt } = useObservedPolling(
    () => api.get<NodeView[]>('/api/v1/nodes'),
    POLL_MS,
  );

  const [query, setQuery] = React.useState('');
  // The filter lives in the URL, not in component state: the KPI band links into it
  // (`?state=reporting`), and a filtered fleet view is a thing an operator pastes into a ticket.
  // `replace` so flipping a filter does not fill the back button with intermediate views.
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get('state'));
  const setFilter = (next: EntityFilter) => {
    const updated = new URLSearchParams(params);
    if (next === 'all') updated.delete('state'); else updated.set('state', next);
    setParams(updated, { replace: true });
  };

  const nodes = data ?? [];
  // One clock per render for every age and staleness decision on the page, so the KPI band and
  // the table cannot disagree about whether the same sample is stale.
  const now = Date.now();
  const rows = React.useMemo(() => sortRows(entityRows(nodes, now)), [data, now]);
  const summary = React.useMemo(() => summarise(nodes, now), [data, now]);

  const needle = query.trim().toLowerCase();
  const visible = React.useMemo(() => {
    const byFilter = filterRows(rows, filter);
    if (!needle) return byFilter;
    return byFilter.filter((row) =>
      row.node.name.toLowerCase().includes(needle) || row.node.id.toLowerCase().includes(needle));
  }, [rows, filter, needle]);

  const filtering = needle !== '' || filter !== 'all';
  const clearFilters = () => { setQuery(''); setFilter('all'); };

  // §2.2: the load column only earns its width while most rows can fill it. Past the halfway
  // mark it stops being a column and the absence is stated once, above the table.
  const loadIsColumn = loadColumnEarnsWidth(visible);
  const namesAreUnique = new Set(visible.map((row) => row.node.name)).size === visible.length;

  const cardFacts = React.useMemo(() => rankCardFacts({
    state: visible.map((row) => row.state),
    load: visible.map((row) => (row.readings.cpu.kind === 'reading' ? Math.round(row.readings.cpu.value * 100) : null)),
    // Unobservable rows contribute null, not "0/0": a null is what rankCardFacts reads as "this
    // row has no value here", which is exactly true, and it keeps the column's distinct-ratio
    // honest instead of counting every unreachable node as the same fabricated count.
    instances: visible.map((row) => (row.instances ? `${row.instances.ready}/${row.instances.total}` : null)),
  }), [visible]);

  return (
    <div className="page-stack" data-testid="observability-page">
      <PageHeader
        eyebrow={t('observability.eyebrow')}
        title={t('observability.title')}
        description={t('observability.description')}
        actions={(
          <Button variant="secondary" onClick={() => void reload()}>
            <Icon name="refresh" size={15} /> {t('action.refresh')}
          </Button>
        )}
      />

      {/* page-template §2.1: at most one KPI band, four columns, never three. Each card is a
          count of observations — never a derived health score, which is the shape that lets
          NO_DATA disappear into an average. */}
      <section className="metric-grid" aria-label={t('observability.kpi.aria')} data-region="kpi">
        <MetricCard
          metricId="obs-attention"
          label={t('observability.kpi.attention')}
          value={<span className="ow-tnum">{summary.attention}</span>}
          state={summary.total === 0 ? 'unknown' : 'ready'}
          detail={summary.total === 0
            ? t('observability.kpi.reporting.none')
            : [
              summary.degraded ? t('observability.kpi.attention.degraded', { count: summary.degraded }) : null,
              (summary.staleStates + summary.staleReadySamples) ? t('observability.kpi.attention.stale', { count: summary.staleStates + summary.staleReadySamples }) : null,
              summary.unreachable ? t('observability.kpi.attention.unreachable', { count: summary.unreachable }) : null,
              summary.unknown ? t('observability.kpi.attention.unknown', { count: summary.unknown }) : null,
              summary.revoked ? t('observability.kpi.attention.revoked', { count: summary.revoked }) : null,
              summary.noSample ? t('observability.kpi.attention.noSample', { count: summary.noSample }) : null,
            ].filter(Boolean).join(' · ') || t('observability.kpi.attention.none')}
          href="/app/observability?state=attention"
          showSampled={false}
        />
        <MetricCard
          metricId="obs-reporting"
          label={t('observability.kpi.reporting')}
          value={<span className="ow-tnum">{summary.reporting}</span>}
          denominator={summary.total === 0 ? undefined : summary.total}
          state={summary.total === 0 ? 'unknown' : 'ready'}
          // The peak belongs to the reporting population, not to a fifth card: it is the
          // follow-up question after "who answered", not a separate fleet verdict.
          detail={summary.total === 0
            ? t('observability.kpi.reporting.none')
            : summary.peakCpu
              ? (summary.peakMemory
                ? t('observability.kpi.reporting.peaks', {
                  cpu: percent(locale, summary.peakCpu.value),
                  node: summary.peakCpu.nodeName,
                  memory: percent(locale, summary.peakMemory.value),
                })
                : t('observability.kpi.reporting.peakCpu', {
                  cpu: percent(locale, summary.peakCpu.value),
                  node: summary.peakCpu.nodeName,
                }))
              : summary.peakMemory
                ? t('observability.kpi.reporting.peakMemory', {
                  memory: percent(locale, summary.peakMemory.value),
                  node: summary.peakMemory.nodeName,
                })
                : t('observability.kpi.reporting.detail')}
          sampledAt={summary.observedAt}
          href="/app/observability?state=reporting"
        />
        <MetricCard
          metricId="obs-stale"
          label={t('observability.kpi.stale')}
          value={<span className="ow-tnum">{summary.staleRows}</span>}
          // A fleet with no rows at all is UNKNOWN; a fleet whose rows are only unreachable
          // still has a real stale-row count if the kernel marked them stale.
          state={summary.total === 0 ? 'unknown' : (summary.staleRows > 0 || summary.reporting > 0 ? 'ready' : 'noData')}
          detail={summary.total === 0
            ? t('observability.kpi.reporting.none')
            : summary.staleRows > 0
              ? t('observability.kpi.stale.oldest', {
                at: summary.oldestStaleSampleAt ? ageMessage(locale, summary.oldestStaleSampleAt) : '',
              })
              : summary.reporting === 0
                ? t('observability.kpi.stale.none')
                : t('observability.kpi.stale.current')}
          href="/app/observability?state=stale"
          showSampled={false}
        />
        <MetricCard
          metricId="obs-unobservable"
          label={t('observability.kpi.unobservable')}
          value={<span className="ow-tnum">{summary.notObservable + summary.noSample}</span>}
          state={summary.total === 0 ? 'unknown' : 'ready'}
          detail={t('observability.kpi.unobservable.detail', {
            unreachable: summary.notObservable,
            noSample: summary.noSample,
          })}
          href="/app/observability?state=unobservable"
          showSampled={false}
        />
      </section>

      {/* Where the numbers came from and how old the newest one is. The cards above each carry
          a verdict; this line carries the source and the clock, which is what makes the verdict
          checkable rather than authoritative. */}
      <p className="stat-note" data-testid="observability-freshness" data-observed-at={summary.observedAt ?? ''} data-stale-samples={summary.staleSamples}>
        {summary.observedAt
          ? t('observability.freshness', { at: ageMessage(locale, summary.observedAt), seconds: POLL_MS / 1000 })
          : t('observability.freshness.none')}
      </p>

      {/* §2.4: one row, one control height. Every control here is the 40px tier. */}
      <section className="toolbar" data-testid="observability-filters">
        <div className="relative flex min-w-[260px] max-w-[460px] flex-1 items-center">
          <Icon name="search" size={16} className="absolute left-[10px] text-muted-foreground" />
          <Input
            aria-label={t('observability.search.aria')}
            placeholder={t('observability.search.placeholder')}
            value={query}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)}
            className="pl-[33px]"
          />
        </div>
        <Select value={filter} onValueChange={(value: string) => setFilter(value as EntityFilter)}>
          {/* page-template §2.4 rule C1: one control tier per toolbar row. The primitive's own
              `h-9` resolves to 36 while the `Input` beside it takes the global 40px control
              min-height, which is the 8px baseline break the v3 audit measured on four admin
              toolbars. Reading --ow-control-md here keeps both controls on one tier without
              editing the shared primitive (which other sessions are also touching). */}
          <SelectTrigger
            aria-label={t('observability.filter.aria')}
            className="h-[var(--ow-control-md)] w-[240px] max-w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('observability.filter.all')}</SelectItem>
            <SelectItem value="attention">{t('observability.filter.attention')}</SelectItem>
            <SelectItem value="reporting">{t('observability.filter.reporting')}</SelectItem>
            <SelectItem value="stale">{t('observability.filter.stale')}</SelectItem>
            <SelectItem value="unobservable">{t('observability.filter.unobservable')}</SelectItem>
          </SelectContent>
        </Select>
        {filtering ? (
          <Button variant="ghost" onClick={clearFilters}>{t('ui.clearFilters')}</Button>
        ) : null}
        <span className="toolbar-count" data-testid="observability-count">
          {t('observability.count', { shown: visible.length, total: rows.length })}
        </span>
      </section>

      {/* A payload older than 2.5 polls is not current, and the page says so rather than
          letting the reader assume the numbers are live. */}
      {isStale(observedAt, POLL_MS) ? (
        <NoticeBar
          state="stale"
          title={t('ui.stale.title')}
          detail={t('ui.stale.detail', { at: observedAt ?? '' })}
          action={<Button variant="secondary" onClick={() => void reload()}>{t('action.retry')}</Button>}
        />
      ) : null}

      {/* Rows already on screen survive a failed refresh; a first load is the AsyncBoundary's
          error panel. A mid-session refusal is named here rather than swallowed by
          `error={data ? null : error}` - a revoked grant and a transient blip must not look
          identical, and the clock-based STALE notice is not a reason. */}
      {data && error ? (
        <div data-testid="observability-refresh-error">
          <NoticeBar
            state="error"
            title={t('observability.refresh.failed.title')}
            detail={apiFailureCopy(error, t).reason}
            action={<Button variant="secondary" onClick={() => void reload()}>{t('action.retry')}</Button>}
          />
        </div>
      ) : null}

      <AsyncBoundary
        loading={loading}
        // Rows already on screen survive a failed refresh; only a first load with nothing to
        // show becomes the error panel.
        error={data ? null : error}
        hasData={Boolean(data)}
        isEmpty={rows.length === 0}
        skeletonRows={6}
        onRetry={() => void reload()}
        emptyState={(
          <EmptyState
            icon="server"
            title={t('observability.empty.fleet.title')}
            description={t('observability.empty.fleet.description')}
          />
        )}
      >
        {visible.length === 0 ? (
          <div data-empty-state="filtered">
            <EmptyState
              icon="search"
              title={t('observability.empty.filtered.title')}
              description={t('observability.empty.filtered.description')}
              action={<Button variant="secondary" onClick={clearFilters}>{t('ui.clearFilters')}</Button>}
            />
          </div>
        ) : (
          <section className="panel table-panel" data-region="fleet">
            {/* §2.7 + machine-language M1: the dashed token appears ONCE per region, and this
                is the region's one. The sentence carries the coverage, so the rows below can
                state absence in words and spend no further boxes. */}
            <p className="stat-note" data-table-note="coverage">
              {loadIsColumn ? t('observability.table.note') : t('observability.table.noteDegraded')}
              {summary.noSample > 0 ? (
                <>
                  {' '}
                  <NoData detail={t('observability.noData.detail')} />{' '}
                  {t('observability.table.coverage', { missing: summary.noSample, total: rows.length })}
                </>
              ) : null}
              {summary.notObservable > 0 ? (
                <>
                  {' '}
                  <UnknownValue detail={t('observability.unknown.detail')} />{' '}
                  {t('observability.table.unobservable', { count: summary.notObservable })}
                </>
              ) : null}
              {summary.staleSamples > 0 ? (
                <> {t('observability.table.stale', { count: summary.staleSamples })}</>
              ) : null}
            </p>
            <Table className={stackTable}>
              {/* §2.2 caps a table at five columns. Four here: identity, state, load, instances.
                  os/arch and generation are constant across a fleet of one architecture, so they
                  ride the identity cell's second line instead of owning columns. */}
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('table.node')}</TableHead>
                  <TableHead>{t('table.status')}</TableHead>
                  {loadIsColumn ? <TableHead>{t('observability.table.load')}</TableHead> : null}
                  <TableHead>{t('table.instances')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {visible.map((row) => {
                  const href = `/app/observability/nodes/${row.node.id}`;
                  const identity = formatIdentity({
                    name: row.node.name,
                    id: row.node.id,
                    at: row.observedAt ?? row.node.lastSeenAt,
                    locale,
                    nameIsUnique: namesAreUnique,
                    rowsOnPage: visible.length,
                  });
                  return (
                    <TableRow
                      key={row.node.id}
                      className={`cursor-pointer ${cardTwoLineRow} ${stackRow}`}
                      data-entity-state={row.state}
                      data-observed-at={row.observedAt ?? ''}
                      onClick={() => navigate(href)}
                    >
                      <IdentityCell label={t('table.node')} identity={identity} href={href} cardFact>
                        <span className="mono">{row.node.os}/{row.node.arch}</span>
                        <span className="ow-key">{t('nodes.table.generation', { generation: row.node.generation })}</span>
                      </IdentityCell>
                      <StackCell label={t('table.status')} className={cardCellClass(cardFacts.includes('state'))}>
                        <div className="ow-cell-stack">
                          <StatusIndicator state={indicatorForEntityState(row.state)} />
                          {/* Staleness is a second fact about a node that still answers, so it
                              rides beside the state instead of replacing it. */}
                          {row.stale && row.state !== 'unreachable' && row.state !== 'revoked' ? (
                            <span className="ow-cell-meta">{t('observability.cell.staleSample')}</span>
                          ) : stateCanReport(row.state) && !METRIC_KEYS.some((key) => row.readings[key].kind === 'reading') ? (
                            // Reachable but silent: the state chip is Ready because the node
                            // answered, and the missing sample is the reliability fact beside it.
                            <span className="ow-cell-meta" data-reading="noSample">{t('observability.cell.noSample')}</span>
                          ) : null}
                        </div>
                      </StackCell>
                      {loadIsColumn ? (
                        <StackCell
                          label={t('observability.table.load')}
                          data-reading-cell="load"
                          className={`${cardLineAfter} ${cardCellClass(cardFacts.includes('load'))}`}
                        >
                          <LoadCell row={row} locale={locale} />
                        </StackCell>
                      ) : null}
                      <StackCell
                        label={t('table.instances')}
                        className={`${cardLineAfter} ${cardCellClass(cardFacts.includes('instances'))}`}
                      >
                        {/* A node that cannot report does not get to claim "0 of 3 ready": the
                            counts are stored rows, and for an unreachable node they describe the
                            last time it answered, not now. Same gate as the load cell. */}
                        {row.instances ? (
                          <>
                            <strong className="ow-tnum">{row.instances.ready}/{row.instances.total}</strong>
                            <span className="ow-cell-meta ms-1">{t('status.ready')}</span>
                          </>
                        ) : (
                          <span className="ow-obs-absent" data-reading="unknown">{t('observability.reading.unreachable')}</span>
                        )}
                      </StackCell>
                      <StackCell label="" className={cardActionCell} onClick={(event) => event.stopPropagation()}>
                        <RowActions
                          label={t('observability.row.actions', { name: row.node.name })}
                          actions={[
                            { id: 'open', label: t('observability.row.open'), icon: 'arrowRight', onSelect: () => navigate(href) },
                            copyIdAction(row.node.id, t('observability.row.copyId')),
                          ]}
                        />
                      </StackCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </section>
        )}
      </AsyncBoundary>

      {/* §2.1: at most two secondary panels. One states what this surface cannot answer yet —
          the honest half of an observability console — and the other points at the sources. */}
      <section className="panel pad" data-testid="observability-scope" data-region="scope">
        <div className="panel-head">
          <div>
            <h2>{t('observability.scope.title')}</h2>
            <p>{t('observability.scope.description')}</p>
          </div>
        </div>
        <ul className="ow-scope-list">
          <li>
            <span className="ow-scope-have"><Icon name="check" size={14} aria-hidden="true" /></span>
            <div>
              <strong>{t('observability.scope.have.title')}</strong>
              <p>{t('observability.scope.have.detail')}</p>
            </div>
          </li>
          <li>
            <span className="ow-scope-missing"><Icon name="circleDashed" size={14} aria-hidden="true" /></span>
            <div>
              <strong>{t('observability.scope.missing.title')}</strong>
              <p>{t('observability.scope.missing.detail')}</p>
            </div>
          </li>
          <li>
            <span className="ow-scope-missing"><Icon name="circleDashed" size={14} aria-hidden="true" /></span>
            <div>
              <strong>{t('observability.scope.retention.title')}</strong>
              <p>{t('observability.scope.retention.detail')}</p>
            </div>
          </li>
        </ul>
        <p className="stat-note">
          <Link to="/admin/nodes">{t('observability.scope.link')}</Link>
        </p>
      </section>
    </div>
  );
}
