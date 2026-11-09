import * as React from 'react';
import { ApiError } from '@opsweave/platform-client';
import { usePolling } from '@opsweave/platform-client/hooks';
import { apiFailureCopy } from '@opsweave/platform-client/kernel-messages';
import { clearBodyState, reportBodyState, type BodyState } from '@opsweave/platform-client/platform-status';
import { useT } from '@opsweave/platform-client/i18n';
import { Icon } from '@opsweave/ui/icons';
import { Button } from '@opsweave/ui/button';
import { Skeleton } from './Ui';
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

/**
 * How many polling intervals a payload may age before it counts as stale. A poll that hits
 * the wall twice still leaves headroom for one slow response; the third interval is already
 * late enough that "we saw it recently" would be a guess.
 */
export const STALE_AFTER_INTERVALS = 2.5;

/** Stale means "the newest observation is older than {@link STALE_AFTER_INTERVALS} polling rounds" — never a timer. */
export function isStale(observedAt: string | null, intervalMs: number): boolean {
  if (!observedAt) return false;
  return Date.now() - new Date(observedAt).getTime() > intervalMs * STALE_AFTER_INTERVALS;
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
  report = true,
  source = 'kernel',
  children,
}: {
  loading: boolean;
  error: Error | null;
  hasData: boolean;
  isEmpty?: boolean;
  emptyState?: React.ReactNode;
  onRetry?: () => void;
  skeletonRows?: number;
  /**
   * Whether this boundary owns the whole body. A page boundary reports the chrome state; an
   * inline section (a failed upload inside a still-usable wizard) must not make the topbar
   * claim the platform is unavailable.
   */
  report?: boolean;
  /**
   * Who produced the untranslated sentence. The Kernel's message is attributed as the Kernel's;
   * a remote extension's message is attributed as the plugin's. Never silently relabelled.
   */
  source?: 'kernel' | 'plugin';
  children: React.ReactNode;
}) {
  const t = useT();
  const state = classify(error);
  // Each boundary owns its claim: it releases it on unmount, so a plugin that recovers cannot
  // leave the chrome saying "unavailable". A plugin failure is attention, not unavailable -
  // the Kernel answered; one isolated extension did not.
  const owner = React.useId();
  const bodyState: BodyState =
    state === 'forbidden' ? 'forbidden'
      : state === 'conflict' ? 'attention'
        : state === 'error' ? (source === 'plugin' ? 'attention' : 'unavailable')
          : isEmpty ? 'empty'
            : 'ready';
  React.useEffect(() => {
    if (!report) return;
    reportBodyState(bodyState, owner);
    return () => clearBodyState(owner);
  }, [bodyState, report, owner]);

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
    return (
      <div data-async-state="error">
        <StatePanel state="error">
          <StatusIndicator state="error" />
          <h2>{t('error.loadTitle')}</h2>
          <AsyncErrorMessage error={error as Error} source={source} />
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
 * The failure paragraph every error surface prints, with no panel of its own.
 *
 * The sentence the reader acts on is the client's; the Kernel's (or a plugin's) own English
 * message is attributed beside it, never substituted for it (AGENTS.md 前端与国际化). Extracted
 * so an inline failure (a rejected confirmation, a failed upload) says exactly what a full-page
 * boundary says instead of printing `error.message` raw.
 */
export function AsyncErrorMessage({ error, source = 'kernel' }: { error: Error; source?: 'kernel' | 'plugin' }) {
  const t = useT();
  const apiError = error instanceof ApiError ? error : null;
  const failure = apiFailureCopy(error, t);
  const plugin = source === 'plugin';
  return (
    <>
      <p>{plugin ? t('extensions.error.isolationNote') : failure.reason}</p>
      <div className="async-panel-meta">
        {apiError ? <span className="mono">{t('ui.error.code')}: {apiError.code}</span> : null}
        {apiError?.requestId ? <span className="mono">{t('ui.error.requestId')}: {apiError.requestId}</span> : null}
      </div>
      {failure.kernelMessage ? (
        <p className="server-quote" data-testid="server-message" data-source={source}>
          <span className="server-source">{t(plugin ? 'ui.textSource.plugin' : 'ui.textSource.kernel')}</span>
          {failure.kernelMessage}
        </p>
      ) : null}
    </>
  );
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
