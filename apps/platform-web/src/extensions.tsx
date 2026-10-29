import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import type { AccessInfo, Surface } from './surface';
import type { ContributionRejection, Extension } from './types';
import { EmptyState, ErrorState, Skeleton } from './components/Ui';
import { SidebarGroup } from './components/app/sidebar';
import { useT } from './i18n';
import type { MessageKey, TranslateParams } from './i18n';

/** The `t` signature `useT()` returns; threaded into helpers that render error copy. */
type Translator = (key: MessageKey, params?: TranslateParams) => string;

type LoadedExtension = {
  extension: Extension;
  registration: any;
  error?: string;
};

/* ---------------------------------------------------------------------------
 * Contribution contract v2, with v1 kept working (G06).
 *
 * The server is the authority: it validates every contribution and only ships the ones
 * this user may see. The client repeats the validation anyway, because a contribution the
 * host cannot route must never reach the router - a foreign path would either shadow a
 * shell route or throw during render, and one dropped item is the lesser failure. A
 * rejection is recorded and logged, never thrown.
 * ------------------------------------------------------------------------- */

/** Rule 1: the only surfaces a contribution may declare. */
const CONTRIBUTION_SURFACES: readonly Surface[] = ['admin', 'workspace'];

/** Rule 5: the capability that makes one surface's contributions visible to a user. */
const SURFACE_CAPABILITY: Record<Surface, string> = { admin: 'platform:access', workspace: 'workspace:access' };

/** Rule 4: the whole capability vocabulary; an unknown name invalidates the contribution. */
export const KNOWN_CAPABILITIES: readonly string[] = ['platform:access', 'workspace:access'];

/** Rule 2: a contribution lives under its own plugin id, one prefix per surface. */
const SURFACE_NAMESPACE: Record<Surface, string> = { admin: '/admin/ext/', workspace: '/app/ext/' };

/** Rule 6: v1 contributions keep the pre-G04 path shape and are always admin. */
const LEGACY_NAMESPACE = '/ext/';

/** Rule 3: host-owned roots. Their bare form - and anything shallower - is never contributable. */
const RESERVED_ROOTS: readonly string[] = ['/admin', '/app', '/login', '/api', '/internal', '/assets', '/ext'];

/** One same-origin path: no scheme, query, fragment, whitespace or backslash. */
const PATH_SHAPE = /^\/[A-Za-z0-9._~\/:-]*$/;

/** Where a surface mounts plugin pages; a claim outside an outlet is not answerable. */
const PLUGIN_OUTLET = /^\/(?:admin|app)\/ext\/.+/;

/** A contribution the host accepted; `href` is the absolute route the shell mounts. */
export interface AcceptedContribution {
  pluginId: string;
  kind: 'navigation.item' | 'route.page';
  id: string;
  /** The declared path, unchanged: v1 keeps `/ext/...`, v2 carries its surface prefix. */
  path: string;
  /** Absolute route the shell links to and matches (`/admin/ext/...` for v1). */
  href: string;
  surface: Surface;
  version: 1 | 2;
  requiredCapabilities: string[];
}

export type RejectionCode = 'surface' | 'namespace' | 'reserved' | 'capability';

/** A contribution that was dropped; `href` only exists so a direct hit can explain itself. */
export interface RejectedContribution {
  pluginId: string;
  id: string;
  code: RejectionCode;
  path: string;
  href: string;
  /** The offending value for `surface`/`capability` rejections (a code, never copy). */
  detail: string;
}

