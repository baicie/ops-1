import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useExtensions } from '../extensions';
import { usePolling } from '../hooks';
import { Icon } from '../components/Icons';
import { CopyButton, ErrorState, KV, PageHeader, Skeleton } from '../components/Ui';

export function SettingsPage() {
  const { user } = useAuth();
  const { extensions } = useExtensions();
  const { data, error, loading, reload } = usePolling<Record<string, number | string>>(
    () => (user?.role === 'admin' ? api.get<Record<string, number | string>>('/api/v1/settings/runtime-policies') : Promise.resolve({})),
    0,
  );
  const settingsContributions = extensions.flatMap((extension) =>
    extension.contributions.filter((contribution) => contribution.kind === 'settings.section.v1').map((contribution) => ({ extension, contribution })),
  );
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Workspace configuration" title="Settings" description="General environment facts, runtime policies and host-owned recovery entry points." actions={<Link className="btn btn-secondary" to="/settings/diagnostics"><Icon name="terminal" size={15} /> Bootstrap Diagnostics</Link>} />
      <div className="summary-grid">
        <section className="panel">
          <div className="panel-head"><div><h2>General</h2><p>This 0.0.1 environment is a single internal workspace.</p></div></div>
          <div className="kv-grid">
            <KV label="Workspace">default</KV>
            <KV label="Kernel API">v1</KV>
            <KV label="Runtime protocol" mono>http-json-v1</KV>
            <KV label="Signed publisher policy">trusted allowlist</KV>
            <KV label="Frontend extension model">trusted signed remotes</KV>
            <KV label="Production HA">Not claimed</KV>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>Runtime policies</h2><p>Read-only starting defaults; changing them belongs in a reviewed config change.</p></div><CopyButton value={data ? JSON.stringify(data, null, 2) : ''} label="Copy policies" /></div>
          {loading ? <Skeleton rows={3} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : !data || !Object.keys(data).length ? <p className="muted pad">Admin role is required to inspect runtime policies.</p> : <div className="kv-grid">{Object.entries(data).map(([key, value]) => <KV key={key} label={key}>{String(value)}</KV>)}</div>}
        </section>
      </div>
      <section className="panel">
        <div className="panel-head"><div><h2>Extension settings</h2><p>Settings sections contributed by active signed plugins. The Shell owns layout and permissions; the plugin supplies a scoped section.</p></div></div>
        {settingsContributions.length === 0 ? <p className="muted pad">No active plugin contributes a settings section.</p> : <ul className="contribution-list">{settingsContributions.map(({ extension, contribution }) => <li key={`${extension.pluginId}:${contribution.id}`}><span className="tag">{extension.pluginId}</span><code>{contribution.path}</code><Link className="text-link" to={contribution.path}>Open <Icon name="arrowRight" size={14} /></Link></li>)}</ul>}
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>Recovery and safety</h2><p>Recovery does not depend on any business plugin.</p></div></div>
        <div className="quick-grid">
          <Link to="/settings/diagnostics" className="quick-card"><Icon name="terminal" /><div><strong>Bootstrap diagnostics</strong><span>Kernel health, DB connectivity, node observations and audit.</span></div><Icon name="arrowRight" size={15} /></Link>
          <a href="/bootstrap" className="quick-card"><Icon name="file" /><div><strong>Server-rendered bootstrap page</strong><span>No React or plugin JavaScript required.</span></div><Icon name="external" size={15} /></a>
          <Link to="/activity" className="quick-card"><Icon name="activity" /><div><strong>Audit activity</strong><span>Every privileged action is recorded with its result.</span></div><Icon name="arrowRight" size={15} /></Link>
        </div>
      </section>
    </div>
  );
}
