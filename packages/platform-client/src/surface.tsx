import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * The dual-surface contract (G04).
 *
 * Two shells, one session: `admin` is the platform console, `workspace` is the business
 * workspace. Everything authority-related in this module is *consumed*, never derived:
 * `/api/v1/auth/me` returns `access.allowedSurfaces` and `access.capabilities`, and a
 * response without them is treated as the documented denial (workspace only). A role is
 * never turned into a surface here - hiding UI is not authorization, and inventing one is
 * worse than denying it.
 */

export type Surface = 'admin' | 'workspace';

/** Capability that gates the platform console (design pack docs/06 §2). */
const PLATFORM_ACCESS = 'platform:access';
/** Capability every authenticated user holds for the business workspace. */
const WORKSPACE_ACCESS = 'workspace:access';

export interface AccessInfo {
  allowedSurfaces: Surface[];
  capabilities: string[];
}

/**
 * The documented fallback for a response that carries no `access` at all (or carries a
 * shape this client cannot read): Admin is denied, the workspace stays available.
 */
export const DENY_ACCESS: AccessInfo = { allowedSurfaces: ['workspace'], capabilities: [WORKSPACE_ACCESS] };

const KNOWN_SURFACES: readonly Surface[] = ['admin', 'workspace'];

/**
 * Where the grant came from. "declared" means the server answered the question; "missing"
 * means the payload carried no usable declaration at all - a different operational story
 * (client and kernel out of step) from "declared, and it excludes you" (a permission gap),
 * and the only place that distinction is allowed to surface is the /403 page.
 */
export type AccessSource = 'declared' | 'missing';

export interface SurfaceGrant {
  access: AccessInfo;
  source: AccessSource;
}

/** True when the payload actually declares surfaces or capabilities. */
function declaresAccess(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const record = raw as { allowedSurfaces?: unknown; capabilities?: unknown };
  return Array.isArray(record.allowedSurfaces) || Array.isArray(record.capabilities);
}

/**
 * The single read of the wire payload: the normalized grant plus its provenance, so a
 * missing declaration can be reported as such instead of rendering as a denial.
 */
export function readAccess(raw: unknown): SurfaceGrant {
  if (!declaresAccess(raw)) return { access: { ...DENY_ACCESS }, source: 'missing' };
  return { access: normalizeAccess(raw), source: 'declared' };
}

/**
 * Narrow the wire payload to the two facts the shell uses. Unknown surface names and
 * non-string capabilities are dropped instead of forwarded, so a malformed field can only
 * ever widen the denial, never the authority.
 */
export function normalizeAccess(raw: unknown): AccessInfo {
  if (!raw || typeof raw !== 'object') return DENY_ACCESS;
  const record = raw as { allowedSurfaces?: unknown; capabilities?: unknown };
  const surfaces = Array.isArray(record.allowedSurfaces)
    ? KNOWN_SURFACES.filter((surface) => (record.allowedSurfaces as unknown[]).includes(surface))
    : [];
  const capabilities = Array.isArray(record.capabilities)
    ? (record.capabilities as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  return {
    allowedSurfaces: surfaces.length > 0 ? [...surfaces] : [...DENY_ACCESS.allowedSurfaces],
    capabilities: capabilities.length > 0 ? capabilities : [...DENY_ACCESS.capabilities],
  };
}

/**
 * Can this user enter `surface`?
 *
 * The admin shell additionally requires `platform:access`; the two declarations must agree
 * before a single admin byte is rendered, so a server that lists the surface but forgets the
 * capability still gets a deny. The workspace only reads the surface list: a missing
 * `workspace:access` must not lock every user out of the surface that holds no privileged
 * platform data.
 */
export function canEnterSurface(access: AccessInfo, surface: Surface): boolean {
  if (!access || !Array.isArray(access.allowedSurfaces) || !access.allowedSurfaces.includes(surface)) return false;
  if (surface === 'admin') return Array.isArray(access.capabilities) && access.capabilities.includes(PLATFORM_ACCESS);
  return true;
}

const SURFACE_HOME: Record<Surface, string> = { admin: '/admin/overview', workspace: '/app/home' };

function surfacePrefix(surface: Surface): string {
  return surface === 'admin' ? '/admin' : '/app';
}

/**
 * Preference storage. Every value here is UX state written from `location` by the shell;
 * nothing in it is ever read as permission - the guard always re-reads `access`.
 */
const SURFACE_KEY = 'opsweave-surface';
const SURFACE_OWNER_KEY = 'opsweave-surface-owner';
const PATH_KEY_PREFIX = 'opsweave-surface-path:';

function readValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked storage (private mode) costs the memory, never the navigation.
  }
}

function removeValue(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Same as above: nothing to clean up when storage is unavailable.
  }
}

/** A remembered path is only ever a same-surface absolute path this shell wrote itself. */
function isSurfacePath(path: string | null | undefined, surface: Surface): boolean {
  if (!path) return false;
  if (!path.startsWith(surfacePrefix(surface) + '/')) return false;
  return !path.startsWith('//') && !/[\\\s]/.test(path);
}

export function lastSurface(): Surface | null {
  const stored = readValue(SURFACE_KEY);
  return stored === 'admin' || stored === 'workspace' ? stored : null;
}

function rememberSurface(surface: Surface): void {
  writeValue(SURFACE_KEY, surface);
}

/** Last legal path in that surface, or `null` when nothing (valid) was remembered. */
function lastPath(surface: Surface): string | null {
  const stored = readValue(PATH_KEY_PREFIX + surface);
  return isSurfacePath(stored, surface) ? stored : null;
}

