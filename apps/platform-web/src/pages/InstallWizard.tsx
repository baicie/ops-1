import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { DeploymentView, PackageResult, PluginDetail } from '../types';
import { Icon } from '../components/Icons';
import { Badge } from '../components/ui/badge';
import { Button, buttonVariants } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { STATUS_MAP, badgeVariantForTone, glyphForTone } from '../components/status-tone';
import { ErrorState, Field, KV, PageHeader, Progress, useToast } from '../components/Ui';
import { shortDigest } from '../format';
import { useT } from '../i18n';
import { describePlacementReason } from '../placement-reason';
import { StatusPill } from './table-kit';

type Step = 1 | 2 | 3 | 4;

/**
 * The trust badge carries its own copy ("Signature verified") instead of the status label, so it
 * cannot reuse StatusPill's label. The tone still comes from the shared mapping, never a second
 * table of what a signature state means.
 */
function SignaturePill({ status, label }: { status: string; label: string }) {
  const code = status?.toUpperCase();
  const tone = (code ? STATUS_MAP[code] : undefined)?.tone ?? 'unknown';
  return (
    <Badge variant={badgeVariantForTone(tone)} data-status={code || undefined}>
      <Icon name={glyphForTone(tone)} size={12} />
      {label}
    </Badge>
  );
}

