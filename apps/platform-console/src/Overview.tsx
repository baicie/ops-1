import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '@opsweave/platform-client';
import { useAuth } from '@opsweave/platform-client/auth';
import type { Overview } from '@opsweave/platform-client/contracts';
import { Icon } from '@opsweave/ui/icons';
import { Button, buttonVariants } from '@opsweave/ui/button';
import { EmptyState, TimeAgo } from '@opsweave/ui/Ui';
import { formatDate } from '@opsweave/platform-client/format';
import { useT } from '@opsweave/platform-client/i18n';
import type { MessageKey } from '@opsweave/platform-client/i18n';
import { AsyncBoundary, NoticeBar, useObservedPolling } from '@opsweave/ui/async-boundary';
import { MetricCard } from '@opsweave/ui/metric-card';
import { PageHeader } from '@opsweave/ui/page-header';
import { StatusIndicator, indicatorStateForCode, type IndicatorState } from '@opsweave/ui/status-indicator';
import { useStatusText } from '@opsweave/ui/status';
import { statusForCode } from '@opsweave/ui/status-tone';
import { auditEmptyKind } from '@opsweave/platform-client/audit-scope';
import { localizeAttentionDetail, localizeAttentionTitle } from '@opsweave/platform-client/kernel-messages';
import { isUnconfigured } from '@opsweave/platform-client/platform-status';
import { eventLabelKey } from './overview-events';

/** Only the fields this view reads; /api/v1/diagnostics is a plain object payload. */
interface DiagnosticsView {
  kernel: { version: string; database: string; uptimeSeconds: number };
}

const SEVERITY_STATE: Record<string, IndicatorState> = { critical: 'error', warning: 'attention', info: 'info' };

/** Severity is its own vocabulary: an INFO notice is not a permission wall. */
const SEVERITY_LABEL: Record<string, MessageKey> = {
  critical: 'overview.severity.critical',
  warning: 'overview.severity.warning',
  info: 'overview.severity.info',
};

/**
 * An audit code is not a health claim. ACCEPTED means the kernel admitted the request; the
 * one thing a reader needs from this column is the exception, so only a non-positive result
 * is rendered as a coloured chip and everything else stays silent.
 */
const QUIET_RESULTS = new Set(['ACCEPTED', 'SUCCEEDED', 'COMPLETED', 'VERIFIED', 'READY', 'OK', 'SUCCESS']);

/**
 * The three steps an empty platform has to clear before any number on this page can be true.
 * Written as a table of keys rather than a template literal, so scripts/check-i18n.mjs can
 * still resolve every message statically and a missing translation fails the build.
 */
const SETUP_STEPS: Array<{ step: MessageKey; detail: MessageKey }> = [
  { step: 'overview.setup.step1', detail: 'overview.setup.step1.detail' },
  { step: 'overview.setup.step2', detail: 'overview.setup.step2.detail' },
  { step: 'overview.setup.step3', detail: 'overview.setup.step3.detail' },
];

/**
 * A data source has three outcomes, and only one of them is a verdict about the source.
 *
 * ANSWERED — the newest attempt returned a payload and did not throw.
 * MISSING  — the newest attempt settled without a payload, or it threw. A 200 with an empty
 *            body resolves to `null` rather than throwing (api.ts:42-45), so "no payload" has
 *            to be judged on the data itself: an error-only test would pass that half answer
 *            off as healthy.
 * PENDING  — the first attempt has not settled. `loading` is exactly that flag: hooks.ts:19
 *            clears it in the attempt's `finally`, so on the first paint it is the only honest
 *            signal that we have simply not asked long enough, and a page that is still asking
 *            must not claim a source declined to answer.
 */
type SourceState = 'answered' | 'missing' | 'pending';

function sourceState(data: unknown, error: Error | null, loading: boolean): SourceState {
  if (error) return 'missing';
  if (data !== null && data !== undefined) return 'answered';
  return loading ? 'pending' : 'missing';
}

