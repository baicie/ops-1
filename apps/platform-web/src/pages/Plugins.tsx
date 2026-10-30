import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import type { PluginDetail, PluginSummary } from '../types';
import { Icon } from '../components/Icons';
import { Button, buttonVariants } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { EmptyState, TimeAgo, useToast } from '../components/Ui';
import { ConfirmAction } from '../components/app/confirm-action';
import { FilterScroller } from '../components/app/filter-scroller';
import { shortDigest } from '../format';
import { useT } from '../i18n';
import type { MessageKey } from '../i18n';
import { cn } from '../lib/utils';
import { verifiedWriteFailure, verifyAfterWrite } from '../lib/verify-after-write';
import { AsyncBoundary, NoticeBar, isStale, useObservedPolling } from '../components/app/async-boundary';
import { PageHeader } from '../components/app/page-header';
import { NoData, StatusIndicator, indicatorStateForCode } from '../components/app/status-indicator';
import { RowActions, StackCell, stackBody, stackHead, stackRow, stackTable, type RowAction } from './table-kit';

/** Per-plugin facts only the detail route exposes: digest, trust, activation and deployment health. */
interface PluginFacts {
  digest: string | null;
  trust: string | null;
  generation: number | null;
  deploymentStatus: string | null;
  deploymentAt: string | null;
  deploymentCount: number;
  /** A READY deployment that is not the active version: the only legal rollback target. */
  rollbackTarget: string | null;
  unavailable: boolean;
}

const EMPTY_FACTS: PluginFacts = { digest: null, trust: null, generation: null, deploymentStatus: null, deploymentAt: null, deploymentCount: 0, rollbackTarget: null, unavailable: true };

/** At most this many detail lookups per render pass; the operator sees the first page anyway. */
const FACT_LIMIT = 40;

/** The verb a row - or a batch of rows - is about to run. */
type Verb = 'disable' | 'enable' | 'rollback' | 'uninstall';

interface PendingVerb {
  verb: Verb;
  ids: string[];
  name: string;
  targetVersion?: string;
}

// The confirmation copy, the button label and the success sentence per verb, as literal tables.
// A key built from a template literal defeats scripts/check-i18n.mjs rule 4, so it is banned.
const VERB_LABEL: Record<Verb, MessageKey> = {
  disable: 'action.disable',
  enable: 'action.enable',
  rollback: 'action.rollback',
  uninstall: 'action.uninstall',
};
const VERB_CONFIRM_TITLE: Record<Verb, MessageKey> = {
  disable: 'plugins.confirm.disable.title',
  enable: 'plugins.confirm.enable.title',
  rollback: 'plugins.confirm.rollback.title',
  uninstall: 'plugins.confirm.uninstall.title',
};
const VERB_CONFIRM_BODY: Record<Verb, MessageKey> = {
  disable: 'plugins.confirm.disable.description',
  enable: 'plugins.confirm.enable.description',
  rollback: 'plugins.confirm.rollback.description',
  uninstall: 'plugins.confirm.uninstall.description',
};
const VERB_DONE: Record<Verb, MessageKey> = {
  disable: 'plugins.verb.done.disable',
  enable: 'plugins.verb.done.enable',
  rollback: 'plugins.verb.done.rollback',
  uninstall: 'plugins.verb.done.uninstall',
};

/**
 * The three counts the summary strip prints, written as predicates over the same rows the
 * table renders.
 *
 * This is the fix for a count with no rows behind it: "Needs attention 1" used to be a number
 * the operator then had to hunt for by reading every status cell. Clicking the count filters
 * the table to exactly the rows it counted - one selector for both the number and the filter,
 * so they cannot disagree.
 */
type QuickFilter = 'installed' | 'upgradeable' | 'abnormal';

function isAbnormal(plugin: PluginSummary): boolean {
  const signatureBad = Boolean(plugin.signatureState && plugin.signatureState !== 'VERIFIED');
  const replicasBehind = plugin.totalInstances > 0 && plugin.readyInstances < plugin.totalInstances;
  return signatureBad || replicasBehind || plugin.state === 'DEGRADED' || plugin.state === 'FAILED';
}

function matchesQuickFilter(plugin: PluginSummary, key: QuickFilter): boolean {
  if (plugin.isSystem) return false;
  if (key === 'installed') return plugin.state === 'INSTALLED';
  if (key === 'upgradeable') return Boolean(plugin.latestVersion && plugin.activeVersion && plugin.latestVersion !== plugin.activeVersion);
  return isAbnormal(plugin);
}

