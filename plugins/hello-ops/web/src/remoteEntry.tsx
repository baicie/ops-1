import React, { useEffect, useMemo, useState } from 'react';

declare const __PLUGIN_VERSION__: string;

type HostApi = {
  get(path: string): Promise<any>;
  post(path: string, body: unknown): Promise<any>;
};

export type HelloHost = {
  pluginId: string;
  version: string;
  activationRevision: number;
  api: HostApi;
};

const css = `
.ow-hello { display: flex; flex-direction: column; gap: 20px; }
.ow-hello-hero { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; flex-wrap: wrap; }
.ow-hello-kicker { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--ow-text-muted); margin: 0 0 8px; }
.ow-hello-title { margin: 0; font-size: 24px; line-height: 1.2; color: var(--ow-text); }
.ow-hello-sub { margin: 8px 0 0; color: var(--ow-text-secondary); max-width: 680px; line-height: 1.55; }
.ow-hello-badge { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--ow-border); border-radius: 999px; padding: 6px 12px; font-size: 12px; color: var(--ow-text-secondary); background: var(--ow-surface-2); white-space: nowrap; }
.ow-hello-dot { width: 8px; height: 8px; border-radius: 50%; background: #159a72; box-shadow: 0 0 0 3px rgba(21,154,114,.14); }
.ow-hello-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.ow-hello-card { border: 1px solid var(--ow-border); border-radius: 10px; background: var(--ow-surface); padding: 16px; min-width: 0; }
.ow-hello-card-label { font-size: 12px; color: var(--ow-text-muted); margin: 0 0 6px; }
.ow-hello-card-value { font-size: 14px; color: var(--ow-text); margin: 0; overflow-wrap: anywhere; }
.ow-hello-card-value.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.ow-hello-panel { border: 1px solid var(--ow-border); border-radius: 10px; background: var(--ow-surface); overflow: hidden; }
.ow-hello-panel-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--ow-border); flex-wrap: wrap; }
.ow-hello-panel-title { font-size: 14px; font-weight: 600; margin: 0; color: var(--ow-text); }
.ow-hello-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.ow-hello-btn { appearance: none; border: 1px solid var(--ow-border); background: var(--ow-surface); color: var(--ow-text); border-radius: 6px; padding: 7px 12px; font: inherit; font-size: 13px; cursor: pointer; min-height: 32px; }
.ow-hello-btn:hover { background: var(--ow-surface-2); }
.ow-hello-btn-primary { background: var(--ow-accent); border-color: var(--ow-accent); color: var(--ow-accent-text); }
.ow-hello-btn:focus-visible { outline: 2px solid var(--ow-focus); outline-offset: 2px; }
.ow-hello-pre { margin: 0; padding: 16px; background: var(--ow-code-bg); color: var(--ow-code-text); overflow: auto; max-height: 360px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; }
.ow-hello-state { padding: 18px 16px; color: var(--ow-text-secondary); font-size: 13px; }
.ow-hello-error { border-color: #d05050; background: color-mix(in srgb, #d05050 8%, var(--ow-surface)); }
.ow-hello-foot { display: flex; gap: 16px; flex-wrap: wrap; color: var(--ow-text-muted); font-size: 12px; }
@media (max-width: 640px) { .ow-hello-title { font-size: 20px; } .ow-hello-panel-head { align-items: flex-start; } }
`;

function useStyles() {
  useEffect(() => {
    const id = 'ow-hello-styles';
    if (document.getElementById(id)) return;
    const element = document.createElement('style');
    element.id = id;
    element.textContent = css;
    document.head.appendChild(element);
  }, []);
}

