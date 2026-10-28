import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { PluginDetail, PluginSummary } from '../types';
import { Icon } from '../components/Icons';
import { Button, buttonVariants } from '../components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { EmptyState, TimeAgo, useToast } from '../components/Ui';
import { shortDigest } from '../format';
import { useT } from '../i18n';
import { cn } from '../lib/utils';
import { AsyncBoundary, NoticeBar, isStale, useObservedPolling } from '../components/app/async-boundary';
import { PageHeader } from '../components/app/page-header';
import { NoData, StatusIndicator, indicatorStateForCode } from '../components/app/status-indicator';
import { StackCell, stackBody, stackHead, stackRow, stackTable } from './table-kit';

/** Per-plugin facts only the detail route exposes: digest, trust, activation and deployment health. */
interface PluginFacts {
  digest: string | null;
  trust: string | null;
  generation: number | null;
  deploymentStatus: string | null;
  deploymentAt: string | null;
  deploymentCount: number;
  unavailable: boolean;
}

const EMPTY_FACTS: PluginFacts = { digest: null, trust: null, generation: null, deploymentStatus: null, deploymentAt: null, deploymentCount: 0, unavailable: true };

/** At most this many detail lookups per render pass; the operator sees the first page anyway. */
const FACT_LIMIT = 40;

/**
 * §4.5 B. Summary first (with the counting rule printed next to it), then search + state filter,
 * then the table. A column the API does not answer renders NO_DATA — a replica count of 0 for a
 * plugin that was never deployed would be a lie dressed as a number.
 */
