import type { MessageKey } from '../../i18n';

/** The two consoles the design pack defines. Only ADMIN exists as a shell in this round. */
export type AdminSurface = 'admin';

export type AdminNavGroupId = 'platform' | 'runtime' | 'security';

export interface AdminNavGroup {
  id: AdminNavGroupId;
  /** Catalog key: group headings are copy like any other label. */
  labelKey: MessageKey;
}

export interface AdminNavItem {
  id: string;
  to: string;
  labelKey: MessageKey;
  /** Icon key from components/Icons; an unknown key renders the alert glyph. */
  icon: string;
  group: AdminNavGroupId;
  /**
   * Reserved for the dual-surface router (G04/G05). Declared now so navigation metadata
   * already carries the dimension; nothing in G02 filters on it, because a surface the
   * permission matrix has not authorized must not be reachable from the shell.
   */
  surface: AdminSurface;
  end?: boolean;
}

/** docs/design/dual-workspace-v2/pack/docs/03-information-architecture.md §3.2. */
export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  { id: 'platform', labelKey: 'nav.section.platform' },
  { id: 'runtime', labelKey: 'nav.section.runtime' },
  { id: 'security', labelKey: 'nav.section.security' },
];

/**
 * Ten destinations, unchanged from the pre-G02 shell: G02 re-groups the navigation, it does
 * not add or remove routes. "Deployments" is intentionally absent - the page does not exist
 * yet, and a menu entry that opens nothing is a lie in the UI.
 */
export const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { id: 'overview', to: '/', labelKey: 'nav.overview', icon: 'overview', group: 'platform', surface: 'admin', end: true },
  { id: 'plugins', to: '/plugins', labelKey: 'nav.plugins', icon: 'plugins', group: 'platform', surface: 'admin' },
  { id: 'nodes', to: '/nodes', labelKey: 'nav.nodes', icon: 'nodes', group: 'platform', surface: 'admin' },
  { id: 'pipelines', to: '/pipelines', labelKey: 'nav.pipelines', icon: 'pipeline', group: 'runtime', surface: 'admin' },
  { id: 'jobs', to: '/jobs', labelKey: 'nav.jobs', icon: 'clock', group: 'runtime', surface: 'admin' },
  { id: 'governance', to: '/governance', labelKey: 'nav.governance', icon: 'shield', group: 'runtime', surface: 'admin' },
  { id: 'access', to: '/access', labelKey: 'nav.access', icon: 'access', group: 'security', surface: 'admin' },
  { id: 'activity', to: '/activity', labelKey: 'nav.activity', icon: 'activity', group: 'security', surface: 'admin' },
  { id: 'settings', to: '/settings', labelKey: 'nav.settings', icon: 'settings', group: 'security', surface: 'admin', end: true },
  { id: 'opsCenter', to: '/ops-center', labelKey: 'nav.opsCenter', icon: 'ops', group: 'security', surface: 'admin' },
];

/** Document title for the current route; unchanged mapping from the pre-G02 Layout. */
export function titleKeyFor(pathname: string): MessageKey {
  if (pathname === '/') return 'page.overview';
  if (pathname.startsWith('/plugins')) return 'page.plugins';
  if (pathname.startsWith('/pipelines')) return pathname.includes('/editor') ? 'page.pipelineStudio' : 'page.pipelines';
  if (pathname.startsWith('/jobs')) return 'page.jobs';
  if (pathname.startsWith('/nodes')) return 'page.nodes';
  if (pathname.startsWith('/governance')) return 'page.governance';
  if (pathname.startsWith('/activity')) return 'page.activity';
  if (pathname.startsWith('/access')) return 'page.access';
  if (pathname.startsWith('/settings')) return 'page.settings';
  if (pathname.startsWith('/instances')) return 'page.instanceLogs';
  if (pathname.startsWith('/ops-center')) return 'page.opsCenter';
  if (pathname.startsWith('/ext/')) return 'page.extension';
  return 'app.brand';
}

/** Deeper routes whose leaf has its own page title; anything else falls back to the id. */
const CHILD_TITLE_KEYS: Array<{ test: RegExp; key: MessageKey }> = [
  { test: /^\/pipelines\/[^/]+\/editor$/, key: 'page.pipelineStudio' },
  { test: /^\/pipelines\/[^/]+\/run$/, key: 'page.runPipeline' },
  { test: /^\/pipelines\/[^/]+$/, key: 'page.pipelineDetail' },
  { test: /^\/jobs\/[^/]+$/, key: 'page.jobDetail' },
  { test: /^\/settings\/diagnostics$/, key: 'page.diagnostics' },
  { test: /^\/instances\/[^/]+\/logs$/, key: 'page.instanceLogs' },
];

export interface AdminBreadcrumbNode {
  /** Present when the segment is a known destination; the caller translates it. */
  labelKey?: MessageKey;
  /** Decoded raw segment (ids of nodes, plugins, jobs) when no key applies. */
  text?: string;
  to: string;
}

/** Long ids are shortened in the middle so the header keeps one line. */
function shorten(segment: string): string {
  return segment.length > 22 ? segment.slice(0, 10) + '\u2026' + segment.slice(-6) : segment;
}

/**
 * Breadcrumb derived from the URL, not from a per-page prop: a page cannot forget to pass
 * its trail, and an unknown deep link still renders a truthful path.
 */
export function breadcrumbTrail(pathname: string): AdminBreadcrumbNode[] {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return [{ labelKey: 'page.overview', to: '/' }];
  const top = ADMIN_NAV_ITEMS.find((item) => item.to === '/' + segments[0]);
  const nodes: AdminBreadcrumbNode[] = [
    { labelKey: top?.labelKey, text: top ? undefined : shorten(decodeURIComponent(segments[0])), to: '/' + segments[0] },
  ];
  for (let index = 1; index < segments.length; index += 1) {
    const to = '/' + segments.slice(0, index + 1).join('/');
    const known = CHILD_TITLE_KEYS.find((entry) => entry.test.test(to));
    nodes.push({
      labelKey: known?.key,
      text: known ? undefined : shorten(decodeURIComponent(segments[index])),
      to,
    });
  }
  return nodes;
}
