import React, { useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { Diagnostics } from '../types';
import { Icon } from '../components/Icons';
import { CopyButton, ErrorState, KV, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';
import { formatDuration } from '../format';
import { useT } from '../i18n';

export function DiagnosticsPage() {
  const t = useT();
  const { data, error, loading, reload } = usePolling(() => api.get<Diagnostics>('/api/v1/diagnostics'), 8000);
  const [raw, setRaw] = useState(false);
  if (loading && !data) return <><PageHeader title={t('page.diagnostics')} /><Skeleton rows={6} /></>;
  if (error) return <><PageHeader title={t('page.diagnostics')} /><ErrorState error={error} onRetry={() => void reload()} /></>;
  if (!data) return null;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={t('diagnostics.eyebrow')}
        title={t('page.diagnostics')}
        description={t('diagnostics.description')}
        actions={<><button className="btn btn-secondary" onClick={() => setRaw(!raw)}>{raw ? t('diagnostics.action.visualView') : t('diagnostics.action.rawJson')}</button><button className="btn btn-secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> {t('action.refresh')}</button></>}
      />
      <section className="health-strip">
        <div className="health-strip-item"><span className="health-strip-label">{t('diagnostics.kernel')}</span><strong>{data.kernel.version}</strong><span className="muted">API v{data.kernel.apiMajor}</span></div>
        <div className="health-strip-item"><span className="health-strip-label">{t('diagnostics.field.database')}</span><StatusBadge status={data.kernel.database === 'connected' ? 'READY' : 'FAILED'} label={data.kernel.database} /></div>
        <div className="health-strip-item"><span className="health-strip-label">{t('diagnostics.uptime')}</span><strong>{formatDuration(data.kernel.uptimeSeconds)}</strong></div>
        <div className="health-strip-item"><span className="health-strip-label">{t('diagnostics.packages')}</span><strong>{data.counts.packages}</strong></div>
        <div className="health-strip-item"><span className="health-strip-label">{t('common.readyInstances')}</span><strong>{data.counts.readyInstances}</strong></div>
        <div className="health-strip-item"><span className="health-strip-label">{t('common.deployments')}</span><strong>{data.counts.deployments}</strong></div>
      </section>
      {raw ? <section className="panel"><div className="panel-head"><div><h2>{t('diagnostics.raw.title')}</h2><p>{t('diagnostics.raw.description')}</p></div></div><pre className="json-view">{JSON.stringify(data, null, 2)}</pre></section> : (
        <>
          <div className="summary-grid">
            <section className="panel">
              <div className="panel-head"><div><h2>{t('diagnostics.facts.title')}</h2><p>{t('diagnostics.facts.description')}</p></div><CopyButton value={JSON.stringify(data)} label={t('diagnostics.copy')} /></div>
              <div className="kv-grid">
                <KV label={t('table.version')}>{data.kernel.version}</KV>
                <KV label={t('diagnostics.field.apiMajor')}>{data.kernel.apiMajor}</KV>
                <KV label={t('common.runtimeProtocol')} mono>{data.kernel.runtimeProtocol}</KV>
                <KV label={t('diagnostics.field.database')}>{data.kernel.database}</KV>
                <KV label={t('diagnostics.field.dataDir')} mono>{data.kernel.dataDir}</KV>
                <KV label={t('diagnostics.field.webDist')} mono>{data.kernel.webDist}</KV>
              </div>
            </section>
            <section className="panel">
              <div className="panel-head"><div><h2>{t('diagnostics.commands.title')}</h2><p>{t('diagnostics.commands.description')}</p></div></div>
              <div className="command-block"><pre>{`opsctl status
opsctl doctor
opsctl nodes
opsctl plugins
opsctl plugin disable <plugin-id>`}</pre><CopyButton value={`opsctl status\nopsctl doctor\nopsctl nodes\nopsctl plugins\nopsctl plugin disable <plugin-id>`} /></div>
              <div className="callout"><Icon name="terminal" size={16} /><p>{data.bootstrap.note}</p></div>
            </section>
          </div>
          <section className="panel"><div className="panel-head"><div><h2>{t('diagnostics.nodes.title')}</h2><p>{t('diagnostics.nodes.description')}</p></div></div>
            <table className="data-table"><thead><tr><th>{t('table.node')}</th><th>{t('table.status')}</th><th>{t('table.lastObserved')}</th></tr></thead><tbody>{data.nodes.map((node) => <tr key={node.id}><td data-label={t('table.node')}><strong>{node.name}</strong><div className="mono small">{node.id}</div></td><td data-label={t('table.status')}><StatusBadge status={node.status} /></td><td data-label={t('table.lastObserved')}><TimeAgo value={node.lastSeenAt} /></td></tr>)}</tbody></table>
          </section>
          <section className="panel"><div className="panel-head"><div><h2>{t('common.runtimePolicies')}</h2><p>{t('diagnostics.policies.description')}</p></div></div><div className="kv-grid">{Object.entries(data.policies).map(([key, value]) => <KV key={key} label={key}>{value}</KV>)}</div></section>
          <section className="panel"><div className="panel-head"><div><h2>{t('diagnostics.audit.title')}</h2><p>{t('diagnostics.audit.description')}</p></div></div><ul className="event-list">{data.recentEvents.map((event) => <li key={event.id}><div className="event-marker"><Icon name={event.result === 'REJECTED' ? 'warning' : 'check'} size={13} /></div><div className="event-copy"><div className="event-title"><strong>{event.eventType}</strong><StatusBadge status={event.result} /></div><p>{event.subjectType} <span className="mono">{event.subjectId}</span></p></div><TimeAgo value={event.occurredAt} /></li>)}</ul></section>
        </>
      )}
    </div>
  );
}
