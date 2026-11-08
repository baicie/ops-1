import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import type { Capability, Extension, PluginSummary, Publisher } from '../types';
import { Icon } from '../components/Icons';
import { Button, buttonVariants } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { CopyButton, EmptyState } from '../components/Ui';
import { AsyncBoundary, NoticeBar, isStale, useObservedPolling } from '../components/app/async-boundary';
import { MetricCard } from '../components/app/metric-card';
import { PageHeader } from '../components/app/page-header';
import { Sheet, SheetContent } from '../components/app/sheet';
import { NoData, StatusIndicator, UnknownValue, type IndicatorState } from '../components/app/status-indicator';
import { useCompactViewport } from '../shells/surface/SurfaceChrome';
import { useI18n, useT } from '../i18n';
import type { MessageKey } from '../i18n';
import { ApiError } from '../api';
import { cn } from '../lib/utils';
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
  type RowAction,
} from './table-kit';
import {
  buildSourcesModel,
  summarize,
  type Connector,
  type EvidenceTrust,
  type GrantReach,
  type GrantView,
  type Readiness,
  type SourcesModel,
} from './sources-model';
import { ConnectorConfigForm } from './sources-config';

/**
 * `/app/sources` — the telemetry connector surface.
 *
 * Everything on this page is derived from two kernel reads that know nothing about any vendor:
 * the plugin list and the capability registry. `sources-model.ts` joins them, so a connector
 * written by another team shows up here the moment it activates with a source-family capability
 * — there is no per-connector branch in this file and no vendor name anywhere in it.
 *
 * Three rules shape what gets rendered, and all three are about *not* overstating:
 *
 *   1. Nothing absent is drawn as healthy. "Not deployed", "capability not granted" and "never
 *      collected" are three different facts with three different words, and a read that failed
 *      (403 on grants, for instance) renders UNKNOWN rather than the pessimistic answer.
 *   2. No secret reaches the DOM. The configuration form takes a `secret://` reference or an
 *      environment variable NAME, never a value, and never echoes an existing one back. There
 *      is no code path here that can render credential material (`rules/03-security.md`).
 *   3. Trust is reported, not inferred. An unsigned bundle, or a verified one whose publisher
 *      lost trust, can never read as SOURCE_ATTESTED.
 *
 * Layout is `page-template.md` §2.1 in fixed order: header → one KPI band → toolbar → the
 * primary table panel → at most two secondary panels.
 */

/** 30s: a connector's readiness changes on deployment timescales, not request timescales. */
const POLL_MS = 30_000;

/** What the four reads answer with. A null is "this read did not answer", never "empty". */
interface SourcesPayload {
  plugins: PluginSummary[];
  capabilities: Capability[] | null;
  /** null when the caller may not list grants (viewer 403) or the read failed. */
  grants: GrantView[] | null;
  publishers: Publisher[] | null;
  extensions: Extension[] | null;
}

/**
 * One read per endpoint, and a failure on a *secondary* endpoint degrades that column instead
 * of the page. Only the plugin list is load-bearing: without it there are no rows at all, so
 * its rejection propagates and `AsyncBoundary` renders the error/403 panel.
 *
 * `capabilities` is what makes a plugin a source, so it is also required — but its own failure
 * is reported as `null` so the page can say "the registry did not answer" rather than "there
 * are no connectors", which would be a claim about the platform rather than about the read.
 */
async function readSources(): Promise<SourcesPayload> {
  const [plugins, capabilities, grants, publishers, extensions] = await Promise.all([
    api.get<PluginSummary[]>('/api/v1/plugins'),
    api.get<Capability[]>('/api/v1/capabilities').catch(() => null),
    api.get<GrantView[]>('/api/v1/capability-grants').catch(() => null),
    api.get<Publisher[]>('/api/v1/publishers').catch(() => null),
    api.get<Extension[]>('/api/v1/extensions').catch(() => null),
  ]);
  return { plugins, capabilities, grants, publishers, extensions };
}

/* ── vocabulary: one word per fact, shared by table, cards and drawer ───────── */

