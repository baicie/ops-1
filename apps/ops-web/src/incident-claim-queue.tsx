import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '@opsweave/platform-client';
import { useI18n, useT } from '@opsweave/platform-client/i18n';
import type { MessageKey } from '@opsweave/platform-client/i18n';
import { ageMessage } from '@opsweave/platform-client/age';
import { shortLocator } from '@opsweave/platform-client/identity';
import { Icon } from '@opsweave/ui/icons';
import { Button } from '@opsweave/ui/button';
import { EmptyState, useToast } from '@opsweave/ui/Ui';
import { Status } from '@opsweave/ui/status';
import { StatusIndicator } from '@opsweave/ui/status-indicator';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@opsweave/ui/table';
import type { BusinessWorkspace } from './incident-model';
import {
  claimFailureKey,
  claimFailureNeedsRefresh,
  claimPayload,
  claimQueueState,
  type ClaimableIncident,
  type ClaimableIncidentList,
  type ClaimedIncident,
} from './incident-claims';
import { StackCell, cardActionCell, cardLineAfter, cardTwoLineRow, stackBody, stackHead, stackRow, stackTable } from '@opsweave/ui/table-kit';

/**
 * The workspace queue of unclaimed automation incidents (G13-B1.4).
 *
 * An automation incident is owned by the non-login automation service user, so an
 * operator's ordinary read (owner = caller) can never show it. This panel is the one
 * sanctioned second look; the kernel returns a minimal summary and the only action it
 * offers is an atomic claim. Claiming moves ownership to this account, after which the
 * ordinary incident detail - evidence, verdict, closure - applies unchanged.
 *
 * The panel is rendered only for a role the kernel would accept; a viewer sees neither
 * the panel nor a disabled button that would invite a refused write.
 */
