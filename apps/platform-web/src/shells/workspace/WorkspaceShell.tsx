import * as React from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useDocumentTitle } from '../../hooks';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { Icon } from '../../components/Icons';
import { Breadcrumb, type BreadcrumbEntry } from '../../components/app/breadcrumb';
import {
  Sidebar,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarItem,
  SidebarProvider,
  useSidebar,
} from '../../components/app/sidebar';
import { VersionBadge } from '../../components/VersionBadge';
import { SURFACE_CAPABILITIES, SURFACE_CAPABILITY_ORDER, type SurfaceNavGroup } from '../../pages/workspace';
import { AccountMenu, LanguageSwitcher, ThemeToggle, useCompactViewport } from '../surface/SurfaceChrome';

/**
 * The Business Workspace shell (G04).
 *
 * Honest by construction: this shell renders the two things the product can actually
 * deliver today - the signed-in user's own workspace page, and explicit "not shipped yet"
 * statements for the capabilities whose domain model and API do not exist. No sample
 * incidents, no invented RCA, no placeholder metrics.
 */

interface WorkspaceNavItem {
  id: string;
  to: string;
  labelKey: MessageKey;
  icon: string;
  group: SurfaceNavGroup;
  end?: boolean;
}

const WORKSPACE_NAV_GROUPS: Array<{ id: SurfaceNavGroup; labelKey: MessageKey }> = [
  { id: 'work', labelKey: 'nav.section.work' },
  { id: 'discover', labelKey: 'nav.section.discover' },
];

/** Home is the only workspace destination that is not a capability (pages/workspace registry). */
const WORKSPACE_NAV_ITEMS: WorkspaceNavItem[] = [
  { id: 'home', to: '/app/home', labelKey: 'workspace.nav.home', icon: 'overview', group: 'work', end: true },
  ...SURFACE_CAPABILITY_ORDER.map((capability) => ({
    id: capability,
    to: SURFACE_CAPABILITIES[capability].to,
    labelKey: SURFACE_CAPABILITIES[capability].labelKey,
    icon: SURFACE_CAPABILITIES[capability].icon,
    group: SURFACE_CAPABILITIES[capability].navGroup,
  })),
];

const TITLES: Array<{ test: RegExp; key: MessageKey }> = [
  { test: /^\/app\/home$/, key: 'page.workspaceHome' },
  { test: /^\/app\/incidents/, key: 'page.workspaceIncidents' },
  { test: /^\/app\/investigations/, key: 'page.workspaceInvestigations' },
  { test: /^\/app\/observability/, key: 'page.workspaceObservability' },
  { test: /^\/app\/resources/, key: 'page.workspaceResources' },
  { test: /^\/app\/sources/, key: 'page.workspaceSources' },
  { test: /^\/app\/reports/, key: 'page.workspaceReports' },
];

export function workspaceTitleKey(pathname: string): MessageKey {
  return TITLES.find((entry) => entry.test.test(pathname))?.key ?? 'app.brand';
}

function WorkspaceSidebar({ compact, menuButtonRef }: { compact: boolean; menuButtonRef: React.RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const { collapsed, toggleCollapsed, setMobileOpen } = useSidebar();
  const location = useLocation();
  const closeDrawer = React.useCallback(() => setMobileOpen(false), [setMobileOpen]);

  return (
    <Sidebar
      label={t('nav.aria.main')}
      id="workspace-sidebar"
      data-testid="workspace-sidebar"
      data-surface="workspace"
      className="workspace-sidebar"
      drawer={compact}
      restoreFocusTo={menuButtonRef}
    >
      <SidebarHeader className="brand-row">
        <Link className="brand" to="/app/home" aria-label={t('nav.aria.brandHome')}>
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span className="brand-word">{t('app.brand')}</span>
        </Link>
        <button type="button" className="icon-btn sidebar-close" aria-label={t('nav.aria.close')} data-sidebar-autofocus onClick={closeDrawer}>
          <Icon name="close" />
        </button>
      </SidebarHeader>

      <div className="workspace-pill" title={t('surface.workspace.name')}>
        <span className="workspace-dot" aria-hidden="true" />
        <span>{t('surface.workspace.name')}</span>
      </div>

      <nav className="nav">
        {WORKSPACE_NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.id} label={t(group.labelKey)}>
            {WORKSPACE_NAV_ITEMS.filter((item) => item.group === group.id).map((item) => (
              <SidebarItem
                key={item.id}
                to={item.to}
                label={t(item.labelKey)}
                icon={item.icon}
                end={item.end}
                onNavigate={closeDrawer}
              />
            ))}
          </SidebarGroup>
        ))}
      </nav>

      <SidebarFooter className="sidebar-footer">
        <VersionBadge />
        <div className="sidebar-foot-actions">
          <button
            type="button"
            className="icon-btn collapse-btn"
            onClick={toggleCollapsed}
            aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
            aria-pressed={collapsed}
            data-testid="sidebar-collapse"
          >
            <Icon name="chevron" className={collapsed ? '' : 'flip'} />
          </button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function WorkspaceShellFrame() {
  const { t } = useI18n();
  const location = useLocation();
  const { collapsed, mobileOpen, setMobileOpen } = useSidebar();
  const menuButtonRef = React.useRef<HTMLButtonElement>(null);
  const compact = useCompactViewport();
  useDocumentTitle(t(workspaceTitleKey(location.pathname)));

  React.useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname, setMobileOpen]);

  const trail = React.useMemo<BreadcrumbEntry[]>(
    () => [{ label: t(workspaceTitleKey(location.pathname)) }],
    [location.pathname, t],
  );

  return (
    <div className={'shell workspace-shell' + (collapsed ? ' shell-collapsed' : '')} data-surface="workspace">
      <a className="skip-link" href="#main-content">{t('nav.skipToContent')}</a>
      <WorkspaceSidebar compact={compact} menuButtonRef={menuButtonRef} />
      <div className="main-column">
        <header className="topbar workspace-topbar">
          <button
            type="button"
            ref={menuButtonRef}
            className="icon-btn mobile-menu"
            onClick={() => setMobileOpen(true)}
            aria-label={t('nav.aria.open')}
            aria-expanded={mobileOpen}
            aria-controls="workspace-sidebar"
            data-testid="sidebar-trigger"
          >
            <Icon name="menu" />
          </button>

          <Breadcrumb label={t('topbar.aria.breadcrumb')} entries={trail} className="workspace-breadcrumb" />

          <div className="topbar-right">
            <LanguageSwitcher />
            <ThemeToggle />
            <AccountMenu surface="workspace" />
          </div>
        </header>
        <main id="main-content" className="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** Business Workspace chrome: navigation rail + topbar + content, sharing one session. */
export function WorkspaceShell() {
  return (
    <SidebarProvider>
      <WorkspaceShellFrame />
    </SidebarProvider>
  );
}
