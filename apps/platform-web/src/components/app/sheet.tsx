import * as React from 'react';
import { Dialog, DialogClose } from '../ui/dialog';
import { DialogFrame } from './dialog-frame';

/**
 * Side sheet built on the shared dialog frame (no new dependency, no second overlay stack: it
 * inherits the dialog's z-index, focus trap and Escape handling).
 *
 * The panel stays a dialog at every width; only the geometry changes, so the mobile command
 * palette and a future DetailSheet share one implementation - the same head/body/foot as every
 * centred dialog, positioned to one edge instead of the middle.
 */
export const Sheet = Dialog;

export type SheetSide = 'left' | 'right';

export interface SheetContentProps extends Omit<React.ComponentPropsWithoutRef<typeof DialogFrame>, 'variant' | 'size'> {
  side?: SheetSide;
  title: string;
  /** Radix warns when a dialog has no description; pass `undefined` explicitly to opt out. */
  description?: string;
  closeLabel: string;
}

export function SheetContent({ side = 'left', ...props }: SheetContentProps) {
  return <DialogFrame variant={side === 'left' ? 'sheet-left' : 'sheet-right'} {...props} />;
}

export function SheetClose({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <DialogClose asChild>
      <button type="button" className="icon-btn" aria-label={label}>{children}</button>
    </DialogClose>
  );
}