/**
 * §4.5 B. Summary first (with the counting rule printed next to it), then search + state filter,
 * then the table. A column the API does not answer renders NO_DATA - a replica count of 0 for a
 * plugin that was never deployed would be a lie dressed as a number.
 *
 * The table is a control surface, not a report. Every row carries the verbs the Kernel already
 * accepts (disable / enable / rollback / uninstall), the summary counts are the filters that
 * select the rows they counted, and a deployment state is a link into the entity it describes.
 * A verb the Kernel cannot serve is not drawn here.
 */
export function PluginsPage() {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const canOperate = user?.role === 'admin' || user?.role === 'operator';
  const isAdmin = user?.role === 'admin';
  const { data, error, loading, reload, observedAt } = useObservedPolling(() => api.get<PluginSummary[]>('/api/v1/plugins'), 8000);
  const [query, setQuery] = useState('');
  const [state, setState] = useState('ALL');
  const [quickFilter, setQuickFilter] = useState<QuickFilter | null>(null);
  const [facts, setFacts] = useState<Record<string, PluginFacts>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingVerb | null>(null);
  const [factsEpoch, setFactsEpoch] = useState(0);
  const requested = useRef(new Set<string>());
  const plugins = useMemo(() => data || [], [data]);

  // One detail read per plugin per package version. The list endpoint carries no digest or
  // deployment status, so the columns that need them ask the plugin route exactly once.
  useEffect(() => {
    let cancelled = false;
    const pendingReads = plugins
      .filter((plugin) => !requested.current.has(`${plugin.id}@${plugin.latestVersion ?? ''}`))
      .slice(0, FACT_LIMIT);
    for (const plugin of pendingReads) requested.current.add(`${plugin.id}@${plugin.latestVersion ?? ''}`);
    void Promise.all(pendingReads.map(async (plugin) => {
      let next: PluginFacts = EMPTY_FACTS;
      try {
        const detail = await api.get<PluginDetail>(`/api/v1/plugins/${encodeURIComponent(plugin.id)}`);
        const latest = detail.packageVersions?.[0];
        const deployment = detail.deployments?.[0];
        const activeVersion = detail.activeVersion ?? plugin.activeVersion;
        // A rollback target must be a READY deployment that is not the one running now.
        const rollbackTarget = (detail.deployments || []).find((item) => item.status === 'READY' && item.version !== activeVersion)?.version ?? null;
        next = {
          digest: latest?.bundleDigest ?? null,
          trust: latest?.signatureState ?? null,
          generation: detail.activeRevision?.generation ?? null,
          deploymentStatus: deployment?.status ?? null,
          deploymentAt: deployment?.updatedAt ?? null,
          deploymentCount: detail.deployments?.length ?? 0,
          rollbackTarget,
          unavailable: false,
        };
      } catch {
        // A plugin the detail route cannot answer keeps NO_DATA rather than a guessed value.
      }
      if (!cancelled) setFacts((previous) => ({ ...previous, [plugin.id]: next }));
    }));
    return () => { cancelled = true; };
  }, [plugins, factsEpoch]);

  const filtered = useMemo(() => plugins.filter((plugin) => {
    const matchesQuery = `{plugin.id} ${plugin.name} ${plugin.publisher || ''}`.toLowerCase().includes(query.toLowerCase());
    const matchesState = state === 'ALL' || plugin.state === state;
    const matchesQuick = quickFilter === null || matchesQuickFilter(plugin, quickFilter);
    return matchesQuery && matchesState && matchesQuick;
  }), [plugins, query, state, quickFilter]);

  const summary = useMemo(() => summarize(plugins), [plugins]);
  const selectable = canOperate ? filtered.filter((plugin) => !plugin.isSystem).map((plugin) => plugin.id) : [];
  const selectedPlugins = useMemo(() => plugins.filter((plugin) => selected.includes(plugin.id)), [plugins, selected]);
  /**
   * The batch bar applies the same guards as the row menu. Without them the bar offered a Stop for
   * a plugin with no active revision - a button whose only possible outcome was a Kernel rejection.
   */
  const selectionStoppable = selectedPlugins.length > 0 && selectedPlugins.every((plugin) => !plugin.isSystem && plugin.state !== 'DISABLED' && Boolean(plugin.activeVersion));
  const selectionStartable = selectedPlugins.length > 0 && selectedPlugins.every((plugin) => !plugin.isSystem && plugin.state === 'DISABLED');
  const allSelected = selectable.length > 0 && selectable.every((id) => selected.includes(id));

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      toast.push({ tone: 'ok', title: t('plugins.action.copyId'), detail: id });
    } catch {
      toast.push({ tone: 'danger', title: t('error.copyFailed'), detail: id });
    }
  }

  /** One request per plugin id: the Kernel has no bulk route, and none is invented here. */
  async function call(verb: Verb, id: string, targetVersion?: string): Promise<void> {
    const base = `/api/v1/plugins/${encodeURIComponent(id)}`;
    if (verb === 'disable') { await api.post(`${base}/disable`, { reason: t('plugins.verb.disableReason') }); return; }
    if (verb === 'enable') { await api.post(`${base}/enable`, {}); return; }
    if (verb === 'uninstall') { await api.post(`${base}/uninstall`, {}); return; }
    await api.post(`${base}/rollback`, {
      targetVersion,
      // The Kernel refuses a rollback without the revision it expects to roll back from.
      expectedRevision: facts[id]?.generation ?? 0,
      desiredReplicas: 2,
    });
  }

  /**
   * What each verb promises, read off the resource the verb changes - never off its response body.
   *
   * `enable` promises a restart request, not INSTALLED: the Kernel writes STAGED on that path and
   * no route in this build restores INSTALLED, so expecting INSTALLED here would report a working
   * request as a failure. The copy next to the button says the same thing in one sentence.
   */
  function expectation(verb: Verb, targetVersion?: string) {
    return (detail: PluginDetail): boolean => {
      if (verb === 'disable') return detail.state === 'DISABLED';
      if (verb === 'enable') return detail.state !== 'DISABLED';
      if (verb === 'rollback') return detail.activeVersion === targetVersion;
      return detail.state === 'UNINSTALLED';
    };
  }

  /** One verb, verified: the write, then a fresh GET that has to show the change. */
  function verified(verb: Verb, id: string, targetVersion?: string) {
    return verifyAfterWrite<PluginDetail>({
      write: () => call(verb, id, targetVersion),
      read: () => api.get<PluginDetail>(`/api/v1/plugins/${encodeURIComponent(id)}`),
      expected: expectation(verb, targetVersion),
      describe: (detail) => detail.state || 'NO_DATA',
      absentIsExpected: verb === 'uninstall',
    });
  }

  async function runPending(): Promise<void> {
    if (!pending) return;
    const { verb, ids, targetVersion } = pending;
    const failures: Array<{ id: string; error: Error }> = [];
    const states: string[] = [];
    // Sequential on purpose: the Kernel serialises activations per plugin, and a parallel burst
    // would make the first failure indistinguishable from the rest.
    for (const id of ids) {
      const result = await verified(verb, id, targetVersion);
      const failure = verifiedWriteFailure(result, t);
      if (failure) failures.push({ id, error: failure });
      else states.push(result.state);
    }
    for (const id of ids) {
      requested.current.delete(`${id}@${plugins.find((plugin) => plugin.id === id)?.latestVersion ?? ''}`);
      setFacts((previous) => { const next = { ...previous }; delete next[id]; return next; });
    }
    setFactsEpoch((value) => value + 1);
    setSelected([]);
    await reload();
    // A 200 that did not change the state is a failure. Nothing landed -> the dialog stays open
    // and prints the state that is really there; a partial batch names the ids that failed.
    if (failures.length === ids.length) throw failures[0].error;
    if (failures.length > 0) {
      toast.push({ tone: 'danger', title: t('plugins.verb.partial', { failed: failures.length, total: ids.length }), detail: failures.map((item) => item.id).join(', ') });
      return;
    }
    toast.push({ tone: 'ok', title: t(VERB_DONE[verb], { count: ids.length }), detail: t('verify.state', { state: states.join(', ') }) });
  }

  function openVerb(verb: Verb, plugin: PluginSummary, targetVersion?: string) {
    setPending({ verb, ids: [plugin.id], name: plugin.name, targetVersion });
  }

  /** The verbs one row may run, with the reason printed when one is refused. */
  function actionsFor(plugin: PluginSummary): RowAction[] {
    const open = () => navigate(plugin.isSystem ? '/admin/ops-center' : `/admin/plugins/${plugin.id}`);
    const fact = facts[plugin.id];
    const actions: RowAction[] = [
      { id: 'details', label: t('plugins.action.details'), icon: 'external', onSelect: open },
      { id: 'copy', label: t('plugins.action.copyId'), icon: 'copy', onSelect: () => void copyId(plugin.id) },
    ];
    if (!canOperate) return actions;
    const system = plugin.isSystem;
    const disabled = plugin.state === 'DISABLED';
    actions.push({
      id: 'disable',
      label: t('action.disable'),
      icon: 'stop',
      // Destructive and, in this build, not restorable from the UI: the row paints it as such.
      danger: true,
      divider: true,
      disabled: system || disabled || !plugin.activeVersion,
      disabledReason: system ? t('plugins.verb.system') : disabled ? t('plugins.verb.alreadyDisabled') : t('plugins.verb.notActivated'),
      onSelect: () => openVerb('disable', plugin),
    });
    actions.push({
      id: 'enable',
      label: t('action.enable'),
      icon: 'play',
      disabled: system || !disabled,
      disabledReason: system ? t('plugins.verb.system') : t('plugins.verb.notDisabled'),
      onSelect: () => openVerb('enable', plugin),
    });
    actions.push({
      id: 'rollback',
      label: t('action.rollback'),
      icon: 'rotate',
      disabled: system || !fact?.rollbackTarget,
      disabledReason: fact?.unavailable ? t('plugins.verb.noDetail') : t('plugins.verb.noRollbackTarget'),
      onSelect: () => openVerb('rollback', plugin, fact?.rollbackTarget ?? undefined),
    });
    actions.push({
      id: 'uninstall',
      label: t('action.uninstall'),
      icon: 'trash',
      danger: true,
      divider: true,
      // require_admin on the Kernel side; an operator sees the reason, not a 403.
      disabled: system || !isAdmin,
      disabledReason: system ? t('plugins.verb.system') : t('plugins.verb.adminOnly'),
      onSelect: () => openVerb('uninstall', plugin),
    });
    actions.push({
      id: 'install',
      label: t('plugins.action.installPackage'),
      icon: 'plus',
      divider: true,
      onSelect: () => navigate('/admin/plugins/install'),
    });
    return actions;
  }

  const pendingName = pending ? (pending.ids.length === 1 ? pending.name : t('plugins.batch.name', { count: pending.ids.length })) : '';

  return (
    <div className="page-stack">
      <PageHeader
        title={t('page.plugins')}
        actions={<Button variant="secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>}
        primary={<Link className={buttonVariants()} to="/admin/plugins/install"><Icon name="plus" size={15} /> {t('plugins.action.installPackage')}</Link>}
      />
      <AsyncBoundary loading={loading} error={error} hasData={Boolean(data)} onRetry={() => void reload()} skeletonRows={6}>
        {/* One strip, three counts, and each count is the filter that selects its own rows. The
            counting rule still travels with the number as the cell's title and accessible name. */}
        <section className="stat-block" aria-label={t('plugins.summary.aria')} data-testid="plugins-summary">
          <div className="ow-summary">
            <SummaryCard summaryKey="installed" label={t('plugins.summary.installed')} value={summary.installed} definition={t('plugins.summary.installed.definition')} active={quickFilter === 'installed'} onSelect={() => setQuickFilter((current) => current === 'installed' ? null : 'installed')} />
            <SummaryCard summaryKey="upgradeable" label={t('plugins.summary.upgradeable')} value={summary.upgradeable} definition={t('plugins.summary.upgradeable.definition')} tone={summary.upgradeable > 0 ? 'warn' : undefined} active={quickFilter === 'upgradeable'} onSelect={() => setQuickFilter((current) => current === 'upgradeable' ? null : 'upgradeable')} />
            <SummaryCard summaryKey="abnormal" label={t('plugins.summary.abnormal')} value={summary.abnormal} definition={t('plugins.summary.abnormal.definition')} tone={summary.abnormal > 0 ? 'danger' : undefined} active={quickFilter === 'abnormal'} onSelect={() => setQuickFilter((current) => current === 'abnormal' ? null : 'abnormal')} />
          </div>
          {summary.system > 0 ? (
            <p className="stat-note" data-testid="plugins-system-note">{t('plugins.summary.systemNote', { count: summary.system })}</p>
          ) : null}
        </section>
        {isStale(observedAt, 8000) ? <NoticeBar state="stale" title={t('ui.stale.title')} detail={t('ui.stale.detail', { at: observedAt ?? '' })} /> : null}
        <section className="toolbar">
          <div className="relative flex min-w-[220px] max-w-[460px] flex-1 items-center">
            <Icon name="search" size={16} className="absolute left-[10px] text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('plugins.search.placeholder')} aria-label={t('plugins.search.aria')} className="pl-[33px]" />
          </div>
          <FilterScroller activeKey={state} testId="plugins-filter">
            <Tabs value={state} onValueChange={(value) => { setState(value); setQuickFilter(null); }}>
              <TabsList aria-label={t('plugins.filter.aria')}>
                {['ALL', 'INSTALLED', 'STAGED', 'DISABLED', 'AVAILABLE'].map((value) => (
                  <TabsTrigger key={value} value={value}>{value === 'ALL' ? t('common.all') : value === 'INSTALLED' ? t('status.installed') : value === 'STAGED' ? t('status.staged') : value === 'DISABLED' ? t('status.disabled') : t('status.available')}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </FilterScroller>
          <span className="toolbar-count">{t('plugins.count.summary', { filtered: filtered.length, total: plugins.length })}</span>
        </section>
        {quickFilter ? (
          <div className="quick-filter-bar" data-testid="plugins-quick-filter" data-quick-filter={quickFilter} role="status">
            <Icon name="filter" size={14} />
            <span>{t('plugins.quickFilter.active', { label: quickFilter === 'installed' ? t('plugins.summary.installed') : quickFilter === 'upgradeable' ? t('plugins.summary.upgradeable') : t('plugins.summary.abnormal'), count: filtered.length })}</span>
            <button type="button" className="text-link" onClick={() => setQuickFilter(null)}>{t('plugins.quickFilter.clear')}</button>
          </div>
        ) : null}
        {canOperate && selected.length > 0 ? (
          <div className="batch-bar" data-testid="plugins-batch" role="region" aria-label={t('plugins.batch.aria')}>
            <span className="batch-count">{t('plugins.batch.selected', { count: selected.length })}</span>
            <Button
              variant="destructive"
              size="sm"
              disabled={!selectionStoppable}
              title={selectionStoppable ? undefined : t('plugins.verb.notActivated')}
              onClick={() => setPending({ verb: 'disable', ids: selected, name: '' })}
            ><Icon name="stop" size={14} /> {t('action.disable')}</Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!selectionStartable}
              title={selectionStartable ? undefined : t('plugins.verb.notDisabled')}
              onClick={() => setPending({ verb: 'enable', ids: selected, name: '' })}
            ><Icon name="play" size={14} /> {t('action.enable')}</Button>
            <button type="button" className="text-link" onClick={() => setSelected([])}>{t('plugins.batch.clear')}</button>
          </div>
        ) : null}
        {filtered.length === 0 ? (
          <EmptyState icon="plugins" title={plugins.length ? t('plugins.empty.filtered.title') : t('plugins.empty.none.title')} description={plugins.length ? t('plugins.empty.filtered.description') : t('plugins.empty.none.description')} action={quickFilter ? <Button variant="secondary" onClick={() => setQuickFilter(null)}>{t('plugins.quickFilter.clear')}</Button> : <Link className={buttonVariants()} to="/admin/plugins/install">{t('plugins.action.installPackage')}</Link>} />
        ) : (
          <section className="panel table-panel">
            <Table className={cn('plugins-table', stackTable)}>
              <TableHeader className={stackHead}>
                {/* Name and version are one block to read, so they lead. Deployment and runtime
                    readiness are two different states and are named as two columns instead of
                    being mixed into one "health" heading. */}
                <TableRow className="hover:bg-transparent">
                  {canOperate ? (
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        className="row-check"
                        data-testid="plugins-select-all"
                        aria-label={t('plugins.batch.selectAll')}
                        checked={allSelected}
                        onChange={(event) => setSelected(event.target.checked ? selectable : [])}
                      />
                    </TableHead>
                  ) : null}
                  <TableHead>{t('table.plugin')}</TableHead>
                  <TableHead>{t('table.version')}</TableHead>
                  <TableHead className="max-[1200px]:hidden">{t('table.publisher')}</TableHead>
                  <TableHead>{t('table.deployment')}</TableHead>
                  <TableHead>{t('table.readyReplicas')}</TableHead>
                  <TableHead>{t('table.digest')}</TableHead>
                  <TableHead className="max-[1200px]:hidden">{t('table.activation')}</TableHead>
                  <TableHead aria-label={t('table.actions')} />
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {filtered.map((plugin) => {
                  const fact = facts[plugin.id];
                  const upgrade = Boolean(plugin.latestVersion && plugin.activeVersion && plugin.latestVersion !== plugin.activeVersion);
                  const entity = plugin.isSystem ? '/admin/ops-center' : `/admin/plugins/${plugin.id}`;
                  const open = () => navigate(entity);
                  const checked = selected.includes(plugin.id);
                  return (
                    <TableRow key={plugin.id} className={cn('cursor-pointer focus-visible:outline-offset-[-2px]', stackRow)} data-plugin={plugin.id} data-abnormal={isAbnormal(plugin) ? 'true' : undefined} onClick={open} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') open(); }}>
                      {canOperate ? (
                        <TableCell className="w-8 max-[768px]:w-full max-[768px]:border-0 max-[768px]:px-3.5 max-[768px]:pt-0 max-[768px]:text-left">
                          <input
                            type="checkbox"
                            className="row-check"
                            data-testid="plugins-select-`{plugin.id}"
                            aria-label={t('plugins.batch.select', { name: plugin.name })}
                            checked={checked}
                            disabled={plugin.isSystem}
                            onClick={(event) => event.stopPropagation()}
                            onChange={(event) => {
                              event.stopPropagation();
                              setSelected((current) => event.target.checked ? [...current, plugin.id] : current.filter((id) => id !== plugin.id));
                            }}
                          />
                        </TableCell>
                      ) : null}
                      <StackCell label={t('table.plugin')}>
                        <div className="entity-cell">
                          <span className={cn('entity-icon', plugin.isSystem && 'system')}><Icon name={plugin.isSystem ? 'ops' : 'box'} size={17} /></span>
                          <div><strong>{plugin.name}</strong><span className="mono">{plugin.id}</span></div>
                          {plugin.isSystem && <span className="tag">{t('common.tag.system')}</span>}
                        </div>
                      </StackCell>
                      <StackCell label={t('table.version')}>
                        <div className="ow-cell">
                          <span className="mono ow-cell-value">{plugin.activeVersion || plugin.latestVersion || null}{!(plugin.activeVersion || plugin.latestVersion) && <NoData detail={t('ui.noData.detail')} />}</span>
                          {upgrade ? <span className="ow-cell-meta">{t('plugins.upgrade.available', { version: plugin.latestVersion ?? '' })}</span> : null}
                        </div>
                      </StackCell>
                      <StackCell label={t('table.publisher')} className="max-[1200px]:hidden">
                        <div className="ow-cell">
                          <span className="ow-cell-value">{plugin.publisher ? <span className="text-muted-foreground">{plugin.publisher}</span> : <NoData detail={t('ui.noData.detail')} />}</span>
                        </div>
                      </StackCell>
                      <StackCell label={t('table.deployment')}>
                        <div className="ow-cell">
                          {fact?.deploymentStatus ? (
                            <>
                              {/* A deployment state is an entity, not a word: it opens the plugin
                                  whose deployment it describes. */}
                              <Link
                                className="status-entity"
                                to={entity}
                                data-status-entity={plugin.id}
                                title={t('plugins.status.openEntity', { name: plugin.name })}
                                onClick={(event) => event.stopPropagation()}
                              >
                                <StatusIndicator state={indicatorStateForCode(fact.deploymentStatus)} label={indicatorStateForCode(fact.deploymentStatus) === 'unknown' ? fact.deploymentStatus : undefined} />
                              </Link>
                              {fact.deploymentAt ? <TimeAgo value={fact.deploymentAt} /> : null}
                            </>
                          ) : <NoData detail={t('plugins.health.none')} />}
                        </div>
                      </StackCell>
                      <StackCell label={t('table.readyReplicas')}>
                        <div className="ow-cell">
                          <span className="ow-cell-value">{!fact || fact.deploymentCount === 0 ? <NoData detail={t('plugins.replicas.none')} /> : (
                            <span className={plugin.readyInstances < plugin.totalInstances ? 'text-warning' : undefined}>{plugin.readyInstances}/{plugin.totalInstances}</span>
                          )}</span>
                        </div>
                      </StackCell>
                      <StackCell label={t('table.digest')}>
                        <div className="ow-cell">
                          {fact?.digest ? <span className="mono ow-cell-value" title={fact.digest}>{shortDigest(fact.digest)}</span> : <NoData detail={t('plugins.table.digestHint')} />}
                          {fact?.trust ? (
                            <Link className="status-entity" to={entity} data-status-entity={plugin.id} title={t('plugins.status.openEntity', { name: plugin.name })} onClick={(event) => event.stopPropagation()}>
                              <StatusIndicator state={indicatorStateForCode(fact.trust)} label={t('status.verified')} />
                            </Link>
                          ) : null}
                        </div>
                      </StackCell>
                      <StackCell label={t('table.activation')} className="max-[1200px]:hidden">
                        <div className="ow-cell">
                          {fact?.generation !== null && fact?.generation !== undefined ? (
                            <span className="mono ow-cell-value">{t('plugins.table.generation', { generation: fact.generation })}</span>
                          ) : (
                            <Link className="status-entity" to={entity} data-status-entity={plugin.id} title={t('plugins.status.openEntity', { name: plugin.name })} onClick={(event) => event.stopPropagation()}>
                              <StatusIndicator state="notConfigured" label={t('plugins.table.notActivated')} />
                            </Link>
                          )}
                        </div>
                      </StackCell>
                      <TableCell className="w-8 text-right text-muted-foreground max-[768px]:w-full max-[768px]:border-0 max-[768px]:px-3.5 max-[768px]:pt-0">
                        <RowActions label={t('plugins.action.menu', { name: plugin.name })} actions={actionsFor(plugin)} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </section>
        )}
      </AsyncBoundary>

      {/* Every verb on this page is irreversible or privilege-changing, so every one of them
          goes through the one confirmation surface that keeps a rejection where it was asked. */}
      <ConfirmAction
        open={pending !== null}
        title={pending ? t(VERB_CONFIRM_TITLE[pending.verb], { name: pendingName }) : ''}
        description={pending ? t(VERB_CONFIRM_BODY[pending.verb], { name: pendingName, version: pending.targetVersion ?? '' }) : ''}
        confirmLabel={pending ? t(VERB_LABEL[pending.verb]) : t('action.confirm')}
        danger={pending?.verb !== 'enable'}
        onConfirm={runPending}
        onClose={() => setPending(null)}
      />
    </div>
  );
}

/**
 * One summary count. It is a button, not a card, because it selects the rows it counted.
 *
 * The counting rule still travels with the number (title + accessible name), and the active
 * state is stated twice: aria-pressed for assistive tech, .is-active for the paint.
 */
function SummaryCard({ summaryKey, label, value, definition, tone, active, onSelect }: { summaryKey: string; label: string; value: number; definition: string; tone?: 'warn' | 'danger'; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      className={cn('ow-summary-card', tone === 'warn' && 'is-warn', tone === 'danger' && 'is-danger', active && 'is-active')}
      data-summary={label}
      data-summary-key={summaryKey}
      title={definition}
      aria-pressed={active}
      aria-label={label + ': ' + value + '. ' + definition}
      onClick={onSelect}
    >
      <span className="ow-summary-label">{label}</span>
      <span className="ow-summary-value" data-summary-value={summaryKey}>{value}</span>
      <span className="ow-summary-definition" aria-hidden="true">{definition}</span>
    </button>
  );
}

/**
 * The counting rule, in code, mirroring what the summary cards print:
 * installed  = installation state is INSTALLED;
 * upgradeable = the newest uploaded package version is not the active version;
 * abnormal   = READY replicas below desired, or the installation is DEGRADED/FAILED, or the
 *              newest package signature is not VERIFIED.
 */
function summarize(plugins: PluginSummary[]) {
  let installed = 0;
  let upgradeable = 0;
  let abnormal = 0;
  let system = 0;
  for (const plugin of plugins) {
    // One selector for both pages: the Overview counts kernel.plugin_installations rows, and a
    // built-in (system) plugin has none. Counting it here is what printed 4 beside a 3.
    if (plugin.isSystem) { system += 1; continue; }
    if (matchesQuickFilter(plugin, 'installed')) installed += 1;
    if (matchesQuickFilter(plugin, 'upgradeable')) upgradeable += 1;
    if (matchesQuickFilter(plugin, 'abnormal')) abnormal += 1;
  }
  return { installed, upgradeable, abnormal, system };
}
