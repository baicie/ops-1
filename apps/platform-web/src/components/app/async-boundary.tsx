import * as React from 'react';
import { ApiError } from '../../api';
import { usePolling } from '../../hooks';
import { useT } from '../../i18n';
import { Icon } from '../Icons';
import { Button } from '../ui/button';
import { Skeleton } from '../Ui';
import { StatusIndicator, type IndicatorState } from './status-indicator';

/**
 * Polling plus the observation time this client actually saw the payload at.
 *
 * The Kernel does not stamp every list response with its own observed_at, so the honest
 * "when did we see this" value is captured here, at the moment the promise resolved. It is
 * never synthesised from a timer and never back-dated.
 */
export function useObservedPolling<T>(load: () => Promise<T>, intervalMs = 0) {
  const [observedAt, setObservedAt] = React.useState<string | null>(null);
  const { data, error, loading, reload } = usePolling(async () => {
    const result = await load();
    setObservedAt(new Date().toISOString());
    return result;
  }, intervalMs);
  return { data, error, loading, reload, observedAt };
}

/** Stale means "the newest observation is older than two polling rounds" — never a timer. */
export function isStale(observedAt: string | null, intervalMs: number): boolean {
  if (!observedAt) return false;
  return Date.now() - new Date(observedAt).getTime() > intervalMs * 2.5;
}

type AsyncState = 'loading' | 'ready' | 'empty' | 'error' | 'forbidden' | 'conflict';

/** The HTTP status decides the panel, not the message text: 403 is a permission wall, 409 a conflict. */
function classify(error: Error | null): AsyncState {
  if (!error) return 'ready';
  if (error instanceof ApiError) {
    if (error.status === 403) return 'forbidden';
    if (error.status === 409) return 'conflict';
  }
  return 'error';
}

function StatePanel({ state, children }: { state: 'error' | 'forbidden' | 'conflict'; children: React.ReactNode }) {
  return (
    <div className="async-panel" role="alert" data-panel-state={state}>
      {children}
    </div>
  );
}

/**
 * One boundary for every request-driven surface: loading, permission wall, conflict, error and
 * empty each get their own UI instead of a shared spinner (docs/09 §9.1). A 403 never prints
 * resource details — the panel cannot leak what the caller may not see.
 */
export function AsyncBoundary({
  loading,
  error,
  hasData,
  isEmpty = false,
  emptyState,
  onRetry,
  skeletonRows = 5,
  children,
}: {
  loading: boolean;
  error: Error | null;
  hasData: boolean;
  isEmpty?: boolean;
  emptyState?: React.ReactNode;
  onRetry?: () => void;
  skeletonRows?: number;
  children: React.ReactNode;
}) {
  const t = useT();
  const state = classify(error);

  if (loading && !hasData) {
    return (
      <div className="async-loading" data-async-state="loading" role="status" aria-busy="true">
        <Skeleton rows={skeletonRows} />
      </div>
    );
  }

  if (state === 'forbidden') {
    return (
      <div data-async-state="forbidden">
        <StatePanel state="forbidden">
          <StatusIndicator state="forbidden" />
          <h2>{t('ui.forbidden.title')}</h2>
          <p>{t('ui.forbidden.description')}</p>
        </StatePanel>
      </div>
    );
  }

  if (state === 'conflict') {
    return (
      <div data-async-state="conflict">
        <StatePanel state="conflict">
          <StatusIndicator state="conflict" />
          <h2>{t('ui.conflict.title')}</h2>
          <p>{t('ui.conflict.description')}</p>
          {onRetry ? <Button variant="secondary" onClick={onRetry}><Icon name="refresh" size={15} /> {t('action.retry')}</Button> : null}
        </StatePanel>
      </div>
    );
  }

  if (state === 'error') {
    const apiError = error instanceof ApiError ? error : null;
    return (
      <div data-async-state="error">
        <StatePanel state="error">
          <StatusIndicator state="error" />
          <h2>{t('error.loadTitle')}</h2>
          <p>{error?.message || t('error.unknown')}</p>
          <div className="async-panel-meta">
            {apiError ? <span className="mono">{t('ui.error.code')}: {apiError.code}</span> : null}
            {apiError?.requestId ? <span className="mono">{t('ui.error.requestId')}: {apiError.requestId}</span> : null}
          </div>
          {onRetry ? <Button variant="secondary" onClick={onRetry}><Icon name="refresh" size={15} /> {t('action.retry')}</Button> : null}
        </StatePanel>
      </div>
    );
  }

  if (isEmpty && emptyState) {
    return <div data-async-state="empty">{emptyState}</div>;
  }

  return <div data-async-state="ready">{children}</div>;
}

/**
 * The banner for "this is not wrong, but it is not current either": STALE, PARTIAL and
 * NOT_CONFIGURED notices that must never be folded into a green summary.
 */
export function NoticeBar({
  state,
  title,
  detail,
  action,
}: {
  state: IndicatorState;
  title: string;
  detail?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={`notice-bar notice-${state}`} data-notice={state}>
      <StatusIndicator state={state} label={title} />
      {detail ? <p className="notice-detail">{detail}</p> : null}
      {action ? <div className="notice-action">{action}</div> : null}
    </div>
  );
}
