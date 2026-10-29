import * as React from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks';
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

function AdminShellFrame() {
  const { t } = useI18n();
  const location = useLocation();
  const { collapsed, setMobileOpen } = useSidebar();
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);
  const compact = useCompactViewport();
  useDocumentTitle(t(titleKeyFor(location.pathname)));

  // Keep the pre-G02 behaviour: a route change always parks the drawer.
  React.useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname, setMobileOpen]);

  return (
    <div className={'shell admin-shell' + (collapsed ? ' shell-collapsed' : '')}>
      <a className="skip-link" href="#main-content">{t('nav.skipToContent')}</a>
      <AdminSidebar compact={compact} menuButtonRef={menuButtonRef} />
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
