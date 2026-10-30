import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import type { Overview } from '../types';
import { Icon } from '../components/Icons';
import { Button, buttonVariants } from '../components/ui/button';
import { EmptyState, TimeAgo } from '../components/Ui';
import { formatDate } from '../format';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n';
import { AsyncBoundary, NoticeBar, useObservedPolling } from '../components/app/async-boundary';
import { MetricCard } from '../components/app/metric-card';
import { PageHeader } from '../components/app/page-header';
import { StatusIndicator, indicatorStateForCode, type IndicatorState } from '../components/app/status-indicator';
import { useStatusText } from '../components/app/status';
import { statusForCode } from '../components/status-tone';
import { localizeAttentionDetail, localizeAttentionTitle } from '../lib/kernel-messages';
import { isUnconfigured } from '../lib/platform-status';

/** Only the fields this view reads; /api/v1/diagnostics is a plain object payload. */
interface DiagnosticsView {
  kernel: { version: string; database: string; uptimeSeconds: number };
}

const SEVERITY_STATE: Record<string, IndicatorState> = { critical: 'error', warning: 'attention', info: 'notConfigured' };

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
 * Audit rows read as sentences, so the known event vocabulary gets a label.
 *
 * "Known" means the codes the kernel actually writes into kernel.audit_events (grep of
 * apps/kernel/src), not the six this table happened to start with: `plugin.activated` is what a
 * plugin activation writes, and it reached the console as a raw dot-path in a mono font while
 * `pipeline.draft_created` beside it read "Draft created".
 */
const EVENT_LABELS: Record<string, MessageKey> = {
  'pipeline.created': 'event.pipeline.created',
  'pipeline.draft_created': 'event.pipeline.draftCreated',
  'pipeline.draft_updated': 'event.pipeline.draftUpdated',
  'pipeline.draft_published': 'event.pipeline.draftPublished',
  'pipeline.revision_published': 'event.pipeline.revisionPublished',
  'pipeline.job_completed': 'event.pipeline.jobCompleted',
  'pipeline.job_failed': 'event.pipeline.jobFailed',
  'pipeline.job_terminalized': 'event.pipeline.jobTerminalized',
  'plugin.activated': 'event.plugin.activated',
  'plugin.staged': 'event.plugin.staged',
  'plugin.disabled': 'event.plugin.disabled',
  'plugin.uninstalled': 'event.plugin.uninstalled',
  'plugin.rejected': 'event.plugin.rejected',
  'deployment.created': 'event.deployment.created',
  'node.enrolled': 'event.node.enrolled',
  'node.revoked': 'event.node.revoked',
  'node.enrollment_token.created': 'event.node.enrollmentTokenCreated',
  'publisher.added': 'event.publisher.added',
  'publisher.revoked': 'event.publisher.revoked',
  'user.created': 'event.user.created',
  'user.updated': 'event.user.updated',
  'capability.granted': 'event.capability.granted',
  'capability.revoked': 'event.capability.revoked',
  'capability.service_invoke': 'event.capability.serviceInvoke',
};

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
  // The band says one thing. Its three children (state, headline, when) are the same three
  // facts the old banner carried, minus the card frame and the icon bubble.
  //
  // The healthy branch is the one V5 left repeating itself: the chip read "READY", the headline
  // read "Platform is ready" and the line under it said "every desired replica is READY", while
  // the topbar pill already said "Platform ready" - one verdict, four times. The chip carries
  // the word (the rule v5-acceptance pins: the chip states it, the headline explains it), so the
  // headline now states the grounds no other line on the page states.
  const healthHeadline = !data
    ? ''
    : unconfigured
      ? t('overview.setup.headline')
      : data.health === 'READY'
      ? t('overview.health.allClearDetail')
      : data.health === 'DEGRADED'
        ? t(criticalCount === 1 ? 'overview.health.criticalIssue' : 'overview.health.criticalIssues', { count: criticalCount })
        : t('overview.health.attention');
  // Which state the chip draws, and whether it must print a wire code: a code this build does
  // not map is the one case where the verbatim token is the honest label (status-indicator.ts).
  const bandState = unconfigured ? 'notConfigured' : indicatorStateForCode(data?.health);
  const bandCode = !unconfigured && bandState === 'unknown' ? data?.health ?? undefined : undefined;
  // The detail line is rendered only where it adds a fact: the setup instructions, or the first
  // open issue. Under a headline that already states the grounds it was that sentence twice.
  const healthDetail = !data
    ? null
    : unconfigured
      ? t('overview.health.notConfiguredDetail')
      : data.attention.length
        ? localizeAttentionDetail(data.attention[0].detail, t).text
        : null;
  const days = data ? groupEventsByDay(data.recentEvents) : [];

  return (
    <div className="page-stack">
      {/* One primary action. On an empty platform the next step is a node, not another
          package: installing a plugin with no node enrolled would sit PENDING forever. */}
      <PageHeader
        title={t('page.overview')}
        actions={<Button variant="secondary" onClick={() => { void overview.reload(); void diagnostics.reload(); }}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>}
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
            {/* Layer 1 - the verdict, then the counts. One observation stamp covers both:
                four modules each printing their own copy of it was four copies of one fact. */}
            <div className="status-summary">
              <section
                className={`health-band tone-${unconfigured ? 'neutral' : data.health === 'READY' ? 'ok' : data.health === 'DEGRADED' ? 'danger' : 'warn'}`}
                aria-label={t('overview.health.aria')}
                data-health={unconfigured ? 'NOT_CONFIGURED' : data.health}
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
                  {healthDetail ? <p>{healthDetail}</p> : null}
                </div>
                <div className="health-band-side" data-testid="overview-observed">
                  <span title={observedAt ?? undefined}>{observedAt ? t('ui.observedAt', { at: formatDate(observedAt) }) : t('ui.notObserved')}</span>
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
                  <EmptyState icon="activity" title={t('overview.events.empty.title')} description={t('overview.events.empty.description')} />
                ) : (
                  <ol className="event-list">
                    {days.map((day) => (
                      <React.Fragment key={day.key}>
                        <li className="event-day" aria-hidden="true">{dayLabel(t, day.key)}</li>
                        {day.rows.map((row) => {
                          const quiet = QUIET_RESULTS.has(row.result.toUpperCase());
                          const inner = (
                            <>
                              <span className="event-time"><TimeAgo value={row.at} /></span>
                              <span className="event-body">
                                <span className="event-title">
                                  <strong className={EVENT_LABELS[row.eventType] ? undefined : 'mono'}>{EVENT_LABELS[row.eventType] ? t(EVENT_LABELS[row.eventType]) : row.eventType}</strong>
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
                            <li key={row.key} data-event={row.eventType}>
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
