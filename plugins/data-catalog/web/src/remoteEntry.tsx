import React, { useEffect, useState } from 'react';

declare const __PLUGIN_VERSION__: string;
type HostApi = { get(path: string): Promise<any>; post(path: string, body: unknown, idempotencyKey?: string): Promise<any> };
export type DataHost = { pluginId: string; version: string; activationRevision: number; api: HostApi };
const css = `
.dc { display:flex; flex-direction:column; gap:18px; }
.dc-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; flex-wrap:wrap; }
.dc h1 { margin:0; font-size:26px; color:var(--ow-text); }
.dc p.lead { margin:6px 0 0; color:var(--ow-text-secondary); max-width:760px; line-height:1.5; }
.dc-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
.dc-card { border:1px solid var(--ow-border); background:var(--ow-surface); border-radius:12px; padding:16px; }
.dc-card h2 { margin:0 0 6px; font-size:15px; }
.dc-muted { color:var(--ow-text-muted); font-size:12px; }
.dc-table { width:100%; border-collapse:collapse; font-size:13px; }
.dc-table th,.dc-table td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--ow-border); vertical-align:top; }
.dc-table th { color:var(--ow-text-muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
.dc-row { cursor:pointer; }
.dc-row:hover { background:var(--ow-surface-2); }
.dc-form { display:flex; flex-direction:column; gap:10px; max-width:620px; }
.dc-form label { display:flex; flex-direction:column; gap:5px; font-size:12px; color:var(--ow-text-secondary); }
.dc-form input,.dc-form textarea { font:inherit; color:var(--ow-text); background:var(--ow-surface); border:1px solid var(--ow-border); border-radius:7px; padding:8px 10px; }
.dc-form textarea { min-height:120px; font-family:ui-monospace,monospace; font-size:12px; }
.dc-actions { display:flex; gap:8px; flex-wrap:wrap; }
.dc-btn { border:1px solid var(--ow-border); background:var(--ow-surface); color:var(--ow-text); border-radius:7px; padding:7px 12px; font:inherit; font-size:13px; cursor:pointer; }
.dc-btn.primary { background:var(--ow-accent); color:var(--ow-accent-text); border-color:var(--ow-accent); }
.dc-btn:disabled { opacity:.5; cursor:not-allowed; }
.dc-error { border:1px solid #c74a4a; background:color-mix(in srgb,#c74a4a 8%,var(--ow-surface)); color:var(--ow-text); padding:12px; border-radius:8px; white-space:pre-wrap; }
.dc-pre { margin:0; padding:12px; background:var(--ow-code-bg); color:var(--ow-code-text); border-radius:8px; overflow:auto; max-height:300px; font-size:12px; }
.dc-empty { padding:28px; text-align:center; color:var(--ow-text-muted); border:1px dashed var(--ow-border); border-radius:10px; }
@media(max-width:700px){
  .dc-head{flex-direction:column;}
  .dc-table,.dc-table tbody,.dc-table tr,.dc-table td{display:block;width:100%;}
  .dc-table thead{display:none;}
  .dc-table tr{border:1px solid var(--ow-border);border-radius:9px;margin:8px 0;padding:8px 10px;background:var(--ow-surface);}
  .dc-table td{border:0;padding:4px 0;}
  .dc-table td::before{content:attr(data-label) ": ";color:var(--ow-text-muted);font-weight:600;}
}
`;
function useStyles() { useEffect(() => { if (document.getElementById('ow-data-catalog-styles')) return; const style = document.createElement('style'); style.id = 'ow-data-catalog-styles'; style.textContent = css; document.head.appendChild(style); }, []); }
const starterFields = [
  { name: 'id', type: 'string', nullable: false, ordinal: 0, semanticTags: ['identifier'] },
  { name: 'name', type: 'string', nullable: true, ordinal: 1 },
  { name: 'observed_at', type: 'timestamp', nullable: true, ordinal: 2 },
];
function CatalogPage({ host }: { host: DataHost }) {
  useStyles();
  const [datasets, setDatasets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<any>(null);
  const [schemas, setSchemas] = useState<any[]>([]);
  const [lineage, setLineage] = useState<any[]>([]);
  const [lineageDetail, setLineageDetail] = useState<any>(null);
  const [lineageCursor, setLineageCursor] = useState<string | null>(null);
  const [draftFields, setDraftFields] = useState('');
  const [draftBase, setDraftBase] = useState(1);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [diff, setDiff] = useState<any>(null);
  const [records, setRecords] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [fields, setFields] = useState(JSON.stringify(starterFields, null, 2));
  const [busy, setBusy] = useState(false);
  async function load() { setLoading(true); setError(null); try { const result = await host.api.get('/api/data-catalog/datasets'); setDatasets(result.items || []); } catch (cause: any) { setError(cause?.message || 'Could not load datasets'); } finally { setLoading(false); } }
  async function open(dataset: any) { setSelected(dataset); try { const [s, l] = await Promise.all([host.api.get(`/api/data-catalog/datasets/${dataset.datasetId}/schemas`), host.api.get(`/api/data-catalog/datasets/${dataset.datasetId}/lineage?limit=50`)]); setSchemas(s || []); setLineage(l?.items || []); setLineageCursor(l?.nextCursor || null); const latest = (s || [])[0]; if (latest) { setDraftBase(latest.schemaRevision); setDraftFields(JSON.stringify(latest.fields, null, 2)); } } catch (cause: any) { setError(cause?.message || 'Could not load schema'); } }
  async function loadRecords() { if (!selected) return; setBusy(true); try { const result = await host.api.get(`/api/data-catalog/datasets/${selected.datasetId}/records?limit=100`); setRecords(result.items || []); } catch (cause: any) { setError(cause?.message || 'Could not load records'); } finally { setBusy(false); } }
  async function createDraft() { if (!selected) return; setBusy(true); setError(null); try { const draft = await host.api.post(`/api/data-catalog/datasets/${selected.datasetId}/schemas/drafts`, { baseRevision: draftBase, fields: JSON.parse(draftFields) }); setDraftRevision(draft.schemaRevision); const result = await host.api.get(`/api/data-catalog/datasets/${selected.datasetId}/schemas/${draft.schemaRevision}/diff?against=${draftBase}`); setDiff(result); await open(selected); } catch (cause: any) { setError(cause?.message || 'Could not create schema draft'); } finally { setBusy(false); } }
  async function publishDraft() { if (!selected || !draftRevision) return; setBusy(true); setError(null); try { await host.api.post(`/api/data-catalog/datasets/${selected.datasetId}/schemas/${draftRevision}/publish`, {}); setDraftRevision(null); setDiff(null); await open(selected); } catch (cause: any) { setError(cause?.message || 'Could not publish schema revision'); } finally { setBusy(false); } }
  async function create() { setBusy(true); setError(null); try { const parsed = JSON.parse(fields); const dataset = await host.api.post('/api/data-catalog/datasets', { name, fields: parsed, retentionPolicy: { mode: 'RETAIN', maxRecords: 10000, maxBytes: 16777216 } }); setName(''); await load(); await open(dataset); } catch (cause: any) { setError(cause?.message || 'Create failed'); } finally { setBusy(false); } }
  useEffect(() => { void load(); }, []);
  return <div className="dc">
    <header className="dc-head"><div><p className="dc-muted">data.catalog.v1 · {host.pluginId}</p><h1>Data Catalog</h1><p className="lead">Datasets own semantic Schema revisions. Schema revisions are immutable after publish; Preview and Ingestion are owned by Data Integration.</p></div><span className="dc-muted">revision {host.activationRevision}</span></header>
    {error && <div className="dc-error" role="alert">{error}</div>}
    <div className="dc-grid"><div className="dc-card"><h2>{datasets.length}</h2><span className="dc-muted">Datasets</span></div><div className="dc-card"><h2>{schemas.length}</h2><span className="dc-muted">Schema revisions {selected ? `· ${selected.name}` : ''}</span></div><div className="dc-card"><h2>{lineage.length}</h2><span className="dc-muted">Lineage batches {selected ? '' : '· select a dataset'}</span></div></div>
    <section className="dc-card"><div className="dc-head"><h2>Datasets</h2><button className="dc-btn" onClick={() => void load()} disabled={loading}>Refresh</button></div>{loading ? <p className="dc-muted">Loading…</p> : datasets.length === 0 ? <div className="dc-empty">No datasets yet. Create one below.</div> : <table className="dc-table"><thead><tr><th>Name</th><th>Schema</th><th>Owner</th><th>Updated</th></tr></thead><tbody>{datasets.map((dataset) => <tr className="dc-row" key={dataset.datasetId} onClick={() => void open(dataset)}><td data-label="Name">{dataset.name}</td><td data-label="Schema">r{dataset.schemaRevision}</td><td data-label="Owner">{dataset.ownerPluginId}</td><td data-label="Updated">{new Date(dataset.updatedAt).toLocaleString()}</td></tr>)}</tbody></table>}</section>
    <section className="dc-card"><h2>Create dataset</h2><p className="dc-muted">The first schema revision is published immediately. Create later revisions as drafts and publish compatible changes.</p><div className="dc-form"><label>Name<input data-testid="catalog-dataset-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="host-metrics" /></label><label>Fields JSON<textarea data-testid="catalog-dataset-fields" value={fields} onChange={(event) => setFields(event.target.value)} spellCheck={false} /></label><button data-testid="catalog-create-dataset" className="dc-btn primary" onClick={() => void create()} disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create dataset'}</button></div></section>
    {selected && <section className="dc-card" data-testid="catalog-dataset-detail"><div className="dc-head"><h2>{selected.name}</h2><span className="dc-muted" data-testid="catalog-dataset-id">datasetId {selected.datasetId}</span></div><h3>Schema revisions</h3><pre data-testid="catalog-schema-revisions" className="dc-pre">{JSON.stringify(schemas, null, 2)}</pre><div className="dc-form"><label>Draft fields JSON (base r{draftBase})<textarea data-testid="catalog-draft-fields" value={draftFields} onChange={(event) => setDraftFields(event.target.value)} spellCheck={false} /></label><div className="dc-actions"><button data-testid="catalog-create-draft" className="dc-btn" onClick={() => void createDraft()} disabled={busy}>Create compatible draft</button>{draftRevision && <button data-testid="catalog-publish-draft" className="dc-btn primary" onClick={() => void publishDraft()} disabled={busy}>Publish r{draftRevision}</button>}</div></div>{diff && <pre data-testid="catalog-schema-diff" className="dc-pre">{JSON.stringify(diff, null, 2)}</pre>}<div className="dc-actions"><button data-testid="catalog-load-records" className="dc-btn" onClick={() => void loadRecords()} disabled={busy}>Load records</button></div>{records.length > 0 && <pre data-testid="catalog-records" className="dc-pre">{JSON.stringify(records, null, 2)}</pre>}<h3>Lineage</h3>
      <p className="dc-muted">Source → Pipeline → Dataset. Missing historical metadata is shown as UNKNOWN, never inferred.</p>
      {lineage.length === 0 ? <div className="dc-empty">No lineage yet. Run a pipeline into this dataset.</div> : <table className="dc-table"><thead><tr><th>Source</th><th>Pipeline</th><th>Job</th><th>Records</th><th>Metadata</th><th>Time</th></tr></thead><tbody>{lineage.map((item) => <tr className="dc-row" key={item.lineageId} onClick={() => void host.api.get(`/api/data-catalog/datasets/${selected.datasetId}/lineage/${item.lineageId}`).then(setLineageDetail).catch((cause: any) => setError(cause?.message || 'Lineage detail failed'))}><td data-label="Source">{item.sourceIdentity || item.sourceBatchKey}</td><td data-label="Pipeline">{item.pipeline ? `${item.pipeline.pipelineId} · r${item.pipeline.revision}` : 'UNKNOWN'}</td><td data-label="Job">{item.job?.jobId || 'UNKNOWN'}</td><td data-label="Records">{item.accepted} accepted / {item.rejected} rejected</td><td data-label="Metadata">{item.metadataStatus}</td><td data-label="Time">{new Date(item.occurredAt).toLocaleString()}</td></tr>)}</tbody></table>}
      {lineageCursor && <button className="dc-btn" onClick={() => void host.api.get(`/api/data-catalog/datasets/${selected.datasetId}/lineage?limit=50&cursor=${encodeURIComponent(lineageCursor)}`).then((page) => { setLineage((items) => [...items, ...(page.items || [])]); setLineageCursor(page.nextCursor || null); }).catch((cause: any) => setError(cause?.message || 'Lineage page failed'))}>Load more</button>}
      {lineageDetail && <div className="dc-card"><div className="dc-head"><h3>Lineage detail</h3><button className="dc-btn" onClick={() => setLineageDetail(null)}>Close</button></div><pre data-testid="catalog-lineage-detail" className="dc-pre">{JSON.stringify(lineageDetail, null, 2)}</pre></div>}
      <pre data-testid="catalog-lineage" className="dc-pre">{JSON.stringify(lineage, null, 2)}</pre></section>}
  </div>;
}
export function register(host: DataHost) { return { components: { 'catalog-page': () => <CatalogPage host={host} /> }, navigation: { 'data-catalog-nav': { label: 'Data Catalog', order: 30 } } }; }
(window as any).__OPSWEAVE_REMOTES__ = (window as any).__OPSWEAVE_REMOTES__ || {};
(window as any).__OPSWEAVE_REMOTES__['opsweave.data-catalog'] = { register };
export { CatalogPage };
