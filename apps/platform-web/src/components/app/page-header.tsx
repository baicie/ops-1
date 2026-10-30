import * as React from 'react';
import { cn } from '../../lib/utils';

/**
 * Page header: one title, one description, at most one primary call to action.
 *
 * The single-CTA rule is enforced by the API rather than by review — a page passes `primary`
 * once, and every other control is an `action` rendered in front of it. The breadcrumb lives in
 * the AdminShell topbar (G01) and is deliberately not repeated here: two trails on one screen
 * would be a defect, and the shell already derives it from the URL.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  primary,
  meta,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  eyebrow?: string;
  actions?: React.ReactNode;
  /** The single primary CTA of this page. */
  primary?: React.ReactNode;
  /** Status chips directly below the description. */
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('page-header', className)} data-testid="page-header">
      <div className="page-header-copy">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {/* page-template §2.2: one header height on every page, so the meta chips share the
            description's line instead of opening a third one. A chip row of its own measured
            8px of margin + 21px of chip, which is why /admin/plugins/{id} carried an 86px
            header against a 36px one on /admin/nodes: the height was never declared, it was
            the sum of whichever slots the page happened to pass. */}
        {description || meta ? (
          <div className="page-header-sub">
            {description ? <p className="page-description">{description}</p> : null}
            {meta ? <div className="page-header-meta">{meta}</div> : null}
          </div>
        ) : null}
      </div>
      {actions || primary ? (
        <div className="page-actions">
          {actions}
          {primary}
        </div>
      ) : null}
    </header>
  );
}
