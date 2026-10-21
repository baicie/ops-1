import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { usePolling } from '../hooks';
import type { AuditEvent, DeploymentView, PluginDetail } from '../types';
import { Icon } from '../components/Icons';
import { ConfirmDialog, CopyButton, EmptyState, ErrorState, Field, KV, Modal, PageHeader, Progress, Skeleton, StatusBadge, TimeAgo, useToast } from '../components/Ui';
import { formatDate, formatBytes, shortDigest } from '../format';

type Tab = 'overview' | 'versions' | 'deployments' | 'capabilities' | 'permissions' | 'events';

export function PluginDetailPage() {
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

  if (loading && !data) return <><PageHeader title="Plugin" /><Skeleton rows={6} /></>;
  if (error) return <><PageHeader title="Plugin" /><ErrorState error={error} onRetry={() => void reload()} /></>;
  if (!data) return null;

  async function run(label: string, action: () => Promise<unknown>, success: string) {
    setBusy(label);
    try {
      await action();
      toast.push({ tone: 'ok', title: success });
      await reload();
    } catch (cause) {
      const apiError = cause as ApiError;
      toast.push({ tone: 'danger', title: apiError.code || 'Action failed', detail: apiError.message });
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
    }), `Deployment requested for ${deployVersion}`);
    setDeployOpen(false);
    setTab('deployments');
  }

  async function activate(version: string) {
    await run('activate', () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/activations`, {
      version,
      expectedRevision: data?.activeRevision?.generation ?? 0,
    }), `Activated ${version}`);
  }

  async function disable() {
    await run('disable', () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/disable`, { reason: 'Disabled from plugin detail' }), 'Plugin disabled');
  }

  async function enable() {
    await run('enable', () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/enable`, {}), 'Re-deployment requested');
  }

  async function uninstall() {
    await run('uninstall', () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/uninstall`, {}), 'Plugin uninstalled; data retained');
  }

  async function rollback() {
    await run('rollback', () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/rollback`, {
      targetVersion: rollbackVersion,
      expectedRevision: data?.activeRevision?.generation ?? 0,
      desiredReplicas: 2,
    }), `Rollback requested to ${rollbackVersion}`);
  }

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'versions', label: 'Versions', count: versions.length },
    { id: 'deployments', label: 'Deployments', count: data.deployments.length },
    { id: 'capabilities', label: 'Capabilities', count: data.provides.length + data.requires.length },
    { id: 'permissions', label: 'Permissions', count: data.permissions.length },
    { id: 'events', label: 'Events', count: events.length },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow={`${data.publisher || 'unknown publisher'} · ${data.isSystem ? 'system plugin' : 'trusted package'}`}
        title={<span className="title-with-status">{data.name}{data.isSystem ? <span className="tag">SYSTEM</span> : null}</span>}
        description={<><span className="mono">{data.id}</span> · effective version <strong>{activeVersion || 'none'}</strong> · revision {data.activeRevision?.generation ?? 0}</>}
        actions={<>
          {readyCandidate && <button className="btn btn-primary" onClick={() => setConfirm('activate')} disabled={Boolean(busy)}><Icon name="play" size={15} /> Activate {readyCandidate.version}</button>}
          {!activeVersion && latestDeployment?.status !== 'READY' && versions[0] && <button className="btn btn-primary" onClick={() => { setDeployVersion(versions[0].version); setDeployOpen(true); }} disabled={Boolean(busy)}><Icon name="play" size={15} /> Deploy</button>}
          {latestDeployment?.status === 'READY' && latestDeployment.version === activeVersion && <StatusBadge status="READY" label="Ready" />}
          {activeVersion && <button className="btn btn-secondary" onClick={() => setConfirm('disable')} disabled={Boolean(busy)}><Icon name="stop" size={15} /> Disable</button>}
          {!activeVersion && data.state === 'DISABLED' && <button className="btn btn-secondary" onClick={() => setConfirm('enable')} disabled={Boolean(busy)}><Icon name="rotate" size={15} /> Enable</button>}
          <button className="btn btn-secondary" onClick={() => setTab('versions')}><Icon name="plugins" size={15} /> Versions</button>
        </>}
      />
      <div className="detail-meta">
        <StatusBadge status={data.state} />
        {data.activeRevision && <span className="meta-chip"><Icon name="activity" size={13} /> Revision {data.activeRevision.generation}</span>}
        {data.activeRevision?.activatedAt && <span className="meta-chip">Activated <TimeAgo value={data.activeRevision.activatedAt} /></span>}
        {data.isSystem && <span className="meta-chip"><Icon name="access" size={13} /> Host-owned recovery UI</span>}
      </div>

      <div className="tabs" role="tablist">
        {tabs.map((item) => <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}{item.count !== undefined ? <span className="tab-count">{item.count}</span> : null}</button>)}
      </div>

      {tab === 'overview' && (
        <>
          <div className="summary-grid">
            <section className="panel">
              <div className="panel-head"><div><h2>Effective state</h2><p>Observed facts, not a merged SUCCESS state.</p></div></div>
              <div className="kv-grid">
                <KV label="Installation">{data.state}</KV>
                <KV label="Active version">{activeVersion || 'None'}</KV>
                <KV label="Active revision">{data.activeRevision?.generation ?? 0}</KV>
                <KV label="Desired replicas">{activeDeployment?.desiredReplicas ?? latestDeployment?.desiredReplicas ?? 0}</KV>
                <KV label="READY">{activeDeployment ? `${activeDeployment.readyInstances}/${activeDeployment.totalInstances}` : 'No active deployment'}</KV>
                <KV label="Deployment status">{activeDeployment ? <StatusBadge status={activeDeployment.status} /> : '—'}</KV>
              </div>
              {activeDeployment && <Progress value={activeDeployment.readyInstances} max={Math.max(activeDeployment.desiredReplicas, 1)} label="Ready replicas" />}
            </section>
            <section className="panel">
              <div className="panel-head"><div><h2>Artifact trust</h2><p>Distinct hashes for distinct trust domains.</p></div></div>
              {trustVersion ? (
                <div className="kv-grid">
                  <KV label="Publisher">{data.publisher}</KV>
                  <KV label="Signature"><StatusBadge status={trustVersion.signatureState} /></KV>
                  <KV label="Image" mono>{shortDigest(trustVersion.imageRef, 22)} <CopyButton value={trustVersion.imageRef} /></KV>
                  <KV label="Bundle" mono>{shortDigest(trustVersion.bundleDigest, 22)} <CopyButton value={trustVersion.bundleDigest} /></KV>
                  <KV label="Artifact" mono>{shortDigest(trustVersion.artifactDigest, 22)} <CopyButton value={trustVersion.artifactDigest} /></KV>
                  <KV label="Published">{formatDate(trustVersion.createdAt)}</KV>
                </div>
              ) : <EmptyState icon="file" title="System plugin" description="Host-owned assets; no external package digest applies." />}
            </section>
          </div>
          <section className="panel">
            <div className="panel-head"><div><h2>Instances</h2><p>Observed instance state reported by each Node. A heartbeat alone does not make an instance READY.</p></div>{activeDeployment && <Link className="text-link" to={`/plugins/${data.id}/deployments`}>Deployment detail <Icon name="arrowRight" size={14} /></Link>}</div>
            <InstanceTable instances={activeDeployment?.instances || []} />
          </section>
        </>
      )}

      {tab === 'versions' && (
        <section className="panel table-panel">
          <div className="panel-head"><div><h2>Package versions</h2><p>Immutable id+version → digest. Same version cannot point to new bytes.</p></div><button className="btn btn-secondary" onClick={() => setDeployOpen(true)}><Icon name="plus" size={15} /> Deploy version</button></div>
          {versions.length === 0 ? <EmptyState icon="file" title="No external versions" description="This system plugin is shipped with the Shell." /> : (
            <table className="data-table">
              <thead><tr><th>Version</th><th>Status</th><th>Signature</th><th>Image digest</th><th>Published</th><th>Actions</th></tr></thead>
              <tbody>
                {versions.map((version) => {
                  const deployment = data.deployments.find((item) => item.version === version.version);
                  return (
                    <tr key={version.version}>
                      <td data-label="Version"><strong className="mono">{version.version}</strong>{version.version === activeVersion && <span className="tag tag-ok">ACTIVE</span>}</td>
                      <td data-label="Status"><StatusBadge status={version.status} /></td>
                      <td data-label="Signature"><StatusBadge status={version.signatureState} /></td>
                      <td data-label="Image digest"><span className="mono small">{shortDigest(version.imageRef, 18)}</span><CopyButton value={version.imageRef} /></td>
                      <td data-label="Published"><TimeAgo value={version.createdAt} /></td>
                      <td data-label="Actions" className="actions-cell">
                        {deployment?.status === 'READY' && deployment.version !== activeVersion && <button className="btn btn-small btn-primary" onClick={() => { setRollbackVersion(version.version); setConfirm('activate'); }}>Activate</button>}
                        {(!deployment || ['DISABLED', 'DEGRADED', 'FAILED'].includes(deployment.status)) && version.version !== activeVersion && <button className="btn btn-small" onClick={() => { setDeployVersion(version.version); setDeployOpen(true); }}>{deployment ? 'Redeploy' : 'Deploy'}</button>}
                        {deployment?.status === 'READY' && deployment.version !== activeVersion && <button className="btn btn-small" onClick={() => { setRollbackVersion(version.version); setConfirm('rollback'); }}>Rollback</button>}
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
          {data.deployments.length === 0 ? <EmptyState icon="plugins" title="No deployments" description="Select a version and deploy it to eligible nodes." action={<button className="btn btn-primary" onClick={() => setDeployOpen(true)}>Deploy version</button>} /> : data.deployments.map((deployment) => (
            <DeploymentCard key={deployment.id} deployment={deployment} active={deployment.version === activeVersion} onActivate={() => { setRollbackVersion(deployment.version); setConfirm('activate'); }} onRollback={() => { setRollbackVersion(deployment.version); setConfirm('rollback'); }} />
          ))}
        </div>
      )}

      {tab === 'capabilities' && (
        <div className="summary-grid">
          <section className="panel"><div className="panel-head"><div><h2>Provides</h2><p>Versioned contracts other plugins may require.</p></div></div>{data.provides.length ? <ul className="capability-list">{data.provides.map((capability) => <li key={capability.name}><code>{capability.name}</code><span>v{capability.major}</span></li>)}</ul> : <EmptyState icon="plugins" title="No provided capabilities" />}</section>
          <section className="panel"><div className="panel-head"><div><h2>Requires</h2><p>Activations fail closed if a required provider is missing.</p></div></div>{data.requires.length ? <ul className="capability-list">{data.requires.map((capability) => <li key={capability.name}><code>{capability.name}</code><span>v{capability.major}</span></li>)}</ul> : <EmptyState icon="check" title="No dependencies" />}</section>
        </div>
      )}

      {tab === 'permissions' && (
        <section className="panel"><div className="panel-head"><div><h2>Requested permissions</h2><p>These are data/capability permissions declared by the signed manifest. UI hiding is never authorization.</p></div></div>
          {data.permissions.length ? <ul className="permission-list">{data.permissions.map((permission) => <li key={permission}><Icon name="key" size={15} /><code>{permission}</code><span className="muted">granted at activation</span></li>)}</ul> : <EmptyState icon="access" title="No permissions requested" />}
          <div className="callout"><Icon name="alert" size={16} /><p>Permission expansion on upgrade must be reviewed and approved before activation. This version shows the manifest as signed.</p></div>
        </section>
      )}

      {tab === 'events' && (
        <section className="panel table-panel">
          <div className="panel-head"><div><h2>Plugin events</h2><p>Audited lifecycle and failure actions for this subject.</p></div><Link className="text-link" to="/activity">Global activity <Icon name="arrowRight" size={14} /></Link></div>
          {events.length === 0 ? <EmptyState icon="activity" title="No events yet" /> : (
            <table className="data-table"><thead><tr><th>Event</th><th>Result</th><th>Actor</th><th>When</th></tr></thead><tbody>{events.map((event) => <tr key={event.id}><td data-label="Event"><strong>{event.eventType}</strong><div className="muted small">{event.action}</div></td><td data-label="Result"><StatusBadge status={event.result} /></td><td data-label="Actor"><span className="mono small">{event.actorType}:{event.actorId.slice(0, 8)}</span></td><td data-label="When"><TimeAgo value={event.occurredAt} /></td></tr>)}</tbody></table>
          )}
        </section>
      )}

      <Modal open={deployOpen} onClose={() => setDeployOpen(false)} title={`Deploy ${data.name}`} footer={<><button className="btn btn-secondary" onClick={() => setDeployOpen(false)}>Cancel</button><button className="btn btn-primary" onClick={() => void deploy()} disabled={busy === 'deploy'}>{busy === 'deploy' ? 'Requesting…' : 'Deploy'}</button></>}>
        <div className="form-stack">
          <Field label="Version" hint="A deployment is desired state; READY is only claimed after every replica reports readiness.">
            <select value={deployVersion} onChange={(event) => setDeployVersion(event.target.value)}>
              {versions.map((version) => <option key={version.version} value={version.version}>{version.version} ({version.status})</option>)}
            </select>
          </Field>
          <div className="form-grid">
            <Field label="Desired replicas"><input type="number" min={0} max={20} value={replicas} onChange={(event) => setReplicas(Number(event.target.value))} /></Field>
            <Field label="Node selector" hint="Comma-separated key=value pairs"><input value={selector} onChange={(event) => setSelector(event.target.value)} placeholder="role=node,zone=lab" /></Field>
          </div>
          <div className="callout"><Icon name="alert" size={16} /><p>Max one instance per node in this form. Placement stays PENDING if no healthy node matches the selector.</p></div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirm === 'activate'}
        title={`Activate ${rollbackVersion || readyCandidate?.version || ''}?`}
        description={<>This switches the effective activation revision for <strong>{data.name}</strong>. Gateway routes move only to READY instances of the new revision; the previous revision enters a bounded drain window.</>}
        confirmLabel="Activate revision"
        busy={busy === 'activate'}
        onConfirm={() => void activate(rollbackVersion || readyCandidate?.version || '')}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'disable'}
        title={`Disable ${data.name}?`}
        description={<>The active capability and all Gateway routes are revoked immediately. Running instances are asked to stop; business data is retained. Consumers of this capability will receive <code>CAPABILITY_UNAVAILABLE</code>.</>}
        confirmLabel="Disable plugin"
        danger
        busy={busy === 'disable'}
        onConfirm={() => void disable()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'enable'}
        title={`Enable ${data.name}?`}
        description={<>The latest deployment will be recreated. The plugin is not effective until every replica is READY and you explicitly activate a new revision.</>}
        confirmLabel="Request re-deployment"
        busy={busy === 'enable'}
        onConfirm={() => void enable()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'uninstall'}
        title={`Uninstall ${data.name}?`}
        description={<>Runtime artifacts and routes are removed. <strong>Business data is retained by default.</strong> Purge is a separate, higher-privilege operation and is not available here.</>}
        confirmLabel="Uninstall"
        danger
        busy={busy === 'uninstall'}
        onConfirm={() => void uninstall()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'rollback'}
        title={`Roll back to ${rollbackVersion}?`}
        description={<>A rollback is a new activation of an older version, not a database migration reversal. If the old schema is incompatible, activation must be blocked by policy.</>}
        confirmLabel="Roll back"
        danger
        busy={busy === 'rollback'}
        onConfirm={() => void rollback()}
        onClose={() => setConfirm(null)}
      />
      {!activeVersion && data.state === 'INSTALLED' && <div className="sticky-note"><Icon name="alert" size={15} /> State says INSTALLED but no ACTIVE revision exists. Inspect activation history; do not treat this as serving.</div>}
    </div>
  );
}

function InstanceTable({ instances }: { instances: PluginDetail['deployments'][number]['instances'] }) {
  if (!instances.length) return <EmptyState icon="nodes" title="No instances observed" description="The reconciler has not placed a slot, or the deployment is not running." />;
  return (
    <table className="data-table">
      <thead><tr><th>Slot</th><th>Node</th><th>State</th><th>Container</th><th>Restarts</th><th>Observed</th><th>Logs</th></tr></thead>
      <tbody>{instances.map((instance) => (
        <tr key={instance.id}>
          <td data-label="Slot"><span className="mono">#{instance.slot}</span></td>
          <td data-label="Node"><strong>{instance.nodeName || instance.nodeId.slice(0, 8)}</strong><div className="muted small">{instance.nodeStatus}</div></td>
          <td data-label="State"><StatusBadge status={instance.state} />{instance.lastError && <div className="inline-hint text-danger">{instance.lastError}</div>}</td>
          <td data-label="Container"><span className="mono small">{instance.containerId ? instance.containerId.slice(0, 12) : '—'}</span></td>
          <td data-label="Restarts">{instance.restartCount}</td>
          <td data-label="Observed"><TimeAgo value={instance.observedAt} /></td>
          <td data-label="Logs"><Link className="text-link" to={`/instances/${instance.id}/logs`}><Icon name="logs" size={14} /> Live</Link></td>
        </tr>
      ))}</tbody>
    </table>
  );
}

function DeploymentCard({ deployment, active, onActivate, onRollback }: { deployment: DeploymentView; active: boolean; onActivate(): void; onRollback(): void }) {
  return (
    <section className={`panel deployment-card ${active ? 'deployment-active' : ''}`}>
      <div className="panel-head">
        <div className="deployment-title"><h2 className="mono">{deployment.version}</h2><StatusBadge status={deployment.status} />{active && <span className="tag tag-ok">EFFECTIVE</span>}</div>
        <div className="page-actions">
          {deployment.status === 'READY' && !active && <button className="btn btn-small btn-primary" onClick={onActivate}>Activate</button>}
          {deployment.status === 'READY' && active && <button className="btn btn-small" onClick={onRollback}>Rollback</button>}
        </div>
      </div>
      <div className="kv-grid deployment-kv">
        <KV label="Deployment ID" mono>{deployment.id.slice(0, 13)}…</KV>
        <KV label="Generation">{deployment.generation}</KV>
        <KV label="Ready">{deployment.readyInstances}/{deployment.desiredReplicas}</KV>
        <KV label="CPU / memory">{deployment.resources?.cpuMillis ?? '—'} mCPU / {formatBytes((deployment.resources?.memoryMiB || 0) * 1024 * 1024)}</KV>
        <KV label="Created">{formatDate(deployment.createdAt)}</KV>
        <KV label="Reason">{deployment.statusReason || '—'}</KV>
      </div>
      {deployment.statusReason && <div className="callout"><Icon name="alert" size={15} /><p>{deployment.statusReason}</p></div>}
      <InstanceTable instances={deployment.instances} />
    </section>
  );
}