const TRUST_LABEL: Record<EvidenceTrust, MessageKey> = {
  SOURCE_ATTESTED: 'sources.trust.sourceAttested',
  OPERATOR_ASSERTED: 'sources.trust.operatorAsserted',
  UNVERIFIED: 'sources.trust.unverified',
  UNKNOWN: 'sources.trust.unknown',
};

/** Why the level is what it is — a tooltip, never the label. */
const TRUST_REASON: Record<Connector['trustReason'], MessageKey> = {
  signed: 'sources.trust.reason.signed',
  system: 'sources.trust.reason.system',
  publisherRevoked: 'sources.trust.reason.publisherRevoked',
  unsigned: 'sources.trust.reason.unsigned',
  missing: 'sources.trust.reason.missing',
};

const REACH_LABEL: Record<GrantReach, MessageKey> = {
  granted: 'sources.reach.granted',
  notGranted: 'sources.reach.notGranted',
  expired: 'sources.reach.expired',
  revoked: 'sources.reach.revoked',
  unknown: 'sources.reach.unknown',
};

const READINESS_LABEL: Record<Readiness, MessageKey> = {
  serving: 'sources.readiness.serving',
  partial: 'sources.readiness.partial',
  down: 'sources.readiness.down',
  none: 'sources.readiness.none',
  unknown: 'sources.readiness.unknown',
};

/**
 * Trust rendered as a chip whose *state* is the honest one.
 *
 * Attested is the only level that reads as ready. `UNVERIFIED` is an attention state rather
 * than an error — the connector may be deliberately unsigned in a dev install — and `UNKNOWN`
 * stays unknown, because the difference between "unsigned" and "not checked" is the whole
 * point of having four levels.
 */
const TRUST_STATE: Record<EvidenceTrust, IndicatorState> = {
  SOURCE_ATTESTED: 'ready',
  OPERATOR_ASSERTED: 'attention',
  UNVERIFIED: 'attention',
  UNKNOWN: 'unknown',
};

const REACH_STATE: Record<GrantReach, IndicatorState> = {
  granted: 'ready',
  notGranted: 'notConfigured',
  expired: 'attention',
  revoked: 'revoked',
  unknown: 'unknown',
};

const READINESS_STATE: Record<Readiness, IndicatorState> = {
  serving: 'ready',
  partial: 'degraded',
  down: 'error',
  none: 'notConfigured',
  unknown: 'unknown',
};

/** The one filter axis. Each value selects exactly the rows its KPI card counted. */
type Filter = 'ALL' | 'SERVING' | 'ATTENTION' | 'UNATTESTED';

const FILTER_LABEL: Record<Filter, MessageKey> = {
  ALL: 'sources.filter.all',
  SERVING: 'sources.filter.serving',
  ATTENTION: 'sources.filter.attention',
  UNATTESTED: 'sources.filter.unattested',
};

/** True when the plugin's own install state says it is up. */
function isActive(connector: Connector): boolean {
  const code = String(connector.state || '').toUpperCase();
  return code === 'ACTIVE' || code === 'READY';
}

/**
 * The filter, written so the chip and the table can never disagree: the KPI cards call
 * `summarize()` and these predicates are the same three conditions, in the same order.
 */
function matchesFilter(connector: Connector, filter: Filter): boolean {
  if (filter === 'ALL') return true;
  const serving = isActive(connector) && connector.readiness === 'serving' && connector.reach === 'granted';
  if (filter === 'SERVING') return serving;
  if (filter === 'UNATTESTED') return connector.trust === 'UNVERIFIED' || connector.trust === 'OPERATOR_ASSERTED';
  return !serving;
}

/**
 * table-spec §2.2, as one function instead of per column.
 *
 * A column earns its width only while the rows on screen can tell each other apart through it:
 * below one distinct value per five rows a reader stops *scanning* the column and merely *reads*
 * it once, which costs the same as one line of qualifier and takes a fifth of the table. Under
 * ten rows the ratio is noise, so the column is kept — the rule needs a page to measure.
 *
 * Demotion, never deletion: every caller moves the fact to the identity cell's second line or to
 * the drawer, so nothing an operator could act on leaves the page.
 */
