import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import { canEnterSurface, surfaceEntryPath, type Surface } from '../../surface';
import { Icon } from '../../components/Icons';
import { PageHeader } from '../../components/Ui';
import { Avatar } from '../../components/app/avatar';
import { Button, buttonVariants } from '../../components/ui/button';
import { SUPPORTED_LOCALES, useI18n } from '../../i18n';
import type { Locale, MessageKey } from '../../i18n';

/**
 * Presentation shared by *both* surfaces: the drawer breakpoint, the theme preference, the
 * language switcher, the account menu with the surface switcher, and the one page that
 * belongs to neither shell (/403). Keeping them here is what makes the two shells siblings
 * of one session instead of two applications that happen to share a cookie.
 */

/** Same breakpoint the shell CSS and the admin shell use; state and layout never disagree. */
export function useCompactViewport(query = '(max-width: 1024px)'): boolean {
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

const THEME_STORAGE_KEY = 'opsweave-theme';

type Theme = 'light' | 'dark';

function readStoredTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/** One preference for the whole product: switching shell must not flip the theme. */
export function useTheme() {
  const [theme, setTheme] = React.useState<Theme>(readStoredTheme);
  React.useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // A blocked storage keeps the theme for this session only.
    }
  }, [theme]);
  return {
    theme,
    toggle: () => setTheme((previous) => (previous === 'light' ? 'dark' : 'light')),
  };
}

/** A locale's display name is its own endonym, stored identically in every catalog. */
const LOCALE_LABEL_KEYS: Record<Locale, MessageKey> = {
  en: 'nav.language.en',
  'zh-CN': 'nav.language.zhCN',
};

export function LanguageSwitcher() {
  const { t, locale, setLocale } = useI18n();
  return (
    <select
      className="lang-select"
      data-testid="language-switcher"
      aria-label={t('nav.language')}
      value={locale}
      onChange={(event) => setLocale(event.target.value as Locale)}
    >
      {SUPPORTED_LOCALES.map((option) => (
        <option key={option} value={option}>{t(LOCALE_LABEL_KEYS[option])}</option>
      ))}
    </select>
  );
}

export function ThemeToggle() {
  const { t } = useI18n();
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      onClick={toggle}
      aria-label={theme === 'light' ? t('theme.switchToDark') : t('theme.switchToLight')}
      data-testid="theme-toggle"
    >
      <Icon name={theme === 'light' ? 'moon' : 'sun'} />
    </button>
  );
}

/**
 * The surface switcher lives where the account lives, because it changes *identity scope*,
 * not a route. One entry, pointing at the other surface: it is only rendered when the
 * server grant allows entering that surface, so an unauthorized Admin entry cannot exist
 * to be clicked. Both directions are plain `Link`s - the session and its React providers
 * stay mounted, which is exactly the guarantee "switch without signing in again".
 */
function SurfaceSwitcher({ surface, onNavigate }: { surface: Surface; onNavigate: () => void }) {
  const { t } = useI18n();
  const { access } = useAuth();
  const other: Surface = surface === 'admin' ? 'workspace' : 'admin';
  if (!canEnterSurface(access, other)) return null;
  return (
    <div className="user-menu-switch" role="group" aria-label={t('surface.switch.label')}>
      <Link
        className="user-menu-item"
        role="menuitem"
        to={surfaceEntryPath(other)}
        onClick={onNavigate}
        data-testid={other === 'admin' ? 'surface-switch-admin' : 'surface-switch-workspace'}
      >
        <Icon name={other === 'admin' ? 'server' : 'layout'} size={15} />
        <span className="user-menu-item-copy">
          <strong>{other === 'admin' ? t('surface.admin.name') : t('surface.workspace.name')}</strong>
          <small>{other === 'admin' ? t('surface.switch.toAdminHint') : t('surface.switch.toWorkspaceHint')}</small>
        </span>
      </Link>
    </div>
  );
}

/** Account menu: identity, surface switch, security destination and sign-out. */
export function AccountMenu({ surface }: { surface: Surface }) {
  const { t } = useI18n();
  const { user, access, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const close = React.useCallback(() => setOpen(false), []);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && !wrapRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const canReachAccessPage = canEnterSurface(access, 'admin');

  return (
    <div className="user-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="user-button"
        onClick={() => setOpen((previous) => !previous)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="user-menu-trigger"
      >
        <Avatar className="avatar" name={user?.displayName} email={user?.email} aria-hidden="true" />
        <span className="user-copy"><strong>{user?.displayName}</strong><small>{user?.role}</small></span>
        <Icon name="down" size={14} />
      </button>
      {open ? (
        <div className="user-menu" role="menu" aria-label={t('topbar.menu.account')}>
          <div className="user-menu-head">
            <strong>{user?.displayName}</strong>
            <span>{user?.email}</span>
            <span className="user-menu-surface" data-testid="current-surface">
              {surface === 'admin' ? t('surface.admin.name') : t('surface.workspace.name')}
            </span>
          </div>
          <SurfaceSwitcher surface={surface} onNavigate={close} />
          <div className="user-menu-sep" role="presentation" />
          {canReachAccessPage ? (
            <button role="menuitem" onClick={() => { close(); navigate('/admin/access'); }}>
              <Icon name="access" size={15} /> {t('topbar.menu.accessTrust')}
            </button>
          ) : null}
          <button role="menuitem" onClick={async () => { close(); await logout(); navigate('/login'); }}>
            <Icon name="logout" size={15} /> {t('topbar.menu.signOut')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * /403. Deliberately shell-less: an unauthorized user gets no navigation into the platform
 * console, and the page names no resource, title or id - only the missing capability and
 * the two ways out.
 */
export function ForbiddenPage() {
  const { t } = useI18n();
  const { access, accessSource, logout } = useAuth();
  const navigate = useNavigate();
  const canReachWorkspace = canEnterSurface(access, 'workspace');
  return (
    <main id="main-content" className="main-content forbidden-page">
      <div className="page-stack">
        <PageHeader eyebrow={t('forbidden.eyebrow')} title={t('forbidden.title')} description={t('forbidden.description')} />
        <section className="panel panel-pad" data-testid="forbidden-panel">
          <p className="muted">{t('forbidden.hint')}</p>
          {accessSource === 'missing' ? (
            // Only a missing declaration produces this line: "you are not allowed in" and
            // "this client cannot tell" must not look the same to whoever is on call.
            <p className="muted small" data-testid="forbidden-access-missing" data-access-source={accessSource}>
              {t('forbidden.hint.unavailable')}
            </p>
          ) : null}
          <div className="page-actions">
            {canReachWorkspace ? (
              <Link className={buttonVariants()} to={surfaceEntryPath('workspace')} data-testid="forbidden-to-workspace">
                {t('forbidden.action.workspace')}
              </Link>
            ) : null}
            <Button
              variant="secondary"
              data-testid="forbidden-sign-out"
              onClick={async () => { await logout(); navigate('/login'); }}
            >
              {t('forbidden.action.signOut')}
            </Button>
          </div>
        </section>
      </div>
    </main>
  );
}
