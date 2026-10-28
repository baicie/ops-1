import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { PluginSummary } from '../types';
import { Icon } from '../components/Icons';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';
import { useT } from '../i18n';

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
        actions={<><button className="btn btn-secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> {t('action.refresh')}</button><Link className="btn btn-primary" to="/plugins/install"><Icon name="plus" size={15} /> {t('plugins.action.installPackage')}</Link></>}
      />
      <section className="toolbar">
        <div className="search-box"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('plugins.search.placeholder')} aria-label={t('plugins.search.aria')} /></div>
        <div className="segmented" role="group" aria-label={t('plugins.filter.aria')}>
          {['ALL', 'INSTALLED', 'STAGED', 'DISABLED'].map((value) => (
            <button key={value} className={state === value ? 'active' : ''} onClick={() => setState(value)}>{value === 'ALL' ? t('common.all') : value === 'INSTALLED' ? t('status.installed') : value === 'STAGED' ? t('status.staged') : t('status.disabled')}</button>
          ))}
        </div>
        <span className="toolbar-count">{t('plugins.count.summary', { filtered: filtered.length, total: plugins.length })}</span>
      </section>
      {loading && !data ? <Skeleton rows={5} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : filtered.length === 0 ? (
        <EmptyState icon="plugins" title={plugins.length ? t('plugins.empty.filtered.title') : t('plugins.empty.none.title')} description={plugins.length ? t('plugins.empty.filtered.description') : t('plugins.empty.none.description')} action={<Link className="btn btn-primary" to="/plugins/install">{t('plugins.action.installPackage')}</Link>} />
      ) : (
        <section className="panel table-panel">
          <table className="data-table plugins-table">
            <thead><tr><th>{t('table.plugin')}</th><th>{t('table.state')}</th><th>{t('table.active')}</th><th>{t('table.instances')}</th><th>{t('table.publisher')}</th><th>{t('table.updated')}</th><th aria-label={t('table.actions')} /></tr></thead>
            <tbody>
              {filtered.map((plugin) => (
                <tr key={plugin.id} className="clickable" onClick={() => navigate(plugin.isSystem ? '/ops-center' : `/plugins/${plugin.id}`)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') navigate(plugin.isSystem ? '/ops-center' : `/plugins/${plugin.id}`); }}>
                  <td data-label={t('table.plugin')}>
                    <div className="entity-cell">
                      <span className={`entity-icon ${plugin.isSystem ? 'system' : ''}`}><Icon name={plugin.isSystem ? 'ops' : 'box'} size={17} /></span>
                      <div><strong>{plugin.name}</strong><span className="mono">{plugin.id}</span></div>
                      {plugin.isSystem && <span className="tag">{t('common.tag.system')}</span>}
                    </div>
                  </td>
                  <td data-label={t('table.state')}><StatusBadge status={plugin.state} /></td>
                  <td data-label={t('table.active')}><span className="mono">{plugin.activeVersion || plugin.latestVersion || '—'}</span></td>
                  <td data-label={t('table.instances')}><span className={plugin.readyInstances < plugin.totalInstances ? 'text-warn' : ''}>{plugin.readyInstances}/{plugin.totalInstances}</span><span className="muted small"> READY</span></td>
                  <td data-label={t('table.publisher')}><span className="muted">{plugin.publisher || '—'}</span></td>
                  <td data-label={t('table.updated')}><TimeAgo value={plugin.updatedAt} /></td>
                  <td className="row-action"><Icon name="chevron" size={16} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <p className="table-footnote"><Icon name="alert" size={13} /> {t('plugins.footnote')}</p>
    </div>
  );
}
