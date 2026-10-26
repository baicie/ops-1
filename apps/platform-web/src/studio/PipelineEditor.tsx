import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, newIdempotencyKey } from '../api';
import type { PipelineDetail, PipelineDraft, PipelinePreview, PipelineRevision, PipelineValidation } from '../types';
import { Icon } from '../components/Icons';
import { ErrorState, PageHeader, Skeleton } from '../components/Ui';
import { useDocumentTitle } from '../hooks';
import { GraphCanvas } from './GraphCanvas';
import { toGraph, fromGraph } from './ir/adapter';
import { definitionDiff } from './ir/diff';
import type { GraphEdge, GraphNode } from './ir/types';
import { validatePipeline } from './ir/validation';

interface EditorGraph { nodes: GraphNode[]; edges: GraphEdge[] }
interface HistoryEntry { graph: EditorGraph }

const irKey = (value: { nodes: unknown[]; edges: unknown[] }) => JSON.stringify([value.nodes, value.edges]);

const NODE_LABEL: Record<string, string> = {
  'builtin.source.http_json': 'HTTP Source',
  'builtin.parse.json': 'Parse JSON',
  'builtin.map.fields': 'Map Fields',
  'builtin.filter.predicate': 'Filter Records',
  'builtin.validate.schema': 'Validate Schema',
  'builtin.sink.dataset': 'Dataset Sink',
};
function nodeLabel(type: string) { return NODE_LABEL[type] || type.split('.').slice(-1)[0]; }

function configValue(nodeType: string, key: string, value: unknown) {
  return { nodeType, key, value };
}

