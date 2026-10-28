import * as React from 'react';
import { ApiError } from '../../api';
import { useT } from '../../i18n';
import { Icon } from '../Icons';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

/**
 * The one confirmation surface for an irreversible or privilege-changing action (docs/04 §4.4
 * "ConfirmAction", docs/09 §9.1: a success is the server's answer, not the click).
 *
 * The contract is deliberately narrow so every caller behaves the same way:
 *   - resolving closes the dialog — the action is done;
 *   - rejecting keeps it open, prints the failure and re-enables the same button, so the retry
 *     is the button the operator already has instead of a second path through the page;
 *   - a second submit while the request is in flight is dropped in the handler as well as by
 *     the disabled attribute (a fast double click can land both events before a re-render).
 */
export function ConfirmAction({
  open,
  title,
  description,
  confirmLabel,
  danger = true,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  /** Performs the action. Resolve to close the dialog, reject to stay open and offer a retry. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);
  const inFlight = React.useRef(false);

  // A dismissed dialog forgets the previous failure; reopening it starts clean.
  React.useEffect(() => {
    if (!open) {
      setPending(false);
      setError(null);
      inFlight.current = false;
    }
  }, [open]);

  async function confirm() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (cause) {
      setError(cause as Error);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const apiError = error instanceof ApiError ? error : null;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogContent
        closeLabel={t('aria.closeDialog')}
        aria-describedby={undefined}
        className="max-w-[480px]"
        data-testid="confirm-dialog"
        data-confirm-state={pending ? 'pending' : error ? 'error' : 'idle'}
      >
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="text-[var(--ow-text-secondary)] leading-relaxed">{description}</div>
        {error ? (
          <div className="inline-error" role="alert" data-confirm-error>
            <Icon name="warning" size={16} />
            <div>
              <p>{error.message || t('error.unknown')}</p>
              {apiError ? <p className="mono text-sm">{t('ui.error.code')}: {apiError.code}</p> : null}
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={pending} data-confirm-cancel>{t('action.cancel')}</Button>
          <Button
            variant={danger ? 'destructive' : 'default'}
            onClick={() => void confirm()}
            disabled={pending}
            aria-busy={pending || undefined}
            data-confirm-submit
          >
            {pending ? t('action.working') : error ? t('action.retry') : confirmLabel ?? t('action.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