/** Trailing slashes make the same contribution two different routes; one form wins. */
function normalizePath(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

/**
 * Where a rejected contribution claimed to live, so the route that answers it can name the
 * reason. Only a well-formed absolute path yields one: a malformed claim is not a URL.
 */
function claimedHref(path: string): string {
  if (!PATH_SHAPE.test(path)) return '';
  const href = path.startsWith('/admin') || path.startsWith('/app') ? path : '/admin' + path;
  // A claim on a host route (or a bare surface root) is not something a plugin outlet may answer.
  return PLUGIN_OUTLET.test(href) ? href : '';
}

type CapabilityRead = { ok: true; capabilities: string[] } | { ok: false; detail: string };

/** Rule 4: absent means "no extra requirement"; anything outside the vocabulary is fatal. */
function readCapabilities(raw: unknown): CapabilityRead {
  if (raw === undefined || raw === null) return { ok: true, capabilities: [] };
  if (!Array.isArray(raw)) return { ok: false, detail: 'not-a-list' };
  const capabilities: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !KNOWN_CAPABILITIES.includes(value)) {
      return { ok: false, detail: typeof value === 'string' ? value : 'not-a-string' };
    }
    if (!capabilities.includes(value)) capabilities.push(value);
  }
  return { ok: true, capabilities };
}

/**
 * One wire contribution in, one acceptance decision out.
 *
 * `null` means "not a contribution this module mounts" (a `settings.section.v1`, a shape
 * without an id) rather than a rejection: only a well-formed contribution that breaks a
 * rule is recorded as rejected.
 */
export function normalizeContribution(
  pluginId: string,
  raw: unknown,
): AcceptedContribution | RejectedContribution | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const kind = typeof source.kind === 'string' ? source.kind : '';
  const family = kind === 'navigation.item.v1' || kind === 'navigation.item.v2'
    ? 'navigation.item'
    : kind === 'route.page.v1' || kind === 'route.page.v2'
      ? 'route.page'
      : null;
  if (!family) return null;
  const id = typeof source.id === 'string' ? source.id : '';
  const path = normalizePath(source.path);
  if (!id || !PATH_SHAPE.test(path)) return null;

  const version: 1 | 2 = kind.endsWith('.v2') ? 2 : 1;
  const reject = (code: RejectionCode, detail = ''): RejectedContribution => ({
    pluginId, id, code, path, href: claimedHref(path), detail,
  });

  if (RESERVED_ROOTS.includes(path)) return reject('reserved', path);

  let surface: Surface = 'admin';
  if (version === 2) {
    const declared = source.surface;
    if (typeof declared !== 'string' || !CONTRIBUTION_SURFACES.includes(declared as Surface)) {
      return reject('surface', typeof declared === 'string' ? declared : 'missing');
    }
    surface = declared as Surface;
    if (!path.startsWith(SURFACE_NAMESPACE[surface] + pluginId + '/')) return reject('namespace', path);
  } else if (!path.startsWith(LEGACY_NAMESPACE) || path.length <= LEGACY_NAMESPACE.length) {
    return reject('namespace', path);
  }

  const capabilities = readCapabilities(source.requiredCapabilities);
  if (!capabilities.ok) return reject('capability', capabilities.detail);

  return {
    pluginId,
    kind: family,
    id,
    path,
    href: version === 1 ? '/admin' + path : path,
    surface,
    version,
    requiredCapabilities: capabilities.capabilities,
  };
}

/**
 * What this user may see of `surface`. UX filtering only - the server already withheld
 * what this user may not see, and the two filters can only ever widen a deny.
 */
export function visibleContributions(
  accepted: AcceptedContribution[],
  access: AccessInfo,
  surface: Surface,
): AcceptedContribution[] {
  if (!access.allowedSurfaces.includes(surface)) return [];
  if (!access.capabilities.includes(SURFACE_CAPABILITY[surface])) return [];
  return accepted.filter((contribution) =>
    contribution.surface === surface
    && contribution.requiredCapabilities.every((capability) => access.capabilities.includes(capability)));
}

/** Absolute path match: the route, or anything a plugin nests below it. */
function isWithin(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + '/');
}

