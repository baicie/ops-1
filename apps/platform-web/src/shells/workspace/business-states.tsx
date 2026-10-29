import * as React from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api';
import { useAuth } from '../../auth';
import { useT, useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n';
import { visibleContributions, useExtensions } from '../../extensions';
import { isStale, useObservedPolling } from '../../components/app/async-boundary';
import { StatusIndicator, type IndicatorState } from '../../components/app/status-indicator';
import { Icon } from '../../components/Icons';
import { Button } from '../../components/ui/button';

/**
 * The business-side state vocabulary (G07).
 *
 * The platform console's states answer "what is the platform doing"; these answer "may I
 * read this business thing, and is what I see current". Six of them are required to look
 * different from each other - EMPTY, PARTIAL, STALE, UNAVAILABLE, 403 and 404 - because
 * collapsing them into one grey "nothing here" box is how a permission wall ends up being
 * read as an empty inbox. Every one is driven by an observed HTTP answer or by the absence of
 * an interface; none is inferred from a timer or a role.
 */

export type BusinessState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'partial'
  | 'stale'
  | 'unavailable'
  | 'forbidden'
  | 'notFound';

/** Reuses the shared observational glyph so both surfaces speak one visual language. */
const STATE_GLYPH: Record<BusinessState, IndicatorState> = {
  loading: 'loading',
  ready: 'ready',
  empty: 'noData',
  partial: 'partial',
  stale: 'stale',
  unavailable: 'notConfigured',
  forbidden: 'forbidden',
  notFound: 'unknown',
};

const STATE_LABEL: Record<BusinessState, MessageKey> = {
  loading: 'workspace.state.loading',
  ready: 'workspace.state.ready',
  empty: 'workspace.state.empty',
  partial: 'workspace.state.partial',
  stale: 'workspace.state.stale',
  unavailable: 'workspace.state.unavailable',
  forbidden: 'workspace.state.forbidden',
  notFound: 'workspace.state.notFound',
};

/**
 * The HTTP status decides the state, never the message text: a 403 is a permission wall and
 * a 404 is a missing interface, and neither is allowed to render as "empty data".
 */
export function businessStateForError(error: Error | null | undefined): BusinessState | null {
  if (!error) return null;
  if (error instanceof ApiError) {
    if (error.status === 403) return 'forbidden';
    if (error.status === 404) return 'notFound';
  }
  return 'unavailable';
}

/**
 * One state, rendered the same way everywhere on the business side: glyph + state name +
 * what the reader is looking at + the one action that is actually possible.
 */
export function BusinessStatePanel({
  state,
  title,
  detail,
  action,
  testId,
}: {
  state: BusinessState;
  title: string;
  detail?: React.ReactNode;
  action?: React.ReactNode;
  testId?: string;
}) {
  const t = useT();
  return (
    <div className="business-state" data-state={state} data-testid={testId}>
      <StatusIndicator state={STATE_GLYPH[state]} label={t(STATE_LABEL[state])} />
      <div className="business-state-copy">
        <p className="business-state-title">{title}</p>
        {detail ? <p className="business-state-detail">{detail}</p> : null}
      </div>
      {action ? <div className="business-state-action">{action}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Platform version
 *
 * The only business-safe platform fact (the G07 brief allows it): which build the browser is
 * looking at. It is read from the kernel's own version endpoint and stamped with the moment
 * this client saw it, so a later failed probe ages into STALE with a real timestamp instead
 * of quietly keeping a value that is no longer observed.
 * ------------------------------------------------------------------------- */

export const PLATFORM_PROBE_INTERVAL_MS = 30_000;

interface VersionPayload {
  version?: string | null;
  commitSha?: string | null;
}

async function readVersion(): Promise<VersionPayload> {
  const response = await fetch('/api/v1/version', {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new ApiError(response.status, 'VERSION_PROBE_FAILED', 'version probe answered ' + response.status);
  }
  return (await response.json()) as VersionPayload;
}

export interface PlatformVersionSignal {
  state: BusinessState;
  version: string | null;
  commitSha: string | null;
  observedAt: string | null;
  reload: () => void;
}

export function usePlatformVersion(): PlatformVersionSignal {
  const { data, error, loading, reload, observedAt } = useObservedPolling(readVersion, PLATFORM_PROBE_INTERVAL_MS);
  const failure = businessStateForError(error);
  const agedOut = observedAt !== null && isStale(observedAt, PLATFORM_PROBE_INTERVAL_MS);

  if (failure) {
    // A value we did observe, but not within the polling budget, is stale - not current.
    return { state: agedOut ? 'stale' : failure, version: data?.version ?? null, commitSha: data?.commitSha ?? null, observedAt, reload };
  }
  if (loading && !observedAt) {
    return { state: 'loading', version: null, commitSha: null, observedAt: null, reload };
  }
  if (agedOut) {
    return { state: 'stale', version: data?.version ?? null, commitSha: data?.commitSha ?? null, observedAt, reload };
  }
  return { state: 'ready', version: data?.version ?? null, commitSha: data?.commitSha ?? null, observedAt, reload };
}

/* ---------------------------------------------------------------------------
 * Business plugin entries
 *
 * The one business data source that really exists today. It is read through the shared
 * extension provider, which the server has already filtered to this session, so a plugin
 * that is not permitted here simply never appears in the list - an entry the user cannot open
 * must have no entry in the UI at all.
 * ------------------------------------------------------------------------- */

export interface BusinessPluginEntry {
  key: string;
  href: string;
  label: string;
}

export interface BusinessPluginsSignal {
  state: BusinessState;
  entries: BusinessPluginEntry[];
  reload: () => void;
}

export function useBusinessPlugins(): BusinessPluginsSignal {
  const { access } = useAuth();
  const { accepted, rejected, loaded, loading, error, reload } = useExtensions();

  if (loading) return { state: 'loading', entries: [], reload };

  const failure = businessStateForError(error);
  if (failure) return { state: failure, entries: [], reload };

  const pages = visibleContributions(accepted, access, 'workspace').filter((entry) => entry.kind === 'route.page');
  const entries: BusinessPluginEntry[] = pages.map((page) => ({
    key: page.pluginId + ':' + page.id,
    href: page.href,
    // The host never invents a plugin's display name; the id's last segment is what it has.
    label: page.pluginId.split('.').slice(-1)[0].replace(/-/g, ' '),
  }));

  const owners = new Set(pages.map((page) => page.pluginId));
  const unloadable = [...owners].filter((pluginId) => Boolean(loaded[pluginId]?.error)).length;
  // A refused contribution only counts here when it claimed a workspace outlet: the
  // console's own rejections are not this surface's business.
  const refused = rejected.filter((entry) => entry.href.startsWith('/app/ext/')).length;

  if (entries.length === 0) {
    return { state: unloadable > 0 ? 'unavailable' : 'empty', entries, reload };
  }
  return { state: unloadable > 0 || refused > 0 ? 'partial' : 'ready', entries, reload };
}

/**
 * The three cards of "available now". Everything under them is either session state or a
 * live response - that is the whole point of the section: it is what a business user can act
 * on today, next to the four task areas that are explicitly waiting for a service.
 */
export function BusinessPluginCard() {
  const t = useT();
  const { state, entries, reload } = useBusinessPlugins();
  const retry = (
    <Button variant="secondary" onClick={() => reload()} data-testid="business-plugins-retry">
      <Icon name="refresh" size={15} /> {t('action.retry')}
    </Button>
  );

  if (state === 'ready' || state === 'partial') {
    return (
      <div className="business-card" data-testid="business-plugins" data-state={state}>
        <BusinessStatePanel
          state={state}
          title={state === 'partial' ? t('workspace.home.plugins.partial.title') : t('workspace.home.plugins.title')}
          detail={state === 'partial' ? t('workspace.home.plugins.partial.description') : undefined}
        />
        <ul className="business-entry-list">
          {entries.map((entry) => (
            <li key={entry.key}>
              <Link to={entry.href} data-entry-plugin={entry.key}>
                <Icon name="external" size={14} /> {entry.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="business-card" data-testid="business-plugins" data-state={state}>
      <BusinessStatePanel
        state={state}
        title={state === 'loading'
          ? t('workspace.home.plugins.loading.title')
          : state === 'empty'
            ? t('workspace.home.plugins.empty.title')
            : state === 'forbidden'
              ? t('workspace.home.plugins.forbidden.title')
              : t('workspace.home.plugins.unavailable.title')}
        detail={state === 'loading'
          ? t('workspace.home.plugins.loading.description')
          : state === 'empty'
            ? t('workspace.home.plugins.empty.description')
            : state === 'forbidden'
              ? t('workspace.home.plugins.forbidden.description')
              : t('workspace.home.plugins.unavailable.description')}
        action={state === 'loading' ? undefined : retry}
      />
    </div>
  );
}

/** Platform version card: version + the moment this client last read it. */
export function PlatformVersionCard() {
  const t = useT();
  const { formatDateTime } = useI18n();
  const { state, version, observedAt, reload } = usePlatformVersion();
  const observed = observedAt ? t('workspace.home.platform.observed', { time: formatDateTime(observedAt) }) : t('workspace.home.platform.never');

  if (state === 'ready' || state === 'stale') {
    return (
      <div className="business-card" data-testid="business-platform" data-state={state}>
        {state === 'stale' ? (
          <BusinessStatePanel
            state="stale"
            title={t('workspace.home.platform.stale.title')}
            detail={t('workspace.home.platform.stale.description')}
          />
        ) : null}
        <dl className="business-kv">
          <div>
            <dt>{t('workspace.home.platform.title')}</dt>
            <dd className="mono">{version ?? t('badge.value.unknown')}</dd>
          </div>
          <div>
            <dt>{t('workspace.home.platform.observedLabel')}</dt>
            <dd>{observed}</dd>
          </div>
        </dl>
      </div>
    );
  }

  return (
    <div className="business-card" data-testid="business-platform" data-state={state}>
      <BusinessStatePanel
        state={state}
        title={state === 'loading'
          ? t('workspace.home.platform.loading.title')
          : state === 'notFound'
            ? t('workspace.home.platform.notFound.title')
            : t('workspace.home.platform.unavailable.title')}
        detail={state === 'loading'
          ? t('workspace.home.platform.loading.description')
          : state === 'notFound'
            ? t('workspace.home.platform.notFound.description')
            : t('workspace.home.platform.unavailable.description')}
        action={state === 'loading' ? undefined : (
          <Button variant="secondary" onClick={() => reload()} data-testid="business-platform-retry">
            <Icon name="refresh" size={15} /> {t('action.retry')}
          </Button>
        )}
      />
    </div>
  );
}
