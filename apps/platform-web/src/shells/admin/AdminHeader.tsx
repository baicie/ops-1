import * as React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import { api } from '../../api';
import type { Overview } from '../../types';
import { Icon } from '../../components/Icons';
import { TimeAgo } from '../../components/Ui';
import { useI18n, SUPPORTED_LOCALES } from '../../i18n';
import type { Locale, MessageKey } from '../../i18n';
import { Avatar } from '../../components/app/avatar';
import { Breadcrumb, type BreadcrumbEntry } from '../../components/app/breadcrumb';
import { CommandPalette, useCommandShortcut, type CommandEntry } from '../../components/app/command';
import { useSidebar } from '../../components/app/sidebar';
import { breadcrumbTrail, ADMIN_NAV_ITEMS } from './AdminNavigation';

const THEME_STORAGE_KEY = 'opsweave-theme';

type Theme = 'light' | 'dark';

/** A locale's display name is its own endonym, stored identically in every catalog. */
const LOCALE_LABEL_KEYS: Record<Locale, MessageKey> = {
  en: 'nav.language.en',
  'zh-CN': 'nav.language.zhCN',
};

function readStoredTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * Topbar: breadcrumb, navigation command palette, platform health, language, theme and the
 * account menu. Health polling stays a bare best-effort request so an unreachable kernel
 * can never take the shell down with it.
 */
export function AdminHeader({
  compact,
  menuButtonRef,
}: {
  compact: boolean;
  menuButtonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t, locale, setLocale } = useI18n();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { mobileOpen, setMobileOpen } = useSidebar();

  const [theme, setTheme] = React.useState<Theme>(readStoredTheme);
  const [health, setHealth] = React.useState<Overview | null>(null);
  const [userMenu, setUserMenu] = React.useState(false);
  const [commandOpen, setCommandOpen] = React.useState(false);

  useCommandShortcut(() => setCommandOpen(true));

  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // A blocked storage keeps the theme for this session only.
    }
  }, [theme]);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result = await api.get<Overview>('/api/v1/overview');
        if (!cancelled) setHealth(result);
      } catch {
        // The health pill is best-effort; an unreachable kernel leaves it empty.
      }
    }
    void load();
    const timer = window.setInterval(load, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  React.useEffect(() => {
    if (!userMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setUserMenu(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('.user-menu-wrap')) setUserMenu(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [userMenu]);

  const trail = React.useMemo<BreadcrumbEntry[]>(
    () => breadcrumbTrail(location.pathname).map((node) => ({ label: node.labelKey ? t(node.labelKey) : node.text ?? '', to: node.to })),
    [location.pathname, t],
  );

  // Only the destinations this shell can actually render; this round searches navigation.
  const commandEntries = React.useMemo<CommandEntry[]>(
    () => ADMIN_NAV_ITEMS.map((item) => ({ id: item.id, label: t(item.labelKey), path: item.to, keywords: [item.id, item.group] })),
    [t],
  );

  function runCommand(entry: CommandEntry) {
    setCommandOpen(false);
    navigate(entry.path);
  }

  const healthTone = health?.health === 'READY' ? 'ok' : health?.health === 'DEGRADED' ? 'danger' : 'warn';

  return (
    <header className="topbar admin-topbar">
      <button
        type="button"
        ref={menuButtonRef}
        className="icon-btn mobile-menu"
        onClick={() => setMobileOpen(true)}
        aria-label={t('nav.aria.open')}
        aria-expanded={mobileOpen}
        aria-controls="admin-sidebar"
        data-testid="sidebar-trigger"
      >
        <Icon name="menu" />
      </button>

      <Breadcrumb label={t('topbar.aria.breadcrumb')} entries={trail} />

      <div className="topbar-right">
        <button
          type="button"
          className="topbar-command"
          onClick={() => setCommandOpen(true)}
          aria-label={t('topbar.command.open')}
          aria-haspopup="dialog"
          data-testid="command-trigger"
        >
          <Icon name="search" size={15} />
          <span className="topbar-command-text">{t('topbar.command.hint')}</span>
          <kbd className="kbd" aria-hidden="true">&#8984;K</kbd>
        </button>

        {health ? (
          <span className={'health-pill health-' + healthTone} data-testid="health-pill">
            <span className="health-dot" aria-hidden="true" />
            {health.health === 'READY'
              ? t('topbar.health.ready')
              : health.health === 'DEGRADED'
                ? t('topbar.health.critical', { count: health.attention.filter((item) => item.severity === 'critical').length })
                : t('topbar.health.attention')}
          </span>
        ) : null}
        {health?.attention?.length ? (
          <span className="topbar-meta">{t('topbar.lastCheck')} <TimeAgo value={new Date().toISOString()} /></span>
        ) : null}

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

        <button
          type="button"
          className="icon-btn theme-toggle"
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          aria-label={theme === 'light' ? t('theme.switchToDark') : t('theme.switchToLight')}
          data-testid="theme-toggle"
        >
          <Icon name={theme === 'light' ? 'moon' : 'sun'} />
        </button>

        <div className="user-menu-wrap">
          <button
            type="button"
            className="user-button"
            onClick={() => setUserMenu((previous) => !previous)}
            aria-haspopup="menu"
            aria-expanded={userMenu}
            data-testid="user-menu-trigger"
          >
            <Avatar className="avatar" name={user?.displayName} email={user?.email} aria-hidden="true" />
            <span className="user-copy"><strong>{user?.displayName}</strong><small>{user?.role}</small></span>
            <Icon name="down" size={14} />
          </button>
          {userMenu ? (
            <div className="user-menu" role="menu" aria-label={t('topbar.menu.account')}>
              <div className="user-menu-head"><strong>{user?.displayName}</strong><span>{user?.email}</span></div>
              <div className="user-menu-soon" role="menuitem" aria-disabled="true" data-testid="surface-switcher-placeholder">
                <Icon name="layout" size={15} />
                <span className="user-menu-soon-copy">
                  <strong>{t('topbar.menu.surfaceSoon')}</strong>
                  <small>{t('topbar.menu.surfaceSoonHint')}</small>
                </span>
              </div>
              <div className="user-menu-sep" role="presentation" />
              <button role="menuitem" onClick={() => { setUserMenu(false); navigate('/access'); }}>
                <Icon name="access" size={15} /> {t('topbar.menu.accessTrust')}
              </button>
              <button role="menuitem" onClick={async () => { setUserMenu(false); await logout(); navigate('/login'); }}>
                <Icon name="logout" size={15} /> {t('topbar.menu.signOut')}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <CommandPalette
        open={commandOpen}
        onOpenChange={setCommandOpen}
        entries={commandEntries}
        compact={compact}
        onSelect={runCommand}
        closeLabel={t('common.close')}
        labels={{
          title: t('command.title'),
          placeholder: t('command.placeholder'),
          empty: t('command.empty'),
          results: t('command.results'),
          hint: t('command.hint'),
        }}
      />
    </header>
  );
}