export function PipelineEditorPage() {
  const { pipelineId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const draftParam = searchParams.get('draft');
  useDocumentTitle('Pipeline Studio');

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
  const [mobileView, setMobileView] = useState<'nodes' | 'canvas'>('canvas');
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
      if (!source) throw new Error('No published revision or draft is available');
      setGraph(toGraph(source));
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

  if (loading) return <Skeleton rows={8} />;
  if (error) return <ErrorState error={error} onRetry={() => void load(draftParam)} />;
  if (!detail || !graph) return <ErrorState error={new Error('No pipeline data')} onRetry={() => void load(draftParam)} />;
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
      setGraph(toGraph(created.definition)); setBaseline(irKey(created.definition));
      setHistory([]); setFuture([]); setSelectedId(null); setServerValidation(null);
      setNotice(`Draft created · version ${created.version}`);
      navigate(`/pipelines/${encodeURIComponent(pipelineId)}/editor?draft=${created.draftId}`, { replace: true });
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
      setGraph(toGraph(saved.definition));
      setBaseline(irKey(saved.definition));
      setHistory([]); setFuture([]); setServerValidation(null);
      setNotice(`Draft saved · version ${saved.version}`);
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
      setNotice(result.valid ? 'Server validation passed' : 'Server validation failed');
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
      setNotice(`Published r${result.revision}`);
      navigate(`/pipelines/${encodeURIComponent(pipelineId)}`);
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
  const connect = (connection: { source?: string | null; target?: string | null; sourceHandle?: string | null; targetHandle?: string | null }) => {
    const source = graph.nodes.find((node) => node.id === connection.source);
    const target = graph.nodes.find((node) => node.id === connection.target);
    if (!source || !target) return { ok: false, error: 'Connection endpoints are missing' };
    const from = source.data.ir.outputs.find((port) => port.name === connection.sourceHandle);
    const to = target.data.ir.inputs.find((port) => port.name === connection.targetHandle);
    if (!from || !to) { setConnectionError('Handle does not exist on the selected node'); return { ok: false, error: 'Port does not exist' }; }
    const id = `${source.id}:${from.name}->${target.id}:${to.name}`;
    if (graph.edges.some((edge) => edge.id === id)) { setConnectionError('This connection already exists'); return { ok: false, error: 'Duplicate edge' }; }
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
      try { parsed = JSON.parse(sampleInput); } catch { throw new Error('Sample input must be valid JSON'); }
      const result = await api.post<PipelinePreview>('/api/v1/pipelines/preview', { definition, sampleInput: parsed, maxRecords: 50 });
      setPreview(result);
    } catch (cause) { setPreviewError((cause as Error).message); } finally { setPreviewBusy(false); }
  };
  return (
    <div className="page-stack studio-page">
      <PageHeader
        eyebrow="Studio"
        title={definition.name}
        description={<span className="mono">{pipelineId} · r{definition.revision} · {draft ? `draft v${draft.version}` : 'published read-only'} · {dirty ? 'unsaved changes' : 'saved'}</span>}
        actions={<>
          <button className="btn btn-secondary" onClick={undo} disabled={!history.length}><Icon name="rotate" size={15} /> Undo</button>
          <button className="btn btn-secondary" onClick={redo} disabled={!future.length}>Redo</button>
          <button className="btn btn-secondary" onClick={autoLayout}><Icon name="layout" size={15} /> Auto layout</button>
          <button className="btn btn-secondary" onClick={() => changeLayout(layoutDirection === 'horizontal' ? 'vertical' : 'horizontal')} title="Toggle horizontal / vertical layout"><Icon name="refresh" size={15} /> {layoutDirection === 'horizontal' ? 'Horizontal' : 'Vertical'}</button>
          <button className={`btn btn-secondary ${previewOpen ? 'active' : ''}`} onClick={() => setPreviewOpen((value) => !value)}><Icon name="play" size={15} /> Preview</button>
          <Link className="btn btn-secondary" to={`/pipelines/${encodeURIComponent(pipelineId)}`}>Detail</Link>
          {!hasDraft ? <button className="btn btn-primary" onClick={() => void createDraft()} disabled={busy !== null}><Icon name="plus" size={15} /> Create draft</button> : <>
            <button className="btn btn-secondary" onClick={() => void saveDraft()} disabled={busy !== null || !dirty}><Icon name="save" size={15} /> {busy === 'save' ? 'Saving…' : 'Save draft'}</button>
            <button className="btn btn-secondary" onClick={() => void validate()} disabled={busy !== null}><Icon name="check" size={15} /> {busy === 'validate' ? 'Validating…' : 'Validate'}</button>
            <button className="btn btn-primary" onClick={() => void publish()} disabled={!canPublish || busy !== null} title={!serverValidation?.valid ? 'Run server validation first' : dirty ? 'Save before publish' : 'Publish this draft'}><Icon name="upload" size={15} /> {busy === 'publish' ? 'Publishing…' : 'Publish'}</button>
          </>}
        </>}
      />
      {notice && <div className="studio-banner" role="status"><Icon name="check" size={14} /> {notice}</div>}
      {conflict && <div className="studio-banner studio-banner-error studio-conflict" role="alert">
        <Icon name="warning" size={14} />
        <div className="conflict-copy"><strong>{conflict}</strong><span>Local changes are preserved. Server version: {conflictLatest ? `v${conflictLatest.version}` : 'unknown'}.</span>
          {conflictLatest && (() => {
            const diff = definitionDiff(definition, conflictLatest.definition);
            return <div className="conflict-diff" aria-label="Draft definition diff">
              {diff.nodes.length === 0 && diff.edgesAdded.length === 0 && diff.edgesRemoved.length === 0 && <p className="muted small">No structural difference detected; the server revision changed independently.</p>}
              {diff.nodes.map((entry) => <div key={entry.nodeId} className="diff-node">
                <div className="diff-node-head"><strong>{entry.label}</strong><span className="mono">{entry.nodeId}</span><span className={`tag diff-${entry.kind}`}>{entry.kind}</span></div>
                {entry.changes.map((change) => <div key={change.path} className="diff-field"><code>{change.path}</code><span><em>Yours</em> {change.local}</span><span><em>Server</em> {change.server}</span></div>)}
              </div>)}
              {diff.edgesAdded.length > 0 && <p className="small"><strong>Server-only edges:</strong> {diff.edgesAdded.join(', ')}</p>}
              {diff.edgesRemoved.length > 0 && <p className="small"><strong>Local-only edges:</strong> {diff.edgesRemoved.join(', ')}</p>}
            </div>;
          })()}
        </div>
        <div className="conflict-actions">
          <button className="btn btn-secondary btn-small" onClick={() => setConflict(null)}>Keep editing</button>
          <button className="btn btn-secondary btn-small" onClick={() => { if (window.confirm('Discard local changes and load the latest server draft?')) { setConflict(null); void load(draft?.draftId); } }}>Reload latest</button>
          <button className="btn btn-primary btn-small" disabled={!conflictLatest || busy !== null} onClick={() => { if (window.confirm('Overwrite the newer server draft with your local version?')) { setConflict(null); void saveDraft(conflictLatest?.version); } }}>Use local &amp; retry</button>
        </div>
      </div>}
      {drafts.length > 0 && <section className="panel panel-pad studio-drafts"><strong>Saved drafts</strong><div className="draft-row">{drafts.map((item) => <button key={item.draftId} className={`btn btn-secondary btn-small ${draft?.draftId === item.draftId ? 'active' : ''}`} onClick={() => navigate(`/pipelines/${encodeURIComponent(pipelineId)}/editor?draft=${item.draftId}`)}>v{item.version} · {new Date(item.updatedAt).toLocaleString()}</button>)}</div></section>}
      <div className="studio-shell">
        <aside className="panel panel-pad studio-palette">
          <h2>Node palette</h2><p className="muted small">Typed nodes from the current revision.</p>
          {definition.nodes.map((node) => <div key={node.nodeId} className="palette-item" role="button" tabIndex={0} onClick={() => setSelectedId(node.nodeId)} onKeyDown={(event) => { if (event.key === 'Enter') setSelectedId(node.nodeId); }}><Icon name="box" size={15} /><span><strong>{nodeLabel(node.type)}</strong><small className="mono">{node.nodeId}</small></span></div>)}
        </aside>
        <section className="panel studio-canvas" aria-label="Pipeline canvas">
          <div className="mobile-view-toggle" role="group" aria-label="Editor view">
            <button className={mobileView === 'nodes' ? 'active' : ''} onClick={() => setMobileView('nodes')}>Nodes</button>
            <button className={mobileView === 'canvas' ? 'active' : ''} onClick={() => setMobileView('canvas')}>Canvas</button>
          </div>
          {mobileView === 'nodes' ? <div className="mobile-node-list">{definition.nodes.map((node, index) => <button key={node.nodeId} className={selectedId === node.nodeId ? 'active' : ''} onClick={() => setSelectedId(node.nodeId)}><span className="flow-index">{index + 1}</span><span><strong>{nodeLabel(node.type)}</strong><small>{node.nodeId}</small></span><span className="muted small">{node.outputs.length} out</span></button>)}</div> : <GraphCanvas direction={layoutDirection} layoutNonce={layoutNonce} nodes={graph.nodes} edges={graph.edges} selectedId={selectedId} onNodesChange={(nodes) => update({ ...graph, nodes })} onEdgesChange={(edges) => update({ ...graph, edges })} onConnectAttempt={connect} onSelect={setSelectedId} />}
          {connectionError && <div className="studio-error" role="alert"><Icon name="warning" size={14} /> {connectionError}</div>}
          <p className="studio-note"><Icon name="alert" size={13} /> Local edits are not persisted until Save draft. Publish requires server validation.</p>
        </section>
        <aside className="panel panel-pad studio-inspector">
          <h2>Inspector</h2>
          {selected ? <>
            {!hasDraft && <p className="muted small">Create a draft to edit this configuration.</p>}
            <p className="mono small">{selected.nodeId}</p><p className="muted small">{selected.type} · typeVersion {selected.typeVersion}</p>
            <h3>Configuration</h3>
            <NodeConfigForm key={selected.nodeId} node={selected} readOnly={!hasDraft} onChange={(key, value) => updateConfig(selected.nodeId, key, value)} />
            <details className="advanced"><summary>Advanced · type, ports and raw config</summary><p className="mono small">{selected.type} · v{selected.typeVersion}</p><pre>{JSON.stringify(selected.config, null, 2)}</pre></details>
            <h3>Ports</h3><ul className="port-list">{selected.inputs.map((port) => <li key={port.name}><span>{port.name}</span><code>{port.dataType}</code><small>input{port.required ? ' · required' : ''}</small></li>)}{selected.outputs.map((port) => <li key={port.name}><span>{port.name}</span><code>{port.dataType}</code><small>output{port.nullable ? ' · nullable' : ''}</small></li>)}</ul>
          </> : <p className="muted small">Select a node to edit its typed config.</p>}
          <h3>Validation <span className={errors.length === 0 ? 'text-ok' : 'text-danger'}>{errors.length}</span></h3>
          {errors.length === 0 ? <p className="muted small">No local graph errors.</p> : <ul className="validation-list">{errors.map((item, index) => <li key={`${item.code}-${index}`}><button onClick={() => item.nodeId && setSelectedId(item.nodeId)}><strong>{item.code}</strong><span>{item.message}</span></button></li>)}</ul>}
          {serverValidation && <p className="muted small">{serverValidation.valid ? `Server validated · ${serverValidation.planDigest}` : 'Server rejected this graph'}</p>}
        </aside>
      </div>
      {previewOpen && <section className="panel panel-pad studio-preview" aria-label="Preview panel">
        <div className="panel-head"><div><h2>Preview</h2><p className="muted small">Server-side pure transforms on bounded sample input. No Source IO and no Catalog writes.</p></div><button className="btn btn-secondary" onClick={() => void runPreview()} disabled={previewBusy}>{previewBusy ? 'Previewing…' : 'Run preview'}</button></div>
        <label className="preview-input"><span>Sample input (JSON object or array)</span><textarea rows={6} value={sampleInput} onChange={(event) => setSampleInput(event.target.value)} /></label>
        {previewError && <div className="studio-banner studio-banner-error" role="alert"><Icon name="warning" size={14} /> {previewError}</div>}
        {preview && <>
          <div className="preview-summary"><strong>{preview.status}</strong><span>{preview.processedRecords} records</span><span>{preview.elapsedMs} ms</span>{preview.truncated && <span className="tag">TRUNCATED</span>}</div>
          {preview.errors.length > 0 && <ul className="validation-list">{preview.errors.map((item, index) => <li key={`${item.code}-${index}`}><button onClick={() => item.nodeId && setSelectedId(item.nodeId)}><strong>{item.code}</strong><span>{item.message}</span></button></li>)}</ul>}
          <div className="preview-grid">{preview.nodeOutputs.map((node) => <article className="panel preview-node" key={node.nodeId}><div className="pipeline-node-head"><strong>{node.nodeId}</strong><span className="tag">{node.outputCount}</span></div><small className="mono">{node.nodeType}</small><p className="muted small">in {node.inputCount} → out {node.outputCount} · {node.durationMs} ms</p>{node.errors.map((error) => <p className="text-danger small" key={error.code}>{error.code}: {error.message}</p>)}<pre>{JSON.stringify(node.sampleRows, null, 2)}</pre></article>)}</div>
        </>}
        {!preview && !previewError && <p className="muted small">Preview is not a job. It cannot produce a Sink Effect or Receipt.</p>}
      </section>}
    </div>
  );
}

