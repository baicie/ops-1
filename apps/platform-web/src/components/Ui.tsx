import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { Icon } from './Icons';

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

const statusMap: Record<string, { tone: string; label: string }> = {
  READY: { tone: 'ok', label: 'Ready' },
  ACTIVE: { tone: 'ok', label: 'Active' },
  INSTALLED: { tone: 'ok', label: 'Installed' },
  CONFIRMED: { tone: 'ok', label: 'Confirmed' },
  STAGED: { tone: 'info', label: 'Staged' },
  VERIFIED: { tone: 'info', label: 'Verified' },
  AVAILABLE: { tone: 'neutral', label: 'Available' },
  PENDING: { tone: 'warn', label: 'Pending' },
  PREPARING: { tone: 'warn', label: 'Preparing' },
  STARTING: { tone: 'warn', label: 'Starting' },
  DRAINING: { tone: 'warn', label: 'Draining' },
  DEGRADED: { tone: 'warn', label: 'Degraded' },
  ATTENTION: { tone: 'warn', label: 'Attention' },
  UNHEALTHY: { tone: 'danger', label: 'Unhealthy' },
  FAILED: { tone: 'danger', label: 'Failed' },
  REJECTED: { tone: 'danger', label: 'Rejected' },
  DISABLED: { tone: 'neutral', label: 'Disabled' },
  UNINSTALLED: { tone: 'neutral', label: 'Uninstalled' },
  STOPPED: { tone: 'neutral', label: 'Stopped' },
  UNREACHABLE: { tone: 'danger', label: 'Unreachable' },
  UNKNOWN: { tone: 'unknown', label: 'Unknown' },
  ONLINE: { tone: 'ok', label: 'Online' },
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const value = statusMap[status?.toUpperCase()] || { tone: 'unknown', label: status || 'Unknown' };
  const glyph = value.tone === 'ok' ? 'check' : value.tone === 'danger' ? 'warning' : value.tone === 'warn' ? 'alert' : 'clock';
  return (
    <span className={`status status-${value.tone}`}>
      <Icon name={glyph} size={12} />
      {label || value.label}
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
  return (
    <div className="error-state" role="alert">
      <div className="error-icon"><Icon name="warning" size={22} /></div>
      <div>
        <h3>Could not load this view</h3>
        <p>{error?.message || 'Unknown error'}</p>
        {onRetry && <button className="btn btn-secondary" onClick={onRetry}><Icon name="refresh" size={15} /> Retry</button>}
      </div>
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton-stack" aria-label="Loading" aria-busy="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div className="skeleton" key={index} style={{ width: `${92 - (index % 3) * 9}%` }} />
      ))}
    </div>
  );
}

export function TimeAgo({ value }: { value?: string | null }) {
  if (!value) return <span className="muted">Never</span>;
  const date = new Date(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  let relative = '';
  if (seconds < 10) relative = 'just now';
  else if (seconds < 60) relative = `${seconds}s ago`;
  else if (seconds < 3600) relative = `${Math.floor(seconds / 60)}m ago`;
  else if (seconds < 86400) relative = `${Math.floor(seconds / 3600)}h ago`;
  else relative = `${Math.floor(seconds / 86400)}d ago`;
  return <time dateTime={value} title={date.toISOString()}>{relative}</time>;
}

export function CopyButton({ value, label = 'Copy' }: { value?: string | null; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-btn"
      title={label}
      aria-label={label}
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
          <button className="icon-btn" onClick={onClose} aria-label="Close dialog"><Icon name="close" /></button>
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
  confirmLabel = 'Confirm',
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
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="small"
      footer={<>
        <button className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
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
            <button className="icon-btn" aria-label="Dismiss" onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}><Icon name="close" size={14} /></button>
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
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label || 'Progress'}>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${percent}%` }} /></div>
      <span className="progress-label">{value}/{max}</span>
    </div>
  );
}
