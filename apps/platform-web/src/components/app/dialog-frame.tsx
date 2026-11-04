import * as React from 'react';
import { cn } from '../../lib/utils';
import { useT } from '../../i18n';
import { Icon } from '../Icons';
import { DialogClose, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog';

/**
 * One frame for every overlay the shell owns.
 *
 * Until DS-V1-1b there were two: `Modal` painted `.modal` + `.modal-head` + `.modal-body` and
 * `SheetContent` painted a bare Radix content box with its own padding. The two could not be
 * exchanged - a dialog dropped into the sheet lost its insets and a sheet dropped into a dialog
 * lost its side - which is why the same surface was implemented twice and drifted twice.
 *
 * The frame owns the head, the body and the foot; the variant owns only geometry. Both remain
 * Radix Dialog underneath, so focus trap, Escape, scroll lock and `aria-modal` stay the
 * primitive's job.
 */
export type DialogFrameVariant = 'center' | 'sheet-left' | 'sheet-right';

export interface DialogFrameProps extends Omit<React.ComponentPropsWithoutRef<typeof DialogContent>, 'children' | 'closeLabel'> {
  title: string;
  /** Visible explanation under the title. Omit when the body explains itself. */
  description?: string;
  /** Accessible name for the corner dismiss button; defaults to the catalog's Close label. */
  closeLabel?: string;
  footer?: React.ReactNode;
  size?: 'small' | 'medium' | 'large';
  variant?: DialogFrameVariant;
  children: React.ReactNode;
}

const VARIANT_CLASS: Record<DialogFrameVariant, string> = {
  center: 'ow-dialog--center',
  'sheet-left': 'ow-dialog--sheet-left',
  'sheet-right': 'ow-dialog--sheet-right',
};

export function DialogFrame({
  title,
  description,
  closeLabel,
  footer,
  size = 'medium',
  variant = 'center',
  className,
  children,
  ...contentProps
}: DialogFrameProps) {
  const t = useT();
  return (
    <DialogContent
      {...contentProps}
      // The head/body/foot carry the insets; the primitive's own padding would double them.
      className={cn('ow-dialog gap-0 p-0', variant === 'center' && `ow-dialog--${size}`, VARIANT_CLASS[variant], className)}
      // Nothing here points at a description the caller did not render.
      aria-describedby={undefined}
      aria-modal="true"
    >
      <div className="ow-dialog-head">
        <DialogTitle className="ow-dialog-title">{title}</DialogTitle>
        <DialogClose asChild>
          <button type="button" className="icon-btn" aria-label={closeLabel ?? t('aria.closeDialog')}>
            <Icon name="close" />
          </button>
        </DialogClose>
      </div>
      {description ? <DialogDescription className="ow-dialog-description">{description}</DialogDescription> : null}
      <div className="ow-dialog-body">{children}</div>
      {footer ? <div className="ow-dialog-foot">{footer}</div> : null}
    </DialogContent>
  );
}
