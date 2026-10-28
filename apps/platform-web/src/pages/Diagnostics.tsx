import React, { useState } from 'react';
import { api } from '../api';
import type { Diagnostics } from '../types';
import { Icon } from '../components/Icons';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { CopyButton, EmptyState, KV, TimeAgo } from '../components/Ui';
import { AsyncBoundary, NoticeBar, isStale, useObservedPolling } from '../components/app/async-boundary';
import { PageHeader } from '../components/app/page-header';
import { NoData, UnknownValue } from '../components/app/status-indicator';
import { STATUS_MAP, badgeVariantForTone, glyphForTone } from '../components/status-tone';
import { formatDuration } from '../format';
import { useI18n, useT } from '../i18n';
import { StackCell, StatusPill, stackBody, stackHead, stackRow, stackTable } from './table-kit';

const commands = `opsctl status
opsctl doctor
opsctl nodes
opsctl plugins
opsctl plugin disable <plugin-id>`;

/** The page polls at this cadence, which is also the window `isStale` measures against. */
const POLL_INTERVAL_MS = 8000;

/**
 * The kernel reports its database state as protocol data ("connected" is not a status code this
 * shell maps), and this page has always printed that wire value verbatim. Only the tone comes
 * from STATUS_MAP, so the pill is painted here instead of through StatusPill, which localizes.
 */
function DatabasePill({ database }: { database: string }) {
  const code = database === 'connected' ? 'READY' : 'FAILED';
  const tone = STATUS_MAP[code].tone;
  return (
    <Badge variant={badgeVariantForTone(tone)} data-status={code}>
      <Icon name={glyphForTone(tone)} size={12} />
      {database}
    </Badge>
  );
}

