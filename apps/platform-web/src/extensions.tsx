import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import type { Extension } from './types';
import { EmptyState, ErrorState, Skeleton } from './components/Ui';
import { useT } from './i18n';
import type { MessageKey, TranslateParams } from './i18n';

/** The `t` signature `useT()` returns; threaded into helpers that render error copy. */
type Translator = (key: MessageKey, params?: TranslateParams) => string;

type LoadedExtension = {
  extension: Extension;
  registration: any;
  error?: string;
};

interface ExtensionContextValue {
  extensions: Extension[];
  loaded: Record<string, LoadedExtension>;
  loading: boolean;
  error: Error | null;
  reload(): void;
}

const ExtensionContext = createContext<ExtensionContextValue | null>(null);

const SHELL_RESERVED = ['/plugins', '/nodes', '/activity', '/access', '/settings', '/ops-center', '/instances'];

function loadScript(src: string, t: Translator): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-opsweave-remote="${src}"]`);
    if (existing?.dataset.loaded === 'true') return resolve();
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(t('extensions.error.loadFailed', { src }))), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.opsweaveRemote = src;
    script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
    script.onerror = () => reject(new Error(t('extensions.error.loadAssetFailed', { src })));
    document.head.appendChild(script);
  });
}

async function loadRemote(extension: Extension, t: Translator) {
  (window as any).React = React;
  (window as any).ReactDOM = ReactDOM;
  const url = `${extension.assetBase}/${extension.remoteEntry}`;
  await loadScript(url, t);
  const registry = (window as any).__OPSWEAVE_REMOTES__;
  const module = registry?.[extension.pluginId];
  if (!module || typeof module.register !== 'function') {
    throw new Error(t('extensions.error.notRegistered', { pluginId: extension.pluginId }));
  }
  const host = {
    pluginId: extension.pluginId,
    version: extension.version,
    activationRevision: extension.activationRevision,
    api: {
      get: (path: string) => api.gatewayGet(extension.pluginId, path),
      post: (path: string, body: unknown, idempotencyKey?: string) => api.gatewayPost(extension.pluginId, path, body, idempotencyKey),
    },
  };
  return module.register(host);
}

export function ExtensionsProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const { user } = useAuth();
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [loaded, setLoaded] = useState<Record<string, LoadedExtension>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!user) {
      setExtensions([]);
      setLoaded({});
      setLoading(false);
      return;
    }
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const result = await api.get<Extension[]>('/api/v1/extensions');
        if (cancelled) return;
        setExtensions(result);
        setError(null);
        const next: Record<string, LoadedExtension> = {};
        for (const extension of result) {
          const rejected = extension.contributions.some((contribution) => SHELL_RESERVED.some((prefix) => contribution.path === prefix || contribution.path.startsWith(prefix + '/')));
          if (rejected) {
            next[extension.pluginId] = { extension, registration: null, error: t('extensions.error.pathConflict') };
            continue;
          }
          try {
            const registration = await loadRemote(extension, t);
            next[extension.pluginId] = { extension, registration };
          } catch (cause) {
            next[extension.pluginId] = { extension, registration: null, error: (cause as Error).message };
          }
        }
        if (!cancelled) setLoaded(next);
      } catch (cause) {
        if (!cancelled) setError(cause as Error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [reloadToken, user?.id]);

  const value = useMemo(() => ({ extensions, loaded, loading, error, reload: () => setReloadToken((token) => token + 1) }), [extensions, loaded, loading, error]);
  return <ExtensionContext.Provider value={value}>{children}</ExtensionContext.Provider>;
}

export function useExtensions() {
  const value = useContext(ExtensionContext);
  if (!value) throw new Error('useExtensions must be used inside ExtensionsProvider');
  return value;
}

export function ExtensionNavigation() {
  const { extensions, loaded } = useExtensions();
  const items: Array<{ path: string; label: string; pluginId: string }> = [];
  for (const extension of extensions) {
    for (const contribution of extension.contributions) {
      if (contribution.kind !== 'navigation.item.v1') continue;
      const registration = loaded[extension.pluginId]?.registration;
      const label = registration?.navigation?.[contribution.id]?.label
        || extension.pluginId.split('.').slice(-1)[0].replace(/-/g, ' ');
      items.push({ path: contribution.path, label, pluginId: extension.pluginId });
    }
  }
  return <>{items.map((item) => <Link key={`${item.pluginId}:${item.path}`} to={item.path} className="nav-extension">{item.label}</Link>)}</>;
}

export function ExtensionRoute() {
  const t = useT();
  const location = useLocation();
  const { extensions, loaded, loading, error } = useExtensions();
  if (loading) return <Skeleton rows={5} />;
  if (error) return <ErrorState error={error} />;
  const candidates = extensions.flatMap((extension) =>
    extension.contributions
      .filter((contribution) => contribution.kind === 'route.page.v1')
      .map((contribution) => ({ extension, contribution })),
  );
  const match = candidates
    .filter(({ contribution }) => location.pathname === contribution.path || location.pathname.startsWith(contribution.path + '/'))
    .sort((a, b) => b.contribution.path.length - a.contribution.path.length)[0];
  if (!match) {
    return <EmptyState icon="plugins" title={t('extensions.empty.routeNotFound.title')} description={t('extensions.empty.routeNotFound.description')} />;
  }
  const loadedExtension = loaded[match.extension.pluginId];
  if (!loadedExtension) return <Skeleton rows={5} />;
  if (loadedExtension.error) {
    return (
      <div className="extension-error">
        <ErrorState error={new Error(loadedExtension.error)} />
        <p className="muted">{t('extensions.error.isolationNote')}</p>
      </div>
    );
  }
  const component = loadedExtension.registration?.components?.[match.contribution.id];
  if (!component) {
    return <EmptyState icon="plugins" title={t('extensions.empty.noComponent.title')} description={t('extensions.empty.noComponent.description', { id: match.contribution.id })} />;
  }
  return <ExtensionBoundary>{React.createElement(component)}</ExtensionBoundary>;
}

class ExtensionBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return <ErrorState error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}
