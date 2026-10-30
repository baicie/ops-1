import * as React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { ApiError, api } from '../../api';
import { useDocumentTitle } from '../../hooks';
import type { Overview } from '../../types';
import { reportOverview, resetBodyState } from '../../lib/platform-status';
import { useI18n } from '../../i18n';
import { SidebarProvider, useSidebar } from '../../components/app/sidebar';
import { AdminHeader } from './AdminHeader';
import { AdminSidebar } from './AdminSidebar';
import { titleKeyFor } from './AdminNavigation';

/** Drawer breakpoint; the CSS uses the same 1024px, so state and layout never disagree. */
const DRAWER_QUERY = '(max-width: 1024px)';

/**
 * matchMedia instead of a resize listener: the drawer is a *presentation* switch, and a
 * single source for it keeps the React tree and the media query in src/styles.css aligned.
 */
function useCompactViewport(query = DRAWER_QUERY): boolean {
  const [compact, setCompact] = React.useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  React.useEffect(() => {
    const list = window.matchMedia(query);
    const sync = () => setCompact(list.matches);
    sync();
    list.addEventListener('change', sync);
    return () => list.removeEventListener('change', sync);
  }, [query]);
  return compact;
}

/**
 * The shell's one read of \`/api/v1/overview\`.
 *
 * It publishes into lib/platform-status, which is what the topbar pill, the rail's status
 * field and (through the same derivation) the page body read. Keeping the poll here rather
 * than inside the pill is the point: one request, one verdict, three readers.
 */
function PlatformStatusPoll() {
  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await api.get<Overview>('/api/v1/overview');
        if (!cancelled) reportOverview(result);
      } catch (error) {
        if (cancelled) return;
        // 403 is a permission wall, not a broken kernel; everything else means the shell
        // could not observe the platform and must stop implying that it did.
        reportOverview(null, error instanceof ApiError && error.status === 403 ? 'forbidden' : 'unavailable');
      }
    }
    void load();
    const timer = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  return null;
}

function AdminShellFrame() {
  const { t } = useI18n();
  const location = useLocation();
  const { collapsed, setMobileOpen } = useSidebar();
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);
  const compact = useCompactViewport();
  useDocumentTitle(t(titleKeyFor(location.pathname)));

  // Keep the pre-G02 behaviour: a route change always parks the drawer, and a new page has
  // not reported a body state yet, so the chrome must not inherit the previous page's verdict.
  React.useEffect(() => {
    setMobileOpen(false);
    resetBodyState();
  }, [location.pathname, setMobileOpen]);

  return (
    <div className={'shell admin-shell' + (collapsed ? ' shell-collapsed' : '')}>
      <a className="skip-link" href="#main-content">{t('nav.skipToContent')}</a>
      <AdminSidebar compact={compact} menuButtonRef={menuButtonRef} />
      <PlatformStatusPoll />
      <div className="main-column">
        <AdminHeader compact={compact} menuButtonRef={menuButtonRef} />
        <main id="main-content" className="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** AdminShell V2: the platform console chrome (navigation rail + topbar + content). */
export function AdminShell() {
  return (
    <SidebarProvider>
      <AdminShellFrame />
    </SidebarProvider>
  );
}
