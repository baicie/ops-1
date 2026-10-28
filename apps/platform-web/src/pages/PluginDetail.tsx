import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { usePolling } from '../hooks';
import type { AuditEvent, DeploymentView, PluginDetail } from '../types';
import { Icon } from '../components/Icons';
import { ConfirmDialog, CopyButton, EmptyState, ErrorState, Field, KV, Modal, PageHeader, Progress, Skeleton, StatusBadge, TimeAgo, useToast } from '../components/Ui';
import { formatDate, formatBytes, shortDigest } from '../format';
import { useT } from '../i18n';

type Tab = 'overview' | 'versions' | 'deployments' | 'capabilities' | 'permissions' | 'events';

export function PluginDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = usePolling(() => api.get<PluginDetail>(`/api/v1/plugins/${encodeURIComponent(id)}`), 4000);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [deployOpen, setDeployOpen] = useState(false);
  const [deployVersion, setDeployVersion] = useState('');
  const [replicas, setReplicas] = useState(2);
  const [selector, setSelector] = useState('role=node');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'activate' | 'disable' | 'uninstall' | 'rollback' | 'enable'>(null);
  const [rollbackVersion, setRollbackVersion] = useState('');

  useEffect(() => {
    if (!data) return;
    api.get<AuditEvent[]>(`/api/v1/audit?subjectType=plugin&subjectId=${encodeURIComponent(id)}&limit=50`).then(setEvents).catch(() => setEvents([]));
  }, [id, data?.activeRevision?.generation, data?.state]);

  const activeVersion = data?.activeVersion;
  const versions = data?.packageVersions || [];
  const trustVersion = versions.find((version) => version.version === activeVersion) || versions[0];
  const activeDeployment = data?.deployments.find((deployment) => deployment.version === activeVersion);
  const readyCandidate = data?.deployments.find((deployment) => deployment.status === 'READY' && deployment.version !== activeVersion);
  const latestDeployment = data?.deployments[0];

  useEffect(() => {
    if (!deployOpen && versions.length) setDeployVersion((current) => current || versions[0].version);
  }, [deployOpen, versions]);

  if (loading && !data) return <><PageHeader title={t('table.plugin')} /><Skeleton rows={6} /></>;
  if (error) return <><PageHeader title={t('table.plugin')} /><ErrorState error={error} onRetry={() => void reload()} /></>;
  if (!data) return null;

  async function run(label: string, action: () => Promise<unknown>, success: string) {
    setBusy(label);
    try {
      await action();
      toast.push({ tone: 'ok', title: success });
      await reload();
    } catch (cause) {
      const apiError = cause as ApiError;
      toast.push({ tone: 'danger', title: apiError.code || t('pluginDetail.actionFailed'), detail: apiError.message });
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  async function deploy() {
    await run('deploy', () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/deployments`, {
      version: deployVersion,
      desiredReplicas: replicas,
      nodeSelector: Object.fromEntries(selector.split(',').map((pair) => pair.trim().split('=')).filter((pair) => pair.length === 2)),
      maxInstancesPerNode: 1,
    }), t('pluginDetail.toast.deploymentRequested', { version: deployVersion }));
    setDeployOpen(false);
    setTab('deployments');
  }

  async function activate(version: string) {
    await run('activate', () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/activations`, {
      version,
      expectedRevision: data?.activeRevision?.generation ?? 0,
    }), t('pluginDetail.toast.activated', { version }));
  }

  async function disable() {
    await run('disable', () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/disable`, { reason: 'Disabled from plugin detail' }), t('pluginDetail.toast.disabled'));
  }

  async function enable() {
    await run('enable', () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/enable`, {}), t('pluginDetail.toast.redeploymentRequested'));
  }

  async function uninstall() {
    await run('uninstall', () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/uninstall`, {}), t('pluginDetail.toast.uninstalled'));
  }

  async function rollback() {
    await run('rollback', () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/rollback`, {
      targetVersion: rollbackVersion,
      expectedRevision: data?.activeRevision?.generation ?? 0,
      desiredReplicas: 2,
    }), t('pluginDetail.toast.rollbackRequested', { version: rollbackVersion }));
  }

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'overview', label: t('page.overview') },
    { id: 'versions', label: t('pluginDetail.tab.versions'), count: versions.length },
    { id: 'deployments', label: t('common.deployments'), count: data.deployments.length },
    { id: 'capabilities', label: t('common.capabilities'), count: data.provides.length + data.requires.length },
    { id: 'permissions', label: t('table.permissions'), count: data.permissions.length },
    { id: 'events', label: t('pluginDetail.tab.events'), count: events.length },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={(data.publisher || t('pluginDetail.unknownPublisher')) + ' · ' + (data.isSystem ? t('pluginDetail.systemPlugin') : t('pluginDetail.trustedPackage'))}
        title={<span className="title-with-status">{data.name}{data.isSystem ? <span className="tag">{t('common.tag.system')}</span> : null}</span>}
        description={<><span className="mono">{data.id}</span> · {t('pluginDetail.effectiveVersion')} <strong>{activeVersion || t('pluginDetail.none')}</strong> · {t('pluginDetail.revision', { revision: data.activeRevision?.generation ?? 0 })}</>}
        actions={<>
          {readyCandidate && <button className="btn btn-primary" onClick={() => setConfirm('activate')} disabled={Boolean(busy)}><Icon name="play" size={15} /> {t('pluginDetail.action.activateVersion', { version: readyCandidate.version })}</button>}
          {!activeVersion && latestDeployment?.status !== 'READY' && versions[0] && <button className="btn btn-primary" onClick={() => { setDeployVersion(versions[0].version); setDeployOpen(true); }} disabled={Boolean(busy)}><Icon name="play" size={15} /> {t('action.deploy')}</button>}
          {latestDeployment?.status === 'READY' && latestDeployment.version === activeVersion && <StatusBadge status="READY" label={t('status.ready')} />}
          {activeVersion && <button className="btn btn-secondary" onClick={() => setConfirm('disable')} disabled={Boolean(busy)}><Icon name="stop" size={15} /> {t('action.disable')}</button>}
          {!activeVersion && data.state === 'DISABLED' && <button className="btn btn-secondary" onClick={() => setConfirm('enable')} disabled={Boolean(busy)}><Icon name="rotate" size={15} /> {t('action.enable')}</button>}
          <button className="btn btn-secondary" onClick={() => setTab('versions')}><Icon name="plugins" size={15} /> {t('pluginDetail.tab.versions')}</button>
        </>}
      />
      <div className="detail-meta">
        <StatusBadge status={data.state} />
        {data.activeRevision && <span className="meta-chip"><Icon name="activity" size={13} /> {t('pluginDetail.meta.revision', { revision: data.activeRevision.generation })}</span>}
        {data.activeRevision?.activatedAt && <span className="meta-chip">{t('pluginDetail.meta.activated')} <TimeAgo value={data.activeRevision.activatedAt} /></span>}
        {data.isSystem && <span className="meta-chip"><Icon name="access" size={13} /> {t('pluginDetail.hostOwnedRecovery')}</span>}
      </div>

      <div className="tabs" role="tablist">
        {tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}{item.count !== undefined ? <span className="tab-count">{item.count}</span> : null}</button>)}
      </div>

      {tab === 'overview' && (
        <>
          <div className="summary-grid">
            <section className="panel">
              <div className="panel-head"><div><h2>{t('pluginDetail.effectiveState.title')}</h2><p>{t('pluginDetail.effectiveState.description')}</p></div></div>
              <div className="kv-grid">
                <KV label={t('pluginDetail.field.installation')}>{data.state}</KV>
                <KV label={t('pluginDetail.field.activeVersion')}>{activeVersion || t('common.none')}</KV>
                <KV label={t('pluginDetail.field.activeRevision')}>{data.activeRevision?.generation ?? 0}</KV>
                <KV label={t('field.desiredReplicas')}>{activeDeployment?.desiredReplicas ?? latestDeployment?.desiredReplicas ?? 0}</KV>
                <KV label="READY">{activeDeployment ? `${activeDeployment.readyInstances}/${activeDeployment.totalInstances}` : t('pluginDetail.noActiveDeployment')}</KV>
                <KV label={t('pluginDetail.field.deploymentStatus')}>{activeDeployment ? <StatusBadge status={activeDeployment.status} /> : '—'}</KV>
              </div>
              {activeDeployment && <Progress value={activeDeployment.readyInstances} max={Math.max(activeDeployment.desiredReplicas, 1)} label={t('pluginDetail.readyReplicas')} />}
            </section>
            <section className="panel">
              <div className="panel-head"><div><h2>{t('pluginDetail.artifactTrust.title')}</h2><p>{t('pluginDetail.artifactTrust.description')}</p></div></div>
              {trustVersion ? (
                <div className="kv-grid">
                  <KV label={t('table.publisher')}>{data.publisher}</KV>
                  <KV label={t('table.signature')}><StatusBadge status={trustVersion.signatureState} /></KV>
                  <KV label={t('pluginDetail.field.image')} mono>{shortDigest(trustVersion.imageRef, 22)} <CopyButton value={trustVersion.imageRef} /></KV>
                  <KV label={t('pluginDetail.field.bundle')} mono>{shortDigest(trustVersion.bundleDigest, 22)} <CopyButton value={trustVersion.bundleDigest} /></KV>
                  <KV label={t('pluginDetail.field.artifact')} mono>{shortDigest(trustVersion.artifactDigest, 22)} <CopyButton value={trustVersion.artifactDigest} /></KV>
                  <KV label={t('table.published')}>{formatDate(trustVersion.createdAt)}</KV>
                </div>
              ) : <EmptyState icon="file" title={t('pluginDetail.empty.systemPlugin.title')} description={t('pluginDetail.empty.systemPlugin.description')} />}
            </section>
          </div>
          <section className="panel">
            <div className="panel-head"><div><h2>{t('table.instances')}</h2><p>{t('pluginDetail.instances.description')}</p></div>{activeDeployment && <Link className="text-link" to={`/plugins/${data.id}/deployments`}>{t('pluginDetail.instances.deploymentDetail')} <Icon name="arrowRight" size={14} /></Link>}</div>
            <InstanceTable instances={activeDeployment?.instances || []} />
          </section>
        </>
      )}

      {tab === 'versions' && (
        <section className="panel table-panel">
          <div className="panel-head"><div><h2>{t('pluginDetail.versions.title')}</h2><p>{t('pluginDetail.versions.description')}</p></div><button className="btn btn-secondary" onClick={() => setDeployOpen(true)}><Icon name="plus" size={15} /> {t('pluginDetail.versions.deploy')}</button></div>
          {versions.length === 0 ? <EmptyState icon="file" title={t('pluginDetail.versions.empty.title')} description={t('pluginDetail.versions.empty.description')} /> : (
            <table className="data-table">
              <thead><tr><th>{t('table.version')}</th><th>{t('table.status')}</th><th>{t('table.signature')}</th><th>{t('table.imageDigest')}</th><th>{t('table.published')}</th><th>{t('table.actions')}</th></tr></thead>
              <tbody>
                {versions.map((version) => {
                  const deployment = data.deployments.find((item) => item.version === version.version);
                  return (
                    <tr key={version.version}>
                      <td data-label={t('table.version')}><strong className="mono">{version.version}</strong>{version.version === activeVersion && <span className="tag tag-ok">{t('common.tag.active')}</span>}</td>
                      <td data-label={t('table.status')}><StatusBadge status={version.status} /></td>
                      <td data-label={t('table.signature')}><StatusBadge status={version.signatureState} /></td>
                      <td data-label={t('table.imageDigest')}><span className="mono small">{shortDigest(version.imageRef, 18)}</span><CopyButton value={version.imageRef} /></td>
                      <td data-label={t('table.published')}><TimeAgo value={version.createdAt} /></td>
                      <td data-label={t('table.actions')} className="actions-cell">
                        {deployment?.status === 'READY' && deployment.version !== activeVersion && <button className="btn btn-small btn-primary" onClick={() => { setRollbackVersion(version.version); setConfirm('activate'); }}>{t('action.activate')}</button>}
                        {(!deployment || ['DISABLED', 'DEGRADED', 'FAILED'].includes(deployment.status)) && version.version !== activeVersion && <button className="btn btn-small" onClick={() => { setDeployVersion(version.version); setDeployOpen(true); }}>{deployment ? t('action.redeploy') : t('action.deploy')}</button>}
                        {deployment?.status === 'READY' && deployment.version !== activeVersion && <button className="btn btn-small" onClick={() => { setRollbackVersion(version.version); setConfirm('rollback'); }}>{t('action.rollback')}</button>}
                        {deployment && <StatusBadge status={deployment.status} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      )}

      {tab === 'deployments' && (
        <div className="stack-list">
          {data.deployments.length === 0 ? <EmptyState icon="plugins" title={t('pluginDetail.deployments.empty.title')} description={t('pluginDetail.deployments.empty.description')} action={<button className="btn btn-primary" onClick={() => setDeployOpen(true)}>{t('pluginDetail.versions.deploy')}</button>} /> : data.deployments.map((deployment) => (
            <DeploymentCard key={deployment.id} deployment={deployment} active={deployment.version === activeVersion} onActivate={() => { setRollbackVersion(deployment.version); setConfirm('activate'); }} onRollback={() => { setRollbackVersion(deployment.version); setConfirm('rollback'); }} />
          ))}
        </div>
      )}

      {tab === 'capabilities' && (
        <div className="summary-grid">
          <section className="panel"><div className="panel-head"><div><h2>{t('pluginDetail.capabilities.provides')}</h2><p>{t('pluginDetail.capabilities.provides.description')}</p></div></div>{data.provides.length ? <ul className="capability-list">{data.provides.map((capability) => <li key={capability.name}><code>{capability.name}</code><span>v{capability.major}</span></li>)}</ul> : <EmptyState icon="plugins" title={t('pluginDetail.capabilities.provides.empty')} />}</section>
          <section className="panel"><div className="panel-head"><div><h2>{t('pluginDetail.capabilities.requires')}</h2><p>{t('pluginDetail.capabilities.requires.description')}</p></div></div>{data.requires.length ? <ul className="capability-list">{data.requires.map((capability) => <li key={capability.name}><code>{capability.name}</code><span>v{capability.major}</span></li>)}</ul> : <EmptyState icon="check" title={t('pluginDetail.capabilities.requires.empty')} />}</section>
        </div>
      )}

      {tab === 'permissions' && (
        <section className="panel"><div className="panel-head"><div><h2>{t('common.requestedPermissions')}</h2><p>{t('pluginDetail.permissions.description')}</p></div></div>
          {data.permissions.length ? <ul className="permission-list">{data.permissions.map((permission) => <li key={permission}><Icon name="key" size={15} /><code>{permission}</code><span className="muted">{t('pluginDetail.permissions.declared')}</span></li>)}</ul> : <EmptyState icon="access" title={t('pluginDetail.permissions.empty')} />}
          <div className="callout"><Icon name="alert" size={16} /><p>{t('pluginDetail.permissions.note')}</p></div>
        </section>
      )}

      {tab === 'events' && (
        <section className="panel table-panel">
          <div className="panel-head"><div><h2>{t('pluginDetail.events.title')}</h2><p>{t('pluginDetail.events.description')}</p></div><Link className="text-link" to="/activity">{t('pluginDetail.events.global')} <Icon name="arrowRight" size={14} /></Link></div>
          {events.length === 0 ? <EmptyState icon="activity" title={t('overview.events.empty.title')} /> : (
            <table className="data-table"><thead><tr><th>{t('table.event')}</th><th>{t('table.result')}</th><th>{t('table.actor')}</th><th>{t('table.when')}</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td data-label={t('table.event')}><strong>{event.eventType}</strong><div className="muted small">{event.action}</div></td><td data-label={t('table.result')}><StatusBadge status={event.result} /></td><td data-label={t('table.actor')}><span className="mono small">{event.actorType}:{event.actorId.slice(0, 8)}</span></td><td data-label={t('table.when')}><TimeAgo value={event.occurredAt} /></td></tr>)}</tbody></table>
          )}
        </section>
      )}

      <Modal open={deployOpen} onClose={() => setDeployOpen(false)} title={t('pluginDetail.deployModal.title', { name: data.name })} footer={<><button className="btn btn-secondary" onClick={() => setDeployOpen(false)}>{t('action.cancel')}</button><button className="btn btn-primary" onClick={() => void deploy()} disabled={busy === 'deploy'}>{busy === 'deploy' ? t('pluginDetail.deployModal.requesting') : t('action.deploy')}</button></>}>
        <div className="form-stack">
          <Field label={t('table.version')} hint={t('pluginDetail.deployModal.versionHint')}>
            <select value={deployVersion} onChange={(event) => setDeployVersion(event.target.value)}>
              {versions.map((version) => <option key={version.version} value={version.version}>{version.version} ({version.status})</option>)}
            </select>
          </Field>
          <div className="form-grid">
            <Field label={t('field.desiredReplicas')}><input type="number" min={0} max={20} value={replicas} onChange={(event) => setReplicas(Number(event.target.value))} /></Field>
            <Field label={t('field.nodeSelector')} hint={t('pluginDetail.deployModal.selectorHint')}><input value={selector} onChange={(event) => setSelector(event.target.value)} placeholder="role=node,zone=lab" /></Field>
          </div>
          <div className="callout"><Icon name="alert" size={16} /><p>{t('pluginDetail.deployModal.note')}</p></div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirm === 'activate'}
        title={t('pluginDetail.confirmActivate.title', { version: rollbackVersion || readyCandidate?.version || '' })}
        description={<>{t('pluginDetail.confirmActivate.before')} <strong>{data.name}</strong>{t('pluginDetail.confirmActivate.after')}</>}
        confirmLabel={t('pluginDetail.confirmActivate.confirm')}
        busy={busy === 'activate'}
        onConfirm={() => void activate(rollbackVersion || readyCandidate?.version || '')}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'disable'}
        title={t('pluginDetail.confirmDisable.title', { name: data.name })}
        description={<>{t('pluginDetail.confirmDisable.before')} <code>CAPABILITY_UNAVAILABLE</code>{t('pluginDetail.confirmDisable.after')}</>}
        confirmLabel={t('pluginDetail.confirmDisable.confirm')}
        danger
        busy={busy === 'disable'}
        onConfirm={() => void disable()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'enable'}
        title={t('pluginDetail.confirmEnable.title', { name: data.name })}
        description={t('pluginDetail.confirmEnable.description')}
        confirmLabel={t('pluginDetail.confirmEnable.confirm')}
        busy={busy === 'enable'}
        onConfirm={() => void enable()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'uninstall'}
        title={t('pluginDetail.confirmUninstall.title', { name: data.name })}
        description={<>{t('pluginDetail.confirmUninstall.before')} <strong>{t('pluginDetail.confirmUninstall.retained')}</strong>{t('pluginDetail.confirmUninstall.after')}</>}
        confirmLabel={t('action.uninstall')}
        danger
        busy={busy === 'uninstall'}
        onConfirm={() => void uninstall()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'rollback'}
        title={t('pluginDetail.confirmRollback.title', { version: rollbackVersion })}
        description={t('pluginDetail.confirmRollback.description')}
        confirmLabel={t('pluginDetail.confirmRollback.confirm')}
        danger
        busy={busy === 'rollback'}
        onConfirm={() => void rollback()}
        onClose={() => setConfirm(null)}
      />
      {!activeVersion && data.state === 'INSTALLED' && <div className="sticky-note"><Icon name="alert" size={15} /> {t('pluginDetail.stickyNote')}</div>}
    </div>
  );
}

function InstanceTable({ instances }: { instances: PluginDetail['deployments'][number]['instances'] }) {
  const t = useT();
  if (!instances.length) return <EmptyState icon="nodes" title={t('pluginDetail.instances.empty.title')} description={t('pluginDetail.instances.empty.description')} />;
  return (
    <table className="data-table">
      <thead><tr><th>{t('table.slot')}</th><th>{t('table.node')}</th><th>{t('table.state')}</th><th>{t('table.container')}</th><th>{t('table.restarts')}</th><th>{t('table.observed')}</th><th>{t('table.logs')}</th></tr></thead>
      <tbody>{instances.map((instance) => (
        <tr key={instance.id}>
          <td data-label={t('table.slot')}><span className="mono">#{instance.slot}</span></td>
          <td data-label={t('table.node')}><strong>{instance.nodeName || instance.nodeId.slice(0, 8)}</strong><div className="muted small">{instance.nodeStatus}</div></td>
          <td data-label={t('table.state')}><StatusBadge status={instance.state} />{instance.lastError && <div className="inline-hint text-danger">{instance.lastError}</div>}</td>
          <td data-label={t('table.container')}><span className="mono small">{instance.containerId ? instance.containerId.slice(0, 12) : '—'}</span></td>
          <td data-label={t('table.restarts')}>{instance.restartCount}</td>
          <td data-label={t('table.observed')}><TimeAgo value={instance.observedAt} /></td>
          <td data-label={t('table.logs')}><Link className="text-link" to={`/instances/${instance.id}/logs`}><Icon name="logs" size={14} /> {t('table.live')}</Link></td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function DeploymentCard({ deployment, active, onActivate, onRollback }: { deployment: DeploymentView; active: boolean; onActivate(): void; onRollback(): void }) {
  const t = useT();
  return (
    <section className={`panel deployment-card ${active ? 'deployment-active' : ''}`}>
      <div className="panel-head">
        <div className="deployment-title"><h2 className="mono">{deployment.version}</h2><StatusBadge status={deployment.status} />{active && <span className="tag tag-ok">{t('common.tag.effective')}</span>}</div>
        <div className="page-actions">
          {deployment.status === 'READY' && !active && <button className="btn btn-small btn-primary" onClick={onActivate}>{t('action.activate')}</button>}
          {deployment.status === 'READY' && active && <button className="btn btn-small" onClick={onRollback}>{t('action.rollback')}</button>}
        </div>
      </div>
      <div className="kv-grid deployment-kv">
        <KV label={t('pluginDetail.deployment.fieldId')} mono>{deployment.id.slice(0, 13)}…</KV>
        <KV label={t('table.generation')}>{deployment.generation}</KV>
        <KV label={t('status.ready')}>{deployment.readyInstances}/{deployment.desiredReplicas}</KV>
        <KV label={t('pluginDetail.deployment.cpuMemory')}>{deployment.resources?.cpuMillis ?? '—'} mCPU / {formatBytes((deployment.resources?.memoryMiB || 0) * 1024 * 1024)}</KV>
        <KV label={t('table.created')}>{formatDate(deployment.createdAt)}</KV>
        <KV label={t('pluginDetail.deployment.fieldReason')}>{deployment.statusReason || '—'}</KV>
      </div>
      {deployment.statusReason && <div className="callout"><Icon name="alert" size={15} /><p>{deployment.statusReason}</p></div>}
      <InstanceTable instances={deployment.instances} />
    </section>
  );
}