export function InstallWizardPage() {
  const t = useT();
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
  const placementReason = describePlacementReason(deployment?.statusReason, t);

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
      toast.push({ tone: 'danger', title: apiError.code || t('install.toast.deployFailed'), detail: apiError.message });
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
      toast.push({ tone: 'ok', title: t('install.toast.activated', { pluginId: pkg.pluginId }), detail: t('install.toast.activated.detail', { version: pkg.version }) });
      navigate(`/plugins/${pkg.pluginId}`);
    } catch (cause) {
      const apiError = cause as ApiError;
      toast.push({ tone: 'danger', title: apiError.code || t('install.toast.activationFailed'), detail: apiError.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-stack narrow-page">
      <PageHeader
        title={t('install.title')}
        description={t('install.description')}
        actions={<Link to="/plugins" className={buttonVariants({ variant: 'secondary' })}>{t('action.cancel')}</Link>}
      />
      <ol className="stepper" aria-label={t('install.steps.aria')}>
        {[
          [1, t('install.step.selectPackage')],
          [2, t('install.step.verify')],
          [3, t('install.step.placement')],
          [4, t('install.step.readiness')],
        ].map(([number, label]) => (
          <li key={String(number)} className={step === number ? 'active' : step > Number(number) ? 'done' : ''}>
            <span className="step-index">{step > Number(number) ? <Icon name="check" size={14} /> : number}</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>

      {step === 1 && (
        <section className="panel wizard-panel">
          <div className="panel-head"><div><h2>{t('install.chooseBundle.title')}</h2><p>{t('install.chooseBundle.description')}</p></div></div>
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
            <h3>{file ? file.name : t('install.dropzone.title')}</h3>
            <p>{file ? t('install.dropzone.uploading', { size: (file.size / 1024).toFixed(1) }) : t('install.dropzone.hint')}</p>
            {busy && <div className="spinner-label"><span className="spinner" /> {t('install.dropzone.verifying')}</div>}
          </div>
          {error && <ErrorState error={error} />}
          <div className="callout"><Icon name="access" size={16} /><p>{t('install.uploadNote')}</p></div>
        </section>
      )}

      {step === 2 && pkg && (
        <>
          <section className="panel wizard-panel">
            <div className="panel-head"><div><h2>{t('install.trust.title')}</h2><p>{t('install.trust.description')}</p></div><SignaturePill status={pkg.signatureState} label={t('install.trust.badge')} /></div>
            <div className="kv-grid">
              <KV label={t('table.plugin')}><span className="mono">{pkg.pluginId}</span></KV>
              <KV label={t('table.version')}>{pkg.version}</KV>
              <KV label={t('table.publisher')}>{pkg.publisher}</KV>
              <KV label={t('install.field.packageStatus')}><StatusPill status={pkg.status} /></KV>
              <KV label={t('install.field.bundleDigest')} mono>{shortDigest(pkg.bundleDigest, 20)}</KV>
              <KV label={t('install.field.artifactDigest')} mono>{shortDigest(pkg.artifactDigest, 20)}</KV>
              <KV label={t('install.field.backendImage')} mono>{shortDigest(pkg.imageRef, 24)}</KV>
              <KV label={t('install.field.frontend')}>{manifest?.frontend ? t('install.field.frontend.count', { count: contributions.length }) : t('common.none')}</KV>
            </div>
            <div className="callout callout-ok"><Icon name="check" size={16} /><p>{t('install.trust.okNote')}</p></div>
          </section>
          <section className="summary-grid">
            <div className="panel">
              <div className="panel-head"><div><h2>{t('common.requestedPermissions')}</h2><p>{t('install.permissions.description')}</p></div></div>
              {selectedPermissions.length ? <ul className="permission-list">{selectedPermissions.map((permission: string) => <li key={permission}><Icon name="key" size={15} /><code>{permission}</code></li>)}</ul> : <p className="muted pad">{t('install.permissions.empty')}</p>}
            </div>
            <div className="panel">
              <div className="panel-head"><div><h2>{t('install.compat.title')}</h2><p>{t('install.compat.description')}</p></div></div>
              <div className="kv-grid">
                <KV label={t('install.field.kernelApiMajor')}>{manifest?.compatibility?.kernelApiMajor ?? '—'}</KV>
                <KV label={t('install.field.webSdkMajor')}>{manifest?.compatibility?.webSdkMajor ?? '—'}</KV>
                <KV label={t('install.field.runtime')}>{manifest?.backend ? `${manifest.backend.protocol?.name}/v${manifest.backend.protocol?.version}` : t('install.field.runtime.frontendOnly')}</KV>
                <KV label={t('install.field.apiPrefix')}><span className="mono">{manifest?.backend?.apiPrefix || '—'}</span></KV>
                <KV label={t('table.cpu')}>{t('install.field.cpu.value', { value: pkg.manifest?.resources?.cpuMillis ?? 0 })}</KV>
                <KV label={t('table.memory')}>{t('install.field.memory.value', { value: pkg.manifest?.resources?.memoryMiB ?? 0 })}</KV>
              </div>
            </div>
          </section>
          {contributions.length > 0 && <section className="panel"><div className="panel-head"><div><h2>{t('install.contributions.title')}</h2><p>{t('install.contributions.description')}</p></div></div><ul className="contribution-list">{contributions.map((contribution) => <li key={`${contribution.kind}:${contribution.id}`}><span className="tag">{contribution.kind}</span><code>{contribution.path}</code></li>)}</ul></section>}
          <div className="wizard-actions"><Button variant="secondary" onClick={() => setStep(1)}>{t('action.back')}</Button><Button onClick={() => setStep(3)}>{t('install.action.continuePlacement')}</Button></div>
        </>
      )}

      {step === 3 && pkg && (
        <section className="panel wizard-panel">
          <div className="panel-head"><div><h2>{t('install.placement.title')}</h2><p>{t('install.placement.description')}</p></div></div>
          <div className="form-grid">
            <Field label={t('field.desiredReplicas')} hint={t('install.field.desiredReplicas.hint')}><Input type="number" min={0} max={20} value={replicas} onChange={(event) => setReplicas(Number(event.target.value))} /></Field>
            <Field label={t('field.nodeSelector')} hint={t('install.field.nodeSelector.hint')}><Input value={selector} onChange={(event) => setSelector(event.target.value)} placeholder="role=node" /></Field>
          </div>
          <div className="callout"><Icon name="nodes" size={16} /><p>{t('install.placement.note.before')} <strong>PENDING</strong>{t('install.placement.note.after')}</p></div>
          <div className="wizard-actions"><Button variant="secondary" onClick={() => setStep(2)}>{t('action.back')}</Button><Button onClick={() => void deploy()} disabled={busy}>{busy ? t('install.deploy.creating') : t('install.action.deployToNodes')}</Button></div>
        </section>
      )}

      {step === 4 && pkg && (
        <section className="panel wizard-panel">
          <div className="panel-head"><div><h2>{t('install.readiness.title')}</h2><p>{t('install.readiness.description')}</p></div><StatusPill status={deployment?.status || 'PENDING'} /></div>
          {deploymentError && <div className="inline-error" role="alert"><Icon name="warning" size={16} /> {deploymentError}</div>}
          {deployment ? (
            <>
              <div className="readiness-block">
                <div className="readiness-number">{deployment.readyInstances}<span>/{deployment.desiredReplicas}</span></div>
                <div className="readiness-copy"><strong>{t('install.readiness.replicasReady')}</strong><p>{placementReason ? placementReason.title : t('install.readiness.waitingDetail')}</p>{placementReason?.raw && <details className="advanced"><summary>{t('placement.reason.raw')}</summary><p className="mono small">{placementReason.raw}</p></details>}</div>
              </div>
              <Progress value={deployment.readyInstances} max={Math.max(deployment.desiredReplicas, 1)} label={t('install.readiness.progressLabel')} />
              <div className="instance-mini-list">
                {deployment.instances.map((instance) => <div className="instance-mini" key={instance.id}><span className="mono">#{instance.slot}</span><strong>{instance.nodeName}</strong><StatusPill status={instance.state} /><span className="muted small">{t('install.restarts', { count: instance.restartCount })}</span></div>)}
              </div>
              <div className={`callout ${deployment.status === 'READY' ? 'callout-ok' : ''}`}><Icon name={deployment.status === 'READY' ? 'check' : 'clock'} size={16} /><p>{deployment.status === 'READY' ? t('install.ready.note') : deployment.status === 'DEGRADED' || deployment.status === 'FAILED' ? t('install.blocked.note') : t('install.waiting.note')}</p></div>
            </>
          ) : <p className="muted pad">{t('install.deploy.creating')}</p>}
          <div className="wizard-actions">
            <Button variant="secondary" onClick={() => setStep(3)} disabled={busy}>{t('action.back')}</Button>
            <Button onClick={() => void activate()} disabled={busy || deployment?.status !== 'READY'}>{busy ? t('install.activating') : t('pluginDetail.confirmActivate.confirm')}</Button>
          </div>
        </section>
      )}
    </div>
  );
}
