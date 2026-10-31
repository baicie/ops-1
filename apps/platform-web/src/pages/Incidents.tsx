import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { IncidentView } from '../types';
import { useAuth } from '../auth';
import { useDocumentTitle } from '../hooks';
import { useI18n, useT } from '../i18n';
import type { MessageKey } from '../i18n';
import { ageMessage } from '../lib/age';
import { Icon } from '../components/Icons';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { EmptyState, Field, Modal, useToast } from '../components/Ui';
import { AsyncBoundary } from '../components/app/async-boundary';
import { PageHeader } from '../components/app/page-header';
import { Status } from '../components/app/status';
import { statusForCode } from '../components/status-tone';
import {
  FILTER_ANY,
  INCIDENT_SEVERITY_CODES,
  INCIDENT_STATUS_CODES,
  OWNER_ANY,
  OWNER_SELF,
  TITLE_MAX_CHARS,
  TITLE_MIN_CHARS,
  incidentFailureKey,
  incidentListQuery,
  incidentSourceKey,
  incidentsEmptyKind,
  type IncidentListPayload,
  ownerFilterValue,
  shortOwner,
  toIsoInstant,
  toLocalInputValue,
} from '../incidents';
import {
  IdentityCell,
  RowActions,
  StackCell,
  cardActionCell,
  copyIdAction,
  formatIdentity,
  stackBody,
  stackHead,
  stackRow,
  stackTable,
} from './table-kit';

/**
 * `/app/incidents` - the incident list (G11 D3).
 *
 * What this page may show is decided by the kernel: the list endpoint answers with the rows the
 * caller's role can read, and every write is gated server-side. The page therefore renders what
 * it read and states, in one panel, exactly what this slice does not do (no collector, no AI
 * diagnosis, no close endpoint, no free-text search) instead of implying those exist.
 */

/** One row of the admin-only user directory. Absent for an operator or a viewer. */
interface DirectoryUser {
  id: string;
  email: string;
  displayName: string;
}

/**
 * Owner names, when the signed-in role may read them.
 *
 * `GET /api/v1/users` requires the admin role. A refusal is not an error to surface: it is the
 * reason this page prints an id instead of a name, so the absence is reported as the directory
 * being unreadable rather than hidden behind a generic "Unknown user".
 */
export function useUserDirectory(): { names: Record<string, string> | null; readable: boolean } {
  const [state, setState] = React.useState<{ names: Record<string, string> | null; readable: boolean }>({ names: null, readable: false });
  React.useEffect(() => {
    let cancelled = false;
    api.get<DirectoryUser[]>('/api/v1/users')
      .then((users) => {
        if (cancelled) return;
        const names: Record<string, string> = {};
        for (const user of users) names[user.id] = user.displayName || user.email;
        setState({ names, readable: true });
      })
      .catch(() => { if (!cancelled) setState({ names: null, readable: false }); });
    return () => { cancelled = true; };
  }, []);
  return state;
}

/**
 * A failed operation, explained by its stable error code.
 *
 * The code decides the copy; the Kernel's English sentence is never rendered as the message
 * (rules/06). A code this client has no copy for is reported as a code plus a generic sentence,
 * which is at least true, instead of showing a sentence the catalog cannot translate.
 */
export function IncidentFailureNotice({ error, testId }: { error: unknown; testId?: string }) {
  const t = useT();
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : null;
  const code = apiError?.code ?? null;
  const key: MessageKey | null = incidentFailureKey(code);
  const message = key
    ? t(key)
    : apiError
      ? t('incidents.error.unknown', { code: apiError.code })
      : t('incidents.error.network');
  return (
    <div className="inline-error" role="alert" data-testid={testId} data-error-code={code ?? 'UNREACHABLE'}>
      <Icon name="warning" size={14} />
      <div>
        <p>{message}</p>
        <p className="muted small">
          {code ? <code data-testid="incident-error-code">{code}</code> : null}
          {apiError?.requestId ? <span> · {t('ui.error.requestId')} <code>{apiError.requestId}</code></span> : null}
        </p>
      </div>
    </div>
  );
}

