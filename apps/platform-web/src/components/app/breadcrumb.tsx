import * as React from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/utils';

export interface BreadcrumbEntry {
  /** Localized label resolved by the caller; never a hardcoded string. */
  label: string;
  /** Omitted for the trailing crumb, which is the current page and not a link. */
  to?: string;
}

/**
 * Path derived breadcrumb for the admin header.
 *
 * The last entry carries `aria-current="page"` and renders as plain text, so screen
 * readers announce the current location once instead of offering a self-link.
 */
export function Breadcrumb({ label, entries, className }: { label: string; entries: BreadcrumbEntry[]; className?: string }) {
  if (entries.length === 0) return null;
  return (
    <nav className={cn('breadcrumbs admin-breadcrumb', className)} aria-label={label}>
      <ol className="breadcrumb-list">
        {entries.map((entry, index) => {
          const isLast = index === entries.length - 1;
          return (
            <li key={`${entry.to ?? 'current'}:${index}`} className="breadcrumb-item">
              {index > 0 ? <span className="crumb-sep" aria-hidden="true">/</span> : null}
              {entry.to && !isLast ? (
                <Link to={entry.to} title={entry.label}>{entry.label}</Link>
              ) : (
                <span aria-current={isLast ? 'page' : undefined} title={entry.label}>{entry.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
