import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { PipelineDefinition, PipelineDetail, PipelineList, PipelineRevision } from '../types';
import { Icon } from '../components/Icons';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';
import { useDocumentTitle } from '../hooks';
import { GraphCanvas } from '../studio/GraphCanvas';
import { toGraph, fromGraph } from '../studio/ir/adapter';
import type { GraphEdge, GraphNode } from '../studio/ir/types';
import { validatePipeline } from '../studio/ir/validation';

export function PipelinesPage() {
  useDocumentTitle('Pipelines');
  const [data, setData] = useState<PipelineList | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const path = `/api/v1/pipelines?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    api.get<PipelineList>(path)
      .then((result) => { if (!cancelled) { setData(result); setError(null); } })
      .catch((cause) => { if (!cancelled) setError(cause as Error); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cursor]);

  const items = (data?.items || []).filter((item) =>
    `${item.name} ${item.pipelineId}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="page-stack">
      <PageHeader
        title="Pipelines"
        description="Published typed pipelines and their immutable revisions. Editing is the next Studio milestone."
        actions={<button className="btn btn-secondary" onClick={() => setCursor(null)}><Icon name="refresh" size={15} /> Refresh</button>}
      />
      <section className="toolbar">
        <div className="search-box"><Icon name="search" size={16} /><input aria-label="Search pipelines" placeholder="Search by name or pipeline id" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <span className="toolbar-count">{items.length} shown</span>
      </section>
      {loading && !data ? <Skeleton rows={5} /> : error ? <ErrorState error={error} onRetry={() => setCursor(cursor)} /> : items.length === 0 ? (
        <EmptyState icon="file" title={data?.items.length ? 'No pipelines match this filter' : 'No pipelines yet'} description={data?.items.length ? 'Clear the search or refresh the list.' : 'Create a pipeline through the typed-pipeline API. The Studio editor is the next milestone.'} />
      ) : (
        <section className="panel table-panel">
          <table className="data-table">
            <thead><tr><th>Pipeline</th><th>Revision</th><th>Created</th><th>Updated</th><th aria-label="Open" /></tr></thead>
            <tbody>
              {items.map((pipeline) => (
                <tr key={pipeline.pipelineId} className="clickable" tabIndex={0}>
                  <td><Link to={`/pipelines/${encodeURIComponent(pipeline.pipelineId)}`}><strong>{pipeline.name}</strong><span className="mono block">{pipeline.pipelineId}</span></Link></td>
                  <td><span className="mono">r{pipeline.latestRevision}</span></td>
                  <td><TimeAgo value={pipeline.createdAt} /></td>
                  <td><TimeAgo value={pipeline.updatedAt} /></td>
                  <td className="row-action"><Icon name="chevron" size={16} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <div className="pagination-row">
        <button className="btn btn-secondary" disabled={!cursor} onClick={() => { setCursor(null); }}>First page</button>
        <button className="btn btn-secondary" disabled={!data?.nextCursor} onClick={() => setCursor(data?.nextCursor || null)}>Next page <Icon name="arrowRight" size={14} /></button>
      </div>
    </div>
  );
}

function NodeSummary({ definition }: { definition: PipelineDefinition }) {
  return (
    <div className="pipeline-node-grid">
      {definition.nodes.map((node) => (
        <div key={node.nodeId} className="panel pipeline-node-card">
          <div className="pipeline-node-head"><strong>{node.nodeId}</strong><StatusBadge status="READY" label="typed" /></div>
          <span className="mono small">{node.type}</span>
          <div className="port-row"><span>inputs</span><code>{node.inputs.map((p) => p.name).join(', ') || '—'}</code></div>
          <div className="port-row"><span>outputs</span><code>{node.outputs.map((p) => p.name).join(', ') || '—'}</code></div>
        </div>
      ))}
    </div>
  );
}

export function PipelineDetailPage() {
  const { pipelineId = '' } = useParams();
  useDocumentTitle('Pipeline detail');
  const [detail, setDetail] = useState<PipelineDetail | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.get<PipelineDetail>(`/api/v1/pipelines/${encodeURIComponent(pipelineId)}`)
      .then((result) => { if (!cancelled) { setDetail(result); setError(null); } })
      .catch((cause) => { if (!cancelled) setError(cause as Error); });
    return () => { cancelled = true; };
  }, [pipelineId]);
  if (error) return <ErrorState error={error} />;
  if (!detail) return <Skeleton rows={6} />;
  const latest = detail.latest;
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Pipeline"
        title={detail.name}
        description={<span className="mono">{detail.pipelineId}</span>}
        actions={<><Link className="btn btn-secondary" to="/pipelines"><Icon name="arrowRight" size={15} /> All pipelines</Link><Link className="btn btn-primary" to={`/pipelines/${encodeURIComponent(detail.pipelineId)}/editor`}><Icon name="ops" size={15} /> Open Studio</Link></>}
      />
      <section className="summary-grid">
        <div className="panel metric-card"><span className="metric-label">Latest revision</span><strong className="metric-value">r{detail.latestRevision}</strong></div>
        <div className="panel metric-card"><span className="metric-label">Nodes</span><strong className="metric-value">{latest?.definition.nodes.length ?? 0}</strong></div>
        <div className="panel metric-card"><span className="metric-label">Digest</span><strong className="metric-value mono small">{latest?.digest?.replace('sha256:', '').slice(0, 16) || '—'}…</strong></div>
        <div className="panel metric-card"><span className="metric-label">Published</span><strong className="metric-value small"><TimeAgo value={latest?.publishedAt} /></strong></div>
      </section>
      {latest ? <section className="panel panel-pad"><div className="panel-head"><div><h2>Latest revision</h2><p className="muted small">{latest.definition.name} · {latest.digest}</p></div><StatusBadge status="READY" label="IMMUTABLE" /></div><NodeSummary definition={latest.definition} /></section> : <EmptyState icon="file" title="No published revision" />}
      <section className="panel panel-pad">
        <div className="panel-head"><div><h2>Revision history</h2><p className="muted small">Published revisions are immutable.</p></div></div>
        {detail.revisions.length === 0 ? <EmptyState icon="clock" title="No revisions" /> : (
          <ul className="revision-list">{detail.revisions.map((revision) => (
            <li key={revision.revision}><span className="mono">r{revision.revision}</span><span className="mono muted small">{revision.digest}</span><StatusBadge status="READY" label={revision.status} /><TimeAgo value={revision.publishedAt} /></li>
          ))}</ul>
        )}
      </section>
      <p className="table-footnote"><Icon name="alert" size={13} /> Studio currently reads published revisions. Draft editing and publishing are separate gates.</p>
    </div>
  );
}

export function PipelineEditorPage() {
  const { pipelineId = '' } = useParams();
  useDocumentTitle('Pipeline Studio');
  const [revision, setRevision] = useState<PipelineRevision | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ nodes: GraphNode[]; edges: GraphEdge[] }>>([]);
  const [future, setFuture] = useState<Array<{ nodes: GraphNode[]; edges: GraphEdge[] }>>([]);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get<PipelineDetail>(`/api/v1/pipelines/${encodeURIComponent(pipelineId)}`)
      .then((detail) => {
        if (cancelled) return;
        if (!detail.latest) { setError(new Error('No published revision')); return; }
        setRevision(detail.latest);
        setGraph(toGraph(detail.latest.definition));
      })
      .catch((cause) => { if (!cancelled) setError(cause as Error); });
    return () => { cancelled = true; };
  }, [pipelineId]);

  if (error) return <ErrorState error={error} />;
  if (!revision || !graph) return <Skeleton rows={8} />;
  const definition = fromGraph(revision.definition, graph);
  const validation = validatePipeline(definition);
  const selected = definition.nodes.find((node) => node.nodeId === selectedId) || null;
  const update = (next: { nodes: GraphNode[]; edges: GraphEdge[] }, markDirty = true) => {
    setHistory((items) => [...items.slice(-19), graph]);
    setFuture([]);
    setGraph(next);
    if (markDirty) setDirty(true);
  };
  const undo = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setFuture((items) => [graph, ...items]);
    setGraph(previous);
    setHistory((items) => items.slice(0, -1));
    setDirty(true);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    setHistory((items) => [...items, graph]);
    setGraph(next);
    setFuture((items) => items.slice(1));
    setDirty(true);
  };
  const connect = (connection: { source?: string | null; target?: string | null; sourceHandle?: string | null; targetHandle?: string | null }) => {
    const source = graph.nodes.find((node) => node.id === connection.source);
    const target = graph.nodes.find((node) => node.id === connection.target);
    if (!source || !target) return { ok: false, error: 'Connection endpoints are missing' };
    const from = source.data.ir.outputs.find((port) => port.name === connection.sourceHandle);
    const to = target.data.ir.inputs.find((port) => port.name === connection.targetHandle);
    if (!from || !to) return { ok: false, error: 'Port does not exist' };
    if (from.dataType !== to.dataType) {
      const message = `Type mismatch: ${from.dataType} → ${to.dataType}`;
      setConnectionError(message);
      return { ok: false, error: message };
    }
    setConnectionError(null);
    return { ok: true };
  };
  return (
    <div className="page-stack">
      <PageHeader eyebrow="Studio" title={revision.definition.name} description={<span className="mono">{pipelineId} · r{revision.revision} · {dirty ? 'local changes' : 'published revision'}</span>} actions={<><button className="btn btn-secondary" onClick={undo} disabled={!history.length}><Icon name="rotate" size={15} /> Undo</button><button className="btn btn-secondary" onClick={redo} disabled={!future.length}>Redo</button><Link className="btn btn-secondary" to={`/pipelines/${encodeURIComponent(pipelineId)}`}>Pipeline detail</Link><button className="btn btn-primary" disabled title="Draft/publish API is not part of this read-only Studio gate">Publish unavailable</button></>} />
      <div className="studio-shell">
        <aside className="panel panel-pad studio-palette">
          <h2>Node palette</h2><p className="muted small">Read-only palette from this revision.</p>
          {revision.definition.nodes.map((node) => <div key={node.nodeId} className="palette-item" onClick={() => setSelectedId(node.nodeId)}><Icon name="box" size={15} /><span><strong>{node.nodeId}</strong><small className="mono">{node.type}</small></span></div>)}
        </aside>
        <section className="panel studio-canvas" aria-label="Pipeline canvas">
          <GraphCanvas nodes={graph.nodes} edges={graph.edges} selectedId={selectedId} onNodesChange={(nodes) => update({ ...graph, nodes })} onEdgesChange={(edges) => update({ ...graph, edges })} onConnectAttempt={connect} onSelect={setSelectedId} />
          {connectionError && <div className="studio-error" role="alert"><Icon name="warning" size={14} /> {connectionError}</div>}
          <p className="studio-note"><Icon name="alert" size={13} /> Local editing only. Server validation and publish are a separate gate.</p>
        </section>
        <aside className="panel panel-pad studio-inspector">
          <h2>Inspector</h2>
          {selected ? <><p className="mono small">{selected.nodeId}</p><p className="muted small">{selected.type} · typeVersion {selected.typeVersion}</p><h3>Config</h3><pre>{JSON.stringify(selected.config, null, 2)}</pre><h3>Ports</h3><ul className="port-list">{selected.inputs.map((port) => <li key={port.name}><span>{port.name}</span><code>{port.dataType}</code><small>input{port.required ? ' · required' : ''}</small></li>)}{selected.outputs.map((port) => <li key={port.name}><span>{port.name}</span><code>{port.dataType}</code><small>output{port.nullable ? ' · nullable' : ''}</small></li>)}</ul></> : <p className="muted small">Select a node to inspect its typed config.</p>}
          <h3>Validation <span className={validation.valid ? 'text-ok' : 'text-danger'}>{validation.errors.length}</span></h3>
          {validation.errors.length === 0 ? <p className="muted small">No local graph errors.</p> : <ul className="validation-list">{validation.errors.map((item, index) => <li key={`${item.code}-${index}`}><button onClick={() => item.nodeId && setSelectedId(item.nodeId)}><strong>{item.code}</strong><span>{item.message}</span></button></li>)}</ul>}
        </aside>
      </div>
    </div>
  );
}
