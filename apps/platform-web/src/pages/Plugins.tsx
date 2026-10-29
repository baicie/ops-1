import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { PluginSummary } from '../types';
import { Icon } from '../components/Icons';
import { Button, buttonVariants } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { EmptyState, ErrorState, PageHeader, Skeleton, TimeAgo } from '../components/Ui';
import { useT } from '../i18n';
import { cn } from '../lib/utils';
import { StackCell, StatusPill, stackBody, stackHead, stackRow, stackTable } from './table-kit';

export function PluginsPage() {
  const t = useT();
  const navigate = useNavigate();
  const { data, error, loading, reload } = usePolling(() => api.get<PluginSummary[]>('/api/v1/plugins'), 8000);
  const [query, setQuery] = useState('');
  const [state, setState] = useState('ALL');
  const plugins = data || [];
  const filtered = useMemo(() => plugins.filter((plugin) => {
    const matchesQuery = `${plugin.id} ${plugin.name} ${plugin.publisher || ''}`.toLowerCase().includes(query.toLowerCase());
    const matchesState = state === 'ALL' || plugin.state === state;
    return matchesQuery && matchesState;
  }), [plugins, query, state]);

  return (
    <div className="page-stack">
      <PageHeader
        title={t('page.plugins')}
        description={t('plugins.description')}
        actions={<><Button variant="secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button><Link className={buttonVariants()} to="/plugins/install"><Icon name="plus" size={15} /> {t('plugins.action.installPackage')}</Link></>}
      />
      <section className="toolbar">
        <div className="relative flex min-w-[260px] max-w-[460px] flex-1 items-center">
          <Icon name="search" size={16} className="absolute left-[10px] text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('plugins.search.placeholder')} aria-label={t('plugins.search.aria')} className="pl-[33px]" />
        </div>
        <Tabs value={state} onValueChange={setState}>
          <TabsList aria-label={t('plugins.filter.aria')}>
            {['ALL', 'INSTALLED', 'STAGED', 'DISABLED'].map((value) => (
              <TabsTrigger key={value} value={value}>{value === 'ALL' ? t('common.all') : value === 'INSTALLED' ? t('status.installed') : value === 'STAGED' ? t('status.staged') : t('status.disabled')}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <span className="toolbar-count">{t('plugins.count.summary', { filtered: filtered.length, total: plugins.length })}</span>
      </section>
      {loading && !data ? <Skeleton rows={5} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : filtered.length === 0 ? (
        <EmptyState icon="plugins" title={plugins.length ? t('plugins.empty.filtered.title') : t('plugins.empty.none.title')} description={plugins.length ? t('plugins.empty.filtered.description') : t('plugins.empty.none.description')} action={<Link className={buttonVariants()} to="/plugins/install">{t('plugins.action.installPackage')}</Link>} />
      ) : (
        <section className="panel table-panel">
          <Table className={cn('plugins-table', stackTable)}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('table.plugin')}</TableHead>
                <TableHead>{t('table.state')}</TableHead>
                <TableHead>{t('table.active')}</TableHead>
                <TableHead>{t('table.instances')}</TableHead>
                <TableHead>{t('table.publisher')}</TableHead>
                <TableHead>{t('table.updated')}</TableHead>
                <TableHead aria-label={t('table.actions')} />
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {filtered.map((plugin) => (
                <TableRow key={plugin.id} className={cn('cursor-pointer focus-visible:outline-offset-[-2px]', stackRow)} onClick={() => navigate(plugin.isSystem ? '/ops-center' : `/plugins/${plugin.id}`)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') navigate(plugin.isSystem ? '/ops-center' : `/plugins/${plugin.id}`); }}>
                  <StackCell label={t('table.plugin')}>
                    <div className="entity-cell">
                      <span className={`entity-icon ${plugin.isSystem ? 'system' : ''}`}><Icon name={plugin.isSystem ? 'ops' : 'box'} size={17} /></span>
                      <div><strong>{plugin.name}</strong><span className="mono">{plugin.id}</span></div>
                      {plugin.isSystem && <span className="tag">{t('common.tag.system')}</span>}
                    </div>
                  </StackCell>
                  <StackCell label={t('table.state')}><StatusPill status={plugin.state} /></StackCell>
                  <StackCell label={t('table.active')}><span className="mono">{plugin.activeVersion || plugin.latestVersion || '—'}</span></StackCell>
                  <StackCell label={t('table.instances')}><span className={plugin.readyInstances < plugin.totalInstances ? 'text-warning' : ''}>{plugin.readyInstances}/{plugin.totalInstances}</span><span className="text-sm text-muted-foreground"> READY</span></StackCell>
                  <StackCell label={t('table.publisher')}><span className="text-muted-foreground">{plugin.publisher || '—'}</span></StackCell>
                  <StackCell label={t('table.updated')}><TimeAgo value={plugin.updatedAt} /></StackCell>
                  <TableCell className="w-8 text-right text-muted-foreground max-[760px]:hidden"><Icon name="chevron" size={16} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      <p className="table-footnote"><Icon name="alert" size={13} /> {t('plugins.footnote')}</p>
    </div>
  );
}
