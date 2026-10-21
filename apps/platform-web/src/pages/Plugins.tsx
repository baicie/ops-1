import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { PluginSummary } from '../types';
import { Icon } from '../components/Icons';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';

export function PluginsPage() {
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
        title="Plugins"
        description="Installed trusted packages and their effective versions. A package is not an instance."
        actions={<><button className="btn btn-secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> Refresh</button><Link className="btn btn-primary" to="/plugins/install"><Icon name="plus" size={15} /> Install package</Link></>}
      />
      <section className="toolbar">
        <div className="search-box"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by plugin, publisher or id" aria-label="Search plugins" /></div>
        <div className="segmented" role="group" aria-label="Filter by installation state">
          {['ALL', 'INSTALLED', 'STAGED', 'DISABLED'].map((value) => (
            <button key={value} className={state === value ? 'active' : ''} onClick={() => setState(value)}>{value === 'ALL' ? 'All' : value[0] + value.slice(1).toLowerCase()}</button>
          ))}
        </div>
        <span className="toolbar-count">{filtered.length} of {plugins.length}</span>
      </section>
      {loading && !data ? <Skeleton rows={5} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : filtered.length === 0 ? (
        <EmptyState icon="plugins" title={plugins.length ? 'No plugins match this filter' : 'No plugins installed'} description={plugins.length ? 'Clear the search or choose another state.' : 'Upload a signed package to stage the first plugin.'} action={<Link className="btn btn-primary" to="/plugins/install">Install package</Link>} />
      ) : (
        <section className="panel table-panel">
          <table className="data-table plugins-table">
            <thead><tr><th>Plugin</th><th>State</th><th>Active</th><th>Instances</th><th>Publisher</th><th>Updated</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {filtered.map((plugin) => (
                <tr key={plugin.id} className="clickable" onClick={() => navigate(plugin.isSystem ? '/ops-center' : `/plugins/${plugin.id}`)} tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter') navigate(plugin.isSystem ? '/ops-center' : `/plugins/${plugin.id}`); }}>
                  <td data-label="Plugin">
                    <div className="entity-cell">
                      <span className={`entity-icon ${plugin.isSystem ? 'system' : ''}`}><Icon name={plugin.isSystem ? 'ops' : 'box'} size={17} /></span>
                      <div><strong>{plugin.name}</strong><span className="mono">{plugin.id}</span></div>
                      {plugin.isSystem && <span className="tag">SYSTEM</span>}
                    </div>
                  </td>
                  <td data-label="State"><StatusBadge status={plugin.state} /></td>
                  <td data-label="Active"><span className="mono">{plugin.activeVersion || plugin.latestVersion || '—'}</span></td>
                  <td data-label="Instances"><span className={plugin.readyInstances < plugin.totalInstances ? 'text-warn' : ''}>{plugin.readyInstances}/{plugin.totalInstances}</span><span className="muted small"> READY</span></td>
                  <td data-label="Publisher"><span className="muted">{plugin.publisher || '—'}</span></td>
                  <td data-label="Updated"><TimeAgo value={plugin.updatedAt} /></td>
                  <td className="row-action"><Icon name="chevron" size={16} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <p className="table-footnote"><Icon name="alert" size={13} /> Signature-verified packages are shown with their effective revision. Unknown or stale states are never collapsed into “installed”.</p>
    </div>
  );
}
