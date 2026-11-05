import * as React from 'react';
import { api } from '../api';
import { Modal } from '../components/Ui';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Status } from '../components/app/status';
import { badgeVariantForTone } from '../components/status-tone';
import { ageMessage } from '../lib/age';
import { useT, type Locale } from '../i18n';

/**
 * G13-A: collect real telemetry from a registered source and save it as evidence.
 *
 * Two steps that the reader must be able to tell apart:
 *   1. collect  - the plugin talks to Zabbix and returns an observation;
 *   2. save     - the Kernel verifies the plugin's attestation and stores the bytes.
 *
 * The state machine is exported and unit-tested because the expensive failures here
 * are state confusions, not styling: a TIMEOUT shown as EMPTY, a PARTIAL shown as OK,
 * or a submit that looked saved because the dialog closed.
 */

const PLUGIN_ID = 'opsweave.zabbix-source';
const PLUGIN_BASE = '/api/zabbix-source';
const ITEM_LIMIT = 20;
const STALE_AFTER_MS = 15 * 60 * 1000;

export type CollectSourceStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'forbidden' | 'unavailable';

export interface CollectSource {
  sourceId: string;
  workspaceId: string;
  name: string;
  endpoint: string;
  status: string;
  lastProbe?: { outcome: string; observedAt: string };
  budget?: Record<string, number>;
}

export interface CollectHost {
  hostId: string;
  name: string;
  available: 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';
}

export interface CollectItem {
  itemId: string;
  key: string;
  name?: string;
  unit?: string | null;
  valueType: 'FLOAT' | 'INTEGER' | 'TEXT' | 'UNSUPPORTED';
}

export interface CollectSeries {
  itemId: string;
  outcome: string;
  samples: { occurredAt: string; value: number | null; absenceReason?: string | null }[];
}

export interface CollectSnapshot {
  maxBytes: number;
  originalBytes: number;
  truncated: boolean;
  reason: string;
  requestedSamples: number;
  returnedSamples: number;
  droppedSeries: number;
}

export interface CollectionResult {
  collectionId: string;
  sourceId: string;
  outcome: 'OK' | 'EMPTY' | 'NO_DATA' | 'PARTIAL' | 'UNKNOWN' | 'UNAVAILABLE' | 'TIMEOUT';
  requestedItems: number;
  answeredItems: number;
  clamped: string[];
  series: CollectSeries[];
  observedAt: string;
  errorCode?: string | null;
  contentRef: string;
  snapshot?: CollectSnapshot;
}

interface AttestationResponse {
  evidence: {
    kind: string;
    source: string;
    collectedAt: string;
    contentRef: string;
    content: { contentType: string; body: string };
    attestation: { adapterId: string; issuedAt: string; signature: string };
  };
  outcome: string;
}

export type CollectState =
  | 'initial'
  | 'loading'
  | 'ready'
  | 'empty'
  | 'noData'
  | 'partial'
  | 'timeout'
  | 'unavailable'
  | 'forbidden'
  | 'stale'
  | 'submitPending'
  | 'submitConflict'
  | 'saved'
  | 'cancelled';

export interface CollectStateInput {
  sourceStatus: CollectSourceStatus;
  collection: CollectionResult | null;
  submit: 'idle' | 'pending' | 'conflict' | 'saved';
  cancelled: boolean;
  now: number;
}

function isStale(observedAt: string, now: number): boolean {
  const at = Date.parse(observedAt);
  return Number.isFinite(at) && now - at > STALE_AFTER_MS;
}

/** One derivation, used by both the renderer and the tests. */
export function collectState(input: CollectStateInput): CollectState {
  if (input.cancelled) return 'cancelled';
  if (input.submit === 'saved') return 'saved';
  if (input.submit === 'conflict') return 'submitConflict';
  if (input.submit === 'pending') return 'submitPending';
  if (input.sourceStatus === 'forbidden') return 'forbidden';
  if (input.sourceStatus === 'loading') return 'loading';
  if (input.sourceStatus === 'unavailable') return 'unavailable';
  if (input.sourceStatus === 'empty') return 'empty';
  if (input.collection) {
    if (input.collection.outcome === 'UNAVAILABLE') return 'unavailable';
    if (input.collection.outcome === 'TIMEOUT') return 'timeout';
    if (input.collection.outcome === 'UNKNOWN') return 'unavailable';
    if (input.collection.outcome === 'NO_DATA') return 'noData';
    if (input.collection.outcome === 'EMPTY') return 'empty';
    if (input.collection.outcome === 'PARTIAL') return 'partial';
    if (isStale(input.collection.observedAt, input.now)) return 'stale';
    return 'ready';
  }
  return input.sourceStatus === 'ready' ? 'initial' : 'initial';
}

