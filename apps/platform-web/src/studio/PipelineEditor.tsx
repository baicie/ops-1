import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, newIdempotencyKey } from '../api';
import type { PipelineDetail, PipelineDraft, PipelinePreview, PipelineRevision, PipelineValidation } from '../types';
import { Icon } from '../components/Icons';
import { ErrorState, Skeleton } from '../components/Ui';
import { ConfirmAction } from '../components/app/confirm-action';
import { PageHeader } from '../components/app/page-header';
import { StatusIndicator, UnknownValue } from '../components/app/status-indicator';
import { useStatusText } from '../components/app/status';
import { useDocumentTitle } from '../hooks';
import { useT, type MessageKey, type TranslateParams } from '../i18n';
import { GraphCanvas } from './GraphCanvas';
import { toGraph, fromGraph } from './ir/adapter';
import { definitionDiff } from './ir/diff';
import { getPipelineExecutionOrder } from './ir/topology';
import type { GraphEdge, GraphNode } from './ir/types';
import { validatePipeline } from './ir/validation';

interface EditorGraph { nodes: GraphNode[]; edges: GraphEdge[] }
interface HistoryEntry { graph: EditorGraph }

const irKey = (value: { nodes: unknown[]; edges: unknown[] }) => JSON.stringify([value.nodes, value.edges]);

type Translate = (key: MessageKey, params?: TranslateParams) => string;

const NODE_LABEL_KEYS: Record<string, MessageKey> = {
  'builtin.source.http_json': 'studio.nodeType.httpSource',
  'builtin.parse.json': 'studio.nodeType.parseJson',
  'builtin.map.fields': 'studio.nodeType.mapFields',
  'builtin.filter.predicate': 'studio.nodeType.filter',
  'builtin.validate.schema': 'studio.nodeType.validate',
  'builtin.sink.dataset': 'studio.nodeType.datasetSink',
};
/** A type the catalog does not know is protocol data: render its last segment verbatim. */
function nodeLabel(t: Translate, type: string) {
  const key = NODE_LABEL_KEYS[type];
  return key ? t(key) : type.split('.').slice(-1)[0];
}

function configValue(nodeType: string, key: string, value: unknown) {
  return { nodeType, key, value };
}

