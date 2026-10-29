import * as React from 'react';
import { Icon } from '../Icons';
import { useT } from '../../i18n';

/**
 * The Incident Investigation workspace, declared as a layout instead of built (G07).
 *
 * The product has no incident service yet, so there is nothing true to put inside these
 * regions: no event, no timeline point, no hypothesis, no model conclusion. What can be
 * settled today is the *shape* - three desktop-first regions, who owns which question, and
 * an explicit empty slot where each will render once its API exists. A region always states
 * the interface it is waiting for, so the slot itself can never be read as "no events yet".
 */

export type InvestigationRegionId = 'timeline' | 'analysis' | 'detail';

export interface InvestigationRegion {
  id: InvestigationRegionId;
  title: string;
  /** What this region will hold once its API exists - a plan, never a sample. */
  plan: string;
  /** The interface this region is waiting for. */
  requirement?: string;
  /** Real content; when absent the region renders an empty slot and nothing else. */
  content?: React.ReactNode;
}

export interface InvestigationLayoutProps {
  /** Accessible name of the region group (the workspace the user is looking at). */
  label: string;
  regions: InvestigationRegion[];
  /** Plan-level context for the whole workspace; rendered above the regions. */
  notice?: React.ReactNode;
}

/**
 * One empty region body. It is deliberately inert: no button, no fake skeleton and no
 * "no results" phrasing that would suggest a successful query returned nothing.
 */
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

/**
 * Three regions, one grid. Region identity is carried by `data-region`, so the responsive
 * degradation (three columns -> two -> one) is CSS only and the DOM order - timeline, then
 * hypothesis, then detail - is also the tab and screen-reader order at every width.
 */
export function InvestigationLayout({ label, regions, notice }: InvestigationLayoutProps) {
  return (
    <div className="investigation-layout" role="group" aria-label={label} data-layout="desktop-first">
      {notice ? <div className="investigation-notice">{notice}</div> : null}
      {regions.map((region) => {
        const headingId = `investigation-region-${region.id}`;
        return (
          <section
            key={region.id}
            className="investigation-region"
            data-region={region.id}
            aria-labelledby={headingId}
          >
            <header className="investigation-region-head">
              <h3 id={headingId}>{region.title}</h3>
              <p>{region.plan}</p>
            </header>
            <div className="investigation-region-body">
              {region.content ?? <InvestigationSlot requirement={region.requirement} />}
            </div>
          </section>
        );
      })}
    </div>
  );
}