function earnsWidth(values: Array<string | null | undefined>, minRows = 10, floor = 0.2): boolean {
  if (values.length < minRows) return true;
  const present = values.map((value) => String(value ?? '')).filter(Boolean);
  return new Set(present).size / values.length >= floor;
}

/** The haystack the search box reads. Includes the id so an operator can paste one in. */
function haystack(connector: Connector): string {
  return [connector.name, connector.pluginId, connector.capability, connector.publisher ?? '']
    .join(' ')
    .toLowerCase();
}

/* ── the page ──────────────────────────────────────────────────────────────── */

export function SourcesPage() {
  const { t } = useI18n();
  const { locale } = useI18n();
  const { user } = useAuth();
  const { data, error, loading, reload, observedAt } = useObservedPolling(readSources, POLL_MS);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const [detail, setDetail] = useState<Connector | null>(null);
  const [configure, setConfigure] = useState<Connector | null>(null);

  // Writes to a plugin are operator verbs in the kernel (`deployments::disable` calls
  // `require_operator`). The row still *offers* them to a viewer, disabled with the reason —
  // hiding a control is not authorization, and a stated refusal beats a dead end.
  const canOperate = user?.role === 'admin' || user?.role === 'operator';

  const model: SourcesModel = useMemo(
    () => buildSourcesModel({
      plugins: data?.plugins ?? [],
      capabilities: data?.capabilities ?? null,
      grants: data?.grants ?? null,
      publishers: data?.publishers ?? null,
      extensions: data?.extensions ?? null,
    }),
    [data],
  );

  const summary = useMemo(() => summarize(model.connectors), [model.connectors]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return model.connectors.filter(
      (connector) => matchesFilter(connector, filter) && (!needle || haystack(connector).includes(needle)),
    );
  }, [model.connectors, filter, query]);

  /**
   * table-spec §2.2: a column earns its width over the rows on screen. `publisher` is the
   * column most likely to be constant on a single-vendor install, so it is dropped rather than
   * printing the same value down the table — the drawer still carries it per connector.
   */
  const publisherEarnsRatio = useMemo(() => earnsWidth(visible.map((connector) => connector.publisher ?? '')), [visible]);
  /**
   * table-spec §2.2, same rule applied to `reach`.
   *
   * On a healthy install nearly every connector is callable, so the column collapses to two
   * values down twelve rows (measured 0.17 — below the 0.2 floor at which a column is scanned
   * rather than read once). The fact still matters, so it is **demoted, not deleted**: it moves
   * onto the identity cell's qualifier line, which is exactly where §2.2 sends a column that
   * cannot earn its width. The toolbar's "not callable" filter is the other half — a reader
   * looking for the exceptions selects them instead of scanning a near-constant column.
   */
  const reachEarnsColumn = useMemo(() => earnsWidth(visible.map((connector) => connector.reach)), [visible]);
  /**
   * table-spec §2.2 caps a table at 5 columns from 1024px and at 4 between 768 and 1023. The four
   * that stay are the ones the page exists to answer — who it is, whether it runs, whether anyone
   * may call it, and how much its output can be trusted — so `publisher` is the one that gives
   * way below 1024. It is a demotion, not a deletion: the drawer prints it per connector.
   */
  const narrow = useCompactViewport('(max-width: 1023px)');
  const publisherEarnsColumn = publisherEarnsRatio && !narrow;

  /** §2.5: the three facts a 390 card keeps, ranked by distinct ratio over the visible rows. */
  const cardFacts = rankCardFacts({
    status: visible.map((connector) => String(connector.state || '')),
    trust: visible.map((connector) => connector.trust),
    reach: visible.map((connector) => connector.reach),
    replicas: visible.map((connector) =>
      connector.readyInstances === null || connector.totalInstances === null
        ? ''
        : `${connector.readyInstances}/${connector.totalInstances}`),
  });

  /**
   * Stale has two causes and both have to say so, because the table keeps its rows either way
   * (`error={data ? null : error}` just below).
   *
   *   1. the newest observation is older than 2.5 polling rounds (`isStale`);
   *   2. a refresh was refused while the previous rows are still on screen - the rows are a
   *      real past observation, but nothing has confirmed them since.
   *
   * Without the second clause a failed poll left a table that looked current: the rows are
   * retained on purpose, so something must age them. /admin/activity and /admin/settings/
   * diagnostics derive it the same way.
   */
  const stale = isStale(observedAt, POLL_MS) || Boolean(error && data);
  // A 403 on grants is a permission fact about this reader, not a fact about the connectors;
  // it has to be said out loud or every reach cell silently reads UNKNOWN.
  const grantsWithheld = Boolean(data) && data?.grants === null;
  const registrySilent = Boolean(data) && data?.capabilities === null;
  /**
   * No answer at all: the plugin read itself failed (5xx / 403 / 409) and nothing was retained.
   *
   * This is the case where a count must NOT be printed. `summarize([])` is honestly 0 for an
   * empty list, but when the list is empty *because nobody answered*, that same 0 reads as
   * "we looked and there are none" — the exact substitution `AGENTS.md` forbids ("把 UNKNOWN /
   * PARTIAL / NO_DATA 伪装成健康状态") and `machine-language-rules.md` §M1 covers. The conflict
   * screenshot caught it: four cards reading 0 under a panel that said the read had failed.
   */
  const unanswered = !data && Boolean(error);

  /**
   * The sheet is opened from a row menu item, and that item unmounts with the menu. Radix then
   * restores focus to an element that no longer exists, which lands on <body>; return it to the
   * row's action trigger instead. The query is scoped by the row's stable data-connector value.
   */
  const restoreRowFocus = React.useCallback((pluginId: string) => {
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-connector="${CSS.escape(pluginId)}"] [data-testid="row-actions"]`)
        ?.focus();
    });
  }, []);

  function connectorActions(connector: Connector): RowAction[] {
    const actions: RowAction[] = [
      copyIdAction(connector.pluginId, t('sources.action.copyId')),
      { id: 'detail', label: t('sources.action.inspect'), icon: 'search', onSelect: () => setDetail(connector) },
      {
        id: 'configure',
        label: t('sources.action.configure'),
        icon: 'settings',
        // There is no kernel endpoint that writes connector configuration yet (see
        // sources-config.tsx): the form states that and refuses to pretend otherwise.
        onSelect: () => setConfigure(connector),
      },
    ];
    actions.push({
      id: 'admin',
      label: t('sources.action.manage'),
      icon: 'external',
      divider: true,
      onSelect: () => { window.location.assign(`/admin/plugins/${encodeURIComponent(connector.pluginId)}`); },
      disabled: !canOperate,
      disabledReason: t('sources.action.operatorOnly'),
    });
    return actions;
  }

  return (
    <div className="page-stack" data-testid="sources-page">
      <PageHeader
        eyebrow={t('sources.eyebrow')}
        title={t('page.workspaceSources')}
        description={t('sources.description')}
        // One primary CTA per page. Installing a connector is the only verb that creates
        // something here, and it lives in the admin surface, so this is a link, not a button
        // that would 403 for a viewer.
        primary={
          canOperate ? (
            <Link className={buttonVariants()} to="/admin/plugins/install" data-testid="sources-install">
              <Icon name="plus" size={15} /> {t('sources.action.install')}
            </Link>
          ) : undefined
        }
      />

      {/* page-template §2.1: zero or one KPI band, 4 columns, never 3. */}
      <section className="metric-grid" data-testid="sources-kpi">
        <MetricCard
          metricId="sources.total"
          label={t('sources.kpi.total')}
          value={unanswered ? undefined : model.connectors.length}
          detail={t('sources.kpi.total.detail')}
          sampledAt={observedAt}
          showSampled={false}
          state={unanswered || registrySilent ? 'noData' : 'ready'}
        />
        <MetricCard
          metricId="sources.serving"
          label={t('sources.kpi.serving')}
          value={unanswered ? undefined : summary.serving}
          denominator={unanswered || model.connectors.length === 0 ? undefined : model.connectors.length}
          detail={t('sources.kpi.serving.detail')}
          showSampled={false}
          // Serving needs the grant registry to be readable; without it the number would be a
          // guess that happens to look like a health reading.
          state={unanswered ? 'noData' : grantsWithheld || registrySilent ? 'unknown' : 'ready'}
        />
        <MetricCard
          metricId="sources.attention"
          label={t('sources.kpi.attention')}
          value={unanswered ? undefined : summary.attention}
          detail={t('sources.kpi.attention.detail')}
          showSampled={false}
          state={unanswered || registrySilent ? 'noData' : 'ready'}
        />
        <MetricCard
          metricId="sources.unattested"
          label={t('sources.kpi.unattested')}
          value={unanswered ? undefined : summary.unattested}
          detail={t('sources.kpi.unattested.detail')}
          showSampled={false}
          state={unanswered || registrySilent ? 'noData' : 'ready'}
        />
      </section>

      {stale ? (
        <NoticeBar
          state="stale"
          title={t('sources.notice.stale.title')}
          detail={t('sources.notice.stale.detail')}
          action={<Button className="text-muted-foreground" variant="ghost" size="sm" onClick={() => void reload()}>{t('action.refresh')}</Button>}
        />
      ) : null}
      {grantsWithheld ? (
        <NoticeBar state="forbidden" title={t('sources.notice.grants.title')} detail={t('sources.notice.grants.detail')} />
      ) : null}
      {registrySilent ? (
        <NoticeBar state="noData" title={t('sources.notice.registry.title')} detail={t('sources.notice.registry.detail')} />
      ) : null}

      {/* page-template §2.1: toolbar, one control tier per row. */}
      <section className="toolbar" data-testid="sources-toolbar">
        <Input
          className="max-w-[320px]"
          value={query}
          aria-label={t('sources.search.label')}
          placeholder={t('sources.search.placeholder')}
          onChange={(event) => setQuery(event.target.value)}
          data-testid="sources-search"
        />
        <Select value={filter} onValueChange={(value: string) => setFilter(value as Filter)}>
          <SelectTrigger aria-label={t('sources.filter.label')} className="w-[200px]" data-testid="sources-filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(FILTER_LABEL) as Filter[]).map((value) => (
              <SelectItem key={value} value={value}>{t(FILTER_LABEL[value])}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="secondary" onClick={() => void reload()} data-testid="sources-refresh">
          <Icon name="refresh" size={15} /> {t('action.refresh')}
        </Button>
        <span className="toolbar-count" data-testid="sources-count">
          {t('sources.count', { shown: visible.length, total: model.connectors.length })}
        </span>
      </section>

      <AsyncBoundary
        loading={loading}
        /**
         * A retained observation outranks a failed refresh, the same reading as /admin/activity
         * and /admin/settings/diagnostics.
         *
         * Passing `error` unconditionally replaced the whole table with an error wall the moment
         * one poll failed — throwing away the only connector data there is, and taking the stale
         * notice with it (the notice renders above this boundary, so a wall hides the very
         * sentence that would have aged the rows). Connectors the kernel answered for a minute
         * ago are still the best available statement about this platform; what they are not is
         * *current*, and that is what the notice above says. A first load that fails has no rows
         * to keep, so there the wall is right and `error` still reaches the boundary.
         */
        error={data ? null : error}
        hasData={Boolean(data)}
        isEmpty={model.connectors.length === 0}
        onRetry={() => void reload()}
        emptyState={
          <EmptyState
            icon="radar"
            title={t(registrySilent ? 'sources.empty.registry.title' : 'sources.empty.title')}
            description={t(registrySilent ? 'sources.empty.registry.description' : 'sources.empty.description')}
            action={
              canOperate ? (
                <Link className={buttonVariants({ variant: 'secondary' })} to="/admin/plugins/install">
                  {t('sources.action.install')}
                </Link>
              ) : undefined
            }
          />
        }
      >
        {visible.length === 0 ? (
          <section className="panel">
            <EmptyState
              icon="filter"
              title={t('sources.empty.filtered.title')}
              description={t('sources.empty.filtered.description')}
              action={
                <Button variant="secondary" onClick={() => { setQuery(''); setFilter('ALL'); }}>
                  {t('sources.action.clearFilters')}
                </Button>
              }
            />
          </section>
        ) : (
          <section className="panel table-panel" data-testid="sources-table-panel">
            <Table className={cn('sources-table', stackTable)}>
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('sources.table.connector')}</TableHead>
                  <TableHead>{t('table.status')}</TableHead>
                  {reachEarnsColumn ? <TableHead>{t('sources.table.reach')}</TableHead> : null}
                  <TableHead>{t('table.trust')}</TableHead>
                  {publisherEarnsColumn ? <TableHead>{t('table.publisher')}</TableHead> : null}
                  {/* The trailing cell carries the row menu, so it is a slot and not a column -
                      same reading as /admin/nodes and /admin/plugins. A titled header here would
                      add a column whose every row is identical, which is a constant feeding
                      min(distinctRatio) (table-spec §2.2) and a §2.2 cap this table cannot spare.
                      The menu button keeps its own aria-label, so nothing is unnamed. */}
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {visible.map((connector) => {
                  const identity = formatIdentity({
                    name: connector.name,
                    id: connector.pluginId,
                    locale,
                    nameIsUnique: !connector.nameIsAmbiguous,
                    rowsOnPage: visible.length,
                  });
                  return (
                    <TableRow
                      key={connector.pluginId}
                      className={cn('cursor-pointer', cardTwoLineRow, stackRow)}
                      data-connector={connector.pluginId}
                      data-row-key={connector.pluginId}
                      data-trust={connector.trust}
                      data-reach={connector.reach}
                      onClick={() => setDetail(connector)}
                    >
                      <IdentityCell
                        label={t('sources.table.connector')}
                        identity={identity}
                        cardFact
                        className="max-[768px]:pl-5"
                      >
                        {/* The qualifier line: what this connector provides, and at which
                            version. Capability, not vendor — it is the thing that makes it a
                            source.

                            The interpuncts are NOT written here: `.ow-ident-meta > span + span`
                            already supplies one before every sibling (styles.css), so a literal
                            " · " in the text rendered twice ("data.source.v1 · v1·· v1"). Each
                            part is therefore one bare span and the separator stays the
                            stylesheet's job — one owner for the character, as every other
                            qualifier line in the shell has. */}
                        <span className="ow-ident-meta">
                          <span className="mono">{connector.capability}</span>
                          <span>v{connector.major}</span>
                          {connector.activeVersion ? <span>{connector.activeVersion}</span> : null}
                          {/* §2.2's demotion: when reach cannot earn a column it rides the
                              qualifier, so the fact survives and the column does not. Only the
                              exceptions are spelled out — "callable" is the norm and would be a
                              near-constant word on every row. */}
                          {!reachEarnsColumn && connector.reach !== 'granted' ? (
                            <span>{t(REACH_LABEL[connector.reach])}</span>
                          ) : null}
                        </span>
                      </IdentityCell>

                      <StackCell
                        label={t('table.status')}
                        className={cardCellClass(cardFacts.includes('status'))}
                      >
                        {connector.state ? (
                          <StatusIndicator
                            state={READINESS_STATE[connector.readiness]}
                            label={t(READINESS_LABEL[connector.readiness])}
                            detail={
                              connector.readyInstances === null
                                ? undefined
                                : (
                                  <>
                                    {connector.readyInstances} /{' '}
                                    {connector.totalInstances === null
                                      ? <NoData detail={t('ui.noData.detail')} />
                                      : connector.totalInstances}
                                  </>
                                )
                            }
                          />
                        ) : (
                          // No install state at all: the source cannot answer. Not "down".
                          <NoData detail={t('sources.table.noState')} />
                        )}
                      </StackCell>

                      {/* Rendered only while the column earns its width; when it does not, the
                          same fact rides the identity cell's qualifier line above (§2.2's
                          demotion), so nothing is lost and no near-constant column is scanned. */}
                      {reachEarnsColumn ? (
                        <StackCell
                          label={t('sources.table.reach')}
                          className={cn(cardLineAfter, cardCellClass(cardFacts.includes('reach')))}
                        >
                          {connector.reach === 'unknown' ? (
                            <UnknownValue detail={t('sources.reach.unknown.detail')} />
                          ) : (
                            <StatusIndicator
                              state={REACH_STATE[connector.reach]}
                              label={t(REACH_LABEL[connector.reach])}
                              detail={connector.consumers > 0 ? t('sources.reach.consumers', { count: connector.consumers }) : undefined}
                            />
                          )}
                        </StackCell>
                      ) : null}

                      {/* Line 2 on a card, not line 1. The card's first line is sized from the
                          identity at `flex: 1 1 0` against every line-1 cell at `flex: 0 0 auto`
                          (styles.css, "the two-line card"), so each extra badge up there is taken
                          out of the name. Measured at 375 with Status *and* Trust on line 1: the
                          identity line got 8px of the 349px row and `· acme.zabbix` was painted
                          past the cell edge - the one thing §2.5 says may never be clipped. Status
                          is the single line-1 badge, exactly as /admin/jobs and /admin/plugins
                          carry one, and trust rides line 2 with the rest. */}
                      <StackCell
                        label={t('table.trust')}
                        className={cn(cardLineAfter, cardCellClass(cardFacts.includes('trust')))}
                      >
                        <StatusIndicator
                          state={TRUST_STATE[connector.trust]}
                          label={t(TRUST_LABEL[connector.trust])}
                          detail={undefined}
                        />
                        <span className="sr-only">{t(TRUST_REASON[connector.trustReason])}</span>
                      </StackCell>

                      {publisherEarnsColumn ? (
                        <StackCell label={t('table.publisher')} className={cardCellClass(false)}>
                          {connector.publisher ? <span className="mono small">{connector.publisher}</span> : <NoData />}
                        </StackCell>
                      ) : null}

                      <TableCell className={cardActionCell}>
                        <RowActions label={t('sources.action.rowMenu', { name: connector.name })} actions={connectorActions(connector)} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </section>
        )}
      </AsyncBoundary>

      {/* page-template §2.1: at most two secondary panels, in reading order. */}
      {model.unsatisfiedRequirements.length > 0 ? (
        <section className="panel" data-testid="sources-unsatisfied">
          <div className="panel-head">
            <div>
              <h2>{t('sources.unsatisfied.title')}</h2>
              <p>{t('sources.unsatisfied.description')}</p>
            </div>
            <span className="panel-count">{model.unsatisfiedRequirements.length}</span>
          </div>
          <ul className="detail-list pad">
            {model.unsatisfiedRequirements.map((item) => (
              <li key={`${item.name}@${item.major}@${item.consumerPluginId}`}>
                <span className="mono">{item.name} · v{item.major}</span>
                <span className="mono small">{item.consumerPluginId}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {model.unclassifiedProviders > 0 ? (
        <section className="panel" data-testid="sources-scope">
          <div className="panel-head">
            <div>
              <h2>{t('sources.scope.title')}</h2>
              <p>{t('sources.scope.description', { count: model.unclassifiedProviders })}</p>
            </div>
          </div>
        </section>
      ) : null}

      <ConnectorDetailSheet
        connector={detail}
        onClose={() => { if (detail) restoreRowFocus(detail.pluginId); setDetail(null); }}
        // Detail hands over to config; focus stays in the new sheet until it closes, then the
        // row that opened the chain gets it back.
        onConfigure={(connector) => { setDetail(null); setConfigure(connector); }}
        grantsWithheld={grantsWithheld}
      />
      <ConnectorConfigSheet
        connector={configure}
        canOperate={canOperate}
        onClose={() => { if (configure) restoreRowFocus(configure.pluginId); setConfigure(null); }}
      />
    </div>
  );
}

/* ── the inspect drawer ─────────────────────────────────────────────────────── */

/**
 * Everything the table demoted, per connector: the full id, each provided capability with its
 * own reach, the trust reason in words, and the replica counts.
 *
 * The full plugin id lives here with a `CopyButton` (table-spec §2.1: the id is always one
 * click away and never the visible identity).
 */
function ConnectorDetailSheet({
  connector,
  onClose,
  onConfigure,
  grantsWithheld,
}: {
  connector: Connector | null;
  onClose: () => void;
  onConfigure: (connector: Connector) => void;
  grantsWithheld: boolean;
}) {
  const t = useT();
  if (!connector) return null;
  return (
    <Sheet open onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        title={connector.name}
        description={t('sources.detail.description')}
        closeLabel={t('action.close')}
        data-testid="sources-detail"
      >
        <div className="ow-source-detail">
          <ul className="detail-list">
            <li>
              <span>{t('sources.detail.pluginId')}</span>
              <span className="ow-source-id">
                <span className="mono small">{connector.pluginId}</span>
                <CopyButton value={connector.pluginId} label={t('sources.action.copyId')} testId="sources-copy-id" />
              </span>
            </li>
            <li>
              <span>{t('table.trust')}</span>
              <span>{t(TRUST_LABEL[connector.trust])}</span>
            </li>
            <li>
              <span>{t('sources.detail.trustReason')}</span>
              <span>{t(TRUST_REASON[connector.trustReason])}</span>
            </li>
            <li>
              <span>{t('table.publisher')}</span>
              <span className="mono small">{connector.publisher ?? t('state.noData')}</span>
            </li>
            <li>
              <span>{t('table.version')}</span>
              <span className="mono small">{connector.activeVersion ?? connector.latestVersion ?? t('state.noData')}</span>
            </li>
            <li>
              <span>{t('table.instances')}</span>
              <span>
                {connector.readyInstances === null ? (
                  t('state.noData')
                ) : (
                  <>
                    {connector.readyInstances} /{' '}
                    {connector.totalInstances === null
                      ? <NoData detail={t('ui.noData.detail')} />
                      : connector.totalInstances}
                  </>
                )}
              </span>
            </li>
          </ul>

          <h3 className="ow-source-subhead">{t('sources.detail.capabilities')}</h3>
          {grantsWithheld ? (
            <p className="ow-source-note">{t('sources.notice.grants.detail')}</p>
          ) : null}
          <ul className="detail-list">
            {/* `Connector.capabilities` is built from the PROVIDES side of the registry only
                (sources-model: `sourceProvides`), so every row here is a capability this plugin
                offers. The word is printed rather than inferred per row: a direction test over a
                list that cannot contain REQUIRES would be a branch no data can take. */}
            {connector.capabilities.map((item) => (
              <li key={`${item.name}@${item.major}`}>
                <span className="mono small">{item.name} · v{item.major}</span>
                <span>{t('sources.detail.provides')}</span>
              </li>
            ))}
          </ul>

          {/* Collection history needs an evidence/collection-run API that does not exist in
              this build. Saying so is the only honest thing this panel can do: a chart of
              zeroes would read as "nothing happened", which is a claim we cannot make. */}
          <h3 className="ow-source-subhead">{t('sources.detail.collection')}</h3>
          <p className="ow-source-note" data-testid="sources-collection-absent">
            {t('sources.detail.collection.absent')}
          </p>

          <div className="ow-source-actions">
            <Button variant="secondary" onClick={() => onConfigure(connector)} data-testid="sources-detail-configure">
              <Icon name="settings" size={15} /> {t('sources.action.configure')}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ── the configuration drawer ───────────────────────────────────────────────── */

/**
 * The configuration form, wrapped in the sheet.
 *
 * The form itself lives in `sources-config.tsx` because its validation is the security-critical
 * part and is unit-tested apart from the drawer.
 */
function ConnectorConfigSheet({
  connector,
  canOperate,
  onClose,
}: {
  connector: Connector | null;
  canOperate: boolean;
  onClose: () => void;
}) {
  const t = useT();
  if (!connector) return null;
  return (
    <Sheet open onOpenChange={(open: boolean) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        title={t('sources.config.title')}
        description={t('sources.config.description', { name: connector.name })}
        closeLabel={t('action.close')}
        data-testid="sources-config"
      >
        <ConnectorConfigForm connector={connector} canOperate={canOperate} onClose={onClose} />
      </SheetContent>
    </Sheet>
  );
}