function deepest<T extends { href: string }>(entries: T[], pathname: string): T | undefined {
  return entries
    .filter((entry) => entry.href !== '' && isWithin(pathname, entry.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

/** Why a contribution was dropped, in the user's language. */
function rejectionMessage(t: Translator, rejected: RejectedContribution): string {
  if (rejected.code === 'surface') return t('extensions.rejected.surface', { surface: rejected.detail });
  if (rejected.code === 'capability') return t('extensions.rejected.capability', { capability: rejected.detail });
  if (rejected.code === 'reserved') return t('extensions.error.pathConflict');
  return t('extensions.rejected.namespace', { path: rejected.path });
}

/**
 * A server rejection is authoritative: the contribution is not mounted even when a
 * server also ships it. Unauthorized contributions never appear here - the server withholds
 * them instead of rejecting them, so a rejection is a contract violation, not a permission gap.
 */
function readRejections(extension: Extension): ContributionRejection[] {
  if (!Array.isArray(extension.rejections)) return [];
  return extension.rejections.filter((entry): entry is ContributionRejection =>
    Boolean(entry)
    && typeof entry.code === 'string'
    && typeof entry.contributionId === 'string'
    && typeof entry.pluginId === 'string');
}

interface ExtensionContextValue {
  extensions: Extension[];
  accepted: AcceptedContribution[];
  rejected: RejectedContribution[];
  serverRejections: ContributionRejection[];
  loaded: Record<string, LoadedExtension>;
  loading: boolean;
  error: Error | null;
  reload(): void;
}

/** The plugin id an outlet URL points at: `/admin/ext/<pluginId>/...` or `/app/ext/<pluginId>/...`. */
function pluginIdInOutlet(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  return segments[0] === 'admin' || segments[0] === 'app' ? segments[2] ?? '' : '';
}

const ExtensionContext = createContext<ExtensionContextValue | null>(null);

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
  const { user, access } = useAuth();
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [accepted, setAccepted] = useState<AcceptedContribution[]>([]);
  const [rejected, setRejected] = useState<RejectedContribution[]>([]);
  const [serverRejections, setServerRejections] = useState<ContributionRejection[]>([]);
  const [loaded, setLoaded] = useState<Record<string, LoadedExtension>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // Primitive, so a new `access` object with the same grant does not re-fetch every render.
  const grantKey = `${access.allowedSurfaces.join('|')}#${access.capabilities.join('|')}`;

  useEffect(() => {
    if (!user) {
      setExtensions([]);
      setAccepted([]);
      setRejected([]);
      setServerRejections([]);
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
        const nextAccepted: AcceptedContribution[] = [];
        const nextRejected: RejectedContribution[] = [];
        const nextServerRejections: ContributionRejection[] = [];
        for (const extension of Array.isArray(result) ? result : []) {
          const refusals = readRejections(extension);
          nextServerRejections.push(...refusals);
          const refused = new Set(refusals.map((entry) => entry.contributionId));
          const contributions = Array.isArray(extension.contributions) ? extension.contributions : [];
          for (const contribution of contributions) {
            // The server already judged this one invalid; shipping it too does not revive it.
            if (refused.has(String(contribution?.id))) continue;
            const outcome = normalizeContribution(extension.pluginId, contribution);
            if (!outcome) continue;
            if ('code' in outcome) nextRejected.push(outcome);
            else nextAccepted.push(outcome);
          }
        }
        // Recorded, not thrown: one bad item must not cost the shell its remote extensions.
        for (const entry of nextServerRejections) {
          console.warn('[extensions] server rejected contribution', entry);
        }
        for (const entry of nextRejected) {
          console.warn('[extensions] contribution rejected', entry);
        }
        setExtensions(result);
        setAccepted(nextAccepted);
        setRejected(nextRejected);
        setServerRejections(nextServerRejections);
        setError(null);

        const reachable = new Set(
          CONTRIBUTION_SURFACES
            .flatMap((surface) => visibleContributions(nextAccepted, access, surface))
            .map((contribution) => contribution.pluginId),
        );
        const next: Record<string, LoadedExtension> = {};
        for (const extension of result) {
          // Nothing this user may see: no script injected, no component reachable.
          if (!reachable.has(extension.pluginId)) continue;
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
  }, [reloadToken, user?.id, grantKey]);

  const value = useMemo(
    () => ({ extensions, accepted, rejected, serverRejections, loaded, loading, error, reload: () => setReloadToken((token) => token + 1) }),
    [extensions, accepted, rejected, serverRejections, loaded, loading, error],
  );
  return <ExtensionContext.Provider value={value}>{children}</ExtensionContext.Provider>;
}

export function useExtensions() {
  const value = useContext(ExtensionContext);
  if (!value) throw new Error('useExtensions must be used inside ExtensionsProvider');
  return value;
}

/**
 * The plugin items of one surface's navigation. A contribution reaches this component only
 * after the server shipped it and this client re-checked the user's capabilities, and a
 * surface with no visible contribution renders no section at all - a menu that opens
 * nothing is a lie in the UI.
 */
export function ExtensionNavigation({ surface }: { surface: Surface }) {
  const t = useT();
  const { accepted, loaded } = useExtensions();
  const { access } = useAuth();
  const items = visibleContributions(accepted, access, surface)
    .filter((contribution) => contribution.kind === 'navigation.item');
  if (items.length === 0) return null;
  return (
    <SidebarGroup label={t('nav.section.extensions')} className="nav-extensions">
      {items.map((item) => {
        const label = loaded[item.pluginId]?.registration?.navigation?.[item.id]?.label
          || item.pluginId.split('.').slice(-1)[0].replace(/-/g, ' ');
        return (
          <Link
            key={`${item.pluginId}:${item.id}`}
            to={item.href}
            className="nav-extension"
            data-testid={`extension-nav-${item.id}`}
            data-extension-surface={item.surface}
          >
            {label}
          </Link>
        );
      })}
    </SidebarGroup>
  );
}

/**
 * One surface's extension outlet. The plugin renders *inside* this route element: it never
 * receives the router, so it can neither add nor remove a host route.
 */
export function ExtensionRoute({ surface }: { surface: Surface }) {
  const t = useT();
  const { pathname } = useLocation();
  const { access } = useAuth();
  const { accepted, rejected, serverRejections, loaded, loading, error } = useExtensions();
  if (loading) return <Skeleton rows={5} />;
  if (error) return <ErrorState error={error} />;

  const match = deepest(
    visibleContributions(accepted, access, surface).filter((contribution) => contribution.kind === 'route.page'),
    pathname,
  );
  if (!match) {
    // A path a plugin claimed but the host refused: say why instead of showing a 404. The
    // server's own rejections carry no path, so they answer for every path of that plugin.
    const claim = deepest(rejected, pathname);
    const refused = claim ? [] : serverRejections.filter((entry) => entry.pluginId === pluginIdInOutlet(pathname));
    if (claim || refused.length > 0) {
      return (
        <div
          className="extension-error"
          data-testid="extension-rejected"
          data-rejection-code={claim ? claim.code : refused[0].code}
        >
          <EmptyState
            icon="plugins"
            title={t('extensions.rejected.title')}
            description={claim
              ? rejectionMessage(t, claim)
              : t('extensions.rejected.serverCount', { count: refused.length })}
          />
        </div>
      );
    }
    return <EmptyState icon="plugins" title={t('extensions.empty.routeNotFound.title')} description={t('extensions.empty.routeNotFound.description')} />;
  }
  const loadedExtension = loaded[match.pluginId];
  if (!loadedExtension) return <Skeleton rows={5} />;
  if (loadedExtension.error) {
    return (
      <div className="extension-error">
        <ErrorState error={new Error(loadedExtension.error)} />
        <p className="muted">{t('extensions.error.isolationNote')}</p>
      </div>
    );
  }
  const component = loadedExtension.registration?.components?.[match.id];
  if (!component) {
    return <EmptyState icon="plugins" title={t('extensions.empty.noComponent.title')} description={t('extensions.empty.noComponent.description', { id: match.id })} />;
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