function rememberPath(surface: Surface, path: string): void {
  if (isSurfacePath(path, surface)) writeValue(PATH_KEY_PREFIX + surface, path);
}

/** Where a switcher entry lands: the remembered path inside that surface, else its home. */
export function surfaceEntryPath(surface: Surface): string {
  return lastPath(surface) ?? SURFACE_HOME[surface];
}

/** Sign-out, or a different account: preferences belong to the previous identity. */
export function clearSurfaceMemory(): void {
  removeValue(SURFACE_KEY);
  removeValue(SURFACE_OWNER_KEY);
  removeValue(PATH_KEY_PREFIX + 'admin');
  removeValue(PATH_KEY_PREFIX + 'workspace');
}

/** A new user id on the same browser must not inherit the previous user's surface state. */
export function adoptSurfaceOwner(userId: string): void {
  const previous = readValue(SURFACE_OWNER_KEY);
  if (previous && previous !== userId) clearSurfaceMemory();
  writeValue(SURFACE_OWNER_KEY, userId);
}

/**
 * Records the current location for `surface`. Mounted *inside* the guard, so only paths the
 * user was actually allowed to render can become a remembered entry.
 */
export function useRememberSurface(surface: Surface): void {
  const { pathname, search } = useLocation();
  useEffect(() => {
    rememberSurface(surface);
    rememberPath(surface, pathname + search);
  }, [surface, pathname, search]);
}

/* ---------------------------------------------------------------------------
 * Legacy URL compatibility
 *
 * The SPA fallback in the kernel serves index.html for every path, so a bookmarked
 * pre-G04 URL reaches the client and is answered here with a `replace` redirect to its
 * canonical /admin path. Rules are a closed table - never a computed target - so there is
 * no open redirect and no way to bridge into a surface the guard has not cleared: the
 * target re-enters the router at /admin/*, where RequirePlatformAccess runs first.
 * Query strings survive only for the keys the destination actually reads.
 * ------------------------------------------------------------------------- */

interface LegacyRoute {
  pattern: RegExp;
  /** Query keys carried over; every other parameter is dropped, `next`/`redirect` included. */
  allow: readonly string[];
  to: (match: RegExpMatchArray) => string | null;
}

/** Re-encode a captured segment; a malformed escape must not throw during render. */
const id = (value: string) => {
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return encodeURIComponent(value);
  }
};

const LEGACY_ROUTES: readonly LegacyRoute[] = [
  { pattern: /^\/plugins$/, allow: [], to: () => '/admin/plugins' },
  { pattern: /^\/plugins\/install$/, allow: [], to: () => '/admin/plugins/install' },
  { pattern: /^\/plugins\/([^/]+)$/, allow: ['tab'], to: (m) => '/admin/plugins/' + id(m[1]) },
  { pattern: /^\/nodes$/, allow: ['filter'], to: () => '/admin/nodes' },
  { pattern: /^\/nodes\/([^/]+)$/, allow: ['tab'], to: (m) => '/admin/nodes/' + id(m[1]) },
  { pattern: /^\/pipelines$/, allow: ['filter'], to: () => '/admin/pipelines' },
  { pattern: /^\/pipelines\/([^/]+)$/, allow: ['tab'], to: (m) => '/admin/pipelines/' + id(m[1]) },
  { pattern: /^\/pipelines\/([^/]+)\/editor$/, allow: ['draft', 'node'], to: (m) => '/admin/pipelines/' + id(m[1]) + '/editor' },
  { pattern: /^\/pipelines\/([^/]+)\/run$/, allow: [], to: (m) => '/admin/pipelines/' + id(m[1]) + '/run' },
  { pattern: /^\/jobs$/, allow: ['filter'], to: () => '/admin/jobs' },
  { pattern: /^\/jobs\/([^/]+)$/, allow: [], to: (m) => '/admin/jobs/' + id(m[1]) },
  { pattern: /^\/governance$/, allow: [], to: () => '/admin/governance' },
  { pattern: /^\/activity$/, allow: [], to: () => '/admin/activity' },
  { pattern: /^\/access$/, allow: [], to: () => '/admin/access' },
  { pattern: /^\/settings$/, allow: [], to: () => '/admin/settings' },
  { pattern: /^\/settings\/diagnostics$/, allow: [], to: () => '/admin/settings/diagnostics' },
  { pattern: /^\/ops-center$/, allow: [], to: () => '/admin/ops-center' },
  { pattern: /^\/instances\/([^/]+)\/logs$/, allow: [], to: (m) => '/admin/instances/' + id(m[1]) + '/logs' },
  {
    pattern: /^\/ext(\/.*)?$/,
    allow: ['tab'],
    to: (m) => {
      const rest = m[1] ?? '';
      // The plugin namespace is a plain path remainder; anything else is not a legacy URL.
      if (rest && (!/^\/[A-Za-z0-9._~\/-]*$/.test(rest) || rest.includes('..'))) return null;
      return '/admin/ext' + rest;
    },
  },
];

function allowlistedSearch(search: string, allow: readonly string[]): string {
  if (!search || allow.length === 0) return '';
  const source = new URLSearchParams(search);
  const kept = new URLSearchParams();
  for (const key of allow) {
    for (const value of source.getAll(key)) kept.append(key, value);
  }
  const text = kept.toString();
  return text ? '?' + text : '';
}

/** The canonical /admin destination for a pre-G04 path, or `null` when it is not one. */
export function legacyRedirect(pathname: string, search = ''): string | null {
  for (const route of LEGACY_ROUTES) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const target = route.to(match);
    return target ? target + allowlistedSearch(search, route.allow) : null;
  }
  return null;
}