export function DiagnosticsPage() {
  const t = useT();
  const { formatDateTime } = useI18n();
  const { data, error, loading, reload, observedAt } = useObservedPolling(() => api.get<Diagnostics>('/api/v1/diagnostics'), POLL_INTERVAL_MS);
  const [raw, setRaw] = useState(false);
  const stale = isStale(observedAt, POLL_INTERVAL_MS) || Boolean(error && data);
  const nodes = data?.nodes ?? [];
  const events = data?.recentEvents ?? [];
  const policies = data ? Object.entries(data.policies ?? {}) : [];

  return (
    <div className="page-stack">
      {/* One header for every state: the loading and error branches used to repeat it. */}
      <PageHeader
        eyebrow={t('diagnostics.eyebrow')}
        title={t('page.diagnostics')}
        description={t('diagnostics.description')}
        actions={data ? <><Button variant="secondary" onClick={() => setRaw(!raw)}>{raw ? t('diagnostics.action.visualView') : t('diagnostics.action.rawJson')}</Button><Button variant="secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button></> : undefined}
      />
      {stale ? (
        <div data-observed-at={observedAt ?? undefined}>
          <NoticeBar
            state="stale"
            title={t('ui.stale.title')}
            detail={t('ui.stale.detail', { at: observedAt ? formatDateTime(observedAt) : t('ui.notObserved') })}
            action={<Button variant="secondary" size="sm" onClick={() => void reload()}><Icon name="refresh" size={14} /> {t('action.refresh')}</Button>}
          />
        </div>
      ) : null}
      <AsyncBoundary
        loading={loading}
        // A retained observation outranks a failed refresh: the strip stays readable and the
        // notice above says when it was seen, instead of a wall replacing the whole page.
        error={data ? null : error}
        hasData={Boolean(data)}
        skeletonRows={6}
        onRetry={() => void reload()}
      >
        {data ? (
          <>
            <section className="health-strip">
              <div className="health-strip-item"><span className="health-strip-label">{t('diagnostics.kernel')}</span><strong>{data.kernel.version || <UnknownValue detail={t('ui.unknown.detail')} />}</strong><span className="muted">API v{Number.isFinite(data.kernel.apiMajor) ? data.kernel.apiMajor : <UnknownValue detail={t('ui.unknown.detail')} />}</span></div>
              <div className="health-strip-item"><span className="health-strip-label">{t('diagnostics.field.database')}</span>{data.kernel.database ? <DatabasePill database={data.kernel.database} /> : <UnknownValue detail={t('ui.unknown.detail')} />}</div>
              <div className="health-strip-item"><span className="health-strip-label">{t('diagnostics.uptime')}</span><strong>{Number.isFinite(data.kernel.uptimeSeconds) ? formatDuration(data.kernel.uptimeSeconds) : <UnknownValue detail={t('ui.unknown.detail')} />}</strong></div>
              <div className="health-strip-item"><span className="health-strip-label">{t('diagnostics.packages')}</span><strong>{Number.isFinite(data.counts?.packages) ? data.counts.packages : <UnknownValue detail={t('ui.unknown.detail')} />}</strong></div>
              <div className="health-strip-item"><span className="health-strip-label">{t('common.readyInstances')}</span><strong>{Number.isFinite(data.counts?.readyInstances) ? data.counts.readyInstances : <UnknownValue detail={t('ui.unknown.detail')} />}</strong></div>
              <div className="health-strip-item"><span className="health-strip-label">{t('common.deployments')}</span><strong>{Number.isFinite(data.counts?.deployments) ? data.counts.deployments : <UnknownValue detail={t('ui.unknown.detail')} />}</strong></div>
            </section>
            {raw ? <section className="panel"><div className="panel-head"><div><h2>{t('diagnostics.raw.title')}</h2><p>{t('diagnostics.raw.description')}</p></div></div><pre className="json-view">{JSON.stringify(data, null, 2)}</pre></section> : (
              <>
                <div className="summary-grid">
                  <section className="panel">
                    <div className="panel-head"><div><h2>{t('diagnostics.facts.title')}</h2><p>{t('diagnostics.facts.description')}</p></div><CopyButton value={JSON.stringify(data)} label={t('diagnostics.copy')} /></div>
                    <div className="kv-grid">
                      <KV label={t('table.version')}>{data.kernel.version || <UnknownValue detail={t('ui.unknown.detail')} />}</KV>
                      <KV label={t('diagnostics.field.apiMajor')}>{Number.isFinite(data.kernel.apiMajor) ? data.kernel.apiMajor : <UnknownValue detail={t('ui.unknown.detail')} />}</KV>
                      <KV label={t('common.runtimeProtocol')} mono>{data.kernel.runtimeProtocol || <UnknownValue detail={t('ui.unknown.detail')} />}</KV>
                      <KV label={t('diagnostics.field.database')}>{data.kernel.database || <UnknownValue detail={t('ui.unknown.detail')} />}</KV>
                      <KV label={t('diagnostics.field.dataDir')} mono>{data.kernel.dataDir || <UnknownValue detail={t('ui.unknown.detail')} />}</KV>
                      <KV label={t('diagnostics.field.webDist')} mono>{data.kernel.webDist || <UnknownValue detail={t('ui.unknown.detail')} />}</KV>
                    </div>
                  </section>
                  <section className="panel">
                    <div className="panel-head"><div><h2>{t('diagnostics.commands.title')}</h2><p>{t('diagnostics.commands.description')}</p></div></div>
                    <div className="command-block"><pre>{commands}</pre><CopyButton value={commands} /></div>
                    <div className="callout"><Icon name="terminal" size={16} /><p>{data.bootstrap?.note || t('diagnostics.bootstrap.noteMissing')}</p></div>
                  </section>
                </div>
                <section className="panel table-panel"><div className="panel-head"><div><h2>{t('diagnostics.nodes.title')}</h2><p>{t('diagnostics.nodes.description')}</p></div></div>
                  {nodes.length === 0 ? <EmptyState icon="nodes" title={t('diagnostics.nodes.empty')} /> : (
                    <Table className={stackTable}>
                      <TableHeader className={stackHead}>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>{t('table.node')}</TableHead>
                          <TableHead>{t('table.status')}</TableHead>
                          <TableHead>{t('table.lastObserved')}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody className={stackBody}>
                        {nodes.map((node) => (
                          <TableRow key={node.id} className={stackRow}>
                            <StackCell label={t('table.node')}><strong>{node.name}</strong><div className="mono text-sm">{node.id}</div></StackCell>
                            <StackCell label={t('table.status')}><StatusPill status={node.status} /></StackCell>
                            {/* No recorded heartbeat is NO_DATA, not "never" and not a blank cell. */}
                            <StackCell label={t('table.lastObserved')}>{node.lastSeenAt ? <TimeAgo value={node.lastSeenAt} /> : <NoData detail={t('ui.noData.detail')} />}</StackCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </section>
                <section className="panel"><div className="panel-head"><div><h2>{t('common.runtimePolicies')}</h2><p>{t('diagnostics.policies.description')}</p></div></div>{policies.length === 0 ? <EmptyState icon="settings" title={t('diagnostics.policies.empty')} /> : <div className="kv-grid">{policies.map(([key, value]) => <KV key={key} label={key}>{value}</KV>)}</div>}</section>
                <section className="panel"><div className="panel-head"><div><h2>{t('diagnostics.audit.title')}</h2><p>{t('diagnostics.audit.description')}</p></div></div>{events.length === 0 ? <EmptyState icon="activity" title={t('diagnostics.audit.empty')} /> : (
                  <ul className="event-list">{events.map((event) => <li key={event.id}><div className="event-marker"><Icon name={event.result === 'REJECTED' ? 'warning' : 'check'} size={13} /></div><div className="event-copy"><div className="event-title"><strong>{event.eventType}</strong><StatusPill status={event.result} /></div><p>{event.subjectType} <span className="mono">{event.subjectId}</span></p></div><TimeAgo value={event.occurredAt} /></li>)}</ul>
                )}</section>
              </>
            )}
          </>
        ) : null}
      </AsyncBoundary>
    </div>
  );
}
