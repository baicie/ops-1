import * as React from 'react';
import { Icon } from '../Icons';
import { useT } from '../../i18n';

/**
 * The Incident Investigation workspace (G12 D).
 *
 * G07 declared this layout with three empty regions, because the product had no incident data to
 * put in them. The data exists now, so the same three regions are the page's real working set:
 * the incident rail on the left, the timeline and evidence analysis in the middle, the selected
 * evidence plus the two decisions about the record on the right.
 *
 * One rule shapes the component: the phone gets the same three panes, not a truncated one. Below
 * 1024 the panes become tabs rather than being dropped, so the rail is still a list a reader can
 * open and the detail pane still shows the evidence it belongs to. A pane that is merely hidden
 * at 390 is a pane the reader cannot use, which is why the compact branch renders a real tablist
 * with roving focus and arrow keys instead of relying on a display:none rule.
 */

export type InvestigationPaneId = 'rail' | 'analysis' | 'detail';

export interface InvestigationPane {
  id: InvestigationPaneId;
  /** The pane's name, used by the tab and by the desktop region's accessible name. */
  label: string;
  /** A number worth seeing before opening the pane (incidents, evidence rows). */
  count?: number | null;
  content: React.ReactNode;
}

export interface InvestigationLayoutProps {
  /** Accessible name of the workspace (which incident is being investigated). */
  label: string;
  panes: InvestigationPane[];
  /** Which pane is shown below 1024. Omit to let the workspace keep its own state. */
  activePane?: InvestigationPaneId;
  /** Called when the reader changes pane (tab click, arrow key) or when the page asks for one. */
  onPaneChange?: (id: InvestigationPaneId) => void;
  /** Which pane is shown first below 1024. Defaults to the analysis pane. */
  initialPane?: InvestigationPaneId;
  /** Plan-level context for the whole workspace; rendered above the panes. */
  notice?: React.ReactNode;
}

const COMPACT_QUERY = '(max-width: 1023px)';

/** True below 1024. A layout that changes its navigation model has to ask: CSS alone cannot
 *  decide whether three regions are tabs or columns, and deciding in CSS would leave a tablist
 *  in the accessibility tree on a desktop where it means nothing. */
export function useCompactLayout(): boolean {
  const [compact, setCompact] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia(COMPACT_QUERY);
    const sync = () => setCompact(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return compact;
}

/** One empty pane body. Inert on purpose: it names the interface it is waiting for rather than
 *  reporting an empty result set, which would claim a query had succeeded and found nothing. */
export function InvestigationSlot({ requirement }: { requirement?: string }) {
  const t = useT();
  return (
    <div className="investigation-slot" data-slot-empty="true">
      <span className="investigation-slot-mark" aria-hidden="true"><Icon name="inbox" size={16} /></span>
      <p className="investigation-slot-title">{t('workspace.region.empty')}</p>
      {requirement ? <p className="investigation-slot-line">{t('workspace.notYet.missingLabel')} {requirement}</p> : null}
      <p className="investigation-slot-line">{t('workspace.region.emptyHint')}</p>
    </div>
  );
}

const paneElementId = (id: InvestigationPaneId) => 'investigation-pane-' + id;
const tabElementId = (id: InvestigationPaneId) => 'investigation-tab-' + id;

export function InvestigationLayout({ label, panes, activePane, onPaneChange, initialPane, notice }: InvestigationLayoutProps) {
  const compact = useCompactLayout();
  const fallback = panes.find((pane) => pane.id === 'analysis')?.id ?? panes[0].id;
  const firstPane = initialPane && panes.some((pane) => pane.id === initialPane) ? initialPane : fallback;
  const [own, setOwn] = React.useState<InvestigationPaneId>(firstPane);
  // Controlled when the page supplies a pane (it needs to move the tab when a row opens), internal
  // otherwise, so the component is usable as a plain layout too.
  const active = activePane ?? own;
  const setActive = (id: InvestigationPaneId) => {
    if (activePane === undefined) setOwn(id);
    onPaneChange?.(id);
  };
  const tabRefs = React.useRef<Record<string, HTMLButtonElement | null>>({});

  // WAI-ARIA tabs, automatic activation: the arrow keys move the selection AND the panel, which
  // is what a reader expects from a tab strip. Home/End go to the ends of the strip.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const ids = panes.map((pane) => pane.id);
    const current = ids.indexOf(active);
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (current + 1) % ids.length;
    else if (event.key === 'ArrowLeft') nextIndex = (current - 1 + ids.length) % ids.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = ids.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextId = ids[nextIndex];
    setActive(nextId);
    tabRefs.current[nextId]?.focus();
  };

  return (
    <>
      {compact ? (
        <div className="investigation-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown} data-testid="investigation-tabs">
          {panes.map((pane) => {
            const selected = pane.id === active;
            return (
              <button
                key={pane.id}
                type="button"
                role="tab"
                id={tabElementId(pane.id)}
                aria-selected={selected}
                aria-controls={paneElementId(pane.id)}
                tabIndex={selected ? 0 : -1}
                className="investigation-tab"
                data-testid={'investigation-tab-' + pane.id}
                ref={(node) => { tabRefs.current[pane.id] = node; }}
                onClick={() => setActive(pane.id)}
              >
                {pane.label}
                {typeof pane.count === 'number' ? <span className="investigation-tab-count" data-pane-count={pane.count}>{pane.count}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        className="investigation-workspace"
        data-layout={compact ? 'compact' : 'wide'}
        data-active-pane={compact ? active : undefined}
        role="group"
        aria-label={compact ? undefined : label}
      >
        {notice ? <div className="investigation-notice">{notice}</div> : null}
        {panes.map((pane) => (
          <section
            key={pane.id}
            id={paneElementId(pane.id)}
            className="investigation-pane"
            data-pane={pane.id}
            role={compact ? 'tabpanel' : 'region'}
            aria-labelledby={compact ? tabElementId(pane.id) : undefined}
            aria-label={compact ? undefined : pane.label}
            hidden={compact && active !== pane.id ? true : undefined}
            data-testid={'investigation-pane-' + pane.id}
          >
            {pane.content}
          </section>
        ))}
      </div>
    </>
  );
}