export function PluginsPage() {
  const t = useT();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload, observedAt } = useObservedPolling(() => api.get<PluginSummary[]>('/api/v1/plugins'), 8000);
  const [query, setQuery] = useState('');
  const [state, setState] = useState('ALL');
  const [facts, setFacts] = useState<Record<string, PluginFacts>>({});
  const requested = useRef(new Set<string>());
  const plugins = useMemo(() => data || [], [data]);

  // One detail read per plugin per package version. The list endpoint carries no digest or
  // deployment status, so the columns that need them ask the plugin route exactly once.
  useEffect(() => {
    let cancelled = false;
    const pending = plugins
      .filter((plugin) => !requested.current.has(`${plugin.id}@${plugin.latestVersion ?? ''}`))
      .slice(0, FACT_LIMIT);
    for (const plugin of pending) requested.current.add(`${plugin.id}@${plugin.latestVersion ?? ''}`);
    void Promise.all(pending.map(async (plugin) => {
      let next: PluginFacts = EMPTY_FACTS;
      try {
        const detail = await api.get<PluginDetail>(`/api/v1/plugins/${encodeURIComponent(plugin.id)}`);
        const latest = detail.packageVersions?.[0];
        const deployment = detail.deployments?.[0];
        next = {
          digest: latest?.bundleDigest ?? null,
          trust: latest?.signatureState ?? null,
          generation: detail.activeRevision?.generation ?? null,
          deploymentStatus: deployment?.status ?? null,
          deploymentAt: deployment?.updatedAt ?? null,
          deploymentCount: detail.deployments?.length ?? 0,
          unavailable: false,
        };
      } catch {
        // A plugin the detail route cannot answer keeps NO_DATA rather than a guessed value.
      }
      if (!cancelled) setFacts((previous) => ({ ...previous, [plugin.id]: next }));
    }));
    return () => { cancelled = true; };
  }, [plugins]);

  const filtered = useMemo(() => plugins.filter((plugin) => {
    const matchesQuery = `${plugin.id} ${plugin.name} ${plugin.publisher || ''}`.toLowerCase().includes(query.toLowerCase());
    const matchesState = state === 'ALL' || plugin.state === state;
    return matchesQuery && matchesState;
  }), [plugins, query, state]);

  const summary = useMemo(() => summarize(plugins), [plugins]);

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      toast.push({ tone: 'ok', title: t('plugins.action.copyId'), detail: id });
    } catch {
      toast.push({ tone: 'danger', title: t('error.copyFailed'), detail: id });
    }
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={t('page.plugins')}
        description={t('plugins.description')}
        actions={<Button variant="secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>}
        primary={<Link className={buttonVariants()} to="/plugins/install"><Icon name="plus" size={15} /> {t('plugins.action.installPackage')}</Link>}
      />
      <AsyncBoundary loading={loading} error={error} hasData={Boolean(data)} onRetry={() => void reload()} skeletonRows={6}>
        <section className="ow-summary" aria-label={t('plugins.summary.aria')} data-testid="plugins-summary">
          <SummaryCard label={t('plugins.summary.installed')} value={summary.installed} definition={t('plugins.summary.installed.definition')} />
          <SummaryCard label={t('plugins.summary.upgradeable')} value={summary.upgradeable} definition={t('plugins.summary.upgradeable.definition')} tone={summary.upgradeable > 0 ? 'warn' : undefined} />
          <SummaryCard label={t('plugins.summary.abnormal')} value={summary.abnormal} definition={t('plugins.summary.abnormal.definition')} tone={summary.abnormal > 0 ? 'danger' : undefined} />
        </section>
        {isStale(observedAt, 8000) ? <NoticeBar state="stale" title={t('ui.stale.title')} detail={t('ui.stale.detail', { at: observedAt ?? '' })} /> : null}
        <section className="toolbar">
          <div className="relative flex min-w-[220px] max-w-[460px] flex-1 items-center">
            <Icon name="search" size={16} className="absolute left-[10px] text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('plugins.search.placeholder')} aria-label={t('plugins.search.aria')} className="pl-[33px]" />
          </div>
          <div className="ow-filter-scroll">
            <Tabs value={state} onValueChange={setState}>
              <TabsList aria-label={t('plugins.filter.aria')}>
                {['ALL', 'INSTALLED', 'STAGED', 'DISABLED', 'AVAILABLE'].map((value) => (
                  <TabsTrigger key={value} value={value}>{value === 'ALL' ? t('common.all') : value === 'INSTALLED' ? t('status.installed') : value === 'STAGED' ? t('status.staged') : value === 'DISABLED' ? t('status.disabled') : t('status.available')}</TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          <span className="toolbar-count">{t('plugins.count.summary', { filtered: filtered.length, total: plugins.length })}</span>
        </section>
        {filtered.length === 0 ? (
          <EmptyState icon="plugins" title={plugins.length ? t('plugins.empty.filtered.title') : t('plugins.empty.none.title')} description={plugins.length ? t('plugins.empty.filtered.description') : t('plugins.empty.none.description')} action={<Link className={buttonVariants()} to="/plugins/install">{t('plugins.action.installPackage')}</Link>} />
        ) : (
          <section className="panel table-panel">
            <Table className={cn('plugins-table', stackTable)}>
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('table.plugin')}</TableHead>
                  <TableHead>{t('table.publisher')}</TableHead>
                  <TableHead>{t('table.version')}</TableHead>
                  <TableHead>{t('table.digest')}</TableHead>
                  <TableHead>{t('table.activation')}</TableHead>
                  <TableHead>{t('table.readyReplicas')}</TableHead>
                  <TableHead>{t('table.recentHealth')}</TableHead>
                  <TableHead aria-label={t('table.actions')} />
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {filtered.map((plugin) => {
                  const fact = facts[plugin.id];
                  const upgrade = Boolean(plugin.latestVersion && plugin.activeVersion && plugin.latestVersion !== plugin.activeVersion);
                  const open = () => navigate(plugin.isSystem ? '/ops-center' : `/plugins/${plugin.id}`);
                  return (
                    <TableRow key={plugin.id} className={cn('cursor-pointer focus-visible:outline-offset-[-2px]', stackRow)} data-plugin={plugin.id} onClick={open} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') open(); }}>
                      <StackCell label={t('table.plugin')}>
                        <div className="entity-cell">
                          <span className={`entity-icon ${plugin.isSystem ? 'system' : ''}`}><Icon name={plugin.isSystem ? 'ops' : 'box'} size={17} /></span>
                          <div><strong>{plugin.name}</strong><span className="mono">{plugin.id}</span></div>
                          {plugin.isSystem && <span className="tag">{t('common.tag.system')}</span>}
                        </div>
                      </StackCell>
                      <StackCell label={t('table.publisher')}>{plugin.publisher ? <span className="text-muted-foreground">{plugin.publisher}</span> : <NoData detail={t('ui.noData.detail')} />}</StackCell>
                      <StackCell label={t('table.version')}>
                        <div className="ow-cell-stack">
                          <span className="mono">{plugin.activeVersion || plugin.latestVersion || null}{!(plugin.activeVersion || plugin.latestVersion) && <NoData detail={t('ui.noData.detail')} />}</span>
                          {upgrade ? <span className="ow-cell-note">{t('plugins.upgrade.available', { version: plugin.latestVersion ?? '' })}</span> : null}
                        </div>
                      </StackCell>
                      <StackCell label={t('table.digest')}>
                        <div className="ow-cell-stack">
                          {fact?.digest ? <span className="mono text-sm" title={fact.digest}>{shortDigest(fact.digest)}</span> : <NoData detail={t('plugins.table.digestHint')} />}
                          {fact?.trust ? <StatusIndicator state={indicatorStateForCode(fact.trust)} label={t('status.verified')} /> : null}
                        </div>
                      </StackCell>
                      <StackCell label={t('table.activation')}>
                        {fact?.generation !== null && fact?.generation !== undefined ? (
                          <span className="mono">{t('plugins.table.generation', { generation: fact.generation })}</span>
                        ) : (
                          <StatusIndicator state="notConfigured" label={t('plugins.table.notActivated')} />
                        )}
                      </StackCell>
                      <StackCell label={t('table.readyReplicas')}>
                        {!fact ? <NoData detail={t('plugins.replicas.none')} /> : fact.deploymentCount === 0 ? <NoData detail={t('plugins.replicas.none')} /> : (
                          <span className={plugin.readyInstances < plugin.totalInstances ? 'text-warning' : ''}>{plugin.readyInstances}/{plugin.totalInstances}</span>
                        )}
                      </StackCell>
                      <StackCell label={t('table.recentHealth')}>
                        {fact?.deploymentStatus ? (
                          <div className="ow-cell-stack">
                            <StatusIndicator state={indicatorStateForCode(fact.deploymentStatus)} label={indicatorStateForCode(fact.deploymentStatus) === 'unknown' ? fact.deploymentStatus : undefined} />
                            {fact.deploymentAt ? <TimeAgo value={fact.deploymentAt} /> : null}
                          </div>
                        ) : <NoData detail={t('plugins.health.none')} />}
                      </StackCell>
                      <TableCell className="w-8 text-right text-muted-foreground max-[760px]:hidden">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button type="button" className="icon-btn" aria-label={t('plugins.action.menu', { name: plugin.name })} onClick={(event) => event.stopPropagation()}>
                              <Icon name="down" size={16} />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={open}><Icon name="external" size={14} /> {t('plugins.action.details')}</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void copyId(plugin.id)}><Icon name="copy" size={14} /> {t('plugins.action.copyId')}</DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => navigate('/plugins/install')}><Icon name="plus" size={14} /> {t('plugins.action.installPackage')}</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </section>
        )}
      </AsyncBoundary>
      <p className="table-footnote"><Icon name="alert" size={13} /> {t('plugins.footnote')}</p>
    </div>
  );
}

function SummaryCard({ label, value, definition, tone }: { label: string; value: number; definition: string; tone?: 'warn' | 'danger' }) {
  return (
    <div className={cn('ow-summary-card', tone === 'warn' && 'is-warn', tone === 'danger' && 'is-danger')} data-summary={label}>
      <span className="ow-summary-label">{label}</span>
      <span className="ow-summary-value">{value}</span>
      <span className="ow-summary-definition">{definition}</span>
    </div>
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
  for (const plugin of plugins) {
    if (plugin.state === 'INSTALLED') installed += 1;
    if (plugin.latestVersion && plugin.activeVersion && plugin.latestVersion !== plugin.activeVersion) upgradeable += 1;
    const signatureBad = Boolean(plugin.signatureState && plugin.signatureState !== 'VERIFIED');
    const replicasBehind = plugin.totalInstances > 0 && plugin.readyInstances < plugin.totalInstances;
    if (signatureBad || replicasBehind || plugin.state === 'DEGRADED' || plugin.state === 'FAILED') abnormal += 1;
  }
  return { installed, upgradeable, abnormal };
}