export function PipelineEditorPage() {
  const { pipelineId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const draftParam = searchParams.get('draft');
  const t = useT();
  const statusText = useStatusText();
  useDocumentTitle(t('studio.pageTitle'));

  const [detail, setDetail] = useState<PipelineDetail | null>(null);
  const [draft, setDraft] = useState<PipelineDraft | null>(null);
  const [drafts, setDrafts] = useState<PipelineDraft[]>([]);
  const [graph, setGraph] = useState<EditorGraph | null>(null);
  const [baseline, setBaseline] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [future, setFuture] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [serverValidation, setServerValidation] = useState<PipelineValidation | null>(null);
  const [busy, setBusy] = useState<'create' | 'save' | 'validate' | 'publish' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [conflictLatest, setConflictLatest] = useState<PipelineDraft | null>(null);
  const [sampleInput, setSampleInput] = useState('[{"id":"1","name":"alpha","n":2}]');
  const [preview, setPreview] = useState<PipelinePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [layoutDirection, setLayoutDirection] = useState<'horizontal' | 'vertical'>('vertical');
  const [viewMode, setViewMode] = useState<'readable' | 'all'>('readable');
  const [mobileView, setMobileView] = useState<'nodes' | 'canvas'>('canvas');
  const [configInvalid, setConfigInvalid] = useState(false);
  /** Which of the two conflicting-draft writes a confirmation is open for. */
  const [confirmConflict, setConfirmConflict] = useState<null | 'discard' | 'overwrite'>(null);
  const loadSeq = useRef(0);
  useEffect(() => {
    if (!graph) return;
    const local = irKey({ nodes: graph.nodes.map((node) => node.data.ir), edges: graph.edges.map((edge) => edge.data.ir) });
    if (local === baseline) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [graph, baseline]);

  const load = async (draftId?: string | null) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    setConflict(null);
    try {
      const [pipeline, draftList] = await Promise.all([
        api.get<PipelineDetail>(`/api/v1/pipelines/${encodeURIComponent(pipelineId)}`),
        api.get<PipelineDraft[]>(`/api/v1/pipelines/${encodeURIComponent(pipelineId)}/drafts`).catch(() => []),
      ]);
      if (seq !== loadSeq.current) return;
      setDetail(pipeline);
      setDrafts(draftList);
      let active: PipelineDraft | null = null;
      if (draftId) {
        active = await api.get<PipelineDraft>(`/api/v1/pipelines/${encodeURIComponent(pipelineId)}/drafts/${encodeURIComponent(draftId)}`);
      }
      if (seq !== loadSeq.current) return;
      setDraft(active);
      const source = active?.definition || pipeline.latest?.definition;
      if (!source) throw new Error(t('studio.error.noSource'));
      setGraph(toGraph(source, layoutDirection));
      setBaseline(irKey(source));
      setSelectedId(null);
      setHistory([]);
      setFuture([]);
      setServerValidation(null);
      setConnectionError(null);
      setConflictLatest(null);
    } catch (cause) {
      if (seq === loadSeq.current) setError(cause as Error);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => { void load(draftParam); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pipelineId, draftParam]);

  // The shared header renders in every state: the page is still the editor for this pipeline
  // while the definition is loading, refused, or missing.
  const headerFallback = <PageHeader eyebrow={t('studio.eyebrow')} title={pipelineId} description={t('studio.description')} />;
  if (loading) return <div className="page-stack studio-page">{headerFallback}<Skeleton rows={8} /></div>;
  if (error) return <div className="page-stack studio-page">{headerFallback}<ErrorState error={error} onRetry={() => void load(draftParam)} /></div>;
  if (!detail || !graph) return <div className="page-stack studio-page">{headerFallback}<ErrorState error={new Error(t('studio.error.noData'))} onRetry={() => void load(draftParam)} /></div>;
  const published = detail.latest as PipelineRevision | null | undefined;
  const definition = fromGraph(draft?.definition || published?.definition || ({} as never), graph);
  const dirty = irKey(definition) !== baseline;
  const localValidation = validatePipeline(definition);
  const selected = definition.nodes.find((node) => node.nodeId === selectedId) || null;
  const errors = serverValidation?.errors || localValidation.errors;
  const hasDraft = Boolean(draft);
  const canPublish = Boolean(draft && serverValidation?.valid && !dirty);

  const update = (next: EditorGraph) => {
    setHistory((items) => [...items.slice(-29), { graph }]);
    setFuture([]);
    setGraph(next);
    setServerValidation(null);
  };
  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setFuture((items) => [{ graph }, ...items]);
    setHistory((items) => items.slice(0, -1));
    setGraph(previous.graph);
    setServerValidation(null);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    setHistory((items) => [...items, { graph }]);
    setFuture((items) => items.slice(1));
    setGraph(next.graph);
    setServerValidation(null);
  };
  const createDraft = async () => {
    setBusy('create'); setConflict(null); setNotice(null);
    try {
      const created = await api.post<PipelineDraft>(`/api/v1/pipelines/${encodeURIComponent(pipelineId)}/drafts`, { baseRevision: detail.latestRevision });
      setDraft(created); setDrafts((items) => [created, ...items]);
      setGraph(toGraph(created.definition, layoutDirection)); setBaseline(irKey(created.definition));
      setHistory([]); setFuture([]); setSelectedId(null); setServerValidation(null);
      setNotice(t('studio.notice.draftCreated', { version: created.version }));
      navigate(`/admin/pipelines/${encodeURIComponent(pipelineId)}/editor?draft=${created.draftId}`, { replace: true });
    } catch (cause) { setError(cause as Error); } finally { setBusy(null); }
  };
  const saveDraft = async (overrideVersion?: number) => {
    if (!draft) return;
    setBusy('save'); setConflict(null); setNotice(null);
    try {
      const saved = await api.put<PipelineDraft>(
        `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/drafts/${draft.draftId}`,
        { definition },
        { 'if-match': String(overrideVersion ?? draft.version) },
      );
      setDraft(saved);
      setGraph(toGraph(saved.definition, layoutDirection));
      setBaseline(irKey(saved.definition));
      setHistory([]); setFuture([]); setServerValidation(null);
      setNotice(t('studio.notice.draftSaved', { version: saved.version }));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(`${cause.code}: ${cause.message}`);
        try {
          const latest = await api.get<PipelineDraft>(`/api/v1/pipelines/${encodeURIComponent(pipelineId)}/drafts/${draft.draftId}`);
          setConflictLatest(latest);
        } catch { setConflictLatest(null); }
      } else setError(cause as Error);
    } finally { setBusy(null); }
  };
  const validate = async () => {
    setBusy('validate'); setNotice(null);
    try {
      const result = await api.post<PipelineValidation>('/api/v1/pipelines/validate', definition);
      setServerValidation(result);
      setNotice(result.valid ? t('studio.notice.validationPassed') : t('studio.notice.validationFailed'));
    } catch (cause) { setError(cause as Error); } finally { setBusy(null); }
  };
  const publish = async () => {
    if (!draft || !canPublish) return;
    setBusy('publish'); setNotice(null); setConflict(null);
    try {
      const result = await api.postWithHeaders<PipelineRevision>(
        `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/drafts/${draft.draftId}/publish`,
        {},
        { 'idempotency-key': newIdempotencyKey(), 'if-match': String(draft.version) },
      );
      setNotice(t('studio.notice.published', { revision: result.revision }));
      navigate(`/admin/pipelines/${encodeURIComponent(pipelineId)}`);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setConflict(cause.message);
      else setError(cause as Error);
    } finally { setBusy(null); }
  };
  const updateConfig = (nodeId: string, key: string, value: unknown) => {
    const nodes = graph.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      return { ...node, data: { ir: { ...node.data.ir, config: { ...node.data.ir.config, [key]: value } } } };
    });
    update({ ...graph, nodes });
  };
  // Only the `error` texts set through setConnectionError reach the DOM; the returned
  // `error` field is a caller-facing diagnostic that no view renders.
  const connect = (connection: { source?: string | null; target?: string | null; sourceHandle?: string | null; targetHandle?: string | null }) => {
    const source = graph.nodes.find((node) => node.id === connection.source);
    const target = graph.nodes.find((node) => node.id === connection.target);
    if (!source || !target) return { ok: false, error: 'Connection endpoints are missing' };
    const from = source.data.ir.outputs.find((port) => port.name === connection.sourceHandle);
    const to = target.data.ir.inputs.find((port) => port.name === connection.targetHandle);
    if (!from || !to) { setConnectionError(t('studio.canvas.handleMissing')); return { ok: false, error: 'Port does not exist' }; }
    const id = `${source.id}:${from.name}->${target.id}:${to.name}`;
    if (graph.edges.some((edge) => edge.id === id)) { setConnectionError(t('studio.canvas.duplicateEdge')); return { ok: false, error: 'Duplicate edge' }; }
    const candidateEdge: GraphEdge = { id, source: source.id, target: target.id, sourceHandle: from.name, targetHandle: to.name, label: from.dataType, data: { ir: { fromNode: source.id, fromPort: from.name, toNode: target.id, toPort: to.name, dataType: from.dataType } } };
    const result = validatePipeline(fromGraph(draft?.definition || published?.definition || ({} as never), { nodes: graph.nodes, edges: [...graph.edges, candidateEdge] }));
    if (result.errors.length > 0) { setConnectionError(`${result.errors[0].code}: ${result.errors[0].message}`); return { ok: false, error: result.errors[0].message }; }
    setConnectionError(null); return { ok: true };
  };

  const changeLayout = (nextDirection: 'horizontal' | 'vertical') => {
    setHistory((items) => [...items.slice(-29), { graph }]);
    setFuture([]);
    setLayoutDirection(nextDirection);
    setGraph(toGraph(definition, nextDirection));
    setLayoutNonce((value) => value + 1);
  };
  const autoLayout = () => {
    const next = toGraph(definition, layoutDirection);
    setHistory((items) => [...items.slice(-29), { graph }]);
    setFuture([]);
    setGraph(next);
    setLayoutNonce((value) => value + 1);
  };
  const runPreview = async () => {
    setPreviewBusy(true); setPreviewError(null); setPreview(null);
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(sampleInput); } catch { throw new Error(t('studio.error.sampleJson')); }
      const result = await api.post<PipelinePreview>('/api/v1/pipelines/preview', { definition, sampleInput: parsed, maxRecords: 50 });
      setPreview(result);
    } catch (cause) { setPreviewError((cause as Error).message); } finally { setPreviewBusy(false); }
  };
  return (
    <div className="page-stack studio-page">
      {/* Header only: the palette, canvas, inspector and preview keep their dedicated layouts
          (a workflow canvas is not a card), and the meta row states the pipeline facts instead of
          folding them into the description sentence. */}
      <PageHeader
        eyebrow={t('studio.eyebrow')}
        title={definition.name}
        description={t('studio.description')}
        meta={<>
          <span className="meta-chip mono">{pipelineId}</span>
          <span className="meta-chip">{t('studio.meta.revision', { revision: definition.revision })}</span>
          <span className="meta-chip">{draft ? t('studio.header.draftVersion', { version: draft.version }) : t('studio.header.publishedReadOnly')}</span>
          <StatusIndicator state={dirty ? 'attention' : 'ready'} label={dirty ? t('studio.header.unsavedChanges') : t('studio.header.saved')} />
        </>}
      />
      {/* The nine controls are the workspace's toolbar, not the title's company: measured at 1440
          they are 842px wide against a 1328px column whose description needs 496, so a header that
          also carried them either wrapped into a row §2.2's declared 80px does not reserve or was
          clipped by a scroller ("Create draft" at 1523..1651, outside the viewport). page-template
          §2.1 already has the region for this row - between the header and the page's primary
          region - so the header stays 80px, the first block still lands at y=160, and every control
          keeps its tier and its hit area. */}
      <div className="studio-toolbar" role="group" aria-label={t('studio.toolbar.aria')}>
        <button className="btn btn-secondary" onClick={undo} disabled={!history.length}><Icon name="rotate" size={15} /> {t('studio.action.undo')}</button>
        <button className="btn btn-secondary" onClick={redo} disabled={!future.length}>{t('studio.action.redo')}</button>
        <button className="btn btn-secondary" onClick={autoLayout}><Icon name="layout" size={15} /> {t('studio.action.autoLayout')}</button>
        <button className="btn btn-secondary" onClick={() => changeLayout(layoutDirection === 'horizontal' ? 'vertical' : 'horizontal')} title={t('studio.action.layoutToggle')}><Icon name="refresh" size={15} /> {layoutDirection === 'horizontal' ? t('studio.action.horizontal') : t('studio.action.vertical')}</button>
        <button className={`btn btn-secondary ${viewMode === 'readable' ? 'active' : ''}`} onClick={() => { setViewMode('readable'); setLayoutNonce((value) => value + 1); }} title={t('studio.action.readableTitle')}>{t('studio.action.readable')}</button>
        <button className={`btn btn-secondary ${viewMode === 'all' ? 'active' : ''}`} onClick={() => { setViewMode('all'); setLayoutNonce((value) => value + 1); }} title={t('studio.action.fitAllTitle')}>{t('studio.action.fitAll')}</button>
        <button className={`btn btn-secondary ${previewOpen ? 'active' : ''}`} onClick={() => setPreviewOpen((value) => !value)}><Icon name="play" size={15} /> {t('studio.action.preview')}</button>
        <Link className="btn btn-secondary" to={`/admin/pipelines/${encodeURIComponent(pipelineId)}`}>{t('studio.action.detail')}</Link>
        {hasDraft && <>
          <button className="btn btn-secondary" onClick={() => void saveDraft()} disabled={busy !== null || !dirty || configInvalid}><Icon name="save" size={15} /> {busy === 'save' ? t('studio.action.saving') : t('studio.action.saveDraft')}</button>
          <button className="btn btn-secondary" onClick={() => void validate()} disabled={busy !== null}><Icon name="check" size={15} /> {busy === 'validate' ? t('studio.action.validating') : t('studio.action.validate')}</button>
        </>}
        {!hasDraft
          ? <button className="btn btn-primary" onClick={() => void createDraft()} disabled={busy !== null}><Icon name="plus" size={15} /> {t('studio.action.createDraft')}</button>
          : <button className="btn btn-primary" onClick={() => void publish()} disabled={!canPublish || busy !== null} title={!serverValidation?.valid ? t('studio.action.publishHint.validation') : dirty ? t('studio.action.publishHint.save') : t('studio.action.publishHint.publish')}><Icon name="upload" size={15} /> {busy === 'publish' ? t('studio.action.publishing') : t('studio.action.publish')}</button>}
      </div>
      {notice && <div className="studio-banner" role="status"><Icon name="check" size={14} /> {notice}</div>}
      {conflict && <div className="studio-banner studio-banner-error studio-conflict" role="alert">
        <Icon name="warning" size={14} />
        <div className="conflict-copy"><strong>{conflict}</strong><span>{t('studio.conflict.localPreserved', { version: conflictLatest ? `v${conflictLatest.version}` : t('studio.conflict.unknownVersion') })}</span>
          {conflictLatest && (() => {
            const diff = definitionDiff(definition, conflictLatest.definition);
            return <div className="conflict-diff" aria-label={t('studio.conflict.ariaLabel')}>
              {diff.nodes.length === 0 && diff.edgesAdded.length === 0 && diff.edgesRemoved.length === 0 && <p className="muted small">{t('studio.conflict.noDifference')}</p>}
              {diff.nodes.map((entry) => <div key={entry.nodeId} className="diff-node">
                <div className="diff-node-head"><strong>{entry.label}</strong><span className="mono">{entry.nodeId}</span><span className={`tag diff-${entry.kind}`}>{entry.kind}</span></div>
                {entry.changes.map((change) => <div key={change.path} className="diff-field"><code>{change.path}</code><span><em>{t('studio.conflict.yours')}</em> {change.local}</span><span><em>{t('studio.conflict.server')}</em> {change.server}</span></div>)}
              </div>)}
              {diff.edgesAdded.length > 0 && <p className="small"><strong>{t('studio.conflict.edgesServerOnly')}</strong> {diff.edgesAdded.join(', ')}</p>}
              {diff.edgesRemoved.length > 0 && <p className="small"><strong>{t('studio.conflict.edgesLocalOnly')}</strong> {diff.edgesRemoved.join(', ')}</p>}
            </div>;
          })()}
        </div>
        <div className="conflict-actions">
          <button className="btn btn-secondary btn-small" onClick={() => setConflict(null)}>{t('studio.action.keepEditing')}</button>
          <button className="btn btn-secondary btn-small" onClick={() => setConfirmConflict('discard')}>{t('studio.action.reloadLatest')}</button>
          <button className="btn btn-primary btn-small" disabled={!conflictLatest || busy !== null} onClick={() => setConfirmConflict('overwrite')}>{t('studio.action.useLocalRetry')}</button>
        </div>
      </div>}
      {drafts.length > 0 && <section className="panel panel-pad studio-drafts"><strong>{t('studio.drafts.title')}</strong><div className="draft-row">{drafts.map((item) => <button key={item.draftId} className={`btn btn-secondary btn-small ${draft?.draftId === item.draftId ? 'active' : ''}`} onClick={() => navigate(`/admin/pipelines/${encodeURIComponent(pipelineId)}/editor?draft=${item.draftId}`)}>v{item.version} · {new Date(item.updatedAt).toLocaleString()}</button>)}</div></section>}
      <div className="studio-shell">
        <aside className="panel panel-pad studio-palette">
          <h2>{t('studio.palette.title')}</h2><p className="muted small">{t('studio.palette.description')}</p>
          {definition.nodes.map((node) => <div key={node.nodeId} className="palette-item" role="button" tabIndex={0} onClick={() => setSelectedId(node.nodeId)} onKeyDown={(event) => { if (event.key === 'Enter') setSelectedId(node.nodeId); }}><Icon name="box" size={15} /><span><strong>{nodeLabel(t, node.type)}</strong><small className="mono">{node.nodeId}</small></span></div>)}
        </aside>
        <section className="panel studio-canvas" aria-label={t('studio.canvas.ariaLabel')}>
          <div className="mobile-view-toggle" role="group" aria-label={t('studio.canvas.viewGroupAria')}>
            <button className={mobileView === 'nodes' ? 'active' : ''} onClick={() => setMobileView('nodes')}>{t('studio.canvas.viewNodes')}</button>
            <button className={mobileView === 'canvas' ? 'active' : ''} onClick={() => setMobileView('canvas')}>{t('studio.canvas.viewCanvas')}</button>
          </div>
          {mobileView === 'nodes' ? <div className="mobile-node-list">{getPipelineExecutionOrder(definition).orderedNodes.map((node, index) => <button key={node.nodeId} className={selectedId === node.nodeId ? 'active' : ''} onClick={() => setSelectedId(node.nodeId)}><span className={getPipelineExecutionOrder(definition).topologyStatus === 'VALID' ? 'flow-index' : 'flow-index flow-index-token'}>{getPipelineExecutionOrder(definition).topologyStatus === 'VALID' ? index + 1 : <UnknownValue detail={t('ui.unknown.detail')} />}</span><span><strong>{nodeLabel(t, node.type)}</strong><small>{node.nodeId}</small></span><span className="muted small">{t('studio.canvas.nodeOutCount', { count: node.outputs.length })}</span></button>)}</div> : <GraphCanvas direction={layoutDirection} layoutNonce={layoutNonce} viewMode={viewMode} nodes={graph.nodes} edges={graph.edges} selectedId={selectedId} onNodesChange={(nodes) => update({ ...graph, nodes })} onEdgesChange={(edges) => update({ ...graph, edges })} onConnectAttempt={connect} onSelect={setSelectedId} />}
          {connectionError && <div className="studio-error" role="alert"><Icon name="warning" size={14} /> {connectionError}</div>}
          <p className="studio-note"><Icon name="alert" size={13} /> {t('studio.canvas.note')}</p>
        </section>
        <aside className="panel panel-pad studio-inspector">
          <h2>{t('studio.inspector.title')}</h2>
          {selected ? <>
            {!hasDraft && <p className="muted small">{t('studio.inspector.needsDraft')}</p>}
            <p className="mono small">{selected.nodeId}</p><p className="muted small">{selected.type} · {t('studio.inspector.typeVersion', { version: selected.typeVersion })}</p>
            <h3>{t('studio.inspector.configuration')}</h3>
            <NodeConfigForm key={selected.nodeId} node={selected} readOnly={!hasDraft} onValidityChange={setConfigInvalid} onChange={(key, value) => updateConfig(selected.nodeId, key, value)} />
            <details className="advanced"><summary>{t('studio.inspector.advanced')}</summary><p className="mono small">{selected.type} · v{selected.typeVersion}</p><pre>{JSON.stringify(selected.config, null, 2)}</pre></details>
            <h3>Ports</h3><ul className="port-list">{selected.inputs.map((port) => <li key={port.name}><span>{port.name}</span><code>{port.dataType}</code><small>{port.required ? t('studio.port.inputRequired') : t('studio.port.input')}</small></li>)}{selected.outputs.map((port) => <li key={port.name}><span>{port.name}</span><code>{port.dataType}</code><small>{port.nullable ? t('studio.port.outputNullable') : t('studio.port.output')}</small></li>)}</ul>
          </> : <p className="muted small">{t('studio.inspector.selectNode')}</p>}
          <h3>{t('studio.inspector.validation')} <span className={errors.length === 0 ? 'text-ok' : 'text-danger'}>{errors.length}</span></h3>
          {errors.length === 0 ? <p className="muted small">{t('studio.inspector.noErrors')}</p> : <ul className="validation-list">{errors.map((item, index) => <li key={`${item.code}-${index}`}><button onClick={() => item.nodeId && setSelectedId(item.nodeId)}><strong>{item.code}</strong><span>{item.message}</span></button></li>)}</ul>}
          {serverValidation && <p className="muted small">{serverValidation.valid ? t('studio.inspector.serverValidated', { digest: String(serverValidation.planDigest) }) : t('studio.inspector.serverRejected')}</p>}
        </aside>
      </div>
      {previewOpen && <section className="panel panel-pad studio-preview" aria-label={t('studio.preview.ariaLabel')}>
        <div className="panel-head"><div><h2>{t('studio.preview.title')}</h2><p className="muted small">{t('studio.preview.description')}</p></div><button className="btn btn-secondary" onClick={() => void runPreview()} disabled={previewBusy}>{previewBusy ? t('studio.preview.running') : t('studio.preview.run')}</button></div>
        <label className="preview-input"><span>{t('studio.preview.sampleLabel')}</span><textarea rows={6} value={sampleInput} onChange={(event) => setSampleInput(event.target.value)} /></label>
        {previewError && <div className="studio-banner studio-banner-error" role="alert"><Icon name="warning" size={14} /> {previewError}</div>}
        {preview && <>
          {/* The summary paints catalog copy, so it cannot be asserted by its text: the same run
              reads "Completed" in en and "已完成" in zh-CN. The wire code and the counts ride along
              in data-* exactly as Status does with data-status - protocol data, never translated,
              never the label. records is the number the server actually processed, so a test can
              pin it instead of looking for the word "records". */}
          <div className="preview-summary" data-status={preview.status} data-records={preview.processedRecords} data-node-count={preview.nodeOutputs.length}><strong>{statusText(preview.status)}</strong><span>{t('studio.preview.recordCount', { count: preview.processedRecords })}</span><span>{preview.elapsedMs} ms</span>{preview.truncated && <span className="tag">{t('studio.preview.truncated')}</span>}</div>
          {preview.errors.length > 0 && <ul className="validation-list">{preview.errors.map((item, index) => <li key={`${item.code}-${index}`}><button onClick={() => item.nodeId && setSelectedId(item.nodeId)}><strong>{item.code}</strong><span>{item.message}</span></button></li>)}</ul>}
          <div className="preview-grid">{preview.nodeOutputs.map((node) => <article className="panel preview-node" key={node.nodeId} data-node-id={node.nodeId} data-output-count={node.outputCount} data-input-count={node.inputCount} data-error-count={node.errors.length}><div className="pipeline-node-head"><strong>{node.nodeId}</strong><span className="tag">{node.outputCount}</span></div><small className="mono">{node.nodeType}</small><p className="muted small">{t('studio.preview.nodeFlow', { input: node.inputCount, output: node.outputCount, ms: node.durationMs })}</p>{node.errors.map((error) => <p className="text-danger small" key={error.code}>{error.code}: {error.message}</p>)}<pre>{JSON.stringify(node.sampleRows, null, 2)}</pre></article>)}</div>
        </>}
        {!preview && !previewError && <p className="muted small">{t('studio.preview.notAJob')}</p>}
      </section>}
      {/* Both writes below overwrite work, so they ask through ConfirmAction instead of
          window.confirm. The request sequence is unchanged: the same load/save call runs on
          confirm, and the page-level error surface still reports a failure. */}
      <ConfirmAction
        open={confirmConflict === 'discard'}
        title={t('studio.confirmDiscard.title')}
        description={t('studio.conflict.discardConfirm')}
        confirmLabel={t('studio.action.reloadLatest')}
        onConfirm={async () => { setConflict(null); await load(draft?.draftId); }}
        onClose={() => setConfirmConflict(null)}
      />
      <ConfirmAction
        open={confirmConflict === 'overwrite'}
        title={t('studio.confirmOverwrite.title')}
        description={t('studio.conflict.overwriteConfirm')}
        confirmLabel={t('studio.action.useLocalRetry')}
        onConfirm={async () => { setConflict(null); await saveDraft(conflictLatest?.version); }}
        onClose={() => setConfirmConflict(null)}
      />
    </div>
  );
}