/** A collection that produced an observation may be filed; one that produced no
 *  answer (timeout, unavailable, unknown) may not be dressed as evidence. */
export function canSave(collection: CollectionResult | null): boolean {
  return Boolean(
    collection &&
      ['OK', 'EMPTY', 'NO_DATA', 'PARTIAL'].includes(collection.outcome),
  );
}

function sampleCount(result: CollectionResult): number {
  return result.series.reduce((sum, series) => sum + series.samples.length, 0);
}

function windowFrom(preset: string): { from: string; to: string } {
  const hours = preset === '24h' ? 24 : preset === '6h' ? 6 : 1;
  const to = new Date();
  const from = new Date(to.getTime() - hours * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function errorCodeOf(error: unknown): { status?: number; code?: string } {
  if (error && typeof error === 'object') {
    const value = error as { status?: number; code?: string };
    return { status: value.status, code: value.code };
  }
  return {};
}

export function CollectEvidenceDialog({
  open,
  incidentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  incidentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const locale: Locale = document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en';
  const [sourceStatus, setSourceStatus] = React.useState<CollectSourceStatus>('idle');
  const [sources, setSources] = React.useState<CollectSource[]>([]);
  const [sourceId, setSourceId] = React.useState('');
  const [hosts, setHosts] = React.useState<CollectHost[]>([]);
  const [hostsLoading, setHostsLoading] = React.useState(false);
  const [hostId, setHostId] = React.useState('');
  const [items, setItems] = React.useState<CollectItem[]>([]);
  const [itemsLoading, setItemsLoading] = React.useState(false);
  const [selectedItems, setSelectedItems] = React.useState<string[]>([]);
  const [windowPreset, setWindowPreset] = React.useState('1h');
  const [collection, setCollection] = React.useState<CollectionResult | null>(null);
  const [collecting, setCollecting] = React.useState(false);
  const [submit, setSubmit] = React.useState<'idle' | 'pending' | 'conflict' | 'saved'>('idle');
  const [cancelled, setCancelled] = React.useState(false);
  const [errorText, setErrorText] = React.useState('');
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    if (!open) return;
    setCancelled(false);
    setSubmit('idle');
    setCollection(null);
    setErrorText('');
    setSelectedItems([]);
    setHostId('');
    setHosts([]);
    setItems([]);
    setSourceId('');
    setSourceStatus('loading');
    let live = true;
    api.gatewayGet<{ items: CollectSource[] }>(PLUGIN_ID, `${PLUGIN_BASE}/sources`)
      .then((result) => {
        if (!live) return;
        setSources(result.items ?? []);
        setSourceStatus((result.items ?? []).length === 0 ? 'empty' : 'ready');
      })
      .catch((error: unknown) => {
        if (!live) return;
        const { status } = errorCodeOf(error);
        setSourceStatus(status === 403 ? 'forbidden' : 'unavailable');
      });
    return () => { live = false; };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  React.useEffect(() => {
    if (!sourceId) return;
    let live = true;
    setHostsLoading(true);
    setHosts([]);
    setHostId('');
    setItems([]);
    setSelectedItems([]);
    api.gatewayGet<{ items: CollectHost[] }>(PLUGIN_ID, `${PLUGIN_BASE}/sources/${sourceId}/hosts`)
      .then((result) => { if (live) setHosts(result.items ?? []); })
      .catch(() => { if (live) setHosts([]); })
      .finally(() => { if (live) setHostsLoading(false); });
    return () => { live = false; };
  }, [sourceId]);

  React.useEffect(() => {
    if (!sourceId || !hostId) return;
    let live = true;
    setItemsLoading(true);
    setItems([]);
    setSelectedItems([]);
    api.gatewayGet<{ items: CollectItem[] }>(PLUGIN_ID, `${PLUGIN_BASE}/sources/${sourceId}/items?hostId=${encodeURIComponent(hostId)}`)
      .then((result) => { if (live) setItems(result.items ?? []); })
      .catch(() => { if (live) setItems([]); })
      .finally(() => { if (live) setItemsLoading(false); });
    return () => { live = false; };
  }, [sourceId, hostId]);

  const state = collectState({ sourceStatus, collection, submit, cancelled, now });
  const selectedSource = sources.find((source) => source.sourceId === sourceId) ?? null;

  const toggleItem = (itemId: string) => {
    setSelectedItems((current) => {
      if (current.includes(itemId)) return current.filter((id) => id !== itemId);
      if (current.length >= ITEM_LIMIT) return current;
      return [...current, itemId];
    });
  };

  const collectNow = async () => {
    if (!sourceId || selectedItems.length === 0 || collecting) return;
    setCollecting(true);
    setErrorText('');
    setCollection(null);
    setSubmit('idle');
    try {
      const result = await api.gatewayPost<CollectionResult>(
        PLUGIN_ID,
        `${PLUGIN_BASE}/sources/${sourceId}/collect`,
        { itemIds: selectedItems, window: windowFrom(windowPreset) },
      );
      setCollection(result);
    } catch (error: unknown) {
      const { status } = errorCodeOf(error);
      setSourceStatus(status === 403 ? 'forbidden' : 'unavailable');
      setErrorText(t('incidents.collect.errors.collect'));
    } finally {
      setCollecting(false);
    }
  };

  const saveEvidence = async () => {
    if (!collection || !canSave(collection) || submit === 'pending') return;
    setSubmit('pending');
    setErrorText('');
    try {
      const attestation = await api.gatewayPost<AttestationResponse>(
        PLUGIN_ID,
        `${PLUGIN_BASE}/collections/${collection.collectionId}/attestation`,
        { incidentId, kind: 'METRIC_SNAPSHOT' },
      );
      await api.post(`/api/v1/incidents/${encodeURIComponent(incidentId)}/evidence`, {
        kind: attestation.evidence.kind,
        source: attestation.evidence.source,
        collectedAt: attestation.evidence.collectedAt,
        contentRef: attestation.evidence.contentRef,
        content: attestation.evidence.content,
        attestation: attestation.evidence.attestation,
      });
      setSubmit('saved');
      onSaved();
    } catch (error: unknown) {
      const { status } = errorCodeOf(error);
      if (status === 409) {
        setSubmit('conflict');
      } else {
        setSubmit('idle');
        setErrorText(t('incidents.collect.errors.save'));
      }
    }
  };

  const footer = (
    <div className="row" data-testid="incident-collect-actions">
      <Button variant="secondary" onClick={() => { setCancelled(true); onClose(); }} data-testid="incident-collect-cancel">
        {t('action.cancel')}
      </Button>
      <Button variant="secondary" onClick={collectNow} disabled={!sourceId || selectedItems.length === 0 || collecting} data-testid="incident-collect-run">
        {collecting ? t('incidents.collect.collecting') : t('incidents.collect.run')}
      </Button>
      <Button onClick={saveEvidence} disabled={!canSave(collection) || submit === 'pending'} data-testid="incident-collect-save">
        {submit === 'pending' ? t('incidents.collect.saving') : t('incidents.collect.save')}
      </Button>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={t('incidents.collect.title')} size="large" footer={footer}>
      <div className="page-stack" data-testid="incident-collect" data-collect-state={state}>
        <p className="muted small">{t('incidents.collect.description')}</p>

        {state === 'loading' ? <p className="muted small" aria-busy="true" data-testid="incident-collect-loading">{t('aria.loading')}</p> : null}
        {state === 'forbidden' ? (
          <p className="notice-bar" data-testid="incident-collect-forbidden">{t('incidents.collect.forbidden')}</p>
        ) : null}
        {state === 'unavailable' ? (
          <p className="notice-bar" data-testid="incident-collect-unavailable">{t('incidents.collect.unavailable')}</p>
        ) : null}
        {state === 'empty' ? (
          <p className="muted small" data-testid="incident-collect-empty">{t('incidents.collect.emptySources')}</p>
        ) : null}

        {sourceStatus === 'ready' ? (
          <>
            <label className="field">
              <span>{t('incidents.collect.source')}</span>
              <select value={sourceId} onChange={(event) => setSourceId(event.target.value)} data-testid="incident-collect-source">
                <option value="">{t('incidents.collect.sourcePlaceholder')}</option>
                {sources.map((source) => (
                  <option key={source.sourceId} value={source.sourceId}>{source.name}</option>
                ))}
              </select>
              {selectedSource ? (
                <p className="row" data-testid="incident-collect-source-status">
                  <Status code={selectedSource.status} />
                  {selectedSource.lastProbe ? <span className="muted small">{selectedSource.lastProbe.outcome}</span> : null}
                </p>
              ) : null}
            </label>

            <label className="field">
              <span>{t('incidents.collect.host')}</span>
              <select value={hostId} onChange={(event) => setHostId(event.target.value)} disabled={!sourceId || hostsLoading} data-testid="incident-collect-host">
                <option value="">{hostsLoading ? t('aria.loading') : t('incidents.collect.hostPlaceholder')}</option>
                {hosts.map((host) => (
                  <option key={host.hostId} value={host.hostId}>{host.name} · {host.available}</option>
                ))}
              </select>
            </label>

            <div className="field" role="group" aria-label={t('incidents.collect.items')} data-testid="incident-collect-items">
              <span>{t('incidents.collect.itemsHint', { count: ITEM_LIMIT })}</span>
              {itemsLoading ? <p className="muted small" aria-busy="true">{t('aria.loading')}</p> : items.length === 0 ? (
                <p className="muted small" data-testid="incident-collect-items-empty">{t('incidents.collect.noItems')}</p>
              ) : (
                <div className="stack" data-testid="incident-collect-item-list">
                  {items.map((item) => (
                    <label key={item.itemId} className="row">
                      <input
                        type="checkbox"
                        checked={selectedItems.includes(item.itemId)}
                        disabled={!selectedItems.includes(item.itemId) && selectedItems.length >= ITEM_LIMIT}
                        onChange={() => toggleItem(item.itemId)}
                        data-testid={`incident-collect-item-${item.itemId}`}
                      />
                      <span>{item.name || item.key}{item.unit ? ` · ${item.unit}` : ''}</span>
                      {item.valueType === 'TEXT' || item.valueType === 'UNSUPPORTED' ? (
                        <Badge variant={badgeVariantForTone('warn')}>{t('incidents.collect.unsupportedItem')}</Badge>
                      ) : null}
                    </label>
                  ))}
                </div>
              )}
            </div>

            <label className="field">
              <span>{t('incidents.collect.window')}</span>
              <select value={windowPreset} onChange={(event) => setWindowPreset(event.target.value)} data-testid="incident-collect-window">
                <option value="1h">{t('incidents.collect.window1h')}</option>
                <option value="6h">{t('incidents.collect.window6h')}</option>
                <option value="24h">{t('incidents.collect.window24h')}</option>
              </select>
            </label>

            <p className="muted small" data-testid="incident-collect-target">{t('incidents.collect.target', { id: incidentId })}</p>
          </>
        ) : null}

        {collection ? (
          <section className="panel pad" data-testid="incident-collect-result" data-outcome={collection.outcome}>
            <div className="row">
              <Badge
                variant={badgeVariantForTone(
                  collection.outcome === 'OK' ? 'ok' : collection.outcome === 'PARTIAL' ? 'warn' : collection.outcome === 'EMPTY' ? 'info' : 'danger',
                )}
                data-testid="incident-collect-outcome"
              >{collection.outcome}</Badge>
              <span className="muted small" data-testid="incident-collect-observed">
                {ageMessage(locale, collection.observedAt) || collection.observedAt}
              </span>
              {state === 'stale' ? <Badge variant={badgeVariantForTone('warn')} data-testid="incident-collect-stale">{t('incidents.collect.stale')}</Badge> : null}
            </div>
            <p className="muted small">
              {t('incidents.collect.counts', {
                requested: collection.requestedItems,
                answered: collection.answeredItems,
                samples: sampleCount(collection),
              })}
            </p>
            {collection.clamped.length > 0 ? (
              <p className="notice-bar" data-testid="incident-collect-clamped">
                {t('incidents.collect.clamped', { fields: collection.clamped.join(', ') })}
              </p>
            ) : null}
            {collection.snapshot?.truncated ? (
              <p className="notice-bar" data-testid="incident-collect-truncated">
                {t('incidents.collect.truncated', {
                  original: collection.snapshot.originalBytes,
                  returned: collection.snapshot.returnedSamples,
                  requested: collection.snapshot.requestedSamples,
                })}
              </p>
            ) : null}
            <p className="muted small mono" data-testid="incident-collect-content-ref">{collection.contentRef}</p>
            {collection.outcome === 'EMPTY' ? <p className="muted small">{t('incidents.collect.emptyWindow')}</p> : null}
            {collection.outcome === 'NO_DATA' ? <p className="muted small">{t('incidents.collect.noData')}</p> : null}
            {collection.outcome === 'TIMEOUT' ? <p className="muted small" data-testid="incident-collect-timeout">{t('incidents.collect.timeout')}</p> : null}
            {collection.outcome === 'UNAVAILABLE' || collection.outcome === 'UNKNOWN' ? (
              <p className="muted small" data-testid="incident-collect-no-answer">{t('incidents.collect.noAnswer')}</p>
            ) : null}
          </section>
        ) : null}

        {state === 'submitConflict' ? (
          <p className="notice-bar" data-testid="incident-collect-conflict">{t('incidents.collect.conflict')}</p>
        ) : null}
        {state === 'saved' ? (
          <p className="notice-bar" data-testid="incident-collect-saved">{t('incidents.collect.saved')}</p>
        ) : null}
        {errorText ? <p className="notice-bar" data-testid="incident-collect-error">{errorText}</p> : null}
      </div>
    </Modal>
  );
}
