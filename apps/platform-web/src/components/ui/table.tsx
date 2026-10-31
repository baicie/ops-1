import * as React from 'react';
import { cn } from '../../lib/utils';

// With preflight off the UA sheet still gives tables border-collapse: separate and
// border-spacing: 2px, so the wrapper table sets border-collapse explicitly and every
// rule line carries its own border-style/border-width.

export const Table = React.forwardRef<HTMLTableElement, React.TableHTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="relative w-full overflow-auto">
      <table ref={ref} className={cn('ow-table w-full border-collapse caption-bottom text-base', className)} {...props} />
    </div>
  ),
);
Table.displayName = 'Table';

export const TableHeader = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    // bg-muted on the section, not only on each th: a table whose trailing header cell is a
    // row-menu slot leaves that column heading-less, and the band has to reach the edge anyway.
    <thead ref={ref} className={cn('border-b border-solid border-border bg-muted', className)} {...props} />
  ),
);
TableHeader.displayName = 'TableHeader';

export const TableBody = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
  ),
);
TableBody.displayName = 'TableBody';

export const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        // --ow-hover, not --ow-surface-2: #f8f9fb is ~2% off white and styles.css records it as
        // reading like "nothing happened". The CSS override that migrated the wash reaches only
        // the two tables carrying a legacy class; every other row kept the colour it replaced.
        'border-b border-solid border-border transition-colors hover:bg-[var(--ow-hover)] data-[state=selected]:bg-muted',
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = 'TableRow';

export const TableHead = React.forwardRef<HTMLTableCellElement, React.ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <th
      ref={ref}
      className={cn(
        'h-9 whitespace-nowrap border-b border-solid border-border bg-muted px-3.5 text-left align-middle text-sm font-semibold text-muted-foreground',
        className,
      )}
      {...props}
    />
  ),
);
TableHead.displayName = 'TableHead';

export const TableCell = React.forwardRef<HTMLTableCellElement, React.TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, ref) => (
    <td ref={ref} className={cn('px-3.5 py-2.5 align-middle text-base', className)} {...props} />
  ),
);
TableCell.displayName = 'TableCell';

export const TableCaption = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
  ({ className, ...props }, ref) => (
    <caption ref={ref} className={cn('mt-3 text-sm text-muted-foreground', className)} {...props} />
  ),
);
TableCaption.displayName = 'TableCaption';