export function IncidentClaimQueue({
  workspaces,
  refreshToken,
}: {
  workspaces: BusinessWorkspace[] | null;
  refreshToken: number;
}) {
  const t = useT();
  const { locale } = useI18n();
  const navigate = useNavigate();
  const toast = useToast();
  const [items, setItems] = React.useState<ClaimableIncident[] | null>(null);
  const [error, setError] = React.useState<unknown>(null);
  const [loading, setLoading] = React.useState(true);
  const [reload, setReload] = React.useState(0);
  const [claiming, setClaiming] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get<ClaimableIncidentList>('/api/v1/incidents/claimable')
      .then((result) => {
        if (cancelled) return;
        setItems(result.items);
        setError(null);
      })
      .catch((cause: Error) => {
        if (cancelled) return;
        setError(cause);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload, refreshToken]);

  const status = error instanceof ApiError ? error.status : null;
  const state = claimQueueState({ items, error, loading, status });
  const workspaceName = (id: string) =>
    workspaces?.find((workspace) => workspace.workspaceId === id)?.name ?? shortLocator(id);

  const claim = (incident: ClaimableIncident) => {
    setClaiming(incident.id);
    setError(null);
    api.post<ClaimedIncident>(`/api/v1/incidents/${incident.id}/claim`, claimPayload(incident.revision))
      .then((claimed) => {
        toast.push({
          tone: 'ok',
          title: t('incidents.claim.success'),
          detail: t('incidents.claim.successDetail', { title: incident.title }),
        });
        navigate('/app/incidents/' + claimed.id);
      })
      .catch((cause: Error) => {
        const code = cause instanceof ApiError ? cause.code : null;
        setError(cause);
        toast.push({
          tone: 'danger',
          title: t('incidents.claim.failed'),
          detail: claimCopy(t, code),
        });
        // A conflict is a fact about the queue, not about this click: the row moved.
        // Re-read so the next attempt is decided against what the kernel holds now.
        if (claimFailureNeedsRefresh(code)) setReload((value) => value + 1);
      })
      .finally(() => setClaiming(null));
  };

  return (
    <section className="panel" data-testid="incident-claim-queue" data-claim-state={state}>
      <div className="panel-head">
        <div>
          <h2>{t('incidents.claim.title')}</h2>
          <p className="muted small">{t('incidents.claim.description')}</p>
        </div>
        <Button
          variant="secondary"
          data-testid="incident-claim-refresh"
          disabled={loading}
          onClick={() => setReload((value) => value + 1)}
        >
          <Icon name="refresh" size={15} /> {t('incidents.claim.action.refresh')}
        </Button>
      </div>

      {state === 'loading' ? (
        <div className="pad" aria-busy="true" aria-label={t('incidents.claim.loadingAria')} data-testid="incident-claim-loading">
          <div className="skeleton-stack">
            <div className="skeleton" style={{ width: '44%' }} />
            <div className="skeleton" style={{ width: '68%' }} />
          </div>
        </div>
      ) : state === 'forbidden' ? (
        <div className="async-panel" role="alert" data-panel-state="forbidden" data-testid="incident-claim-forbidden">
          <StatusIndicator state="forbidden" label={t('ui.forbidden.title')} />
          <p className="muted small">{t('incidents.claim.error.forbidden')}</p>
        </div>
      ) : state === 'failed' ? (
        <div className="pad" data-testid="incident-claim-failed">
          <div className="inline-error" role="alert" data-error-code={status === null ? 'UNREACHABLE' : (error instanceof ApiError ? error.code : 'HTTP_ERROR')}>
            <Icon name="warning" size={14} />
            <div>
              <p>{claimCopy(t, error instanceof ApiError ? error.code : null)}</p>
              {error instanceof ApiError ? <p className="muted small"><code>{error.code}</code></p> : null}
            </div>
          </div>
          <Button variant="secondary" onClick={() => setReload((value) => value + 1)}>
            <Icon name="refresh" size={15} /> {t('action.retry')}
          </Button>
        </div>
      ) : state === 'empty' ? (
        <div className="pad" data-testid="incident-claim-empty">
          <EmptyState icon="inbox" title={t('incidents.claim.emptyTitle')} description={t('incidents.claim.empty')} />
        </div>
      ) : (
        <Table className={stackTable} data-testid="incident-claim-table">
          <TableHeader className={stackHead}>
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('table.incident')}</TableHead>
              <TableHead>{t('table.severity')}</TableHead>
              <TableHead>{t('table.status')}</TableHead>
              <TableHead>{t('incidents.claim.columnWorkspace')}</TableHead>
              <TableHead>{t('table.started')}</TableHead>
              <TableHead aria-label={t('table.actions')} />
            </TableRow>
          </TableHeader>
          <TableBody className={stackBody}>
            {(items ?? []).map((incident) => (
              <TableRow key={incident.id} className={stackRow + ' ' + cardTwoLineRow} data-testid="incident-claim-row" data-incident-id={incident.id}>
                <StackCell label={t('table.incident')}>
                  {/* Two lines, each bounded: a long title or a source-native id must not
                      push the card past the viewport at 390 (observed before truncation). */}
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="ow-key truncate" title={incident.title} data-testid="incident-claim-title">{incident.title}</span>
                    {incident.nativeId ? <span className="ow-key muted truncate" title={incident.nativeId}>{shortLocator(incident.nativeId)}</span> : null}
                  </span>
                </StackCell>
                <StackCell label={t('table.severity')} className={cardLineAfter}><Status code={incident.severity} /></StackCell>
                <StackCell label={t('table.status')} className={cardLineAfter}><Status code={incident.status} /></StackCell>
                <StackCell label={t('incidents.claim.columnWorkspace')} className={cardLineAfter}>
                  <span data-testid="incident-claim-workspace" data-workspace-id={incident.workspaceId}>{workspaceName(incident.workspaceId)}</span>
                </StackCell>
                <StackCell label={t('table.started')} className={cardLineAfter}>
                  <span title={incident.startedAt}>{ageMessage(locale, incident.startedAt) || incident.startedAt}</span>
                </StackCell>
                <StackCell label={t('table.actions')} className={cardActionCell}>
                  <Button
                    data-testid="incident-claim-button"
                    data-incident-id={incident.id}
                    disabled={claiming !== null}
                    aria-busy={claiming === incident.id}
                    onClick={() => claim(incident)}
                  >
                    <Icon name="check" size={15} /> {claiming === incident.id ? t('incidents.claim.action.claiming') : t('incidents.claim.action.claim')}
                  </Button>
                </StackCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** The code-keyed sentence, in one place for the toast and the inline error. */
function claimCopy(t: (key: MessageKey, values?: Record<string, string | number>) => string, code: string | null): string {
  const key = claimFailureKey(code);
  if (key) return t(key);
  return code ? t('incidents.claim.error.unknown', { code }) : t('incidents.claim.error.network');
}
