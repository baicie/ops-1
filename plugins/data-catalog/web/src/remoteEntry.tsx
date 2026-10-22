import React, { useEffect, useState } from 'react';

declare const __PLUGIN_VERSION__: string;
type HostApi = { get(path: string): Promise<any>; post(path: string, body: unknown): Promise<any> };
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
@media(max-width:600px){ .dc-head{flex-direction:column;} .dc-table{display:block;overflow:auto;} }
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
  const [name, setName] = useState('');
  const [fields, setFields] = useState(JSON.stringify(starterFields, null, 2));
  const [busy, setBusy] = useState(false);
  async function load() { setLoading(true); setError(null); try { const result = await host.api.get('/api/data-catalog/datasets'); setDatasets(result.items || []); } catch (cause: any) { setError(cause?.message || 'Could not load datasets'); } finally { setLoading(false); } }
  async function open(dataset: any) { setSelected(dataset); try { const [s, l] = await Promise.all([host.api.get(`/api/data-catalog/datasets/${dataset.datasetId}/schemas`), host.api.get(`/api/data-catalog/datasets/${dataset.datasetId}/lineage`)]); setSchemas(s || []); setLineage(l || []); } catch (cause: any) { setError(cause?.message || 'Could not load schema'); } }
  async function create() { setBusy(true); setError(null); try { const parsed = JSON.parse(fields); const dataset = await host.api.post('/api/data-catalog/datasets', { name, fields: parsed, retentionPolicy: { mode: 'RETAIN', maxRecords: 10000, maxBytes: 16777216 } }); setName(''); await load(); await open(dataset); } catch (cause: any) { setError(cause?.message || 'Create failed'); } finally { setBusy(false); } }
  useEffect(() => { void load(); }, []);
  return <div className="dc">
    <header className="dc-head"><div><p className="dc-muted">data.catalog.v1 · {host.pluginId}</p><h1>Data Catalog</h1><p className="lead">Datasets own semantic Schema revisions. Schema revisions are immutable after publish; Preview and Ingestion are owned by Data Integration.</p></div><span className="dc-muted">revision {host.activationRevision}</span></header>
    {error && <div className="dc-error" role="alert">{error}</div>}
    <div className="dc-grid"><div className="dc-card"><h2>{datasets.length}</h2><span className="dc-muted">Datasets</span></div><div className="dc-card"><h2>{schemas.length}</h2><span className="dc-muted">Schema revisions {selected ? `· ${selected.name}` : ''}</span></div><div className="dc-card"><h2>{lineage.length}</h2><span className="dc-muted">Lineage batches {selected ? '' : '· select a dataset'}</span></div></div>
    <section className="dc-card"><div className="dc-head"><h2>Datasets</h2><button className="dc-btn" onClick={() => void load()} disabled={loading}>Refresh</button></div>{loading ? <p className="dc-muted">Loading…</p> : datasets.length === 0 ? <div className="dc-empty">No datasets yet. Create one below.</div> : <table className="dc-table"><thead><tr><th>Name</th><th>Schema</th><th>Owner</th><th>Updated</th></tr></thead><tbody>{datasets.map((dataset) => <tr className="dc-row" key={dataset.datasetId} onClick={() => void open(dataset)}><td>{dataset.name}</td><td>r{dataset.schemaRevision}</td><td>{dataset.ownerPluginId}</td><td>{new Date(dataset.updatedAt).toLocaleString()}</td></tr>)}</tbody></table>}</section>
    <section className="dc-card"><h2>Create dataset</h2><p className="dc-muted">The first schema revision is published immediately. Create later revisions as drafts and publish compatible changes.</p><div className="dc-form"><label>Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="host-metrics" /></label><label>Fields JSON<textarea value={fields} onChange={(event) => setFields(event.target.value)} spellCheck={false} /></label><button className="dc-btn primary" onClick={() => void create()} disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create dataset'}</button></div></section>
    {selected && <section className="dc-card"><div className="dc-head"><h2>{selected.name}</h2><span className="dc-muted">datasetId {selected.datasetId}</span></div><h3>Schema revisions</h3><pre className="dc-pre">{JSON.stringify(schemas, null, 2)}</pre><h3>Lineage</h3><pre className="dc-pre">{JSON.stringify(lineage, null, 2)}</pre></section>}
  </div>;
}
export function register(host: DataHost) { return { components: { 'catalog-page': () => <CatalogPage host={host} /> }, navigation: { 'data-catalog-nav': { label: 'Data Catalog', order: 30 } } }; }
(window as any).__OPSWEAVE_REMOTES__ = (window as any).__OPSWEAVE_REMOTES__ || {};
(window as any).__OPSWEAVE_REMOTES__['opsweave.data-catalog'] = { register };
export { CatalogPage };
