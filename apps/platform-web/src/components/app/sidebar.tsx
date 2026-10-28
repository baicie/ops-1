import * as React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '../../lib/utils';
import { Icon } from '../Icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

/** One key for the whole shell: the collapse preference is UX state, never authorization. */
export const SIDEBAR_STORAGE_KEY = 'opsweave-sidebar-collapsed';

interface SidebarContextValue {
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  toggleCollapsed: () => void;
  mobileOpen: boolean;
  setMobileOpen: (next: boolean) => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function readStoredCollapsed(storageKey: string): boolean {
  try {
    return window.localStorage.getItem(storageKey) === 'true';
  } catch {
    // Blocked storage (private mode) keeps the expanded default.
    return false;
  }
}

export function SidebarProvider({
  storageKey = SIDEBAR_STORAGE_KEY,
  children,
}: {
  storageKey?: string;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = React.useState(() => readStoredCollapsed(storageKey));
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(collapsed));
    } catch {
      // Persistence is best-effort; the in-memory preference still applies.
    }
  }, [collapsed, storageKey]);

  const value = React.useMemo<SidebarContextValue>(
    () => ({
      collapsed,
      setCollapsed,
      toggleCollapsed: () => setCollapsed((previous) => !previous),
      mobileOpen,
      setMobileOpen,
    }),
    [collapsed, mobileOpen],
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarContextValue {
  const value = React.useContext(SidebarContext);
  if (!value) throw new Error('useSidebar must be used inside <SidebarProvider>');
  return value;
}

function focusFirst(panel: HTMLElement | null) {
  const target = panel?.querySelector<HTMLElement>('[data-sidebar-autofocus]');
  (target ?? panel)?.focus();
}

/**
 * The nodes a Tab press can reach inside the panel, in document order. `getClientRects()` is
 * the visibility test because it is the one the browser itself applies to sequential focus
 * navigation, and the guards are skipped so the ring never hands focus back to a sentinel.
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
].join(',');

function focusRing(panel: HTMLElement | null): HTMLElement[] {
  if (!panel) return [];
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute('data-sidebar-focus-guard') &&
      element.getClientRects().length > 0,
  );
}

function focusEdge(panel: HTMLElement | null, edge: 'first' | 'last') {
  const ring = focusRing(panel);
  const target = edge === 'first' ? ring[0] : ring[ring.length - 1];
  (target ?? panel)?.focus();
}

/**
 * One end of the trap. While the drawer is open nothing outside it is tabbable - the
 * neighbours are inert and the scrim holds no control - so the browser's own sequence runs
 * from the panel's first control to its last and then steps off the end of the document onto
 * <body>, which is one stop the `aria-modal` claim does not allow. These two guards are the
 * extra stops that close the ring: focus arriving on one is handed to the far edge of the
 * panel, in both directions.
 *
 * They are deliberately not `aria-hidden`: hiding a focusable node from the accessibility
 * tree would be its own violation, and this is the shape focus-scope libraries ship.
 */
function FocusGuard({
  panel,
  wrapTo,
  active,
}: {
  panel: React.RefObject<HTMLElement | null>;
  wrapTo: 'first' | 'last';
  active: boolean;
}) {
  // Always rendered, only ever tabbable while the trap is on: keeping the node in place means
  // opening the drawer never shifts the children's positions and never re-mounts navigation.
  return (
    <span
      tabIndex={active ? 0 : -1}
      data-sidebar-focus-guard={wrapTo}
      onFocus={() => focusEdge(panel.current, wrapTo)}
      style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
    />
  );
}

export interface SidebarProps extends React.HTMLAttributes<HTMLElement> {
  /** Accessible name of the landmark; localized by the caller. */
  label: string;
  /**
   * True when this width presents the panel as an off-canvas drawer. The drawer keeps its
   * children mounted (it is moved out of view with a transform), because the navigation
   * links must stay in the document for the collapsed/expanded state to survive a
   * viewport change without re-mounting the extension navigation.
   */
  drawer?: boolean;
  /** Receives focus when the drawer closes, so keyboard users land back on the trigger. */
  restoreFocusTo?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}

export function Sidebar({ label, drawer = false, restoreFocusTo, className, children, ...props }: SidebarProps) {
  const { mobileOpen, setMobileOpen } = useSidebar();
  const panelRef = React.useRef<HTMLElement>(null);
  const open = drawer && mobileOpen;

  React.useEffect(() => {
    if (!open) return;
    focusFirst(panelRef.current);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // While it covers the page the drawer is a modal, so everything beside it leaves the tab
    // order and the accessibility tree - the mirror image of the parked drawer marking
    // *itself* inert. The scrim is skipped on purpose: it is the click-to-dismiss surface.
    // None of this runs when the drawer is closed, so the desktop rail keeps behaving as the
    // plain landmark it was.
    const shell = panelRef.current?.parentElement;
    const neighbours = shell
      ? Array.from(shell.children).filter(
          (element) =>
            element !== panelRef.current && !element.classList.contains('sidebar-scrim'),
        )
      : [];
    const wasInert = neighbours.map((element) => element.hasAttribute('inert'));
    neighbours.forEach((element) => element.setAttribute('inert', ''));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMobileOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      neighbours.forEach((element, index) => {
        if (!wasInert[index]) element.removeAttribute('inert');
      });
      // Focus returns only once the shell is interactive again: focusing an inert element is
      // a no-op, so restoring it earlier would leave the trigger without focus.
      restoreFocusTo?.current?.focus();
    };
  }, [open, restoreFocusTo, setMobileOpen]);

  // A viewport that grows past the drawer breakpoint must not leave the scrim behind.
  React.useEffect(() => {
    if (!drawer && mobileOpen) setMobileOpen(false);
  }, [drawer, mobileOpen, setMobileOpen]);

  return (
    <>
      {open ? (
        <div className="sidebar-scrim" data-testid="sidebar-scrim" onClick={() => setMobileOpen(false)} aria-hidden="true" />
      ) : null}
      <aside
        ref={panelRef}
        id="admin-sidebar"
        tabIndex={-1}
        aria-label={label}
        // Modal only while it actually covers the page; the desktop rail stays a landmark.
        role={open ? 'dialog' : undefined}
        aria-modal={open ? true : undefined}
        // Out of the accessibility tree and out of the tab order while parked off-canvas.
        inert={drawer && !mobileOpen ? true : undefined}
        className={cn('sidebar admin-sidebar', drawer && 'sidebar-drawer', open && 'sidebar-open', className)}
        data-drawer={drawer ? 'true' : 'false'}
        data-open={open ? 'true' : 'false'}
        {...props}
      >
        <FocusGuard panel={panelRef} wrapTo="last" active={open} />
        {children}
        <FocusGuard panel={panelRef} wrapTo="first" active={open} />
      </aside>
    </>
  );
}

