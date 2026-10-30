import React, { useEffect, useId, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { usePolling } from '../hooks';
import type { AuditEvent, DeploymentView, PluginDetail } from '../types';
import { Icon } from '../components/Icons';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { CopyButton, EmptyState, ErrorState, KV, Progress, Skeleton, TimeAgo, useToast } from '../components/Ui';
import { ConfirmAction } from '../components/app/confirm-action';
import { PageHeader } from '../components/app/page-header';
import { NoData, StatusIndicator } from '../components/app/status-indicator';
import { formatDate, formatBytes, shortDigest } from '../format';
import { useI18n, useT } from '../i18n';
import { describePlacementReason } from '../placement-reason';
import { verifiedWriteDetail, verifiedWriteFailure, verifyAfterWrite } from '../lib/verify-after-write';
import { IdentityCell, StackCell, StatusPill, cardActionCell, cardCellClass, formatIdentity, rankCardFacts, stackBody, stackHead, stackRow, stackTable } from './table-kit';
import { InstallationStatus, useStatusText } from '../components/app/status';

type Tab = 'overview' | 'versions' | 'deployments' | 'capabilities' | 'permissions' | 'events';
const TAB_IDS: readonly Tab[] = ['overview', 'versions', 'deployments', 'capabilities', 'permissions', 'events'];

/** Label + control + hint, the shadcn replacement for the shared Field wrapper. */
function FormField({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <span className="text-sm text-muted-foreground">{hint}</span>}
    </div>
  );
}

/**
 * One recipe for every header fact: an optional 13px icon, an optional 11px muted label, and
 * the 13px value. V4 rendered these five siblings five different ways (mono span, label plus
 * strong, icon plus text, ...), so a reader had to decode the shape before the fact.
 */
function MetaChip({ icon, label, value, mono = false }: { icon?: string; label?: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <span className="meta-chip">
      {icon ? <Icon name={icon} size={13} /> : null}
      {label ? <span className="meta-chip-label">{label}</span> : null}
      <strong className={mono ? 'meta-chip-value mono' : 'meta-chip-value'}>{value}</strong>
    </span>
  );
}

