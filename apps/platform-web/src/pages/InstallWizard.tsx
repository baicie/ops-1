import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { DeploymentView, PackageResult, PluginDetail } from '../types';
import { Icon } from '../components/Icons';
import { ErrorState, Field, KV, PageHeader, Progress, StatusBadge, useToast } from '../components/Ui';
import { shortDigest } from '../format';

type Step = 1 | 2 | 3 | 4;

export function InstallWizardPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<File | null>(null);
  const [pkg, setPkg] = useState<PackageResult | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [replicas, setReplicas] = useState(2);
  const [selector, setSelector] = useState('role=node');
  const [deployment, setDeployment] = useState<DeploymentView | null>(null);
  const [deploymentError, setDeploymentError] = useState<string | null>(null);

  const manifest = pkg?.manifest;
  const contributions: any[] = manifest?.frontend?.contributions || [];

  useEffect(() => {
    if (!deployment || !pkg || step !== 4) return;
    if (['READY', 'ACTIVE', 'DEGRADED', 'FAILED'].includes(deployment.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const list = await api.get<DeploymentView[]>(`/api/v1/plugins/${encodeURIComponent(pkg.pluginId)}/deployments`);
        const current = list.find((item) => item.id === deployment.id);
        if (current) setDeployment(current);
      } catch (cause) {
        setDeploymentError((cause as Error).message);
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [deployment?.status, deployment?.id, pkg?.pluginId, step]);

  const selectedPermissions = useMemo(() => manifest?.permissions || [], [manifest]);

  async function upload(selected: File) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.uploadPackage(selected);
      setPkg(result);
      setFile(selected);
      setStep(2);
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setBusy(false);
    }
  }

  async function deploy() {
    if (!pkg) return;
    setBusy(true);
    setDeploymentError(null);
    try {
      const nodeSelector = Object.fromEntries(selector.split(',').map((pair) => pair.trim().split('=')).filter((pair) => pair.length === 2));
      const result = await api.post<DeploymentView>(`/api/v1/plugins/${encodeURIComponent(pkg.pluginId)}/deployments`, {
        version: pkg.version,
        desiredReplicas: replicas,
        nodeSelector,
        maxInstancesPerNode: 1,
      });
      setDeployment(result);
      setStep(4);
    } catch (cause) {
      const apiError = cause as ApiError;
      toast.push({ tone: 'danger', title: apiError.code || 'Deploy failed', detail: apiError.message });
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    if (!pkg || !deployment) return;
    setBusy(true);
    try {
      const detail = await api.get<PluginDetail>(`/api/v1/plugins/${encodeURIComponent(pkg.pluginId)}`);
      await api.post(`/api/v1/plugins/${encodeURIComponent(pkg.pluginId)}/activations`, {
        version: pkg.version,
        expectedRevision: detail.activeRevision?.generation ?? 0,
      });
      toast.push({ tone: 'ok', title: `${pkg.pluginId} activated`, detail: `Revision switched to ${pkg.version}` });
      navigate(`/plugins/${pkg.pluginId}`);
    } catch (cause) {
      const apiError = cause as ApiError;
      toast.push({ tone: 'danger', title: apiError.code || 'Activation failed', detail: apiError.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack narrow-page">
      <PageHeader
        title="Install signed plugin"
        description="Verify trust first, review permissions, deploy to nodes, then activate as a separate step."
        actions={<Link to="/plugins" className="btn btn-secondary">Cancel</Link>}
      />
      <ol className="stepper" aria-label="Installation steps">
        {[
          [1, 'Select package'],
          [2, 'Verify & review'],
          [3, 'Placement'],
          [4, 'Readiness & activate'],
        ].map(([number, label]) => (
          <li key={String(number)} className={step === number ? 'active' : step > Number(number) ? 'done' : ''}>
            <span className="step-index">{step > Number(number) ? <Icon name="check" size={14} /> : number}</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>

      {step === 1 && (
        <section className="panel wizard-panel">
          <div className="panel-head"><div><h2>Choose a trusted publisher bundle</h2><p>ZIP bundles are verified against the Kernel trust store. The OCI image is pulled separately by digest.</p></div></div>
          <div
            className={`dropzone ${file ? 'has-file' : ''}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => { event.preventDefault(); const dropped = event.dataTransfer.files?.[0]; if (dropped) void upload(dropped); }}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click(); }}
          >
            <input ref={inputRef} type="file" accept=".zip,application/zip" hidden onChange={(event) => { const selected = event.target.files?.[0]; if (selected) void upload(selected); }} />
            <div className="dropzone-icon"><Icon name="file" size={26} /></div>
            <h3>{file ? file.name : 'Drop a signed .plugin.zip here'}</h3>
            <p>{file ? `${(file.size / 1024).toFixed(1)} KiB · uploading…` : 'or click to choose a file. Maximum 64 MiB, no symlinks, path traversal or zip bombs.'}</p>
            {busy && <div className="spinner-label"><span className="spinner" /> Verifying signature and payload digest…</div>}
          </div>
          {error && <ErrorState error={error} />}
          <div className="callout"><Icon name="access" size={16} /><p>Publishing requires a trusted publisher key. Uploading does not execute plugin code and does not make the plugin effective.</p></div>
        </section>
      )}

      {step === 2 && pkg && (
        <>
          <section className="panel wizard-panel">
            <div className="panel-head"><div><h2>Trust verification</h2><p>The Kernel recomputed the payload digest and verified the detached publisher signature before staging.</p></div><StatusBadge status={pkg.signatureState} label="Signature verified" /></div>
            <div className="kv-grid">
              <KV label="Plugin"><span className="mono">{pkg.pluginId}</span></KV>
              <KV label="Version">{pkg.version}</KV>
              <KV label="Publisher">{pkg.publisher}</KV>
              <KV label="Package status"><StatusBadge status={pkg.status} /></KV>
              <KV label="Bundle digest" mono>{shortDigest(pkg.bundleDigest, 20)}</KV>
              <KV label="Artifact digest" mono>{shortDigest(pkg.artifactDigest, 20)}</KV>
              <KV label="Backend image" mono>{shortDigest(pkg.imageRef, 24)}</KV>
              <KV label="Frontend">{manifest?.frontend ? `${contributions.length} contributions` : 'None'}</KV>
            </div>
            <div className="callout callout-ok"><Icon name="check" size={16} /><p>Signature and payload hashes passed. This proves publisher intent and payload integrity, not that the code is free of defects.</p></div>
          </section>
          <section className="summary-grid">
            <div className="panel">
              <div className="panel-head"><div><h2>Requested permissions</h2><p>Review before activation; expanding permissions later requires a new review.</p></div></div>
              {selectedPermissions.length ? <ul className="permission-list">{selectedPermissions.map((permission: string) => <li key={permission}><Icon name="key" size={15} /><code>{permission}</code></li>)}</ul> : <p className="muted pad">No permissions requested.</p>}
            </div>
            <div className="panel">
              <div className="panel-head"><div><h2>Compatibility</h2><p>Kernel and Web SDK major versions must match.</p></div></div>
              <div className="kv-grid">
                <KV label="Kernel API major">{manifest?.compatibility?.kernelApiMajor ?? '—'}</KV>
                <KV label="Web SDK major">{manifest?.compatibility?.webSdkMajor ?? '—'}</KV>
                <KV label="Runtime">{manifest?.backend ? `${manifest.backend.protocol?.name}/v${manifest.backend.protocol?.version}` : 'Frontend only'}</KV>
                <KV label="API prefix"><span className="mono">{manifest?.backend?.apiPrefix || '—'}</span></KV>
                <KV label="CPU">{(pkg.manifest?.resources?.cpuMillis ?? 0)} mCPU</KV>
                <KV label="Memory">{pkg.manifest?.resources?.memoryMiB ?? 0} MiB</KV>
              </div>
            </div>
          </section>
          {contributions.length > 0 && <section className="panel"><div className="panel-head"><div><h2>Front-end contributions</h2><p>Loaded from content-addressed assets at activation time; no Shell rebuild.</p></div></div><ul className="contribution-list">{contributions.map((contribution) => <li key={`${contribution.kind}:${contribution.id}`}><span className="tag">{contribution.kind}</span><code>{contribution.path}</code></li>)}</ul></section>}
          <div className="wizard-actions"><button className="btn btn-secondary" onClick={() => setStep(1)}>Back</button><button className="btn btn-primary" onClick={() => setStep(3)}>Continue to placement</button></div>
        </>
      )}

      {step === 3 && pkg && (
        <section className="panel wizard-panel">
          <div className="panel-head"><div><h2>Choose placement</h2><p>Deploying writes desired state only. READY requires observed readiness from every selected replica.</p></div></div>
          <div className="form-grid">
            <Field label="Desired replicas" hint="Two replicas demonstrate the 0.0.1 two-node path."><input type="number" min={0} max={20} value={replicas} onChange={(event) => setReplicas(Number(event.target.value))} /></Field>
            <Field label="Node selector" hint="Comma-separated labels; empty means any healthy node"><input value={selector} onChange={(event) => setSelector(event.target.value)} placeholder="role=node" /></Field>
          </div>
          <div className="callout"><Icon name="nodes" size={16} /><p>If fewer nodes match than replicas, the deployment stays <strong>PENDING</strong> and explains why. The activation button will not unlock.</p></div>
          <div className="wizard-actions"><button className="btn btn-secondary" onClick={() => setStep(2)}>Back</button><button className="btn btn-primary" onClick={() => void deploy()} disabled={busy}>{busy ? 'Creating deployment…' : 'Deploy to nodes'}</button></div>
        </section>
      )}

      {step === 4 && pkg && (
        <section className="panel wizard-panel">
          <div className="panel-head"><div><h2>Readiness and activation</h2><p>Activation is a distinct transaction. The old revision stays effective until new replicas are READY.</p></div><StatusBadge status={deployment?.status || 'PENDING'} /></div>
          {deploymentError && <div className="inline-error" role="alert"><Icon name="warning" size={16} /> {deploymentError}</div>}
          {deployment ? (
            <>
              <div className="readiness-block">
                <div className="readiness-number">{deployment.readyInstances}<span>/{deployment.desiredReplicas}</span></div>
                <div className="readiness-copy"><strong>Replicas READY</strong><p>{deployment.statusReason || 'Waiting for the reconciler to place and probe every replica.'}</p></div>
              </div>
              <Progress value={deployment.readyInstances} max={Math.max(deployment.desiredReplicas, 1)} label="Deployment readiness" />
              <div className="instance-mini-list">
                {deployment.instances.map((instance) => <div className="instance-mini" key={instance.id}><span className="mono">#{instance.slot}</span><strong>{instance.nodeName}</strong><StatusBadge status={instance.state} /><span className="muted small">restarts {instance.restartCount}</span></div>)}
              </div>
              <div className={`callout ${deployment.status === 'READY' ? 'callout-ok' : ''}`}><Icon name={deployment.status === 'READY' ? 'check' : 'clock'} size={16} /><p>{deployment.status === 'READY' ? 'All replicas report READY. Activation can now switch the effective revision.' : deployment.status === 'DEGRADED' || deployment.status === 'FAILED' ? 'Deployment is not healthy. Activation is blocked; inspect instance errors and retry or roll back.' : 'The reconciler is waiting for observation. This page refreshes automatically.'}</p></div>
            </>
          ) : <p className="muted pad">Creating deployment…</p>}
          <div className="wizard-actions">
            <button className="btn btn-secondary" onClick={() => setStep(3)} disabled={busy}>Back</button>
            <button className="btn btn-primary" onClick={() => void activate()} disabled={busy || deployment?.status !== 'READY'}>{busy ? 'Activating…' : 'Activate revision'}</button>
          </div>
        </section>
      )}
    </div>
  );
}