/**
 * §4.5 A. Three layers, in this order: can the platform serve, what must an operator do,
 * what changed lately.
 *
 * V4 changed the *composition*, because V3 had already flattened the boxes without fixing
 * the weight: the attention list still held the wide column whether it held one row or
 * twelve, so an all-clear page spent its largest region on the words "nothing to do" while
 * eight audit rows were squeezed into a short strip underneath. The page now sizes every
 * region to its content - the audit ledger takes the wide column, the work queue and the
 * module ledger share the narrow one - and the counts sit in one strip whose four cells
 * share a label / value / note rhythm so their baselines line up.
 *
 * Every number still comes from the Kernel; a module the Kernel does not report is UNKNOWN
 * with the reason attached, never 0 and never green.
 */
export function OverviewPage() {
  const t = useT();
  const statusText = useStatusText();
  /**
   * A result code with a row in status-tone is rendered as that row's word ("Confirmed"), the
   * same word the pill of that code uses on every other page. A code the table does not know has
   * no word to print, so it stays verbatim - protocol data is still better than an invention.
   */
  const resultLabel = (code: string) => (statusForCode(code) ? statusText(code) : code);
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const overview = useObservedPolling(() => api.get<Overview>('/api/v1/overview'), 10000);
  // Kernel identity/database comes from the admin-only diagnostics route; a non-admin session
  // simply cannot observe it, which is UNKNOWN with a reason, not a green tick.
  const diagnostics = useObservedPolling(
    async () => (isAdmin ? api.get<DiagnosticsView>('/api/v1/diagnostics') : null),
    30000,
  );
  const data = overview.data;
  const observedAt = overview.observedAt;

  const overviewSource = sourceState(data, overview.error, overview.loading);
  const kernelSource = sourceState(diagnostics.data, diagnostics.error, diagnostics.loading);
  const modules = buildModules(t, data, diagnostics.data, diagnostics.error, kernelSource, isAdmin);
  // Counted, not declared: these are the sources this view actually asked. A non-admin session
  // never requests diagnostics (the loader above), so counting that route as unanswered would report a
  // permission this page never sought as a broken source - it simply is not one of the sources.
  const sourceStates: SourceState[] = isAdmin ? [overviewSource, kernelSource] : [overviewSource];
  const sourcesAnswered = sourceStates.filter((state) => state === 'answered').length;
  // PARTIAL means a source settled without answering. A source still pending is not a verdict.
  const partialSource = sourceStates.includes('missing');

  // A green verdict on an empty platform is the exact failure rules/05 and AGENTS.md forbid:
  // READY with zero nodes and zero plugins has proven nothing, because nothing exists yet. The
  // rule lives in lib/platform-status so the topbar pill and the rail's status field read the
  // same derivation instead of inventing their own (§ P0-2).
  const unconfigured = isUnconfigured(data);

  const criticalCount = data ? data.attention.filter((item) => item.severity === 'critical').length : 0;
  /**
   * The Kernel's health code and the counts this page prints are two facts that can disagree.
   *
   * `Overview.health` is derived from the attention list (apps/kernel/src/plugins.rs:647-653), so a
   * node heartbeating as DEGRADED - or a desired replica that is not READY - is not an attention
   * row, and the code can still read READY. The page used to print "every desired replica is
   * ready" in that case, which is exactly the contradiction the visual-system brief forbids. The
   * band therefore presents a reconciled verdict: READY is only shown when the counts it stands
   * on are all ready. The Kernel's own code stays visible in `data-kernel-health`; no API field is
   * reinterpreted and no payload is rewritten.
   */
  const nodesAllReady = data ? data.nodesTotal === 0 || data.nodesReady === data.nodesTotal : true;
  const instancesAllReady = data ? data.instancesTotal === 0 || data.instancesReady === data.instancesTotal : true;
  const countsDegraded = !nodesAllReady || !instancesAllReady;
  const presentedHealth = !data
    ? 'UNKNOWN'
    : unconfigured
      ? 'NOT_CONFIGURED'
      : data.health === 'READY' && countsDegraded
        ? 'DEGRADED'
        : data.health;
  const bandTone = unconfigured
    ? 'neutral'
    : presentedHealth === 'READY'
      ? 'ok'
      : presentedHealth === 'DEGRADED'
        ? 'danger'
        : presentedHealth === 'ATTENTION'
          ? 'warn'
          : 'neutral';
  const countsDetail = data
    ? !nodesAllReady
      ? t('overview.module.nodes.detail', { ready: data.nodesReady, total: data.nodesTotal })
      : !instancesAllReady
        ? t('overview.module.runtime.detail', { ready: data.instancesReady, total: data.instancesTotal, deployments: data.activeDeployments })
        : null
    : null;
  // The headline states the grounds the chip's word does not: why the verdict is what it is.
  const healthHeadline = !data
    ? ''
    : unconfigured
      ? t('overview.setup.headline')
      : presentedHealth === 'READY'
        ? t('overview.health.allClearDetail')
        : presentedHealth === 'DEGRADED'
          ? data.health === 'READY'
            ? t('overview.health.countsConflict')
            : criticalCount > 0
              ? t(criticalCount === 1 ? 'overview.health.criticalIssue' : 'overview.health.criticalIssues', { count: criticalCount })
              : t('overview.health.degraded')
          : presentedHealth === 'ATTENTION'
            ? t('overview.health.attention')
            : t('overview.health.unknown');
  // Which state the chip draws, and whether it must print a wire code: a code this build does
  // not map is the one case where the verbatim token is the honest label (status-indicator.ts).
  const bandState = unconfigured ? 'notConfigured' : indicatorStateForCode(presentedHealth);
  const bandCode = !unconfigured && bandState === 'unknown' ? presentedHealth : undefined;
  // The detail line is rendered only where it adds a fact: the setup instructions, the first
  // mismatch between the verdict and its counts, or the first open issue.
  const attentionDetail = data && data.attention.length ? localizeAttentionDetail(data.attention[0].detail, t) : null;
  const healthDetail = !data
    ? null
    : unconfigured
      ? t('overview.health.notConfiguredDetail')
      : countsDetail
        ? countsDetail
        : attentionDetail
          ? attentionDetail.text
          : presentedHealth === 'UNKNOWN'
            ? t('overview.health.unknownDetail')
            : null;
  const healthDetailFromKernel = !countsDetail && attentionDetail?.source === 'kernel';
  const days = data ? groupEventsByDay(data.recentEvents) : [];
  /**
   * Why the feed is empty, when it is. This read names no subject type, so the kernel drops
   * every kind this caller cannot read and an empty answer is a boundary as often as it is an
   * empty ledger; the panel used to say "install a signed plugin or join a node", which is a
   * cause it had no evidence for. The kernel's scope decides here, never a role check.
   * The panel keeps no filters of its own, so the helper cannot return `filtered` here.
   */
  const eventsScope = data?.scope ?? null;
  const eventsEmptyKind = auditEmptyKind({ scope: eventsScope, spansSubjectTypes: true });

  return (
    <div className="page-stack">
      {/* One primary action. On an empty platform the next step is a node, not another
          package: installing a plugin with no node enrolled would sit PENDING forever. */}
      <PageHeader
        title={t('page.overview')}
        actions={<Button className="text-muted-foreground" variant="ghost" onClick={() => { void overview.reload(); void diagnostics.reload(); }}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>}
        primary={unconfigured
          // The setup steps say "enroll a node first"; the page used to offer no verb for it.
          ? <Link className={buttonVariants()} to="/admin/nodes" data-testid="overview-primary-join"><Icon name="plus" size={15} /> {t('common.joinNode')}</Link>
          : <Link className={buttonVariants()} to="/admin/plugins/install"><Icon name="plus" size={15} /> {t('overview.action.installPlugin')}</Link>}
      />
      <AsyncBoundary
        loading={overview.loading}
        error={overview.error}
        hasData={Boolean(data)}
        onRetry={() => void overview.reload()}
        skeletonRows={6}
      >
        {data ? (
          <>
            {/* Layer 1 - the verdict, then the counts. The observation stamps live in the
                source line under the strip: one per source, so neither is copied onto four cards. */}
            <div className="status-summary">
              <section
                className={`health-band tone-${bandTone}`}
                aria-label={t('overview.health.aria')}
                data-health={presentedHealth}
                data-kernel-health={data.health}
              >
                <div className="health-band-state">
                  {/* No label prop: a state this mapping knows prints its own localized word.
                      The raw code was reaching the reader as "READY" next to a headline that said
                      the same thing in English; the code stays machine-readable in the
                      data-indicator chip attribute and in the band's data-health. */}
                  <StatusIndicator state={bandState} label={bandCode} />
                </div>
                <div className="health-band-copy">
                  <h2>{healthHeadline}</h2>
                  {healthDetail ? <p>{healthDetail}{healthDetailFromKernel ? <span className="server-source">{t('ui.textSource.kernel')}</span> : null}</p> : null}
                </div>
                <div className="health-band-side">
                  {/* A verdict with no verb is a status snapshot. The band now hands the
                      operator the destination of the first thing that needs doing, instead of
                      an in-page anchor to a list they still have to read. */}
                  {/* Both links are answers to "what needs doing", so with nothing open neither is
                      offered: "Review issues" pointed at a list that, on a healthy platform, holds
                      one sentence saying there is nothing to review. Measured at 0 open issues it
                      was the only dead target on the first screen. */}
                  {data.attention.length > 0 ? (
                    <>
                      <Link className="text-link" to={data.attention[0].link} data-testid="overview-fix-first">
                        {t('overview.action.fixIssue')} <Icon name="arrowRight" size={12} />
                      </Link>
                      <a className="text-link" href="#attention">{t('overview.action.reviewIssues')} <Icon name="arrowRight" size={12} /></a>
                    </>
                  ) : null}
                </div>
              </section>

              <section className="stat-block" aria-label={t('overview.kpi.aria')}>
                <div className="stat-strip">
                  {/* A denominator of zero is not a ratio: "0/0" claims a completeness the
                      platform has not observed. Zero enrolled nodes prints an em dash and the
                      reason, never a full fraction. */}
                  <MetricCard
                    label={t('overview.kpi.healthyNodes')}
                    value={data.nodesTotal === 0 ? '—' : data.nodesReady}
                    denominator={data.nodesTotal === 0 ? undefined : data.nodesTotal}
                    detail={data.nodesTotal === 0 ? t('overview.module.nodes.none') : data.nodesReady === data.nodesTotal ? t('overview.kpi.healthyNodes.allObserved') : t('overview.kpi.healthyNodes.stale')}
                    showSampled={false}
                    href="/admin/nodes"
                  />
                  <MetricCard
                    metricId="installedPlugins"
                    label={t('overview.kpi.installedPlugins')}
                    value={data.pluginsInstalled}
                    detail={t(data.pluginsAvailable === 1 ? 'overview.kpi.installedPlugins.one' : 'overview.kpi.installedPlugins.many', { count: data.pluginsAvailable })}
                    showSampled={false}
                    href="/admin/plugins"
                  />
                  <MetricCard
                    label={t('common.readyInstances')}
                    value={data.instancesTotal === 0 ? '—' : data.instancesReady}
                    denominator={data.instancesTotal === 0 ? undefined : data.instancesTotal}
                    detail={data.instancesTotal === 0 ? t('overview.module.runtime.none') : t('overview.kpi.readyInstances.detail')}
                    showSampled={false}
                    href="/admin/plugins"
                  />
                  <MetricCard
                    label={t('overview.kpi.activeDeployments')}
                    value={data.activeDeployments}
                    detail={t('overview.kpi.activeDeployments.detail')}
                    showSampled={false}
                    href="/admin/plugins"
                  />
                </div>
                <p className="stat-note ow-source-line" data-testid="overview-sources" aria-label={t('overview.sources.aria')}>
                  <span data-source="overview" data-testid="overview-observed" data-observed-at={observedAt ?? ''} data-source-state={overviewSource}>
                    {observedAt ? t('overview.sources.overview', { at: formatDate(observedAt) }) : t('overview.sources.overviewPending')}
                  </span>
                  {isAdmin ? (
                    <span data-source="diagnostics" data-observed-at={diagnostics.observedAt ?? ''} data-source-state={kernelSource}>
                      {diagnostics.observedAt ? t('overview.sources.diagnostics', { at: formatDate(diagnostics.observedAt) }) : t('overview.sources.diagnosticsPending')}
                    </span>
                  ) : null}
                </p>
              </section>
            </div>

            {/* Layer 2 - work (narrow column: the queue first, then what the platform can
                observe) beside history (wide column: the audit ledger with something in it).
                Grid areas, not source order, so a phone reads queue -> history as well. */}
            <div className="console-grid">
              <div className="console-aside">
                <section className="panel" id="attention" aria-labelledby="overview-attention-title">
                  <div className="panel-head">
                    <h2 id="overview-attention-title">{unconfigured ? t('overview.setup.title') : t('overview.attention.title')}</h2>
                    <span className="panel-count">
                      {unconfigured
                        ? t('overview.setup.progress', { done: 0, total: SETUP_STEPS.length })
                        : t('overview.attention.count', { count: data.attention.length })}
                    </span>
                  </div>
                  {unconfigured ? (
                    <div className="setup-block" data-testid="overview-setup">
                      <ol className="setup-steps" aria-label={t('overview.setup.aria')}>
                        {SETUP_STEPS.map((entry, index) => (
                          <li className="setup-step" key={entry.step} data-step={index + 1}>
                            <span className="setup-step-num" aria-hidden="true">{index + 1}</span>
                            <div className="setup-step-copy">
                              <strong>{t(entry.step)}</strong>
                              <p>{t(entry.detail)}</p>
                            </div>
                          </li>
                        ))}
                      </ol>
                      <div className="setup-actions">
                        <Link className={buttonVariants()} to="/admin/nodes"><Icon name="plus" size={15} /> {t('overview.setup.cta')}</Link>
                      </div>
                    </div>
                  ) : data.attention.length === 0 ? (
                    <div className="attention-clear" data-testid="overview-attention-clear">
                      <span className="attention-clear-icon"><Icon name="check" size={13} /></span>
                      <div>
                        <strong>{t('overview.attention.empty.title')}</strong>
                        <span className="attention-clear-sep" aria-hidden="true">·</span>
                        <span>{t('overview.attention.empty.description')}</span>
                      </div>
                    </div>
                  ) : (
                    <ul className="attention-list">
                      {data.attention.map((item, index) => {
                        // The Kernel writes these sentences in English and the payload carries no
                        // message code, so a recognized sentence is localized and an unknown one
                        // is printed verbatim with its source named (lib/kernel-messages).
                        const title = localizeAttentionTitle(item.title, t);
                        const detail = localizeAttentionDetail(item.detail, t);
                        return (
                          <li key={`${item.title}-${index}`} className={`attention-item severity-${item.severity}`} data-severity={item.severity} data-title-source={title.source} data-detail-source={detail.source}>
                            <StatusIndicator state={SEVERITY_STATE[item.severity] ?? 'attention'} label={t(SEVERITY_LABEL[item.severity] ?? 'overview.severity.warning')} />
                            <div className="attention-item-copy">
                              <strong>{title.text}</strong>
                              {title.source === 'kernel' ? <span className="server-source">{t('ui.textSource.kernel')}</span> : null}
                              <p>{detail.text}{detail.source === 'kernel' ? <span className="server-source">{t('ui.textSource.kernel')}</span> : null}</p>
                            </div>
                            <Link className="text-link" to={item.link}>{t('overview.attention.inspect')} <Icon name="arrowRight" size={13} /></Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                <section className="panel" aria-labelledby="overview-modules-title" data-testid="overview-modules">
                  <div className="panel-head">
                    <h2 id="overview-modules-title">{t('overview.modules.title')}</h2>
                  </div>
                  <ul className="module-strip" aria-label={t('overview.modules.aria')}>
                    {groupModules(modules).map((group) =>
                      group.rows.length === 1 ? (
                        <li key={group.rows[0].id} className="module-row">
                          <ModuleCard module={group.rows[0]} t={t} showState />
                        </li>
                      ) : (
                        <li key={group.state + ':' + group.rows[0].id} className="module-row module-row-group" data-indicator={group.state} data-module-count={group.rows.length}>
                          <div className="module-group-head">
                            <StatusIndicator state={group.state} />
                            <span className="module-group-count">{t('overview.modules.grouped', { count: group.rows.length })}</span>
                          </div>
                          <ul className="module-group-cards">
                            {group.rows.map((module) => (
                              <li key={module.id}><ModuleCard module={module} t={t} showState={false} /></li>
                            ))}
                          </ul>
                        </li>
                      ),
                    )}
                  </ul>
                  {partialSource ? <NoticeBar state="partial" title={t('state.partial')} detail={t('ui.partial.sources', { ok: sourcesAnswered, total: sourceStates.length })} /> : null}
                </section>
              </div>

              <section className="panel console-main" data-testid="overview-audit" aria-labelledby="overview-events-title">
                <div className="panel-head">
                  <h2 id="overview-events-title">{t('overview.events.title')}</h2>
                  <Link className="text-link" to="/admin/activity">{t('overview.events.viewAll')} <Icon name="arrowRight" size={13} /></Link>
                </div>
                {data.recentEvents.length === 0 ? (
                  <div data-empty-state={eventsEmptyKind} data-testid="overview-events-empty">
                    {eventsEmptyKind === 'restricted' ? (
                      <EmptyState
                        icon="access"
                        title={t('overview.events.restricted.title')}
                        description={t('overview.events.restricted.description', { kinds: (eventsScope?.readableSubjectTypes ?? []).join(', ') })}
                      />
                    ) : (
                      <EmptyState icon="activity" title={t('overview.events.empty.title')} description={t('overview.events.empty.description')} />
                    )}
                  </div>
                ) : (
                  <ol className="event-list event-ledger">
                    {days.map((day) => (
                      <React.Fragment key={day.key}>
                        <li className="event-day" aria-hidden="true">{dayLabel(t, day.key)}</li>
                        {day.rows.map((row) => {
                          const quiet = QUIET_RESULTS.has(row.result.toUpperCase());
                          const labelKey = eventLabelKey(row.eventType);
                          const inner = (
                            <>
                              <span className="event-time"><TimeAgo value={row.at} /></span>
                              <span className="event-body">
                                <span className="event-title">
                                  <strong className={labelKey ? undefined : 'mono'}>{labelKey ? t(labelKey) : row.eventType}</strong>
                                  {row.count > 1 ? <span className="event-count" title={t('overview.events.repeated', { count: row.count })}>×{row.count}</span> : null}
                                  {!quiet ? (
                                    <span className="event-result">
                                      <StatusIndicator state={indicatorStateForCode(row.result)} label={resultLabel(row.result)} />
                                    </span>
                                  ) : null}
                                </span>
                                <span className="event-subject">
                                  <span className="event-subject-kind">{row.subjectType}</span>
                                  <span aria-hidden="true"> </span>
                                  <span className="mono" title={row.subjectId}>{shortId(row.subjectId)}</span>
                                </span>
                              </span>
                            </>
                          );
                          return (
                            <li key={row.key} data-event={row.eventType} data-event-known={labelKey ? 'true' : 'false'}>
                              {row.href ? <Link className="event-row" to={row.href}>{inner}</Link> : <div className="event-row">{inner}</div>}
                            </li>
                          );
                        })}
                      </React.Fragment>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </>
        ) : null}
      </AsyncBoundary>
    </div>
  );
}

/** Where the kernel module's state can be acted on. A module row with no door is a dead end. */
const KERNEL_HREF = '/admin/settings/diagnostics';

type ModuleRow = {
  id: string;
  labelKey: MessageKey;
  state: IndicatorState;
  detail: string;
  href?: string;
};

/**
 * The first layer: four modules, each stating what it is doing. The counts they used to
 * repeat are in the glance strip, so a row carries only the state and the reason - two
 * lines in every row, which is what keeps the ledger even.
 */
type Translation = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * Consecutive modules that agree on their state are one row.
 *
 * Availability used to print one row per module, and on a healthy platform three of those four
 * rows opened with the same word: Ready, Ready, Ready. The verdict is one fact; the module
 * details are three. Grouping keeps both - the row states the verdict once, and each module in it
 * is still its own link with its own detail. Grouping is by CONSECUTIVE state and never sorts, so
 * a degraded module between two ready ones still gets its own row instead of being folded into a
 * verdict that would then be false for it.
 */
function groupModules(rows: ModuleRow[]): { state: IndicatorState; rows: ModuleRow[] }[] {
  const groups: { state: IndicatorState; rows: ModuleRow[] }[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.state === row.state) last.rows.push(row);
    else groups.push({ state: row.state, rows: [row] });
  }
  return groups;
}

/**
 * One module: its own destination, its own name, its own detail.
 *
 * showState is false inside a group, because that row already states the state for the modules it
 * holds - printing it three more times is the repetition the grouping exists to remove, and
 * printing it on the row while also printing it per card would be four.
 */
function ModuleCard({ module, t, showState }: { module: ModuleRow; t: Translation; showState: boolean }) {
  const body = (
    <>
      <div className="module-card-head">
        <span className="module-card-name">{t(module.labelKey)}</span>
        {showState ? <StatusIndicator state={module.state} /> : null}
      </div>
      <p className="module-card-detail">{module.detail}</p>
      {module.href ? <span className="module-card-go" aria-hidden="true"><Icon name="arrowRight" size={14} /></span> : null}
    </>
  );
  // A card inside a row that already printed the state does not print it again.
  const className = showState ? 'module-card' : 'module-card module-card-inline';
  return module.href ? (
    <Link className={className} to={module.href} data-module={module.id} data-indicator={module.state}>
      {body}
    </Link>
  ) : (
    <div className={className} data-module={module.id} data-indicator={module.state}>{body}</div>
  );
}

function buildModules(
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  data: Overview | null,
  diagnostics: DiagnosticsView | null,
  diagnosticsError: Error | null,
  kernelSource: SourceState,
  isAdmin: boolean,
): ModuleRow[] {
  const kernel: ModuleRow = (() => {
    if (!isAdmin) return { id: 'kernel', labelKey: 'overview.module.kernel', state: 'unknown', detail: t('overview.module.kernel.denied') };
    if (diagnosticsError) return { id: 'kernel', labelKey: 'overview.module.kernel', state: 'unknown', detail: t('overview.module.kernel.error'), href: KERNEL_HREF };
    // Still asking is LOADING; asked and settled with nothing (a 200 with an empty body) is UNKNOWN
    // with the reason attached - the same rule the nodes and runtime cards already follow below.
    if (!diagnostics) {
      return { id: 'kernel', labelKey: 'overview.module.kernel', state: kernelSource === 'pending' ? 'loading' : 'unknown', detail: t('ui.notObserved'), href: KERNEL_HREF };
    }
    const database = diagnostics.kernel.database === 'connected' ? t('overview.module.kernel.dbConnected') : t('overview.module.kernel.dbUnavailable');
    return {
      id: 'kernel',
      labelKey: 'overview.module.kernel',
      state: diagnostics.kernel.database === 'connected' ? 'ready' : 'degraded',
      detail: t('overview.module.kernel.detail', { version: diagnostics.kernel.version, database }),
      href: KERNEL_HREF,
    };
  })();
  const nodes: ModuleRow = !data
    ? { id: 'nodes', labelKey: 'overview.module.nodes', state: 'unknown', detail: t('ui.notObserved'), href: '/admin/nodes' }
    : data.nodesTotal === 0
      ? { id: 'nodes', labelKey: 'overview.module.nodes', state: 'notConfigured', detail: t('overview.module.nodes.none'), href: '/admin/nodes' }
      : {
          id: 'nodes',
          labelKey: 'overview.module.nodes',
          state: data.nodesReady === data.nodesTotal ? 'ready' : 'degraded',
          detail: data.nodesReady === data.nodesTotal ? t('overview.module.nodes.reachable', { total: data.nodesTotal }) : t('overview.module.nodes.detail', { ready: data.nodesReady, total: data.nodesTotal }),
          href: '/admin/nodes',
        };
  const runtime: ModuleRow = !data
    ? { id: 'runtime', labelKey: 'overview.module.runtime', state: 'unknown', detail: t('ui.notObserved'), href: '/admin/plugins' }
    : data.instancesTotal === 0
      ? { id: 'runtime', labelKey: 'overview.module.runtime', state: 'notConfigured', detail: t('overview.module.runtime.none'), href: '/admin/plugins' }
      : {
          id: 'runtime',
          labelKey: 'overview.module.runtime',
          state: data.instancesReady === data.instancesTotal ? 'ready' : 'degraded',
          detail: data.instancesReady === data.instancesTotal ? t('overview.module.runtime.allReady') : t('overview.module.runtime.detail', { ready: data.instancesReady, total: data.instancesTotal, deployments: data.activeDeployments }),
          href: '/admin/plugins',
        };
  // The Kernel exposes no Catalog health source. Marking it READY because plugins exist would
  // be exactly the inference §4.5 A forbids, so it stays UNKNOWN with the reason attached.
  const catalog: ModuleRow = { id: 'catalog', labelKey: 'overview.module.catalog', state: 'unknown', detail: t('overview.module.catalog.unavailable'), href: '/admin/plugins' };
  return [kernel, nodes, runtime, catalog];
}

type AuditRow = {
  key: string;
  eventType: string;
  subjectType: string;
  subjectId: string;
  result: string;
  at: string;
  count: number;
  href?: string;
};

type AuditDay = { key: string; rows: AuditRow[] };

/**
 * The band over a group of audit rows answers one question: is this one burst or a week of
 * them? Today and yesterday get a word, everything older gets its date.
 */
function dayLabel(t: (key: MessageKey, params?: Record<string, string | number>) => string, dayKey: string): string {
  const today = new Date();
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  if (dayKey === iso(today)) return t('overview.events.day.today');
  const yesterday = new Date(today.getTime() - 86400000);
  if (dayKey === iso(yesterday)) return t('overview.events.day.yesterday');
  return formatDate(dayKey + 'T00:00:00Z');
}

/** Long ids are shortened in the middle: a 36-character uuid in a list is not read. */
function shortId(value: string): string {
  if (!value) return '';
  return value.length > 20 ? value.slice(0, 8) + '\u2026' + value.slice(-4) : value;
}

/** Where an audited subject lives, when this shell has a page for it. */
function eventHref(event: Overview['recentEvents'][number]): string | undefined {
  const details = (event.details ?? {}) as Record<string, unknown>;
  if (event.subjectType === 'pipeline' || event.subjectType === 'pipeline_draft') {
    const pipelineId = typeof details.pipelineId === 'string' ? details.pipelineId : event.subjectId;
    return '/admin/pipelines/' + encodeURIComponent(pipelineId);
  }
  if (event.subjectType === 'job') return '/admin/jobs/' + encodeURIComponent(event.subjectId);
  return undefined;
}

/**
 * Group consecutive repeats of the same event on the same subject.
 *
 * The deployed view printed eight rows, four of which were the same two events twice, all
 * with the same timestamp and the same green chip. A burst is one fact ("draft updated
 * twice"), not four - so it renders as one row carrying xN, and the day band explains why
 * everything shares one time.
 */
function groupEventsByDay(events: Overview['recentEvents']): AuditDay[] {
  const days: AuditDay[] = [];
  let current: AuditRow | null = null;
  for (const event of events) {
    const dayKey = event.occurredAt.slice(0, 10);
    let day = days[days.length - 1];
    if (!day || day.key !== dayKey) {
      day = { key: dayKey, rows: [] };
      days.push(day);
      current = null;
    }
    if (current && current.eventType === event.eventType && current.subjectId === event.subjectId) {
      current.count += 1;
      continue;
    }
    current = {
      key: event.id,
      eventType: event.eventType,
      subjectType: event.subjectType,
      subjectId: event.subjectId,
      result: event.result,
      at: event.occurredAt,
      count: 1,
      href: eventHref(event),
    };
    day.rows.push(current);
  }
  return days;
}
