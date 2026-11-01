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

const FILTERS: readonly EntityFilter[] = ['all', 'attention', 'reporting', 'unobservable'];

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
    instances: visible.map((row) => `${row.node.instancesReady}/${row.node.instancesTotal}`),
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
          metricId="obs-reporting"
          label={t('observability.kpi.reporting')}
          value={<span className="ow-tnum">{summary.reporting}</span>}
          denominator={summary.total}
          detail={t('observability.kpi.reporting.detail')}
          sampledAt={summary.observedAt}
          href="/app/observability?state=reporting"
        />
        <MetricCard
          metricId="obs-unobservable"
          label={t('observability.kpi.unobservable')}
          // A fleet with nothing to hide reads 0 here, and that 0 IS an observation: we asked
          // every node and every one answered. It is not the same as `state: unknown`, which is
          // what the card shows when there is no fleet to ask.
          value={<span className="ow-tnum">{summary.notObservable + summary.noSample}</span>}
          state={summary.total === 0 ? 'unknown' : 'ready'}
          detail={t('observability.kpi.unobservable.detail', {
            unreachable: summary.notObservable,
            noSample: summary.noSample,
          })}
          showSampled={false}
        />
        <MetricCard
          metricId="obs-peak-cpu"
          label={t('observability.kpi.peakCpu')}
          value={summary.peakCpu ? percent(locale, summary.peakCpu.value) : undefined}
          // No reporting node means no peak to show, and the card says so with the token
          // instead of printing 0% — which would read as an idle fleet.
          state={summary.peakCpu ? 'ready' : 'noData'}
          detail={summary.peakCpu ? summary.peakCpu.nodeName : t('observability.kpi.peak.none')}
          sampledAt={summary.peakCpu?.observedAt ?? null}
          href={summary.peakCpu ? `/app/observability/nodes/${summary.peakCpu.nodeId}` : undefined}
        />
        <MetricCard
          metricId="obs-peak-memory"
          label={t('observability.kpi.peakMemory')}
          value={summary.peakMemory ? percent(locale, summary.peakMemory.value) : undefined}
          state={summary.peakMemory ? 'ready' : 'noData'}
          detail={summary.peakMemory ? summary.peakMemory.nodeName : t('observability.kpi.peak.none')}
          sampledAt={summary.peakMemory?.observedAt ?? null}
          href={summary.peakMemory ? `/app/observability/nodes/${summary.peakMemory.nodeId}` : undefined}
        />
      </section>

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
          <SelectTrigger aria-label={t('observability.filter.aria')} className="w-[240px] max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('observability.filter.all')}</SelectItem>
            <SelectItem value="attention">{t('observability.filter.attention')}</SelectItem>
            <SelectItem value="reporting">{t('observability.filter.reporting')}</SelectItem>
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
                        <strong className="ow-tnum">{row.node.instancesReady}/{row.node.instancesTotal}</strong>
                        <span className="ow-cell-meta ms-1">{t('status.ready')}</span>
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
