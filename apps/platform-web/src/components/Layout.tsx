import React, { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { useDocumentTitle } from '../hooks';
import { api } from '../api';
import { ExtensionNavigation } from '../extensions';
import type { Overview } from '../types';
import { Icon } from './Icons';
import { StatusBadge, TimeAgo } from './Ui';

const coreNav = [
  { to: '/', label: 'Overview', icon: 'overview', end: true },
  { to: '/plugins', label: 'Plugins', icon: 'plugins' },
  { to: '/pipelines', label: 'Pipelines', icon: 'pipeline' },
  { to: '/jobs', label: 'Jobs', icon: 'clock' },
  { to: '/nodes', label: 'Nodes', icon: 'nodes' },
  { to: '/activity', label: 'Activity', icon: 'activity' },
  { to: '/access', label: 'Access', icon: 'access' },
  { to: '/settings', label: 'Settings', icon: 'settings', end: true },
  { to: '/ops-center', label: 'Ops Center', icon: 'ops' },
];

function titleFor(pathname: string) {
  if (pathname === '/') return 'Overview';
  if (pathname.startsWith('/plugins')) return 'Plugins';
  if (pathname.startsWith('/pipelines')) return pathname.includes('/editor') ? 'Pipeline Studio' : 'Pipelines';
  if (pathname.startsWith('/jobs')) return 'Jobs';
  if (pathname.startsWith('/nodes')) return 'Nodes';
  if (pathname.startsWith('/activity')) return 'Activity';
  if (pathname.startsWith('/access')) return 'Access';
  if (pathname.startsWith('/settings')) return 'Settings';
  if (pathname.startsWith('/instances')) return 'Instance logs';
  if (pathname.startsWith('/ops-center')) return 'Ops Center';
  if (pathname.startsWith('/ext/')) return 'Extension';
  return 'OpsWeave';
}

export function Layout() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('opsweave-theme') || 'light');
  const [health, setHealth] = useState<Overview | null>(null);
  const [userMenu, setUserMenu] = useState(false);
  useDocumentTitle(titleFor(location.pathname));

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
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`} aria-label="Main navigation">
        <div className="brand-row">
          <a className="brand" href="/" aria-label="OpsWeave home">
            <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
            <span className="brand-word">OpsWeave</span>
          </a>
          <button className="icon-btn sidebar-close" aria-label="Close navigation" onClick={() => setMobileOpen(false)}><Icon name="close" /></button>
        </div>
        <div className="workspace-pill" title="default workspace"><span className="workspace-dot" /><span>default workspace</span></div>
        <nav className="nav">
          <p className="nav-section-label">Platform</p>
          {coreNav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} title={item.label}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
          <div className="nav-extensions">
            <p className="nav-section-label">Extensions</p>
            <ExtensionNavigation />
          </div>
        </nav>
        <div className="sidebar-foot">
          <button className="icon-btn theme-toggle" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}>
            <Icon name={theme === 'light' ? 'moon' : 'sun'} />
          </button>
          {!collapsed && <span className="muted small">{theme === 'light' ? 'Light' : 'Dark'} theme</span>}
          <button className="icon-btn collapse-btn" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <Icon name="chevron" className={collapsed ? '' : 'flip'} />
          </button>
        </div>
      </aside>
      {mobileOpen && <div className="sidebar-scrim" onClick={() => setMobileOpen(false)} />}

      <div className="main-column">
        <header className="topbar">
          <button className="icon-btn mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Icon name="menu" /></button>
          <div className="breadcrumbs" aria-label="Breadcrumb">
            <a href="/">OpsWeave</a>
            {crumbs.map((crumb) => <React.Fragment key={crumb.path}><span className="crumb-sep">/</span><span>{crumb.label}</span></React.Fragment>)}
          </div>
          <div className="topbar-right">
            {health && <span className={`health-pill health-${healthTone}`}><span className="health-dot" />{health.health === 'READY' ? 'Platform ready' : health.health === 'DEGRADED' ? `${health.attention.filter((item) => item.severity === 'critical').length} critical` : 'Attention needed'}</span>}
            {health?.attention?.length ? <span className="topbar-meta">Last check <TimeAgo value={new Date().toISOString()} /></span> : null}
            <div className="user-menu-wrap">
              <button className="user-button" onClick={() => setUserMenu(!userMenu)} aria-haspopup="menu" aria-expanded={userMenu}>
                <span className="avatar">{(user?.displayName || '?').slice(0, 1).toUpperCase()}</span>
                <span className="user-copy"><strong>{user?.displayName}</strong><small>{user?.role}</small></span>
                <Icon name="down" size={14} />
              </button>
              {userMenu && (
                <div className="user-menu" role="menu">
                  <div className="user-menu-head"><strong>{user?.displayName}</strong><span>{user?.email}</span></div>
                  <button role="menuitem" onClick={() => { setUserMenu(false); navigate('/access'); }}><Icon name="access" size={15} /> Access & trust</button>
                  <button role="menuitem" onClick={async () => { await logout(); navigate('/login'); }}><Icon name="logout" size={15} /> Sign out</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main id="main-content" className="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
