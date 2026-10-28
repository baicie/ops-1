import * as React from 'react';
import { cn } from '../../lib/utils';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';

/**
 * Side sheet built on the existing Radix dialog primitive (no new dependency, no second
 * overlay stack: it inherits the dialog's z-index, focus trap and Escape handling).
 *
 * The panel stays a dialog at every width; only the geometry changes, so the mobile
 * command palette and a future DetailSheet share one implementation.
 */
export const Sheet = Dialog;

export type SheetSide = 'left' | 'right';

const sideStyles: Record<SheetSide, string> = {
  left: 'left-0 top-0 h-full max-h-full w-[86vw] max-w-[320px] translate-x-0 translate-y-0 rounded-none rounded-r-lg p-4',
  right: 'left-auto right-0 top-0 h-full max-h-full w-[86vw] max-w-[360px] translate-x-0 translate-y-0 rounded-none rounded-l-lg p-4',
};

export interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof DialogContent> {
  side?: SheetSide;
  title: string;
  /** Radix warns when a dialog has no description; pass `undefined` explicitly to opt out. */
  description?: string;
  closeLabel: string;
}

export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogContent>,
  SheetContentProps
>(({ side = 'left', title, description, closeLabel, className, children, ...props }, ref) => (
  <DialogContent
    ref={ref}
    closeLabel={closeLabel}
    className={cn('ow-sheet gap-3', sideStyles[side], className)}
    {...props}
  >
    <DialogTitle className="text-sm font-semibold text-foreground">{title}</DialogTitle>
    {description ? <DialogDescription className="text-sm text-muted-foreground">{description}</DialogDescription> : null}
    {children}
  </DialogContent>
));
SheetContent.displayName = 'SheetContent';

export function SheetClose({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <DialogClose asChild>
      <button type="button" className="icon-btn" aria-label={label}>{children}</button>
    </DialogClose>
  );
}