export function PluginDetailPage() {
  const t = useT();
  const statusText = useStatusText();
  const { id = '' } = useParams();
  const toast = useToast();
  const { data, error, loading, reload } = usePolling(() => api.get<PluginDetail>(`/api/v1/plugins/${encodeURIComponent(id)}`), 4000);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  // The tab belongs in the URL. Two things already assumed it did: the legacy /plugins/:id
  // redirect forwards ?tab= by allowlist, and this page links to its own deployments view. Without
  // reading the parameter that link pointed at a route that does not exist, and the forwarded tab
  // was silently dropped on arrival.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabFromUrl = searchParams.get('tab');
  const urlTab: Tab = TAB_IDS.includes(tabFromUrl as Tab) ? (tabFromUrl as Tab) : 'overview';
  const [tab, setTabState] = useState<Tab>(urlTab);
  // Reading the parameter once into the initial state was not enough: a `Link` to
  // `?tab=…` on this same route re-renders the page without remounting it, so the URL moved
  // and the tab stayed behind. The URL is the source of truth whenever it changes from
  // outside this component (deep link, in-page link, back/forward).
  useEffect(() => {
    setTabState(urlTab);
  }, [urlTab]);
  const setTab = (next: Tab) => {
    setTabState(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'overview') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };
  const [deployOpen, setDeployOpen] = useState(false);
  const [deployVersion, setDeployVersion] = useState('');
  const [replicas, setReplicas] = useState(2);
  const [selector, setSelector] = useState('role=node');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'activate' | 'disable' | 'uninstall' | 'rollback' | 'enable'>(null);
  const [rollbackVersion, setRollbackVersion] = useState('');
  const versionFieldId = useId();
  const replicasFieldId = useId();
  const selectorFieldId = useId();

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

  // The header keeps its description in the loading and error states too: the page still is what
  // it says it is while the answer is missing or refused.
  if (loading && !data) return <><PageHeader title={t('table.plugin')} /><Skeleton rows={6} /></>;
  if (error) return <><PageHeader title={t('table.plugin')} /><ErrorState error={error} onRetry={() => void reload()} /></>;
  if (!data) return null;

  /**
   * Performs one write, then re-reads the detail and believes only the re-read
   * (lib/verify-after-write.ts). A rejection is deliberately not swallowed here: ConfirmAction
   * keeps its dialog open, prints the failure and offers the same button again - and a write the
   * Kernel accepted that left the state unchanged is reported as a failure with the actual state,
   * never as a success.
   */
  async function perform(options: {
    label: string;
    write: () => Promise<unknown>;
    /** True only when the re-read detail shows what the verb promised. */
    expect: (detail: PluginDetail) => boolean;
    success: string;
    /** Uninstall succeeds by the resource going away; a 404 on re-read proves it. */
    absentIsExpected?: boolean;
  }) {
    setBusy(options.label);
    try {
      const result = await verifyAfterWrite<PluginDetail>({
        write: options.write,
        read: () => api.get<PluginDetail>(`/api/v1/plugins/${encodeURIComponent(id)}`),
        expected: options.expect,
        describe: (detail) => detail.state || 'NO_DATA',
        absentIsExpected: options.absentIsExpected,
      });
      const failure = verifiedWriteFailure(result, t);
      await reload();
      if (failure) throw failure;
      toast.push({ tone: 'ok', title: options.success, detail: verifiedWriteDetail(result, t) });
    } finally {
      setBusy(null);
    }
  }

  async function deploy() {
    try {
      await perform({
        label: 'deploy',
        write: () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/deployments`, {
          version: deployVersion,
          desiredReplicas: replicas,
          nodeSelector: Object.fromEntries(selector.split(',').map((pair) => pair.trim().split('=')).filter((pair) => pair.length === 2)),
          maxInstancesPerNode: 1,
        }),
        // A deployment exists for this version only after the create write landed.
        expect: (detail) => detail.deployments.some((item) => item.version === deployVersion),
        success: t('pluginDetail.toast.deploymentRequested', { version: deployVersion }),
      });
      setDeployOpen(false);
      setTab('deployments');
    } catch (cause) {
      const apiError = cause as ApiError;
      toast.push({ tone: 'danger', title: apiError.code || t('pluginDetail.actionFailed'), detail: apiError.message });
    }
  }

  async function activate(version: string) {
    await perform({
      label: 'activate',
      write: () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/activations`, {
        version,
        expectedRevision: data?.activeRevision?.generation ?? 0,
      }),
      expect: (detail) => detail.activeVersion === version,
      success: t('pluginDetail.toast.activated', { version }),
    });
  }

  async function disable() {
    await perform({
      label: 'disable',
      write: () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/disable`, { reason: 'Disabled from plugin detail' }),
      expect: (detail) => detail.state === 'DISABLED',
      success: t('pluginDetail.toast.disabled'),
    });
  }

  async function enable() {
    await perform({
      label: 'enable',
      write: () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/enable`, {}),
      // Start is a restart request: the Kernel leaves DISABLED behind and stops at STAGED.
      expect: (detail) => detail.state !== 'DISABLED',
      success: t('pluginDetail.toast.redeploymentRequested'),
    });
  }

  async function uninstall() {
    await perform({
      label: 'uninstall',
      write: () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/uninstall`, {}),
      expect: (detail) => detail.state === 'UNINSTALLED',
      success: t('pluginDetail.toast.uninstalled'),
      absentIsExpected: true,
    });
  }

  async function rollback() {
    await perform({
      label: 'rollback',
      write: () => api.post(`/api/v1/plugins/${encodeURIComponent(id)}/rollback`, {
        targetVersion: rollbackVersion,
        expectedRevision: data?.activeRevision?.generation ?? 0,
        desiredReplicas: 2,
      }),
      expect: (detail) => detail.activeVersion === rollbackVersion,
      success: t('pluginDetail.toast.rollbackRequested', { version: rollbackVersion }),
    });
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
        title={<span className="title-with-status">{data.name}{data.isSystem ? <Badge variant="secondary">{t('common.tag.system')}</Badge> : null}</span>}
        meta={
          <div className="detail-meta">
            <InstallationStatus state={data.state} />
            <MetaChip mono value={data.id} />
            {activeVersion
              ? <MetaChip label={t('pluginDetail.effectiveVersion')} value={activeVersion} mono />
              : <StatusIndicator state="notConfigured" label={t('plugins.table.notActivated')} />}
            {data.activeRevision
              ? <MetaChip icon="activity" value={t('pluginDetail.meta.revision', { revision: data.activeRevision.generation })} />
              : <NoData detail={t('ui.noData.detail')} />}
            {data.activeRevision?.activatedAt ? <MetaChip label={t('pluginDetail.meta.activated')} value={<TimeAgo value={data.activeRevision.activatedAt} />} /> : null}
            {data.isSystem ? <MetaChip icon="access" value={t('pluginDetail.hostOwnedRecovery')} /> : null}
          </div>
        }
        actions={<>
          {latestDeployment?.status === 'READY' && latestDeployment.version === activeVersion && <StatusPill status="READY" />}
          {activeVersion && <Button variant="secondary" onClick={() => setConfirm('disable')} disabled={Boolean(busy)}><Icon name="stop" size={15} /> {t('action.disable')}</Button>}
          {!activeVersion && data.state === 'DISABLED' && <Button variant="secondary" onClick={() => setConfirm('enable')} disabled={Boolean(busy)}><Icon name="rotate" size={15} /> {t('action.enable')}</Button>}
          <Button variant="secondary" onClick={() => setTab('versions')}><Icon name="plugins" size={15} /> {t('pluginDetail.tab.versions')}</Button>
        </>}
        primary={readyCandidate
          ? <Button onClick={() => setConfirm('activate')} disabled={Boolean(busy)}><Icon name="play" size={15} /> {t('pluginDetail.action.activateVersion', { version: readyCandidate.version })}</Button>
          : !activeVersion && latestDeployment?.status !== 'READY' && versions[0]
            ? <Button onClick={() => { setDeployVersion(versions[0].version); setDeployOpen(true); }} disabled={Boolean(busy)}><Icon name="play" size={15} /> {t('action.deploy')}</Button>
            : undefined}
      />

      {/* Tabs is controlled on the existing `tab` state, so the deploy flow can still land on
          "deployments"; Radix owns role=tablist/tab, aria-selected, the roving tabindex and the
          arrow/Home/End keys, and unmounts the inactive panels exactly like the old `&&` blocks. */}
      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList className="h-auto w-full justify-start overflow-x-auto">
          {tabs.map((item) => (
            <TabsTrigger key={item.id} value={item.id}>
              {item.label}
              {item.count !== undefined ? <span className="ml-[5px] rounded-full border border-solid border-border bg-muted px-1.5 py-px text-[10px] text-muted-foreground">{item.count}</span> : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="mt-[18px] flex flex-col gap-[18px]">
          <div className="summary-grid plugin-detail-grid">
            <section className="panel">
              <div className="panel-head"><div><h2>{t('pluginDetail.effectiveState.title')}</h2><p>{t('pluginDetail.effectiveState.description')}</p></div></div>
              {/* A fact the API did not answer prints NO_DATA: a revision of 0 and a replica count
                  of 0 would be numbers the Kernel never said. */}
              <div className="kv-grid">
                {/* Was `{data.state}`, which printed INSTALLED in English next to a header chip
                    that said "Installed" in the reader's language. The state word comes from the
                    one derivation, so the header and this row cannot disagree. */}
                <KV label={t('pluginDetail.field.installation')}><InstallationStatus state={data.state} /></KV>
                <KV label={t('pluginDetail.field.activeVersion')}>{activeVersion || t('pluginDetail.none')}</KV>
                <KV label={t('pluginDetail.field.activeRevision')}>{data.activeRevision ? data.activeRevision.generation : <NoData detail={t('ui.noData.detail')} />}</KV>
                <KV label={t('field.desiredReplicas')}>{activeDeployment?.desiredReplicas ?? latestDeployment?.desiredReplicas ?? <NoData detail={t('ui.noData.detail')} />}</KV>
                <KV label={t('common.readyInstances')}>{activeDeployment ? `${activeDeployment.readyInstances}/${activeDeployment.totalInstances}` : t('pluginDetail.noActiveDeployment')}</KV>
                <KV label={t('pluginDetail.field.deploymentStatus')}>{activeDeployment ? <StatusPill status={activeDeployment.status} /> : <NoData detail={t('pluginDetail.noActiveDeployment')} />}</KV>
              </div>
              {activeDeployment && <Progress value={activeDeployment.readyInstances} max={Math.max(activeDeployment.desiredReplicas, 1)} label={t('pluginDetail.readyReplicas')} />}
            </section>
            <section className="panel">
              <div className="panel-head"><div><h2>{t('pluginDetail.artifactTrust.title')}</h2><p>{t('pluginDetail.artifactTrust.description')}</p></div></div>
              {trustVersion ? (
                <div className="kv-grid">
                  <KV label={t('table.publisher')}>{data.publisher || <NoData detail={t('ui.noData.detail')} />}</KV>
                  <KV label={t('table.signature')}><StatusPill status={trustVersion.signatureState} /></KV>
                  {/* A hash and its copy control are one row: the hash truncates, the control
                      never moves, and neither wraps onto a second line. */}
                  <KV label={t('pluginDetail.field.image')} mono><span className="kv-hash">{trustVersion.imageRef ? shortDigest(trustVersion.imageRef, 22) : <NoData detail={t('ui.noData.detail')} />}</span> <CopyButton value={trustVersion.imageRef} /></KV>
                  <KV label={t('pluginDetail.field.bundle')} mono><span className="kv-hash">{trustVersion.bundleDigest ? shortDigest(trustVersion.bundleDigest, 22) : <NoData detail={t('ui.noData.detail')} />}</span> <CopyButton value={trustVersion.bundleDigest} /></KV>
                  <KV label={t('pluginDetail.field.artifact')} mono><span className="kv-hash">{trustVersion.artifactDigest ? shortDigest(trustVersion.artifactDigest, 22) : <NoData detail={t('ui.noData.detail')} />}</span> <CopyButton value={trustVersion.artifactDigest} /></KV>
                  <KV label={t('table.published')}>{trustVersion.createdAt ? formatDate(trustVersion.createdAt) : <NoData detail={t('ui.noData.detail')} />}</KV>
                </div>
              ) : <EmptyState icon="file" title={t('pluginDetail.empty.systemPlugin.title')} description={t('pluginDetail.empty.systemPlugin.description')} />}
            </section>
            <section className="panel">
              <div className="panel-head"><div><h2>{t('table.instances')}</h2></div>{activeDeployment && <Link className="text-link" data-testid="plugin-detail-deployments-link" to={`/admin/plugins/${data.id}?tab=deployments`}>{t('pluginDetail.instances.deploymentDetail')} <Icon name="arrowRight" size={14} /></Link>}</div>
              <div className="instance-compact">
                <InstanceTable instances={activeDeployment?.instances || []} />
              </div>
            </section>
          </div>
        </TabsContent>

        <TabsContent value="versions" className="mt-[18px]">
          <section className="panel table-panel">
            <div className="panel-head"><div><h2>{t('pluginDetail.versions.title')}</h2><p>{t('pluginDetail.versions.description')}</p></div><Button variant="secondary" onClick={() => setDeployOpen(true)}><Icon name="plus" size={15} /> {t('pluginDetail.versions.deploy')}</Button></div>
            {versions.length === 0 ? <EmptyState icon="file" title={t('pluginDetail.versions.empty.title')} description={t('pluginDetail.versions.empty.description')} /> : (
              <Table className={stackTable}>
                <TableHeader className={stackHead}>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('table.version')}</TableHead>
                    <TableHead>{t('table.status')}</TableHead>
                    <TableHead>{t('table.signature')}</TableHead>
                    <TableHead>{t('table.imageDigest')}</TableHead>
                    <TableHead>{t('table.published')}</TableHead>
                    <TableHead>{t('table.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className={stackBody}>
                  {versions.map((version) => {
                    const deployment = data.deployments.find((item) => item.version === version.version);
                    return (
                      <TableRow key={version.version} className={stackRow}>
                        <StackCell label={t('table.version')}><strong className="mono">{version.version}</strong>{version.version === activeVersion && <Badge variant="success">{t('common.tag.active')}</Badge>}</StackCell>
                        <StackCell label={t('table.status')}><StatusPill status={version.status} /></StackCell>
                        <StackCell label={t('table.signature')}><StatusPill status={version.signatureState} /></StackCell>
                        <StackCell label={t('table.imageDigest')}>{version.imageRef ? <span className="mono text-sm">{shortDigest(version.imageRef, 18)}</span> : <NoData detail={t('ui.noData.detail')} />}<CopyButton value={version.imageRef} /></StackCell>
                        <StackCell label={t('table.published')}><TimeAgo value={version.createdAt} /></StackCell>
                        <StackCell label={t('table.actions')} className="max-[768px]:flex-wrap">
                          {deployment?.status === 'READY' && deployment.version !== activeVersion && <Button size="sm" onClick={() => { setRollbackVersion(version.version); setConfirm('activate'); }}>{t('action.activate')}</Button>}
                          {(!deployment || ['DISABLED', 'DEGRADED', 'FAILED'].includes(deployment.status)) && version.version !== activeVersion && <Button variant="outline" size="sm" onClick={() => { setDeployVersion(version.version); setDeployOpen(true); }}>{deployment ? t('action.redeploy') : t('action.deploy')}</Button>}
                          {deployment?.status === 'READY' && deployment.version !== activeVersion && <Button variant="outline" size="sm" onClick={() => { setRollbackVersion(version.version); setConfirm('rollback'); }}>{t('action.rollback')}</Button>}
                          {deployment && <StatusPill status={deployment.status} />}
                        </StackCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </section>
        </TabsContent>

        <TabsContent value="deployments" className="mt-[18px]">
          <div className="stack-list">
            {data.deployments.length === 0 ? <EmptyState icon="plugins" title={t('pluginDetail.deployments.empty.title')} description={t('pluginDetail.deployments.empty.description')} action={<Button onClick={() => setDeployOpen(true)}>{t('pluginDetail.versions.deploy')}</Button>} /> : data.deployments.map((deployment) => (
              <DeploymentCard key={deployment.id} deployment={deployment} active={deployment.version === activeVersion} onActivate={() => { setRollbackVersion(deployment.version); setConfirm('activate'); }} onRollback={() => { setRollbackVersion(deployment.version); setConfirm('rollback'); }} />
            ))}
          </div>
        </TabsContent>

        <TabsContent value="capabilities" className="mt-[18px]">
          <div className="summary-grid">
            <section className="panel"><div className="panel-head"><div><h2>{t('pluginDetail.capabilities.provides')}</h2><p>{t('pluginDetail.capabilities.provides.description')}</p></div></div>{data.provides.length ? <ul className="capability-list">{data.provides.map((capability) => <li key={capability.name}><code>{capability.name}</code><span>v{capability.major}</span></li>)}</ul> : <EmptyState icon="plugins" title={t('pluginDetail.capabilities.provides.empty')} />}</section>
            <section className="panel"><div className="panel-head"><div><h2>{t('pluginDetail.capabilities.requires')}</h2><p>{t('pluginDetail.capabilities.requires.description')}</p></div></div>{data.requires.length ? <ul className="capability-list">{data.requires.map((capability) => <li key={capability.name}><code>{capability.name}</code><span>v{capability.major}</span></li>)}</ul> : <EmptyState icon="check" title={t('pluginDetail.capabilities.requires.empty')} />}</section>
          </div>
        </TabsContent>

        <TabsContent value="permissions" className="mt-[18px]">
          <section className="panel"><div className="panel-head"><div><h2>{t('common.requestedPermissions')}</h2><p>{t('pluginDetail.permissions.description')}</p></div></div>
            {data.permissions.length ? <ul className="permission-list">{data.permissions.map((permission) => <li key={permission}><Icon name="key" size={15} /><code>{permission}</code><span className="text-muted-foreground">{t('pluginDetail.permissions.declared')}</span></li>)}</ul> : <EmptyState icon="access" title={t('pluginDetail.permissions.empty')} />}
            <div className="callout"><Icon name="alert" size={16} /><p>{t('pluginDetail.permissions.note')}</p></div>
          </section>
        </TabsContent>

        <TabsContent value="events" className="mt-[18px]">
          <section className="panel table-panel">
            <div className="panel-head"><div><h2>{t('pluginDetail.events.title')}</h2><p>{t('pluginDetail.events.description')}</p></div><Link className="text-link" to="/admin/activity">{t('pluginDetail.events.global')} <Icon name="arrowRight" size={14} /></Link></div>
            {events.length === 0 ? <EmptyState icon="activity" title={t('overview.events.empty.title')} /> : (
              <Table className={stackTable}>
                <TableHeader className={stackHead}>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>{t('table.event')}</TableHead>
                    <TableHead>{t('table.result')}</TableHead>
                    <TableHead>{t('table.actor')}</TableHead>
                    <TableHead>{t('table.when')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className={stackBody}>
                  {events.map((event) => (
                    <TableRow key={event.id} className={stackRow}>
                      <StackCell label={t('table.event')}><strong>{event.eventType}</strong><div className="text-sm text-muted-foreground">{event.action}</div></StackCell>
                      <StackCell label={t('table.result')}><StatusPill status={event.result} /></StackCell>
                      <StackCell label={t('table.actor')}><span className="mono text-sm">{event.actorType}:{event.actorId.slice(0, 8)}</span></StackCell>
                      <StackCell label={t('table.when')}><TimeAgo value={event.occurredAt} /></StackCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </TabsContent>
      </Tabs>

      <Dialog open={deployOpen} onOpenChange={setDeployOpen}>
        <DialogContent closeLabel={t('aria.closeDialog')} aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{t('pluginDetail.deployModal.title', { name: data.name })}</DialogTitle></DialogHeader>
          <div className="form-stack">
            <FormField label={t('table.version')} hint={t('pluginDetail.deployModal.versionHint')} htmlFor={versionFieldId}>
              <select id={versionFieldId} value={deployVersion} onChange={(event) => setDeployVersion(event.target.value)}>
                {versions.map((version) => <option key={version.version} value={version.version}>{version.version} ({statusText(version.status)})</option>)}
              </select>
            </FormField>
            <div className="form-grid">
              <FormField label={t('field.desiredReplicas')} htmlFor={replicasFieldId}><Input id={replicasFieldId} type="number" min={0} max={20} value={replicas} onChange={(event) => setReplicas(Number(event.target.value))} /></FormField>
              <FormField label={t('field.nodeSelector')} hint={t('pluginDetail.deployModal.selectorHint')} htmlFor={selectorFieldId}><Input id={selectorFieldId} value={selector} onChange={(event) => setSelector(event.target.value)} placeholder="role=node,zone=lab" /></FormField>
            </div>
            <div className="callout"><Icon name="alert" size={16} /><p>{t('pluginDetail.deployModal.note')}</p></div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeployOpen(false)}>{t('action.cancel')}</Button>
            <Button onClick={() => void deploy()} disabled={busy === 'deploy'}>{busy === 'deploy' ? t('pluginDetail.deployModal.requesting') : t('action.deploy')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Uninstall, rollback, disable and activation are the irreversible or privilege-changing
          actions of this page: each one goes through the shared ConfirmAction, which disables its
          submit while the request is in flight and keeps the failure on the dialog. */}
      <ConfirmAction
        open={confirm === 'activate'}
        title={t('pluginDetail.confirmActivate.title', { version: rollbackVersion || readyCandidate?.version || '' })}
        description={<>{t('pluginDetail.confirmActivate.before')} <strong>{data.name}</strong>{t('pluginDetail.confirmActivate.after')}</>}
        confirmLabel={t('pluginDetail.confirmActivate.confirm')}
        danger={false}
        onConfirm={() => activate(rollbackVersion || readyCandidate?.version || '')}
        onClose={() => setConfirm(null)}
      />
      <ConfirmAction
        open={confirm === 'disable'}
        title={t('pluginDetail.confirmDisable.title', { name: data.name })}
        description={<>{t('pluginDetail.confirmDisable.before')} <code>CAPABILITY_UNAVAILABLE</code>{t('pluginDetail.confirmDisable.after')}</>}
        confirmLabel={t('pluginDetail.confirmDisable.confirm')}
        onConfirm={() => disable()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmAction
        open={confirm === 'enable'}
        title={t('pluginDetail.confirmEnable.title', { name: data.name })}
        description={t('pluginDetail.confirmEnable.description')}
        confirmLabel={t('pluginDetail.confirmEnable.confirm')}
        danger={false}
        onConfirm={() => enable()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmAction
        open={confirm === 'uninstall'}
        title={t('pluginDetail.confirmUninstall.title', { name: data.name })}
        description={<>{t('pluginDetail.confirmUninstall.before')} <strong>{t('pluginDetail.confirmUninstall.retained')}</strong>{t('pluginDetail.confirmUninstall.after')}</>}
        confirmLabel={t('action.uninstall')}
        onConfirm={() => uninstall()}
        onClose={() => setConfirm(null)}
      />
      <ConfirmAction
        open={confirm === 'rollback'}
        title={t('pluginDetail.confirmRollback.title', { version: rollbackVersion })}
        description={t('pluginDetail.confirmRollback.description')}
        confirmLabel={t('pluginDetail.confirmRollback.confirm')}
        onConfirm={() => rollback()}
        onClose={() => setConfirm(null)}
      />
      {!activeVersion && data.state === 'INSTALLED' && <div className="sticky-note"><Icon name="alert" size={15} /> {t('pluginDetail.stickyNote')}</div>}
    </div>
  );
}

function InstanceTable({ instances }: { instances: PluginDetail['deployments'][number]['instances'] }) {
  const t = useT();
  const { locale } = useI18n();
  if (!instances.length) return <EmptyState icon="nodes" title={t('pluginDetail.instances.empty.title')} description={t('pluginDetail.instances.empty.description')} />;
  /**
   * table-spec §2.5: the three facts the 390 card keeps, ranked by §2.2's distinct ratio. The log
   * link is the card's verb, not a fourth fact - it rides the identity line at 390, so the card
   * stays a way into the logs instead of a dead end.
   */
  const cardFacts = rankCardFacts({
    slot: instances.map((instance) => '#' + instance.slot),
    state: instances.map((instance) => instance.state),
    container: instances.map((instance) => (instance.containerId ? instance.containerId.slice(0, 12) : '')),
  });
  return (
    <Table className={stackTable}>
      <TableHeader className={stackHead}>
        <TableRow className="hover:bg-transparent">
          <TableHead>{t('table.node')}</TableHead>
          <TableHead>{t('table.slot')}</TableHead>
          <TableHead>{t('table.state')}</TableHead>
          <TableHead>{t('table.container')}</TableHead>
          <TableHead>{t('table.logs')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className={stackBody}>{instances.map((instance) => (
        <TableRow key={instance.id} className={stackRow}>
          <IdentityCell label={t('table.node')} identity={formatIdentity({ name: instance.nodeName || instance.nodeId.slice(0, 8), id: instance.nodeId, at: instance.observedAt, locale, rowsOnPage: instances.length })} cardFact>
            <span>{instance.nodeStatus}</span>
            <span>{t('table.restarts')} {instance.restartCount}</span>
          </IdentityCell>
          <StackCell label={t('table.slot')} className={cardCellClass(cardFacts.includes('slot'))}><span className="mono">#{instance.slot}</span></StackCell>
          <StackCell label={t('table.state')} className={cardCellClass(cardFacts.includes('state'))}><StatusPill status={instance.state} />{instance.lastError && <div className="inline-hint text-danger">{instance.lastError}</div>}</StackCell>
          <StackCell label={t('table.container')} className={cardCellClass(cardFacts.includes('container'))}>{instance.containerId ? <span className="mono text-sm">{instance.containerId.slice(0, 12)}</span> : <NoData detail={t('ui.noData.detail')} />}</StackCell>
          <TableCell className={cardActionCell}><Link className="text-link" to={`/admin/instances/${instance.id}/logs`}><Icon name="logs" size={14} /> {t('table.live')}</Link></TableCell>
        </TableRow>
      ))}</TableBody>
    </Table>
  );
}

function DeploymentCard({ deployment, active, onActivate, onRollback }: { deployment: DeploymentView; active: boolean; onActivate(): void; onRollback(): void }) {
  const t = useT();
  const reason = describePlacementReason(deployment.statusReason, t);
  return (
    <section className={`panel deployment-card ${active ? 'deployment-active' : ''}`}>
      <div className="panel-head">
        <div className="deployment-title"><h2 className="mono">{deployment.version}</h2><StatusPill status={deployment.status} />{active && <Badge variant="success">{t('common.tag.effective')}</Badge>}</div>
        <div className="page-actions">
          {deployment.status === 'READY' && !active && <Button size="sm" onClick={onActivate}>{t('action.activate')}</Button>}
          {deployment.status === 'READY' && active && <Button variant="outline" size="sm" onClick={onRollback}>{t('action.rollback')}</Button>}
        </div>
      </div>
      <div className="kv-grid deployment-kv">
        <KV label={t('pluginDetail.deployment.fieldId')} mono>{deployment.id.slice(0, 13)}…</KV>
        <KV label={t('table.generation')}>{deployment.generation}</KV>
        <KV label={t('status.ready')}>{deployment.readyInstances}/{deployment.desiredReplicas}</KV>
        <KV label={t('pluginDetail.deployment.cpuMemory')}>{deployment.resources
          ? <span className="mono">{deployment.resources.cpuMillis} mCPU / {deployment.resources.memoryMiB > 0 ? formatBytes(deployment.resources.memoryMiB * 1024 * 1024) : <NoData detail={t('ui.noData.detail')} />}</span>
          : <NoData detail={t('ui.noData.detail')} />}</KV>
        <KV label={t('table.created')}>{deployment.createdAt ? formatDate(deployment.createdAt) : <NoData detail={t('ui.noData.detail')} />}</KV>
        <KV label={t('pluginDetail.deployment.fieldReason')}>{reason?.title ?? <NoData detail={t('ui.noData.detail')} />}</KV>
      </div>
      {reason && <div className="callout"><Icon name="alert" size={15} /><p>{reason.title}</p></div>}
      {reason?.raw && <details className="advanced"><summary>{t('placement.reason.raw')}</summary><p className="mono small">{reason.raw}</p></details>}
      <InstanceTable instances={deployment.instances} />
    </section>
  );
}