/** "Read at HH:MM:SS", plus the reason when a later refresh failed while rows stayed on screen. */
function Freshness({ observedAt, error }: { observedAt: string | null; error: Error | null }) {
  const t = useT();
  if (!observedAt) return null;
  const at = new Date(observedAt);
  const stamp = Number.isNaN(at.getTime()) ? observedAt : at.toLocaleTimeString();
  const key = error instanceof ApiError ? incidentFailureKey(error.code) : null;
  const reason = error instanceof ApiError
    ? (key ? t(key) : error.code)
    : error
      ? t('incidents.error.network')
      : null;
  return (
    <p className="muted small" data-testid="incident-freshness" data-stale={reason ? 'true' : 'false'}>
      {reason ? t('incidents.freshness.stale', { at: stamp, reason }) : t('incidents.freshness.observed', { at: stamp })}
    </p>
  );
}

/** The chip label for a wire code, from the one status table (never the raw code as copy). */
function codeLabelKey(code: string): MessageKey {
  return statusForCode(code)?.labelKey ?? 'status.unknown';
}

export function IncidentsPage() {
  const t = useT();
  const { locale } = useI18n();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  useDocumentTitle(t('page.workspaceIncidents'));

  const [status, setStatus] = React.useState(FILTER_ANY);
  const [severity, setSeverity] = React.useState(FILTER_ANY);
  const [owner, setOwner] = React.useState(OWNER_ANY);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);
  const [data, setData] = React.useState<IncidentListPayload | null>(null);
  const [error, setError] = React.useState<Error | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [observedAt, setObservedAt] = React.useState<string | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const directory = useUserDirectory();

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const query = incidentListQuery({
      status,
      severity,
      owner: ownerFilterValue(owner, user?.id ?? null),
      cursor,
      limit: 20,
    });
    api.get<IncidentListPayload>('/api/v1/incidents?' + query)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
        setObservedAt(new Date().toISOString());
      })
      .catch((cause: Error) => { if (!cancelled) setError(cause); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [status, severity, owner, cursor, reload, user?.id]);

  const filtering = status !== FILTER_ANY || severity !== FILTER_ANY || owner !== OWNER_ANY;
  const clearFilters = () => { setStatus(FILTER_ANY); setSeverity(FILTER_ANY); setOwner(OWNER_ANY); setCursor(null); };
  const items = data?.items ?? [];
  /**
   * What the kernel said this list would show, carried by the same answer as the rows. The page
   * never derives it from the signed-in role: it renders the scope it was sent, and a body with
   * no scope explains nothing rather than guessing (the same rule as lib/audit-scope.ts).
   */
  const scope = data?.scope ?? null;
  /**
   * An empty list has three causes and an empty array cannot tell them apart. This page used to
   * render all three as "nothing has been entered", which for an operator is false: it reads
   * only the incidents it owns, so a platform with records can still send it an empty page.
   * incidentsEmptyKind decides, and a filter outranks the scope here because clearing a filter
   * can produce the operator's own rows (incidents.ts).
   */
  const emptyKind = incidentsEmptyKind({ scope, filtering });
  const titleCount = new Set(items.map((item) => item.title)).size;
  const ownerName = (ownerId: string) => directory.names?.[ownerId] ?? shortOwner(ownerId);

  return (
    <div className="page-stack" data-testid="incidents-page">
      <PageHeader
        eyebrow={t('incidents.eyebrow')}
        title={t('page.workspaceIncidents')}
        description={t('incidents.list.description')}
        // ONE action in the header, and a short description. At >=769px .page-header is min-height
        // 80px (styles.css, page-template §2.1): 80 when the copy and actions share one row, and as
        // tall as its content when they do not - the box reserves what it needs instead of letting a
        // wrapped action row fall under the next panel. This page keeps a single primary action for a
        // product reason, not a geometric one: one primary CTA per page (page-header.tsx), and
        // refresh acts on the list, so it belongs in the toolbar next to the filters.
        primary={<Button onClick={() => setCreateOpen(true)} data-testid="incident-create-open"><Icon name="plus" size={15} /> {t('incidents.action.create')}</Button>}
      />

      <section className="panel" data-testid="incidents-boundary">
        <div className="panel-head">
          <div>
            <h2>{t('incidents.boundary.title')}</h2>
          </div>
        </div>
        <ul className="detail-list pad">
          <li><span>{t('incidents.boundary.sources')}</span></li>
          <li><span>{t('incidents.boundary.collectors')}</span></li>
          <li><span>{t('incidents.boundary.noAi')}</span></li>
          <li><span>{t('incidents.boundary.closed')}</span></li>
          <li><span>{t('incidents.boundary.search')}</span></li>
          <li><span>{t('incidents.boundary.owner')}</span></li>
        </ul>
      </section>

      <section className="toolbar" data-testid="incident-filters">
        <Select value={status} onValueChange={(value) => { setStatus(value); setCursor(null); }}>
          <SelectTrigger aria-label={t('incidents.filter.statusAria')} data-testid="incident-filter-status" className="w-[190px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={FILTER_ANY}>{t('incidents.filter.allStatuses')}</SelectItem>
            {INCIDENT_STATUS_CODES.map((code) => <SelectItem key={code} value={code} data-testid={'incident-filter-status-option-' + code}>{t(codeLabelKey(code))}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={(value) => { setSeverity(value); setCursor(null); }}>
          <SelectTrigger aria-label={t('incidents.filter.severityAria')} data-testid="incident-filter-severity" className="w-[190px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={FILTER_ANY}>{t('incidents.filter.allSeverities')}</SelectItem>
            {INCIDENT_SEVERITY_CODES.map((code) => <SelectItem key={code} value={code} data-testid={'incident-filter-severity-option-' + code}>{t(codeLabelKey(code))}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={owner} onValueChange={(value) => { setOwner(value); setCursor(null); }}>
          <SelectTrigger aria-label={t('incidents.filter.ownerAria')} data-testid="incident-filter-owner" className="w-[230px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={OWNER_ANY} data-testid="incident-filter-owner-option-all">{t('incidents.filter.allOwners')}</SelectItem>
            {user ? <SelectItem value={OWNER_SELF} data-testid="incident-filter-owner-option-self">{t('incidents.filter.onlyMine')}</SelectItem> : null}
            {directory.names
              ? Object.entries(directory.names).map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)
              : null}
          </SelectContent>
        </Select>
        <Button variant="secondary" data-testid="incident-refresh" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>
        {directory.readable ? null : <span className="muted small" data-testid="incident-owner-directory-unavailable">{t('incidents.filter.directoryUnavailable')}</span>}
        <span className="toolbar-count" data-testid="incidents-count">{t('incidents.count', { shown: items.length })}</span>
      </section>

      {data && error ? <Freshness observedAt={observedAt} error={error} /> : null}

      {loading && !data ? (
        <AsyncBoundary loading hasData={false} error={null}>{null}</AsyncBoundary>
      ) : error && !data ? (
        <section className="panel pad" data-testid="incident-list-failed">
          <IncidentFailureNotice error={error} testId="incident-list-error" />
          <Button variant="secondary" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.retry')}</Button>
        </section>
      ) : items.length === 0 ? (
        // data-narrowed-to is the payload's own answer, printed so the assertion a test makes
        // is the fact the kernel sent rather than a role the page looked up for itself.
        <div data-empty-state={emptyKind} data-narrowed-to={scope?.narrowedTo ?? undefined} data-testid="incidents-empty">
          {emptyKind === 'scoped' ? (
            <EmptyState
              icon="access"
              title={t('incidents.empty.scoped.title')}
              description={t('incidents.empty.scoped.description')}
              // The next step an operator can actually take: a record it creates is owned by it,
              // so the one action that puts a row in this list is the one already on the page.
              action={<Button onClick={() => setCreateOpen(true)}>{t('incidents.action.create')}</Button>}
            />
          ) : (
            <EmptyState
              icon="alert"
              title={filtering ? t('incidents.empty.filtered.title') : t('incidents.empty.none.title')}
              description={filtering ? t('incidents.empty.filtered.description') : t('incidents.empty.none.description')}
              action={filtering
                ? <Button variant="secondary" onClick={clearFilters}>{t('ui.clearFilters')}</Button>
                : <Button onClick={() => setCreateOpen(true)}>{t('incidents.action.create')}</Button>}
            />
          )}
        </div>
      ) : (
        <section className="panel table-panel">
          <Table className={stackTable}>
            <TableHeader className={stackHead}>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('table.incident')}</TableHead>
                <TableHead>{t('table.severity')}</TableHead>
                <TableHead>{t('table.status')}</TableHead>
                <TableHead>{t('table.evidence')}</TableHead>
                <TableHead>{t('table.started')}</TableHead>
                <TableHead>{t('table.owner')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={stackBody}>
              {items.map((incident) => {
                const identity = formatIdentity({
                  name: incident.title,
                  id: incident.id,
                  at: incident.startedAt,
                  locale,
                  nameIsUnique: titleCount === items.length,
                  rowsOnPage: items.length,
                });
                const href = '/app/incidents/' + incident.id;
                return (
                  <TableRow key={incident.id} className={stackRow} data-incident-row={incident.id} onClick={() => navigate(href)}>
                    <IdentityCell label={t('table.incident')} identity={identity} href={href}>
                      <span className="ow-key" data-testid="incident-source" data-source={incident.source}>{t(incidentSourceKey(incident.source))}</span>
                      {incident.relatedEntity ? <span className="ow-key" data-testid="incident-related">{incident.relatedEntity}</span> : null}
                    </IdentityCell>
                    <StackCell label={t('table.severity')}><Status code={incident.severity} /></StackCell>
                    <StackCell label={t('table.status')}><Status code={incident.status} /></StackCell>
                    <StackCell label={t('table.evidence')}>
                      <span data-testid="incident-evidence-count" data-evidence-refs={incident.evidenceRefs.length}>{incident.evidenceRefs.length}</span>
                    </StackCell>
                    <StackCell label={t('table.started')}><span title={incident.startedAt}>{ageMessage(locale, incident.startedAt)}</span></StackCell>
                    <StackCell label={t('table.owner')}>
                      <span className="mono" title={incident.owner} data-testid="incident-owner">{ownerName(incident.owner)}</span>
                    </StackCell>
                    <StackCell label={t('table.actions')} className={cardActionCell}>
                      <RowActions
                        label={t('incidents.action.open')}
                        actions={[
                          copyIdAction(incident.id, t('table.copyIdentifier'), {
                            onCopied: () => toast.push({ tone: 'ok', title: t('action.copy') }),
                            onFailed: () => toast.push({ tone: 'danger', title: t('action.copy'), detail: t('incidents.error.network') }),
                          }),
                          { id: 'open', label: t('incidents.action.open'), icon: 'chevron', onSelect: () => navigate(href) },
                        ]}
                      />
                    </StackCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <p className="table-footnote">{t('incidents.table.evidenceNote')}</p>
        </section>
      )}

      <div className="pagination-row">
        <Button variant="secondary" disabled={!cursor} onClick={() => setCursor(null)}>{t('pipelines.pagination.first')}</Button>
        <Button variant="secondary" disabled={!data?.nextCursor} onClick={() => setCursor(data?.nextCursor ?? null)}>{t('pipelines.pagination.next')}</Button>
      </div>

      <CreateIncidentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(incident) => {
          setCreateOpen(false);
          toast.push({ tone: 'ok', title: t('incidents.create.success'), detail: incident.title });
          navigate('/app/incidents/' + incident.id);
        }}
      />
    </div>
  );
}

/**
 * The create form.
 *
 * It sends `source: 'MANUAL'` explicitly and says so on the form: this page cannot write an
 * API-sourced record, and a record's provenance is not something to leave to a default it does
 * not show. Validation mirrors the kernel's bounds so a typo is answered before the round trip;
 * the kernel's own refusal (403 for a viewer, 400 for a field) is what the reader sees when the
 * two disagree.
 */
function CreateIncidentDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (incident: IncidentView) => void }) {
  const t = useT();
  const [title, setTitle] = React.useState('');
  const [severity, setSeverity] = React.useState<string>('MAJOR');
  const [startedAt, setStartedAt] = React.useState(() => toLocalInputValue(new Date()));
  const [relatedEntity, setRelatedEntity] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);
  const [fieldError, setFieldError] = React.useState<string | null>(null);

  const reset = () => { setTitle(''); setSeverity('MAJOR'); setStartedAt(toLocalInputValue(new Date())); setRelatedEntity(''); setFailure(null); setFieldError(null); };
  const close = () => { reset(); onClose(); };

  const trimmedTitle = title.trim();
  const submit = async () => {
    setFieldError(null);
    setFailure(null);
    if (trimmedTitle.length < TITLE_MIN_CHARS || trimmedTitle.length > TITLE_MAX_CHARS) {
      setFieldError(t('incidents.create.titleInvalid'));
      return;
    }
    const iso = toIsoInstant(startedAt);
    if (!iso) {
      setFieldError(t('incidents.create.startedAtInvalid'));
      return;
    }
    setSubmitting(true);
    try {
      const related = relatedEntity.trim();
      const incident = await api.post<IncidentView>('/api/v1/incidents', {
        title: trimmedTitle,
        severity,
        source: 'MANUAL',
        startedAt: iso,
        ...(related ? { relatedEntity: related } : {}),
      });
      reset();
      onCreated(incident);
    } catch (cause) {
      setFailure(cause);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('incidents.create.title')}
      size="medium"
      footer={(
        <>
          <Button variant="secondary" onClick={close} disabled={submitting}>{t('action.cancel')}</Button>
          <Button onClick={() => void submit()} disabled={submitting} data-testid="incident-create-submit">
            {submitting ? t('incidents.create.submitting') : t('incidents.create.submit')}
          </Button>
        </>
      )}
    >
      <div className="form-stack" data-testid="incident-create-form">
        <p className="muted small">{t('incidents.create.description')}</p>
        <Field label={t('incidents.create.field.title')} hint={t('incidents.create.titleHint')} htmlFor="incident-create-title">
          <Input id="incident-create-title" data-testid="incident-create-title" value={title} maxLength={TITLE_MAX_CHARS} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label={t('table.severity')} htmlFor="incident-create-severity">
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger id="incident-create-severity" data-testid="incident-create-severity" aria-label={t('table.severity')}><SelectValue /></SelectTrigger>
            <SelectContent>
              {INCIDENT_SEVERITY_CODES.map((code) => <SelectItem key={code} value={code} data-testid={'incident-create-severity-option-' + code}>{t(codeLabelKey(code))}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('incidents.create.field.startedAt')} hint={t('incidents.create.startedAtHint')} htmlFor="incident-create-started-at">
          <Input id="incident-create-started-at" data-testid="incident-create-started-at" type="datetime-local" value={startedAt} onChange={(event) => setStartedAt(event.target.value)} />
        </Field>
        <Field label={t('incidents.create.field.relatedEntity')} hint={t('incidents.create.relatedHint')} htmlFor="incident-create-related">
          <Input id="incident-create-related" data-testid="incident-create-related" value={relatedEntity} maxLength={200} onChange={(event) => setRelatedEntity(event.target.value)} />
        </Field>
        <p className="muted small" data-testid="incident-create-source-note">{t('incidents.create.sourceNote')}</p>
        {fieldError ? <p className="inline-error" role="alert" data-testid="incident-create-field-error">{fieldError}</p> : null}
        <IncidentFailureNotice error={failure} testId="incident-create-error" />
      </div>
    </Modal>
  );
}
