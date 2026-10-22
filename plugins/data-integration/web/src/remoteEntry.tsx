import React, { useEffect, useState } from 'react';

declare const __PLUGIN_VERSION__: string;
type HostApi = { get(path: string): Promise<any>; post(path: string, body: unknown, idempotencyKey?: string): Promise<any> };
export type IntegrationHost = { pluginId: string; version: string; activationRevision: number; api: HostApi };
const css = `
.di { display:flex; flex-direction:column; gap:18px; }
.di-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; flex-wrap:wrap; }
.di h1 { margin:0; font-size:26px; color:var(--ow-text); }
.di p.lead { margin:6px 0 0; color:var(--ow-text-secondary); max-width:760px; line-height:1.5; }
.di-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
.di-card { border:1px solid var(--ow-border); background:var(--ow-surface); border-radius:12px; padding:16px; }
.di-card h2 { margin:0 0 6px; font-size:15px; }
.di-muted { color:var(--ow-text-muted); font-size:12px; }
.di-table { width:100%; border-collapse:collapse; font-size:13px; }
.di-table th,.di-table td { text-align:left; padding:10px 12px; border-bottom:1px solid var(--ow-border); vertical-align:top; }
.di-table th { color:var(--ow-text-muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
.di-form { display:flex; flex-direction:column; gap:10px; max-width:680px; }
.di-form label { display:flex; flex-direction:column; gap:5px; font-size:12px; color:var(--ow-text-secondary); }
.di-form input,.di-form textarea { font:inherit; color:var(--ow-text); background:var(--ow-surface); border:1px solid var(--ow-border); border-radius:7px; padding:8px 10px; }
.di-form textarea { min-height:110px; font-family:ui-monospace,monospace; font-size:12px; }
.di-actions { display:flex; gap:8px; flex-wrap:wrap; }
.di-btn { border:1px solid var(--ow-border); background:var(--ow-surface); color:var(--ow-text); border-radius:7px; padding:7px 12px; font:inherit; font-size:13px; cursor:pointer; }
.di-btn.primary { background:var(--ow-accent); color:var(--ow-accent-text); border-color:var(--ow-accent); }
.di-btn:disabled { opacity:.5; cursor:not-allowed; }
.di-error { border:1px solid #c74a4a; background:color-mix(in srgb,#c74a4a 8%,var(--ow-surface)); color:var(--ow-text); padding:12px; border-radius:8px; white-space:pre-wrap; }
.di-pre { margin:0; padding:12px; background:var(--ow-code-bg); color:var(--ow-code-text); border-radius:8px; overflow:auto; max-height:300px; font-size:12px; }
.di-empty { padding:28px; text-align:center; color:var(--ow-text-muted); border:1px dashed var(--ow-border); border-radius:10px; }
@media(max-width:700px){
  .di-head{flex-direction:column;}
  .di-table,.di-table tbody,.di-table tr,.di-table td{display:block;width:100%;}
  .di-table thead{display:none;}
  .di-table tr{border:1px solid var(--ow-border);border-radius:9px;margin:8px 0;padding:8px 10px;background:var(--ow-surface);}
  .di-table td{border:0;padding:4px 0;}
  .di-table td::before{content:attr(data-label) ": ";color:var(--ow-text-muted);font-weight:600;}
}
`;
function useStyles() { useEffect(() => { if (document.getElementById('ow-data-integration-styles')) return; const style = document.createElement('style'); style.id = 'ow-data-integration-styles'; style.textContent = css; document.head.appendChild(style); }, []); }
function IntegrationPage({ host }: { host: IntegrationHost }) {
  useStyles();
  const [sources, setSources] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [discovery, setDiscovery] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:18090/hosts.json');
  const [secretRef, setSecretRef] = useState('secret://local/http-json/source-1');
  const [mapping, setMapping] = useState(JSON.stringify([{ sourcePath: 'id', targetField: 'id', required: true, errorPolicy: 'REJECT_RECORD' }, { sourcePath: 'name', targetField: 'name', required: false, errorPolicy: 'SET_NULL', castTo: 'string' }, { sourcePath: 'observed_at', targetField: 'observed_at', required: false, errorPolicy: 'SET_NULL', castTo: 'timestamp' }], null, 2));
  const [datasetId, setDatasetId] = useState('');
  const [specId, setSpecId] = useState('');
  const [quality, setQuality] = useState<any>(null);
  const [lineage, setLineage] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  async function load() { try { const [s, r] = await Promise.all([host.api.get('/api/data-integration/sources'), host.api.get('/api/data-integration/ingestion-runs')]); setSources(s || []); setRuns(r || []); setError(null); } catch (cause: any) { setError(cause?.message || 'Could not load integration data'); } }
  async function create() { setBusy(true); try { const source = await host.api.post('/api/data-integration/sources', { name, connectorType: 'http-json', endpoint, credential: { credentialRef: secretRef, kind: 'none', maskedHint: 'local' } }); setName(''); await load(); setSelected(source); } catch (cause: any) { setError(cause?.message || 'Create source failed'); } finally { setBusy(false); } }
  async function test() { if (!selected) return; setBusy(true); try { const result = await host.api.post(`/api/data-integration/sources/${selected.sourceId}/test`, {}); setPreview(result); await load(); } catch (cause: any) { setError(cause?.message || 'Connection test failed'); } finally { setBusy(false); } }
  async function discover() { if (!selected) return; setBusy(true); try { setDiscovery(await host.api.post(`/api/data-integration/sources/${selected.sourceId}/discover`, {})); } catch (cause: any) { setError(cause?.message || 'Discovery failed'); } finally { setBusy(false); } }
  async function showPreview() { if (!selected) return; setBusy(true); try { setPreview(await host.api.post(`/api/data-integration/sources/${selected.sourceId}/preview`, { path: '/', limit: 5 })); } catch (cause: any) { setError(cause?.message || 'Preview failed'); } finally { setBusy(false); } }
  async function publishSpec() { if (!selected || !datasetId) return; setBusy(true); try { const spec = await host.api.post(`/api/data-integration/sources/${selected.sourceId}/ingestion-specs`, { sourceRevision: 1, schemaRevision: 1, targetDatasetId: datasetId, mappings: JSON.parse(mapping) }); setSpecId(spec.specId); await load(); } catch (cause: any) { setError(cause?.message || 'Publishing spec failed'); } finally { setBusy(false); } }
  async function runSpec() { if (!specId) return; setBusy(true); try { const run = await host.api.post(`/api/data-integration/ingestion-specs/${specId}/runs`, {}, crypto.randomUUID()); setQuality(null); setLineage(null); await load(); setSpecId(specId); return run; } catch (cause: any) { setError(cause?.message || 'Ingestion run failed'); } finally { setBusy(false); } }
  async function loadQuality(runId: string) { setBusy(true); try { setQuality(await host.api.get(`/api/data-integration/ingestion-runs/${runId}/quality`)); } catch (cause: any) { setError(cause?.message || 'Quality failed'); } finally { setBusy(false); } }
  async function loadLineage(runId: string) { setBusy(true); try { setLineage(await host.api.get(`/api/data-integration/ingestion-runs/${runId}/lineage`)); } catch (cause: any) { setError(cause?.message || 'Lineage failed'); } finally { setBusy(false); } }
  useEffect(() => { void load(); }, []);
  return <div className="di">
    <header className="di-head"><div><p className="di-muted">data.source.v1 · {host.pluginId}</p><h1>Data Integration</h1><p className="lead">HTTP/JSON sources are read through a bounded, SSRF-safe connector. Preview is read-only; ingestion calls Data Catalog through the versioned capability, never its database.</p></div><span className="di-muted">revision {host.activationRevision}</span></header>
    {error && <div className="di-error" role="alert">{error}</div>}
    <div className="di-grid"><div className="di-card"><h2>{sources.length}</h2><span className="di-muted">Sources</span></div><div className="di-card"><h2>{runs.length}</h2><span className="di-muted">Ingestion runs</span></div><div className="di-card"><h2>{discovery?.fields?.length || 0}</h2><span className="di-muted">Discovered fields</span></div></div>
    <section className="di-card"><div className="di-head"><h2>Sources</h2><button className="di-btn" onClick={() => void load()}>Refresh</button></div>{sources.length === 0 ? <div className="di-empty">No sources yet. Create one below.</div> : <table className="di-table"><thead><tr><th>Name</th><th>Type</th><th>Status</th><th>Endpoint</th></tr></thead><tbody>{sources.map((source) => <tr key={source.sourceId} onClick={() => setSelected(source)} style={{ cursor: 'pointer' }}><td data-label="Name">{source.name}</td><td data-label="Type">{source.connectorType}</td><td data-label="Status">{source.status}</td><td data-label="Endpoint" className="di-muted">{source.endpoint}</td></tr>)}</tbody></table>}</section>
    <section className="di-card"><h2>Create HTTP/JSON source</h2><div className="di-form"><label>Name<input data-testid="integration-source-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="host-json" /></label><label>Endpoint<input data-testid="integration-source-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label><label>Credential reference<input value={secretRef} onChange={(event) => setSecretRef(event.target.value)} /></label><button data-testid="integration-create-source" className="di-btn primary" onClick={() => void create()} disabled={busy || !name.trim()}>{busy ? 'Working…' : 'Create source'}</button></div></section>
    {selected && <section className="di-card"><div className="di-head"><h2>{selected.name}</h2><span className="di-muted">{selected.sourceId}</span></div><div className="di-actions"><button data-testid="integration-test" className="di-btn" onClick={() => void test()} disabled={busy}>Test connection</button><button data-testid="integration-discover" className="di-btn" onClick={() => void discover()} disabled={busy}>Discover fields</button><button data-testid="integration-preview" className="di-btn" onClick={() => void showPreview()} disabled={busy}>Preview (read-only)</button></div>{discovery && <pre data-testid="integration-discovery" className="di-pre">{JSON.stringify(discovery, null, 2)}</pre>}{preview && <pre data-testid="integration-preview-result" className="di-pre">{JSON.stringify(preview, null, 2)}</pre>}
      <h3>Publish manual ingestion spec</h3><div className="di-form"><label>Target Dataset ID<input data-testid="integration-dataset-id" value={datasetId} onChange={(event) => setDatasetId(event.target.value)} placeholder="UUID from Data Catalog" /></label><label>Field mapping JSON<textarea data-testid="integration-mapping" value={mapping} onChange={(event) => setMapping(event.target.value)} spellCheck={false} /></label><div className="di-actions"><button data-testid="integration-publish-spec" className="di-btn primary" onClick={() => void publishSpec()} disabled={busy || !datasetId}>Publish spec</button>{specId && <button data-testid="integration-run" className="di-btn" onClick={() => void runSpec()} disabled={busy}>Run once</button>}</div></div>{specId && <p className="di-muted">Published spec: {specId}</p>}</section>}
    <section className="di-card"><h2>Ingestion runs</h2>{runs.length === 0 ? <div className="di-empty">No runs yet. A run is triggered explicitly against a published spec.</div> : <table className="di-table"><thead><tr><th>Run</th><th>Status</th><th>Input</th><th>Accepted</th><th>Rejected</th><th>Unknown</th><th>Details</th></tr></thead><tbody>{runs.map((run) => <tr key={run.runId} data-testid="integration-run-row"><td data-label="Run" className="di-muted">{run.runId.slice(0, 8)}…</td><td data-label="Status">{run.status}</td><td data-label="Input">{run.inputCount ?? 0}</td><td data-label="Accepted">{run.accepted ?? 0}</td><td data-label="Rejected">{run.rejected ?? 0}</td><td data-label="Unknown">{run.unknown ?? 0}</td><td data-label="Details"><button className="di-btn" onClick={() => void loadQuality(run.runId)}>Quality</button> <button className="di-btn" onClick={() => void loadLineage(run.runId)}>Lineage</button></td></tr>)}</tbody></table>}</section>
    {quality && <section className="di-card" data-testid="integration-quality"><h2>Quality</h2><pre className="di-pre">{JSON.stringify(quality, null, 2)}</pre></section>}
    {lineage && <section className="di-card" data-testid="integration-lineage"><h2>Lineage</h2><pre className="di-pre">{JSON.stringify(lineage, null, 2)}</pre></section>}
  </div>;
}
export function register(host: IntegrationHost) { return { components: { 'integration-page': () => <IntegrationPage host={host} /> }, navigation: { 'data-integration-nav': { label: 'Data Integration', order: 31 } } }; }
(window as any).__OPSWEAVE_REMOTES__ = (window as any).__OPSWEAVE_REMOTES__ || {};
(window as any).__OPSWEAVE_REMOTES__['opsweave.data-integration'] = { register };
export { IntegrationPage };
