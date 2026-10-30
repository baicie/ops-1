import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../../lib/utils';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const overlayClass =
  // z-[100] matches .modal-backdrop in src/styles.css so migrated and legacy overlays stack alike.
  // V5 owns the wash itself (.ow-dialog-overlay = rgba(0,0,0,.6)): a dialog that leaves the page
  // behind it fully legible is not modal, it is a floating card.
  'ow-dialog-overlay fixed inset-0 z-[100] backdrop-blur-[2px]';

export interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Accessible name for the corner dismiss button; omit to render no button (localised copy is the caller's). */
  closeLabel?: string;
}

export const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, closeLabel, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className={overlayClass} />
    <DialogPrimitive.Content
      ref={ref}
      // Radix this version sets role and aria-labelledby but not aria-modal, and the exported
      // contract of every dialog in this shell spells it out. Set it on the primitive so no
      // consumer can forget; a caller that knows better can still override it below.
      aria-modal="true"
      className={cn(
        'fixed left-1/2 top-1/2 z-[100] flex max-h-[92vh] w-[calc(100%-40px)] max-w-[640px] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto',
        'rounded-lg border border-solid border-border bg-card p-5 text-card-foreground shadow-[0_24px_70px_rgba(0,0,0,0.35)]',
        'focus-visible:outline-none',
        className,
      )}
      {...props}
    >
      {children}
      {closeLabel ? (
        <DialogPrimitive.Close
          className={cn(
            'absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-sm',
            // bg-transparent is load-bearing, not decoration: preflight is off, so a <button> that
            // declares no background paints the UA's ButtonFace - #6b6b6b in dark - which made the
            // close control a grey slab on the dialog surface and its icon 1.64:1 against it.
            // On --ow-surface the ink below is 7.56:1 in light and 8.99:1 in dark.
            'border border-solid border-transparent bg-transparent text-foreground-secondary transition-colors',
            'hover:bg-secondary hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
          <span className="sr-only">{closeLabel}</span>
        </DialogPrimitive.Close>
      ) : null}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = 'DialogContent';

export const DialogHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col gap-1 pr-6 text-left', className)} {...props} />
  ),
);
DialogHeader.displayName = 'DialogHeader';

export const DialogFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-wrap items-center justify-end gap-2', className)} {...props} />
  ),
);
DialogFooter.displayName = 'DialogFooter';

export const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-snug text-foreground', className)}
    {...props}
  />
));
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm leading-relaxed text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = 'DialogDescription';
