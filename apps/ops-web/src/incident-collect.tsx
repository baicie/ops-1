import * as React from 'react';
import { api } from '@opsweave/platform-client';
import { Modal } from '@opsweave/ui/Ui';
import { Badge } from '@opsweave/ui/badge';
import { Button } from '@opsweave/ui/button';
import { Status } from '@opsweave/ui/status';
import { badgeVariantForTone } from '@opsweave/ui/status-tone';
import { ageMessage } from '@opsweave/platform-client/age';
import { useI18n, useT } from '@opsweave/platform-client/i18n';

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
  | 'noSources'
  | 'empty'
  | 'noData'
  | 'partial'
  | 'timeout'
  | 'unavailable'
  | 'unknown'
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
  if (input.sourceStatus === 'empty') return 'noSources';
  if (input.collection) {
    if (input.collection.outcome === 'UNAVAILABLE') return 'unavailable';
    if (input.collection.outcome === 'TIMEOUT') return 'timeout';
    if (input.collection.outcome === 'UNKNOWN') return 'unknown';
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


/** Wire outcomes rendered as catalog copy; never as raw enum text (rules/06). */
export type OutcomeKey =
  | 'incidents.collect.outcome.ok'
  | 'incidents.collect.outcome.empty'
  | 'incidents.collect.outcome.noData'
  | 'incidents.collect.outcome.partial'
  | 'incidents.collect.outcome.unknown'
  | 'incidents.collect.outcome.unavailable'
  | 'incidents.collect.outcome.timeout';

export function outcomeKey(outcome: string): OutcomeKey {
  switch (outcome) {
    case 'OK': return 'incidents.collect.outcome.ok';
    case 'EMPTY': return 'incidents.collect.outcome.empty';
    case 'NO_DATA': return 'incidents.collect.outcome.noData';
    case 'PARTIAL': return 'incidents.collect.outcome.partial';
    case 'UNKNOWN': return 'incidents.collect.outcome.unknown';
    case 'UNAVAILABLE': return 'incidents.collect.outcome.unavailable';
    case 'TIMEOUT': return 'incidents.collect.outcome.timeout';
    default: return 'incidents.collect.outcome.unknown';
  }
}

export type AvailabilityKey =
  | 'incidents.collect.availability.available'
  | 'incidents.collect.availability.unavailable'
  | 'incidents.collect.availability.unknown';

export function availabilityKey(availability: string): AvailabilityKey {
  switch (availability) {
    case 'AVAILABLE': return 'incidents.collect.availability.available';
    case 'UNAVAILABLE': return 'incidents.collect.availability.unavailable';
    default: return 'incidents.collect.availability.unknown';
  }
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
  const { locale } = useI18n();
  const [sourceStatus, setSourceStatus] = React.useState<CollectSourceStatus>('idle');
  const [sources, setSources] = React.useState<CollectSource[]>([]);
  const [sourceId, setSourceId] = React.useState('');
  const [hosts, setHosts] = React.useState<CollectHost[]>([]);
  const [hostState, setHostState] = React.useState<CollectSourceStatus>('idle');
  const [hostId, setHostId] = React.useState('');
  const [items, setItems] = React.useState<CollectItem[]>([]);
  const [itemState, setItemState] = React.useState<CollectSourceStatus>('idle');
  const [selectedItems, setSelectedItems] = React.useState<string[]>([]);
  const [windowPreset, setWindowPreset] = React.useState('1h');
  const [collection, setCollection] = React.useState<CollectionResult | null>(null);
  // What produced the shown collection. Saving always uses the collection's own
  // bytes, but a reader must be able to see that the form now selects something
  // else than the result on screen.
  const [collectedFrom, setCollectedFrom] = React.useState<string | null>(null);
  const [collecting, setCollecting] = React.useState(false);
  const [collectError, setCollectError] = React.useState('');
  const [submit, setSubmit] = React.useState<'idle' | 'pending' | 'conflict' | 'saved'>('idle');
  const [cancelled, setCancelled] = React.useState(false);
  const [errorText, setErrorText] = React.useState('');
  const [now, setNow] = React.useState(Date.now());
  // A response that arrives after a selector change or a close must not land on
  // the new selection or on the previous incident.
  const generation = React.useRef(0);
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);

  React.useEffect(() => {
    if (!open) return;
    setCancelled(false);
    setSubmit('idle');
    setCollection(null);
    setCollectedFrom(null);
    setCollectError('');
    setErrorText('');
    setSelectedItems([]);
    setHostId('');
    setHosts([]);
    setHostState('idle');
    setItems([]);
    setItemState('idle');
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
    generation.current += 1;
    setCollection(null);
    setCollectedFrom(null);
    setCollectError('');
    let live = true;
    setHostState('loading');
    setHosts([]);
    setHostId('');
    setItemState('idle');
    setItems([]);
    setSelectedItems([]);
    api.gatewayGet<{ items: CollectHost[] }>(PLUGIN_ID, `${PLUGIN_BASE}/sources/${sourceId}/hosts`)
      .then((result) => {
        if (!live) return;
        const rows = result.items ?? [];
        setHosts(rows);
        setHostState(rows.length === 0 ? 'empty' : 'ready');
      })
      .catch((error: unknown) => {
        if (!live) return;
        const { status } = errorCodeOf(error);
        setHosts([]);
        setHostState(status === 403 ? 'forbidden' : 'unavailable');
      });
    return () => { live = false; };
  }, [sourceId]);

  React.useEffect(() => {
    if (!sourceId || !hostId) return;
    generation.current += 1;
    setCollection(null);
    setCollectedFrom(null);
    setCollectError('');
    let live = true;
    setItemState('loading');
    setItems([]);
    setSelectedItems([]);
    api.gatewayGet<{ items: CollectItem[] }>(PLUGIN_ID, `${PLUGIN_BASE}/sources/${sourceId}/items?hostId=${encodeURIComponent(hostId)}`)
      .then((result) => {
        if (!live) return;
        const rows = result.items ?? [];
        setItems(rows);
        setItemState(rows.length === 0 ? 'empty' : 'ready');
      })
      .catch((error: unknown) => {
        if (!live) return;
        const { status } = errorCodeOf(error);
        setItems([]);
        setItemState(status === 403 ? 'forbidden' : 'unavailable');
      });
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

  const windowLabel = windowPreset === '24h'
    ? t('incidents.collect.window24h')
    : windowPreset === '6h'
      ? t('incidents.collect.window6h')
      : t('incidents.collect.window1h');

  const collectNow = async () => {
    if (!sourceId || selectedItems.length === 0 || collecting) return;
    const seq = ++generation.current;
    const requestedSource = sources.find((source) => source.sourceId === sourceId)?.name ?? sourceId;
    setCollecting(true);
    setCollectError('');
    setErrorText('');
    setSubmit('idle');
    try {
      const result = await api.gatewayPost<CollectionResult>(
        PLUGIN_ID,
        `${PLUGIN_BASE}/sources/${sourceId}/collect`,
        { itemIds: selectedItems, window: windowFrom(windowPreset) },
      );
      // A response for an older selection (or an unmounted dialog) is dropped;
      // it must not appear under the source the reader switched to.
      if (seq !== generation.current || !alive.current) return;
      setCollection(result);
      setCollectedFrom(`${requestedSource} · ${windowLabel}`);
    } catch (error: unknown) {
      if (seq !== generation.current || !alive.current) return;
      const { status } = errorCodeOf(error);
      if (status === 403) setSourceStatus('forbidden');
      else setCollectError(t('incidents.collect.errors.collect'));
    } finally {
      if (seq === generation.current && alive.current) setCollecting(false);
    }
  };

  const saveEvidence = async () => {
    if (!collection || !canSave(collection) || submit === 'pending') return;
    const targetIncident = incidentId;
    setSubmit('pending');
    setErrorText('');
    try {
      const attestation = await api.gatewayPost<AttestationResponse>(
        PLUGIN_ID,
        `${PLUGIN_BASE}/collections/${collection.collectionId}/attestation`,
        { incidentId: targetIncident, kind: 'METRIC_SNAPSHOT' },
      );
      // A base plugin without the content-binding contract would return a ref
      // and no bytes. Posting that would store a Legacy row while this dialog
      // promised the Kernel verified the bytes, so refuse instead of guessing.
      const body = attestation.evidence?.content?.body;
      if (typeof body !== 'string' || body.length === 0) {
        throw Object.assign(new Error('the plugin returned no evidence bytes'), {
          status: 502,
          code: 'PLUGIN_CONTENT_MISSING',
        });
      }
      await api.post(`/api/v1/incidents/${encodeURIComponent(targetIncident)}/evidence`, {
        kind: attestation.evidence.kind,
        source: attestation.evidence.source,
        collectedAt: attestation.evidence.collectedAt,
        contentRef: attestation.evidence.contentRef,
        content: { contentType: attestation.evidence.content.contentType, body },
        attestation: attestation.evidence.attestation,
      });
      if (!alive.current) return;
      setSubmit('saved');
      // A toast/refresh failure is not an evidence failure: the row is stored.
      try { onSaved(); } catch { /* the page re-reads on its own schedule */ }
    } catch (error: unknown) {
      if (!alive.current) return;
      const { status, code } = errorCodeOf(error);
      if (status === 409 && (code ?? '').startsWith('INCIDENT_')) {
        setSubmit('conflict');
      } else {
        setSubmit('idle');
        setErrorText(
          code === 'PLUGIN_CONTENT_MISSING'
            ? t('incidents.collect.errors.contract')
            : t('incidents.collect.errors.save'),
        );
      }
    }
  };

  const footer = (
    <div className="flex flex-wrap gap-2" data-testid="incident-collect-actions">
      <Button variant="secondary" onClick={() => { setCancelled(true); onClose(); }} disabled={submit === 'pending'} data-testid="incident-collect-cancel">
        {t('action.cancel')}
      </Button>
      <Button variant="secondary" onClick={collectNow} disabled={!sourceId || selectedItems.length === 0 || collecting || submit === 'pending'} data-testid="incident-collect-run">
        {collecting ? t('incidents.collect.collecting') : t('incidents.collect.run')}
      </Button>
      <Button onClick={saveEvidence} disabled={!canSave(collection) || submit === 'pending'} data-testid="incident-collect-save">
        {submit === 'pending' ? t('incidents.collect.saving') : t('incidents.collect.save')}
      </Button>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={t('incidents.collect.title')} description={t('incidents.collect.description')} size="large" footer={footer} dismissible={submit !== 'pending'}>
      <div className="page-stack" data-testid="incident-collect" data-collect-state={state}>
        {state === 'loading' ? <p className="muted small" aria-busy="true" data-testid="incident-collect-loading">{t('aria.loading')}</p> : null}
        {state === 'forbidden' ? (
          <p className="notice-bar" data-testid="incident-collect-forbidden">{t('incidents.collect.forbidden')}</p>
        ) : null}
        {state === 'unavailable' ? (
          <p className="notice-bar" data-testid="incident-collect-unavailable">{t('incidents.collect.unavailable')}</p>
        ) : null}
        {state === 'noSources' ? (
          <p className="muted small" data-testid="incident-collect-empty">{t('incidents.collect.emptySources')}</p>
        ) : null}
        {state === 'unknown' ? (
          <p className="notice-bar" role="status" data-testid="incident-collect-unknown">{t('incidents.collect.unknown')}</p>
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
            </label>
            {selectedSource ? (
              <p className="flex items-center gap-2" data-testid="incident-collect-source-status">
                <Status code={selectedSource.status} />
              </p>
            ) : null}

            <label className="field">
              <span>{t('incidents.collect.host')}</span>
              <select value={hostId} onChange={(event) => setHostId(event.target.value)} disabled={!sourceId || hostState === 'loading'} data-testid="incident-collect-host">
                <option value="">{hostState === 'loading' ? t('aria.loading') : t('incidents.collect.hostPlaceholder')}</option>
                {hosts.map((host) => (
                  <option key={host.hostId} value={host.hostId}>{host.name} · {t(availabilityKey(host.available))}</option>
                ))}
              </select>
              {hostState === 'forbidden' ? <p className="notice-bar" role="alert" data-testid="incident-collect-hosts-forbidden">{t('incidents.collect.hostsForbidden')}</p> : null}
              {hostState === 'unavailable' ? <p className="notice-bar" role="alert" data-testid="incident-collect-hosts-unavailable">{t('incidents.collect.hostsUnavailable')}</p> : null}
            </label>

            <div className="field" role="group" aria-label={t('incidents.collect.items')} data-testid="incident-collect-items">
              <span>{t('incidents.collect.itemsHint', { count: ITEM_LIMIT })}</span>
              {itemState === 'loading' ? <p className="muted small" aria-busy="true">{t('aria.loading')}</p> : itemState === 'forbidden' ? (
                <p className="notice-bar" role="alert" data-testid="incident-collect-items-forbidden">{t('incidents.collect.itemsForbidden')}</p>
              ) : itemState === 'unavailable' ? (
                <p className="notice-bar" role="alert" data-testid="incident-collect-items-unavailable">{t('incidents.collect.itemsUnavailable')}</p>
              ) : hostId && itemState === 'empty' ? (
                <p className="muted small" data-testid="incident-collect-items-empty">{t('incidents.collect.noItems')}</p>
              ) : (
                <div className="flex flex-col gap-2 min-w-0" data-testid="incident-collect-item-list">
                  {items.map((item) => (
                    <label key={item.itemId} className="flex items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        className="row-check"
                        checked={selectedItems.includes(item.itemId)}
                        disabled={
                          item.valueType === 'TEXT' ||
                          item.valueType === 'UNSUPPORTED' ||
                          (!selectedItems.includes(item.itemId) && selectedItems.length >= ITEM_LIMIT)
                        }
                        onChange={() => toggleItem(item.itemId)}
                        data-testid={`incident-collect-item-${item.itemId}`}
                      />
                      <span className="min-w-0 break-words">{item.name || item.key}{item.unit ? ` · ${item.unit}` : ''}</span>
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

            <p className="muted small break-words" data-testid="incident-collect-target">{t('incidents.collect.target', { id: incidentId })}</p>
          </>
        ) : null}

        {collection ? (
          <section className="panel pad" role="status" aria-live="polite" data-testid="incident-collect-result" data-outcome={collection.outcome}>
            <div className="row">
              <Badge
                variant={badgeVariantForTone(
                  collection.outcome === 'OK' ? 'ok' : collection.outcome === 'PARTIAL' ? 'warn' : collection.outcome === 'EMPTY' ? 'info' : 'danger',
                )}
                data-testid="incident-collect-outcome"
              >{t(outcomeKey(collection.outcome))}</Badge>
              <span className="muted small" data-testid="incident-collect-observed">
                {ageMessage(locale, collection.observedAt) || collection.observedAt}
              </span>
              {state === 'stale' ? <Badge variant={badgeVariantForTone('warn')} data-testid="incident-collect-stale">{t('incidents.collect.stale')}</Badge> : null}
            </div>
            {collectedFrom ? (
              <p className="muted small" data-testid="incident-collect-collected-from">{t('incidents.collect.collectedFrom', { source: collectedFrom })}</p>
            ) : null}
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
            <p className="muted small" data-testid="incident-collect-content-ref"><code data-long-token>{collection.contentRef}</code></p>
            {collection.outcome === 'EMPTY' ? <p className="muted small">{t('incidents.collect.emptyWindow')}</p> : null}
            {collection.outcome === 'NO_DATA' ? <p className="muted small">{t('incidents.collect.noData')}</p> : null}
            {collection.outcome === 'TIMEOUT' ? <p className="muted small" data-testid="incident-collect-timeout">{t('incidents.collect.timeout')}</p> : null}
            {collection.outcome === 'UNAVAILABLE' || collection.outcome === 'UNKNOWN' ? (
              <p className="muted small" data-testid="incident-collect-no-answer">{t('incidents.collect.noAnswer')}</p>
            ) : null}
          </section>
        ) : null}

        {state === 'submitConflict' ? (
          <p className="notice-bar" role="alert" data-testid="incident-collect-conflict">{t('incidents.collect.conflict')}</p>
        ) : null}
        {state === 'saved' ? (
          <p className="notice-bar" role="status" data-testid="incident-collect-saved">{t('incidents.collect.saved')}</p>
        ) : null}
        {collectError ? <p className="notice-bar" role="alert" data-testid="incident-collect-collect-error">{collectError}</p> : null}
        {errorText ? <p className="notice-bar" role="alert" data-testid="incident-collect-error">{errorText}</p> : null}
      </div>
    </Modal>
  );
}
