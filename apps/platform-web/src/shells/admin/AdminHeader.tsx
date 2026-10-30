import * as React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import type { Overview } from '../../types';
import { Icon } from '../../components/Icons';
import { useI18n } from '../../i18n';
import { Breadcrumb, type BreadcrumbEntry } from '../../components/app/breadcrumb';
import { CommandPalette, useCommandShortcut, type CommandEntry } from '../../components/app/command';
import { useSidebar } from '../../components/app/sidebar';
import { AccountMenu, LanguageSwitcher, ThemeToggle } from '../surface/SurfaceChrome';
import { breadcrumbTrail, ADMIN_NAV_ITEMS } from './AdminNavigation';

/**
 * Topbar: breadcrumb, navigation command palette, platform health, language, theme and the
 * account menu.
 *
 * Language, theme and the account menu are the surface-shared chrome (shells/surface), so
 * the workspace topbar and this one cannot drift; the health pill stays admin-only because
 * a platform health probe has no business meaning. Polling stays a bare best-effort
 * request so an unreachable kernel can never take the shell down with it.
 */
export function AdminHeader({
  compact,
  menuButtonRef,
}: {
  compact: boolean;
  menuButtonRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const { mobileOpen, setMobileOpen } = useSidebar();

  const [health, setHealth] = React.useState<Overview | null>(null);
  const [commandOpen, setCommandOpen] = React.useState(false);

  useCommandShortcut(() => setCommandOpen(true));

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

        <LanguageSwitcher />
        <ThemeToggle />
        <AccountMenu surface="admin" />
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
