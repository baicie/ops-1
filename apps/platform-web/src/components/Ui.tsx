import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icons';
import { useT } from '../i18n';
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

/** One mapping for every status code the shell renders; the code stays the wire value. */
const statusMap: Record<string, { tone: string; labelKey: MessageKey }> = {
  READY: { tone: 'ok', labelKey: 'status.ready' },
  ACTIVE: { tone: 'ok', labelKey: 'status.active' },
  INSTALLED: { tone: 'ok', labelKey: 'status.installed' },
  CONFIRMED: { tone: 'ok', labelKey: 'status.confirmed' },
  STAGED: { tone: 'info', labelKey: 'status.staged' },
  VERIFIED: { tone: 'info', labelKey: 'status.verified' },
  AVAILABLE: { tone: 'neutral', labelKey: 'status.available' },
  PENDING: { tone: 'warn', labelKey: 'status.pending' },
  PREPARING: { tone: 'warn', labelKey: 'status.preparing' },
  STARTING: { tone: 'warn', labelKey: 'status.starting' },
  DRAINING: { tone: 'warn', labelKey: 'status.draining' },
  DEGRADED: { tone: 'warn', labelKey: 'status.degraded' },
  ATTENTION: { tone: 'warn', labelKey: 'status.attention' },
  UNHEALTHY: { tone: 'danger', labelKey: 'status.unhealthy' },
  FAILED: { tone: 'danger', labelKey: 'status.failed' },
  REJECTED: { tone: 'danger', labelKey: 'status.rejected' },
  DISABLED: { tone: 'neutral', labelKey: 'status.disabled' },
  UNINSTALLED: { tone: 'neutral', labelKey: 'status.uninstalled' },
  STOPPED: { tone: 'neutral', labelKey: 'status.stopped' },
  UNREACHABLE: { tone: 'danger', labelKey: 'status.unreachable' },
  UNKNOWN: { tone: 'unknown', labelKey: 'status.unknown' },
  ONLINE: { tone: 'ok', labelKey: 'status.online' },
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const t = useT();
  const code = status?.toUpperCase();
  const known = code ? statusMap[code] : undefined;
  const tone = known?.tone || 'unknown';
  const glyph = tone === 'ok' ? 'check' : tone === 'danger' ? 'warning' : tone === 'warn' ? 'alert' : 'clock';
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
  const t = useT();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab' && ref.current) {
        const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((node) => !node.hasAttribute('disabled'));
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    window.setTimeout(() => ref.current?.querySelector<HTMLElement>('button, input, select, textarea')?.focus(), 30);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('aria.closeDialog')}><Icon name="close" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
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
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="small"
      footer={<>
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>{t('action.cancel')}</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
          {busy ? t('action.working') : resolvedConfirmLabel}
        </button>
      </>}
    >
      <div className="confirm-copy">{description}</div>
    </Modal>
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
  return (
    <label className="field" htmlFor={htmlFor}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
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
