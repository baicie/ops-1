import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Icon } from './Icons';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Label } from './ui/label';
import { useT } from '../i18n';
import { STATUS_MAP, glyphForTone } from './status-tone';
import type { MessageKey } from '../i18n';

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="page-header">
      <div className="page-header-copy">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

// The wire code -> tone/label contract lives in status-tone.ts so the shadcn Badge in the
// migrated pages and this legacy pill can never disagree about it.

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const t = useT();
  const code = status?.toUpperCase();
  const known = code ? STATUS_MAP[code] : undefined;
  const tone = known?.tone || 'unknown';
  const glyph = glyphForTone(tone);
  // A code this mapping does not know is protocol data, not copy: render it verbatim
  // (only a missing code becomes a localized "Unknown"). data-status keeps the value
  // machine-readable so selectors never depend on localized text.
  const text = label || (known ? t(known.labelKey) : status || t('status.unknown'));
  return (
    <span className={`status status-${tone}`} data-status={code || undefined}>
      <Icon name={glyph} size={12} />
      {text}
    </span>
  );
}

export function EmptyState({
  icon = 'inbox',
  title,
  description,
  action,
}: {
  icon?: string;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon"><Icon name={icon} size={24} /></div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error | null; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="error-state" role="alert">
      <div className="error-icon"><Icon name="warning" size={22} /></div>
      <div>
        <h3>{t('error.loadTitle')}</h3>
        <p>{error?.message || t('error.unknown')}</p>
        {onRetry && <button className="btn btn-secondary" onClick={onRetry}><Icon name="refresh" size={15} /> {t('action.retry')}</button>}
      </div>
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  const t = useT();
  return (
    <div className="skeleton-stack" aria-label={t('aria.loading')} aria-busy="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div className="skeleton" key={index} style={{ width: `${92 - (index % 3) * 9}%` }} />
      ))}
    </div>
  );
}

export function TimeAgo({ value }: { value?: string | null }) {
  const t = useT();
  if (!value) return <span className="muted">{t('time.never')}</span>;
  const date = new Date(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  // Literal keys, never a template: scripts/check-i18n.mjs verifies every key is present in all locales.
  let relative = '';
  if (seconds < 10) relative = t('time.justNow');
  else if (seconds < 60) relative = t('time.secondsAgo', { count: seconds });
  else if (seconds < 3600) relative = t('time.minutesAgo', { count: Math.floor(seconds / 60) });
  else if (seconds < 86400) relative = t('time.hoursAgo', { count: Math.floor(seconds / 3600) });
  else relative = t('time.daysAgo', { count: Math.floor(seconds / 86400) });
  return <time dateTime={value} title={date.toISOString()}>{relative}</time>;
}

export function CopyButton({ value, label }: { value?: string | null; label?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const text = label || t('action.copy');
  return (
    <button
      className="icon-btn"
      title={text}
      aria-label={text}
      disabled={!value}
      onClick={async (event) => {
        event.stopPropagation();
        if (!value) return;
        try { await navigator.clipboard.writeText(value); } catch { /* clipboard may be unavailable */ }
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
    </button>
  );
}

/**
 * The one dialog body both exports below render. The Radix dialog primitive owns what the
 * hand-written version scripted by hand — Escape, overlay click, focus trap, focus restore and
 * scroll lock — while the markup keeps the pre-migration .modal* structure and insets, so the
 * pages that only pass open/onClose/title keep rendering exactly what they rendered before.
 */
function DialogShell({
  open,
  onClose,
  title,
  size = 'medium',
  footer,
  testId,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: 'small' | 'medium' | 'large';
  footer?: React.ReactNode;
  testId?: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent
        // p-0/gap-0: .modal-head, .modal-body and .modal-foot already carry the insets, and
        // .modal-body stays the only scroll container of the box.
        className={`modal modal-${size} gap-0 overflow-y-hidden p-0`}
        // Nothing renders a dialog description, so the primitive must not point at one.
        aria-describedby={undefined}
        // Radix hides the rest of the page from assistive technology instead of marking the
        // layer modal; the exported contract has always spelled out aria-modal, so keep it.
        aria-modal="true"
        data-testid={testId}
      >
        <div className="modal-head">
          {/* font-bold/leading-normal keep the h2 the primitive would otherwise restyle. */}
          <DialogTitle className="font-bold leading-normal">{title}</DialogTitle>
          <button className="icon-btn" onClick={onClose} aria-label={t('aria.closeDialog')}><Icon name="close" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </DialogContent>
    </Dialog>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'medium',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'small' | 'medium' | 'large';
}) {
  return (
    <DialogShell open={open} onClose={onClose} title={title} size={size} footer={footer}>
      {children}
    </DialogShell>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const resolvedConfirmLabel = confirmLabel ?? t('action.confirm');
  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title={title}
      size="small"
      testId="confirm-dialog"
      footer={<>
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>{t('action.cancel')}</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
          {busy ? t('action.working') : resolvedConfirmLabel}
        </button>
      </>}
    >
      <div className="confirm-copy">{description}</div>
    </DialogShell>
  );
}

type Toast = { id: string; tone: 'ok' | 'danger' | 'info'; title: string; detail?: string };
const ToastContext = createContext<{ push(t: Omit<Toast, 'id'>): void } | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const t = useT();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((items) => [...items, { ...toast, id }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 5200);
  }, []);
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div className={`toast toast-${toast.tone}`} key={toast.id}>
            <Icon name={toast.tone === 'ok' ? 'check' : toast.tone === 'danger' ? 'warning' : 'alert'} size={16} />
            <div><strong>{toast.title}</strong>{toast.detail && <p>{toast.detail}</p>}</div>
            <button className="icon-btn" aria-label={t('aria.dismiss')} onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}><Icon name="close" size={14} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: React.ReactNode; htmlFor?: string }) {
  // The Radix label primitive stays the field's wrapper element on purpose: no caller passes
  // htmlFor yet, so nesting the caller's own control is what associates the two. The primitive's
  // shadcn typography is neutralised in .field (src/styles.css) — those utilities would otherwise
  // reach the nested <input>/<select> through the global `font: inherit`.
  return (
    <Label className="field" htmlFor={htmlFor}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </Label>
  );
}

export function KV({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="kv">
      <span className="kv-label">{label}</span>
      <span className={`kv-value ${mono ? 'mono' : ''}`}>{children}</span>
    </div>
  );
}

export function Progress({ value, max, label }: { value: number; max: number; label?: string }) {
  const t = useT();
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label || t('aria.progress')}>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${percent}%` }} /></div>
      <span className="progress-label">{value}/{max}</span>
    </div>
  );
}