function NodeConfigForm({ node, readOnly, onChange, onValidityChange }: { node: { config: Record<string, unknown>; type: string }; readOnly: boolean; onChange: (key: string, value: unknown) => void; onValidityChange?: (invalid: boolean) => void }) {
  const t = useT();
  const entries = useMemo(() => Object.entries(node.config || {}), [node.config]);
  return (
    <div className="config-form">
      {entries.length === 0 && <p className="muted small">{t('studio.config.empty')}</p>}
      {entries.map(([key, value]) => {
        const id = `${node.type}-${key}`;
        if (typeof value === 'number') return <label key={key} htmlFor={id}><span>{key}</span><input id={id} type="number" value={value} disabled={readOnly} onChange={(event) => onChange(key, Number(event.target.value))} /></label>;
        if (typeof value === 'boolean') return <label key={key} htmlFor={id} className="config-checkbox"><input id={id} type="checkbox" checked={value} disabled={readOnly} onChange={(event) => onChange(key, event.target.checked)} /><span>{key}</span></label>;
        if (typeof value === 'string') return <label key={key} htmlFor={id}><span>{key}</span><input id={id} value={value} disabled={readOnly} onChange={(event) => onChange(key, event.target.value)} /></label>;
        return <JsonConfigField key={key} id={id} label={key} value={value} readOnly={readOnly} onChange={(parsed) => onChange(key, parsed)} onValidityChange={onValidityChange} />;
      })}
    </div>
  );
}


function JsonConfigField({ id, label, value, readOnly, onChange, onValidityChange }: {
  id: string; label: string; value: unknown; readOnly: boolean;
  onChange: (value: unknown) => void; onValidityChange?: (invalid: boolean) => void;
}) {
  const t = useT();
  const serialized = JSON.stringify(value, null, 2);
  const [text, setText] = useState(serialized);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(serialized); setInvalid(false); onValidityChange?.(false); }, [serialized]);
  return (
    <label htmlFor={id}>
      <span>{t('studio.config.jsonLabel', { label })}</span>
      <textarea
        id={id}
        rows={5}
        value={text}
        disabled={readOnly}
        aria-invalid={invalid}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          try {
            const parsed = JSON.parse(next);
            setInvalid(false);
            onValidityChange?.(false);
            onChange(parsed);
          } catch {
            setInvalid(true);
            onValidityChange?.(true);
          }
        }}
      />
      {invalid && <span className="text-danger small" role="alert">{t('studio.config.invalidJson')}</span>}
    </label>
  );
}
