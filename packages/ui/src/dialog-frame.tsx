import * as React from 'react';
import { cn } from '@opsweave/ui/utils';
import { useT } from '@opsweave/platform-client/i18n';
import { Icon } from '@opsweave/ui/icons';
import { DialogClose, DialogContent, DialogDescription, DialogTitle } from '@opsweave/ui/dialog';

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
  description?: React.ReactNode;
  /** Accessible name for the corner dismiss button; defaults to the catalog's Close label. */
  closeLabel?: string;
  /**
   * False while a write is in flight. The close control stays in place but is disabled, and
   * Escape/overlay dismissal is suppressed - hiding the button would hide the state instead of
   * stating it.
   */
  dismissible?: boolean;
  footer?: React.ReactNode;
  size?: 'small' | 'medium' | 'large';
  variant?: DialogFrameVariant;
  children?: React.ReactNode;
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
  dismissible = true,
  footer,
  size = 'medium',
  variant = 'center',
  className,
  children,
  ...contentProps
}: DialogFrameProps) {
  const t = useT();
  // Radix owns the association: when a DialogDescription is mounted it sets aria-describedby to
  // that element's id (and DialogContent concatenates it with any explicit value). Passing a
  // second id here produced `"_r_t_ radix-_r_s_"`, and the second id belonged to no element.
  const hasDescription = description !== undefined && description !== null && description !== '';
  const { onEscapeKeyDown, onPointerDownOutside, ...rest } = contentProps;
  const closeName = closeLabel ?? t('aria.closeDialog');
  return (
    <DialogContent
      {...rest}
      // The head/body/foot carry the insets; the primitive's own padding would double them.
      className={cn('ow-dialog gap-0 p-0', variant === 'center' && `ow-dialog--${size}`, VARIANT_CLASS[variant], className)}
      // No explicit id: with a description Radix points at the element it rendered; without one
      // the attribute is absent rather than pointing at a node that does not exist.
      aria-describedby={undefined}
      aria-modal="true"
      aria-busy={dismissible ? undefined : true}
      onEscapeKeyDown={(event) => {
        if (!dismissible) event.preventDefault();
        onEscapeKeyDown?.(event);
      }}
      onPointerDownOutside={(event) => {
        if (!dismissible) event.preventDefault();
        onPointerDownOutside?.(event);
      }}
      data-dismissible={dismissible ? 'true' : 'false'}
    >
      <div className="ow-dialog-head">
        <DialogTitle className="ow-dialog-title">{title}</DialogTitle>
        {/*
          One close control, disabled rather than swapped out: replacing the DialogClose wrapper
          with a plain button would unmount the focused element mid-write and drop focus. A
          disabled child of DialogClose cannot fire its handler, so the write cannot be dismissed
          by a click; the label carries the reason for assistive technology, not just a title.
        */}
        <DialogClose asChild>
          <button
            type="button"
            className="icon-btn"
            disabled={!dismissible}
            aria-disabled={dismissible ? undefined : true}
            aria-label={dismissible ? closeName : `${closeName}. ${t('aria.closeBlocked')}`}
            title={dismissible ? undefined : t('aria.closeBlocked')}
          >
            <Icon name="close" />
          </button>
        </DialogClose>
      </div>
      {hasDescription ? <DialogDescription className="ow-dialog-description">{description}</DialogDescription> : null}
      {children !== undefined && children !== null && children !== false ? <div className="ow-dialog-body">{children}</div> : null}
      {footer ? <div className="ow-dialog-foot">{footer}</div> : null}
    </DialogContent>
  );
}