export function SidebarHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('sidebar-head', className)} {...props}>
      {children}
    </div>
  );
}

export function SidebarGroup({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('nav-group', className)} role="group" aria-label={label}>
      <p className="nav-section-label" aria-hidden="true">{label}</p>
      {children}
    </div>
  );
}

export interface SidebarItemProps {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
  onNavigate?: () => void;
}

/**
 * Active state computed from the location instead of NavLink's render-prop className:
 * Radix's `Slot` merges props itself and stringifies a function `className`, which
 * silently dropped the `nav-link` class from the rendered anchor.
 */
export function isNavActive(pathname: string, to: string, end?: boolean): boolean {
  if (end) return pathname === to;
  const target = to === '/' ? '/' : to.replace(/\/$/, '');
  return pathname === target || pathname.startsWith(target + '/');
}

/**
 * One navigation destination. Collapsed it renders the icon only, and the same label that
 * the eye loses becomes the tooltip a keyboard or pointer user can still read.
 */
export function SidebarItem({ to, label, icon, end, onNavigate }: SidebarItemProps) {
  const { collapsed } = useSidebar();
  const { pathname } = useLocation();
  const active = isNavActive(pathname, to, end);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink to={to} end={end} onClick={onNavigate} className={cn('nav-link', active && 'active')}>
          <Icon name={icon} />
          <span className="nav-link-label">{label}</span>
        </NavLink>
      </TooltipTrigger>
      {collapsed ? <TooltipContent side="right">{label}</TooltipContent> : null}
    </Tooltip>
  );
}

export function SidebarFooter({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('sidebar-foot', className)} {...props}>
      {children}
    </div>
  );
}
