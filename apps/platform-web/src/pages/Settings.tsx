import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useExtensions } from '../extensions';
import { usePolling } from '../hooks';
import { Icon } from '../components/Icons';
import { buttonVariants } from '../components/ui/button';
import { CopyButton, ErrorState, KV, PageHeader, Skeleton } from '../components/Ui';
import { useT } from '../i18n';

export function SettingsPage() {
  const t = useT();
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
      <PageHeader eyebrow={t('settings.eyebrow')} title={t('page.settings')} description={t('settings.description')} actions={<Link className={buttonVariants({ variant: 'secondary' })} to="/admin/settings/diagnostics"><Icon name="terminal" size={15} /> {t('page.diagnostics')}</Link>} />
      <div className="summary-grid">
        <section className="panel">
          <div className="panel-head"><div><h2>{t('settings.general.title')}</h2><p>{t('settings.general.description')}</p></div></div>
          <div className="kv-grid">
            <KV label={t('settings.field.workspace')}>default</KV>
            <KV label={t('settings.field.kernelApi')}>v1</KV>
            <KV label={t('common.runtimeProtocol')} mono>http-json-v1</KV>
            <KV label={t('settings.field.signedPublisherPolicy')}>{t('settings.value.trustedAllowlist')}</KV>
            <KV label={t('settings.field.frontendModel')}>{t('settings.value.trustedSignedRemotes')}</KV>
            <KV label={t('settings.field.productionHa')}>{t('settings.value.notClaimed')}</KV>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head"><div><h2>{t('common.runtimePolicies')}</h2><p>{t('settings.policies.description')}</p></div><CopyButton value={data ? JSON.stringify(data, null, 2) : ''} label={t('settings.policies.copy')} /></div>
          {loading ? <Skeleton rows={3} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : !data || !Object.keys(data).length ? <p className="muted pad">{t('settings.policies.adminOnly')}</p> : <div className="kv-grid">{Object.entries(data).map(([key, value]) => <KV key={key} label={key}>{String(value)}</KV>)}</div>}
        </section>
      </div>
      <section className="panel">
        <div className="panel-head"><div><h2>{t('settings.extensions.title')}</h2><p>{t('settings.extensions.description')}</p></div></div>
        {settingsContributions.length === 0 ? <p className="muted pad">{t('settings.extensions.empty')}</p> : <ul className="contribution-list">{settingsContributions.map(({ extension, contribution }) => <li key={`${extension.pluginId}:${contribution.id}`}><span className="tag">{extension.pluginId}</span><code>{contribution.path}</code><Link className="text-link" to={contribution.path}>{t('settings.extensions.open')} <Icon name="arrowRight" size={14} /></Link></li>)}</ul>}
      </section>
      <section className="panel">
        <div className="panel-head"><div><h2>{t('settings.recovery.title')}</h2><p>{t('settings.recovery.description')}</p></div></div>
        <div className="quick-grid">
          <Link to="/admin/settings/diagnostics" className="quick-card"><Icon name="terminal" /><div><strong>{t('common.bootstrapDiagnostics')}</strong><span>{t('settings.recovery.diagnostics.description')}</span></div><Icon name="arrowRight" size={15} /></Link>
          <a href="/bootstrap" className="quick-card"><Icon name="file" /><div><strong>{t('settings.recovery.bootstrap.title')}</strong><span>{t('settings.recovery.bootstrap.description')}</span></div><Icon name="external" size={15} /></a>
          <Link to="/admin/activity" className="quick-card"><Icon name="activity" /><div><strong>{t('settings.recovery.audit.title')}</strong><span>{t('settings.recovery.audit.description')}</span></div><Icon name="arrowRight" size={15} /></Link>
        </div>
      </section>
    </div>
  );
}
