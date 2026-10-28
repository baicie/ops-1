import * as React from 'react';
import { useI18n } from '../../i18n';
import { Icon } from '../../components/Icons';
import { ExtensionNavigation } from '../../extensions';
import { Sidebar, SidebarFooter, SidebarGroup, SidebarHeader, SidebarItem, useSidebar } from '../../components/app/sidebar';
import { VersionBadge } from '../../components/VersionBadge';
import { ADMIN_NAV_GROUPS, ADMIN_NAV_ITEMS } from './AdminNavigation';

/**
 * The admin navigation rail. Below the drawer breakpoint the same tree becomes the
 * off-canvas drawer, so a viewport change never re-mounts the extension contributions.
 */
export function AdminSidebar({
  compact,
  menuButtonRef,
}: {
  compact: boolean;
  menuButtonRef: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const { collapsed, toggleCollapsed, setMobileOpen } = useSidebar();
  const closeDrawer = React.useCallback(() => setMobileOpen(false), [setMobileOpen]);

  return (
    <Sidebar label={t('nav.aria.main')} drawer={compact} restoreFocusTo={menuButtonRef}>
      <SidebarHeader className="brand-row">
        <a className="brand" href="/" aria-label={t('nav.aria.brandHome')}>
          <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
          <span className="brand-word">{t('app.brand')}</span>
        </a>
        <button className="icon-btn sidebar-close" aria-label={t('nav.aria.close')} data-sidebar-autofocus onClick={closeDrawer}>
          <Icon name="close" />
        </button>
      </SidebarHeader>

      <div className="workspace-pill" title={t('nav.workspace.default')}>
        <span className="workspace-dot" aria-hidden="true" />
        <span>{t('nav.workspace.default')}</span>
      </div>

      <nav className="nav">
        {ADMIN_NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.id} label={t(group.labelKey)}>
            {ADMIN_NAV_ITEMS.filter((item) => item.group === group.id).map((item) => (
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
        {/* Extension slots stay inside the shell: a plugin contributes an item, never chrome. */}
        <SidebarGroup label={t('nav.section.extensions')} className="nav-extensions">
          <ExtensionNavigation />
        </SidebarGroup>
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