function NodeConfigForm({ node, readOnly, onChange }: { node: { config: Record<string, unknown>; type: string }; readOnly: boolean; onChange: (key: string, value: unknown) => void }) {
  const entries = useMemo(() => Object.entries(node.config || {}), [node.config]);
  return (
    <div className="config-form">
      {entries.length === 0 && <p className="muted small">This node has no configurable fields.</p>}
      {entries.map(([key, value]) => {
        const id = `${node.type}-${key}`;
        if (typeof value === 'number') return <label key={key} htmlFor={id}><span>{key}</span><input id={id} type="number" value={value} disabled={readOnly} onChange={(event) => onChange(key, Number(event.target.value))} /></label>;
        if (typeof value === 'boolean') return <label key={key} htmlFor={id} className="config-checkbox"><input id={id} type="checkbox" checked={value} disabled={readOnly} onChange={(event) => onChange(key, event.target.checked)} /><span>{key}</span></label>;
        if (typeof value === 'string') return <label key={key} htmlFor={id}><span>{key}</span><input id={id} value={value} disabled={readOnly} onChange={(event) => onChange(key, event.target.value)} /></label>;
        return <label key={key} htmlFor={id}><span>{key} (JSON)</span><textarea id={id} rows={5} defaultValue={JSON.stringify(value, null, 2)} disabled={readOnly} onChange={(event) => { try { onChange(key, JSON.parse(event.target.value)); } catch { /* keep last valid value until JSON parses */ } }} /></label>;
      })}
    </div>
  );
}