function formatBytes(value: number | null | undefined) {
  if (!value || value <= 0) return '—';
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

export function HelloPage({ host }: { host: HelloHost }) {
  useStyles();
  const [payload, setPayload] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [echo, setEcho] = useState<any>(null);
  const [echoBusy, setEchoBusy] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await host.api.get('/api/hello');
      setPayload(data);
    } catch (cause: any) {
      setError(cause?.message || 'The Gateway could not reach a ready instance.');
    } finally {
      setLoading(false);
    }
  }

  async function runEcho() {
    setEchoBusy(true);
    try {
      const data = await host.api.post('/api/hello/echo', {
        greeting: 'hello from the browser',
        sentAt: new Date().toISOString(),
      });
      setEcho(data);
    } catch (cause: any) {
      setEcho({ error: cause?.message || 'echo failed' });
    } finally {
      setEchoBusy(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const runtime = payload?.runtime;
  const runtimeLabel = useMemo(() => {
    if (!runtime) return '—';
    return `${runtime.language || 'unknown'}${runtime.node ? ` · ${runtime.node}` : ''}`;
  }, [runtime]);

  return (
    <div className="ow-hello">
      <header className="ow-hello-hero">
        <div>
          <p className="ow-hello-kicker">Dynamic remote extension · Hello Ops</p>
          <h1 className="ow-hello-title">A full-stack plugin, loaded without rebuilding the Shell.</h1>
          <p className="ow-hello-sub">
            The navigation item, route and this remote module arrived in a signed manifest.
            The kernel gateway selected a READY replica and injected the caller context.
          </p>
        </div>
        <div className="ow-hello-badge" aria-label={`activation revision ${host.activationRevision}`}>
          <span className="ow-hello-dot" />
          Active revision {host.activationRevision}
        </div>
      </header>

      <section className="ow-hello-grid" aria-label="Plugin runtime summary">
        <article className="ow-hello-card">
          <p className="ow-hello-card-label">Plugin version</p>
          <p className="ow-hello-card-value">{payload?.version || __PLUGIN_VERSION__}</p>
        </article>
        <article className="ow-hello-card">
          <p className="ow-hello-card-label">Serving instance</p>
          <p className="ow-hello-card-value mono">{payload?.instanceId || 'awaiting response'}</p>
        </article>
        <article className="ow-hello-card">
          <p className="ow-hello-card-label">Backend runtime</p>
          <p className="ow-hello-card-value">{runtimeLabel}</p>
        </article>
        <article className="ow-hello-card">
          <p className="ow-hello-card-label">Gateway request</p>
          <p className="ow-hello-card-value mono">{payload?.requestId || '—'}</p>
        </article>
      </section>

      <section className={`ow-hello-panel ${error ? 'ow-hello-error' : ''}`}>
        <div className="ow-hello-panel-head">
          <h2 className="ow-hello-panel-title">Live backend response</h2>
          <div className="ow-hello-actions">
            <button className="ow-hello-btn" onClick={() => void load()} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button className="ow-hello-btn ow-hello-btn-primary" onClick={() => void runEcho()} disabled={echoBusy}>
              {echoBusy ? 'Calling…' : 'POST echo'}
            </button>
          </div>
        </div>
        {error ? (
          <div className="ow-hello-state" role="alert">
            <strong>Unavailable.</strong> {error} The Gateway never falls back to a mock instance.
          </div>
        ) : (
          <pre className="ow-hello-pre" aria-live="polite">{JSON.stringify(echo || payload || { state: 'loading' }, null, 2)}</pre>
        )}
      </section>

      <footer className="ow-hello-foot">
        <span>Signed remote assets</span>
        <span>HTTP/JSON Runtime v1</span>
        <span>Gateway-mediated identity</span>
        <span>No session token exposed to the remote</span>
      </footer>
    </div>
  );
}

export function register(host: HelloHost) {
  return {
    components: {
      'hello-page': () => <HelloPage host={host} />,
    },
    navigation: {
      'hello-nav': { label: 'Hello Ops', order: 20 },
    },
  };
}

// Stable 0.0.1 remote-registration contract. The Shell injects React and
// ReactDOM as host singletons before loading this script, then reads this map.
if (typeof window !== 'undefined') {
  (window as any).__OPSWEAVE_REMOTES__ = (window as any).__OPSWEAVE_REMOTES__ || {};
  (window as any).__OPSWEAVE_REMOTES__['dev.opsweave.hello'] = { register };
}
