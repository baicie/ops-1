import React, { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useDocumentTitle } from '../hooks';
import { api } from '../api';
import { ExtensionNavigation } from '../extensions';
import type { Overview } from '../types';
import { Icon } from './Icons';
import { StatusBadge, TimeAgo } from './Ui';
import { VersionBadge } from './VersionBadge';
import { useI18n } from '../i18n';
import type { Locale, MessageKey } from '../i18n';
import { SUPPORTED_LOCALES } from '../i18n';

const coreNav: { to: string; labelKey: MessageKey; icon: string; end?: boolean }[] = [
  { to: '/', labelKey: 'nav.overview', icon: 'overview', end: true },
  { to: '/plugins', labelKey: 'nav.plugins', icon: 'plugins' },
  { to: '/pipelines', labelKey: 'nav.pipelines', icon: 'pipeline' },
  { to: '/jobs', labelKey: 'nav.jobs', icon: 'clock' },
  { to: '/nodes', labelKey: 'nav.nodes', icon: 'nodes' },
  { to: '/governance', labelKey: 'nav.governance', icon: 'shield' },
  { to: '/activity', labelKey: 'nav.activity', icon: 'activity' },
  { to: '/access', labelKey: 'nav.access', icon: 'access' },
  { to: '/settings', labelKey: 'nav.settings', icon: 'settings', end: true },
  { to: '/ops-center', labelKey: 'nav.opsCenter', icon: 'ops' },
];

function titleKeyFor(pathname: string): MessageKey {
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

/** A locale's display name is its own endonym, stored identically in every catalog. */
const LOCALE_LABEL_KEYS: Record<Locale, MessageKey> = {
  en: 'nav.language.en',
  'zh-CN': 'nav.language.zhCN',
};

export function Layout() {
  const { user, logout } = useAuth();
  const { t, locale, setLocale } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('opsweave-theme') || 'light');
  const [health, setHealth] = useState<Overview | null>(null);
  const [userMenu, setUserMenu] = useState(false);
  useDocumentTitle(t(titleKeyFor(location.pathname)));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('opsweave-theme', theme);
  }, [theme]);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await api.get<Overview>('/api/v1/overview');
        if (!cancelled) setHealth(result);
      } catch { /* topbar health is best-effort */ }
    }
    void load();
    const timer = window.setInterval(load, 15000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const healthTone = health?.health === 'READY' ? 'ok' : health?.health === 'DEGRADED' ? 'danger' : 'warn';
  const crumbs = useMemo(() => {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts.map((part, index) => ({
      label: part.length > 22 ? `${part.slice(0, 10)}…${part.slice(-6)}` : decodeURIComponent(part),
      path: '/' + parts.slice(0, index + 1).join('/'),
    }));
  }, [location.pathname]);

  return (
    <div className={`shell ${collapsed ? 'shell-collapsed' : ''}`}>
      <a className="skip-link" href="#main-content">{t('nav.skipToContent')}</a>
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`} aria-label={t('nav.aria.main')}>
        <div className="brand-row">
          <a className="brand" href="/" aria-label={t('nav.aria.brandHome')}>
            <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
            <span className="brand-word">{t('app.brand')}</span>
          </a>
          <button className="icon-btn sidebar-close" aria-label={t('nav.aria.close')} onClick={() => setMobileOpen(false)}><Icon name="close" /></button>
        </div>
        <div className="workspace-pill" title={t('nav.workspace.default')}><span className="workspace-dot" /><span>{t('nav.workspace.default')}</span></div>
        <nav className="nav">
          <p className="nav-section-label">{t('nav.section.platform')}</p>
          {coreNav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} title={t(item.labelKey)}>
              <Icon name={item.icon} />
              <span>{t(item.labelKey)}</span>
            </NavLink>
          ))}
          <div className="nav-extensions">
            <p className="nav-section-label">{t('nav.section.extensions')}</p>
            <ExtensionNavigation />
          </div>
        </nav>
        <div className="sidebar-foot">
          <button className="icon-btn theme-toggle" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label={theme === 'light' ? t('theme.switchToDark') : t('theme.switchToLight')}>
            <Icon name={theme === 'light' ? 'moon' : 'sun'} />
          </button>
          {!collapsed && <span className="muted small">{theme === 'light' ? t('theme.label.light') : t('theme.label.dark')}</span>}
          <button className="icon-btn collapse-btn" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}>
            <Icon name="chevron" className={collapsed ? '' : 'flip'} />
          </button>
        </div>
      </aside>
      {mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)} />}

      <div className="main-column">
        <header className="topbar">
          <button className="icon-btn mobile-menu" onClick={() => setMobileOpen(true)} aria-label={t('nav.aria.open')}><Icon name="menu" /></button>
          <div className="breadcrumbs" aria-label={t('topbar.aria.breadcrumb')}>
            <a href="/">{t('app.brand')}</a>
            {crumbs.map((crumb) => <React.Fragment key={crumb.path}><span className="crumb-sep">/</span><span>{crumb.label}</span></React.Fragment>)}
          </div>
          <div className="topbar-right">
            {health && <span className={`health-pill health-${healthTone}`}><span className="health-dot" />{health.health === 'READY' ? t('topbar.health.ready') : health.health === 'DEGRADED' ? t('topbar.health.critical', { count: health.attention.filter((item) => item.severity === 'critical').length }) : t('topbar.health.attention')}</span>}
            {health?.attention?.length ? <span className="topbar-meta">{t('topbar.lastCheck')} <TimeAgo value={new Date().toISOString()} /></span> : null}
            <select
              className="lang-select"
              data-testid="language-switcher"
              aria-label={t('nav.language')}
              value={locale}
              onChange={(event) => setLocale(event.target.value as Locale)}
              // Compact and non-growing: the topbar already holds the health pill and the user menu,
              // so the switcher must not take flex space away from them.
              style={{ flex: '0 0 auto', width: 104, background: 'var(--ow-surface-2)', border: '1px solid var(--ow-border)', borderRadius: 6, padding: '4px 6px', fontSize: 12 }}
            >
              {SUPPORTED_LOCALES.map((option) => (
                <option key={option} value={option}>{t(LOCALE_LABEL_KEYS[option])}</option>
              ))}
            </select>
            <div className="user-menu-wrap">
              <button className="user-button" onClick={() => setUserMenu(!userMenu)} aria-haspopup="menu" aria-expanded={userMenu}>
                <span className="avatar">{(user?.displayName || '?').slice(0, 1).toUpperCase()}</span>
                <span className="user-copy"><strong>{user?.displayName}</strong><small>{user?.role}</small></span>
                <Icon name="down" size={14} />
              </button>
              {userMenu && (
                <div className="user-menu" role="menu">
                  <div className="user-menu-head"><strong>{user?.displayName}</strong><span>{user?.email}</span></div>
                  <button role="menuitem" onClick={() => { setUserMenu(false); navigate('/access'); }}><Icon name="access" size={15} /> {t('topbar.menu.accessTrust')}</button>
                  <button role="menuitem" onClick={async () => { await logout(); navigate('/login'); }}><Icon name="logout" size={15} /> {t('topbar.menu.signOut')}</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main id="main-content" className="main-content">
          <Outlet />
        </main>
        <VersionBadge />
      </div>
    </div>
  );
}
