import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { IncidentView } from '../types';
import { useAuth } from '../auth';
import { useDocumentTitle } from '../hooks';
import { useI18n, useT } from '../i18n';
import type { MessageKey } from '../i18n';
import { ageMessage } from '../lib/age';
import { cn } from '../lib/utils';
import { Icon } from '../components/Icons';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { EmptyState, Field, Modal, useToast } from '../components/Ui';
import { AsyncBoundary } from '../components/app/async-boundary';
import { MetricCard } from '../components/app/metric-card';
import { StatusIndicator } from '../components/app/status-indicator';
import { PageHeader } from '../components/app/page-header';
import { Status } from '../components/app/status';
import { statusForCode } from '../components/status-tone';
import {
  FILTER_ANY,
  INCIDENT_COLUMN_LABEL_KEYS,
  INCIDENT_EMPTY_COPY,
  INCIDENT_SEVERITY_CODES,
  INCIDENT_STATUS_CODES,
  OWNER_ANY,
  OWNER_SELF,
  TITLE_MAX_CHARS,
  TITLE_MIN_CHARS,
  collapseIncidentRuns,
  incidentColumnPlan,
  incidentCountKnown,
  incidentCreateGate,
  incidentFailureKey,
  incidentListQuery,
  incidentListState,
  incidentSourceKey,
  incidentsEmptyKind,
  ownerFilterValue,
  shortOwner,
  toIsoInstant,
  toLocalInputValue,
} from '../incidents';
import type { IncidentColumnId, IncidentCreateGate, IncidentListPayload, BusinessWorkspace } from '../incidents';
import {
  IdentityCell,
  RowActions,
  StackCell,
  cardActionCell,
  cardLineAfter,
  cardTwoLineRow,
  colGrow,
  copyIdAction,
  formatIdentity,
  stackBody,
  stackHead,
  stackRow,
  stackTable,
} from './table-kit';
import { shortLocator } from '../lib/identity';
import { IncidentClaimQueue } from './incident-claim-queue';

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
 * The caller's business workspaces, from `GET /api/v1/business-workspaces`.
 *
 * Three outcomes, and the create gate needs all three kept apart: rows arrived, the read was
 * refused or failed, or no read has answered yet. `loading` is not `empty` for the same reason
 * the incident list refuses to draw a failed read as "no incidents" - an unanswered read must
 * not become a permission decision.
 */
export function useBusinessWorkspaces(): {
  workspaces: BusinessWorkspace[] | null;
  failed: boolean;
  loading: boolean;
} {
  const [state, setState] = React.useState<{ workspaces: BusinessWorkspace[] | null; failed: boolean; loading: boolean }>({
    workspaces: null,
    failed: false,
    loading: true,
  });
  React.useEffect(() => {
    let cancelled = false;
    api.get<BusinessWorkspace[]>('/api/v1/business-workspaces')
      .then((rows) => { if (!cancelled) setState({ workspaces: rows, failed: false, loading: false }); })
      .catch(() => { if (!cancelled) setState({ workspaces: null, failed: true, loading: false }); });
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

/**
 * The viewport width, as a column cap input.
 *
 * §2.2's caps are 5 / 4 / 3-facts, so the plan has to know the width. A CSS media query cannot
 * do this job: dropping a `<th>` and its `<td>`s is a DOM decision, and a column hidden by CSS
 * is still in the accessibility tree and still measured by the §4.1 harness.
 */
function useViewportWidth(): number {
  const [width, setWidth] = React.useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  React.useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
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
  const [boundaryOpen, setBoundaryOpen] = React.useState(false);

  const directory = useUserDirectory();
  const workspaceList = useBusinessWorkspaces();
  const viewportWidth = useViewportWidth();

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
  const titleCount = new Set(items.map((item) => item.title)).size;
  const ownerName = (ownerId: string) => directory.names?.[ownerId] ?? shortOwner(ownerId);

  // One state, derived once, in a pure function the test file pins: eight renderings instead of
  // "spinner or empty list". `rows` is null until a read answers, so a failed first read can
  // never be drawn as "no incidents" (the audit's seven-codes-to-unknown defect, in its list form).
  const listState = incidentListState({ rows: data ? items : null, error, loading, filtering });
  // Which empty list this is, from the scope the kernel sent beside the rows. The payload is the
  // only thing that can tell a narrowed read from an unnarrowed one, because both answer
  // `items: []`; deriving it from the role here would be a second copy of the predicate, and the
  // copy would be the one that drifts (docs/design/g12-scope/narrowed-reads.md 3.3). It is null
  // until a read answers, and the state it governs is only reachable after one.
  const emptyKind = incidentsEmptyKind({ scope: data?.scope ?? null, filtering });
  // What the create affordance may be, from the role and the memberships, never from a guess.
  // It is `unknown` while the workspace read is in flight or failed, and both create entries
  // read THIS value - a second derivation for the empty-state button is how the two entries
  // drift apart. See `incidentCreateGate` for why the server still decides.
  const createGate = incidentCreateGate({
    role: user?.role ?? null,
    workspaces: workspaceList.workspaces,
    workspaceReadFailed: workspaceList.failed,
    scope: data?.scope ?? null,
  });
  const canCreate = createGate.kind === 'allowed';
  // §2.4 collapse and §2.2 degradation are decided on the rows actually on screen, before render.
  const runs = React.useMemo(() => collapseIncidentRuns(items), [items]);
  const plan = React.useMemo(() => incidentColumnPlan(items, viewportWidth), [items, viewportWidth]);
  const shows = (column: IncidentColumnId) => plan.visible.includes(column);
  // A column the plan demoted held one value for all rows: it is stated once under the table
  // (M1's "carry the fact once"), never repeated down a column that earns no width.
  const demotedLabels = plan.demoted.map((column) => t(INCIDENT_COLUMN_LABEL_KEYS[column]));

  // The KPI band answers "what needs me now", so it counts the two things an operator acts on.
  // Both are counts of the rows ON THIS PAGE and say so - a page-scoped count presented as a
  // total would be the same class of lie as a zero standing in for an unread source.
  const openCount = items.filter((item) => item.status === 'OPEN').length;
  const investigatingCount = items.filter((item) => item.status === 'INVESTIGATING').length;
  const criticalCount = items.filter((item) => item.severity === 'CRITICAL').length;
  const withoutEvidence = items.filter((item) => item.evidenceRefs.length === 0).length;
  const hasRows = items.length > 0;

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
        //
        // The primary is the SAME gate the empty-state button reads. It used to be unconditional,
        // so a viewer or an account with no workspace was invited to open a form whose submit the
        // kernel refuses - the one affordance on the page that contradicted the server.
        primary={createGate.kind === 'unknown' ? undefined : canCreate ? (
          <Button onClick={() => setCreateOpen(true)} data-testid="incident-create-open"><Icon name="plus" size={15} /> {t('incidents.action.create')}</Button>
        ) : (
          // Disabled, not hidden: the control is still where the reader expects it, and the
          // tooltip plus the empty-state explanation say which rule is standing in the way.
          <span data-testid="incident-create-blocked" data-create-blocked={createGate.kind} title={t(createGate.reason)}>
            <Button variant="secondary" disabled aria-describedby="incident-create-blocked-reason"><Icon name="plus" size={15} /> {t('incidents.action.create')}</Button>
            <span id="incident-create-blocked-reason" className="sr-only">{t(createGate.reason)}</span>
          </span>
        )}
      />

      {/* page-template §2.1: KPI band, 0 or 1, immediately after the header. `.metric-grid` is
          4/2/1 columns and never 3. Every figure is a count of the rows on THIS page and the
          detail line says so - a page-scoped number presented as a total is the same class of
          claim as a zero standing in for an unread source. The band is drawn only when there
          are rows to count: four zeros under a failed read would read as "all clear". */}
      {hasRows ? (
        <section className="metric-grid" data-testid="incidents-kpi" aria-label={t('incidents.table.panelTitle')}>
          <MetricCard
            metricId="incidents-open"
            label={t('status.open')}
            value={openCount}
            detail={t('incidents.workspace.openCount', { count: openCount, total: items.length })}
            showSampled={false}
          />
          <MetricCard
            metricId="incidents-investigating"
            label={t('status.investigating')}
            value={investigatingCount}
            detail={t('incidents.workspace.openCount', { count: investigatingCount, total: items.length })}
            showSampled={false}
          />
          <MetricCard
            metricId="incidents-critical"
            label={t('status.critical')}
            value={criticalCount}
            detail={t('incidents.workspace.openCount', { count: criticalCount, total: items.length })}
            showSampled={false}
          />
          <MetricCard
            metricId="incidents-without-evidence"
            label={t('incidents.kpi.withoutEvidence')}
            value={withoutEvidence}
            detail={t('incidents.kpi.withoutEvidenceDetail')}
            showSampled={false}
          />
        </section>
      ) : null}

      {/* G13-B1.4: the workspace queue of unclaimed automation incidents. Only a role the
          kernel would accept for a claim renders the panel; a viewer sees nothing rather than
          a button whose submit is refused. The page header and the queue share the same
          membership-bounded workspace list, so a workspace name here is never a guess. */}
      {user?.role === 'operator' || user?.role === 'admin' ? (
        <IncidentClaimQueue workspaces={workspaceList.workspaces} refreshToken={reload} />
      ) : null}

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
        <Button className="text-muted-foreground" variant="ghost" data-testid="incident-refresh" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>
        {directory.readable ? null : <span className="muted small" data-testid="incident-owner-directory-unavailable">{t('incidents.filter.directoryUnavailable')}</span>}
        {/* A count is a claim about how many rows exist. While the read is loading, refused,
            conflicted or failed, no count is known - printing "0" there is the same lie as an
            empty table, and it is the one the panel below was rewritten to stop telling. The
            toolbar speaks only when the list has actually answered. */}
        {incidentCountKnown(listState) ? (
          <span className="toolbar-count" data-testid="incidents-count" data-count-known={items.length}>{t('incidents.count', { shown: items.length })}</span>
        ) : null}
      </section>

      {/* page-template §2.1: the primary table panel. Exactly one of the eight states below is
          rendered, and each one is its own shape - the audit's finding was that a page which
          collapses distinct machine answers into one rendering makes a success and a never-observed
          read look identical. `data-list-state` carries the derived state for the harness. */}
      <section
        className={listState === 'ready' || listState === 'stale' ? 'panel table-panel' : 'panel'}
        data-testid="incidents-table-panel"
        data-list-state={listState}
      >
        <div className="panel-head">
          <div>
            <h2>{t('incidents.table.panelTitle')}</h2>
            {/* STALE is a label on rows that are still true, not a replacement for them. */}
            {listState === 'stale' ? <Freshness observedAt={observedAt} error={error} /> : null}
          </div>
          {hasRows ? (
            <span className="ow-table-meta" data-testid="incidents-count">{t('incidents.count', { shown: items.length })}</span>
          ) : null}
        </div>

        {listState === 'loading' ? (
          <div className="pad" aria-busy="true" aria-label={t('incidents.state.loadingAria')} data-testid="incidents-loading">
            <div className="skeleton-stack">
              <div className="skeleton" style={{ width: '46%' }} />
              <div className="skeleton" style={{ width: '72%' }} />
              <div className="skeleton" style={{ width: '58%' }} />
            </div>
          </div>
        ) : listState === 'forbidden' ? (
          // 403 is a permission wall, not a failure and not an empty list. It names no resource.
          <div className="async-panel" role="alert" data-panel-state="forbidden" data-testid="incidents-forbidden">
            <StatusIndicator state="forbidden" label={t('ui.forbidden.title')} />
            <p className="muted small">{t('incidents.state.forbidden')}</p>
          </div>
        ) : listState === 'conflict' ? (
          <div className="async-panel" role="alert" data-panel-state="conflict" data-testid="incidents-conflict">
            <StatusIndicator state="attention" label={t('ui.conflict.title')} />
            <p className="muted small">{t('incidents.state.conflict')}</p>
            <Button variant="secondary" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.retry')}</Button>
          </div>
        ) : listState === 'failed' ? (
          <div className="pad" data-testid="incident-list-failed">
            <IncidentFailureNotice error={error} testId="incident-list-error" />
            <p className="muted small">{t('incidents.state.failed')}</p>
            <Button variant="secondary" onClick={() => setReload((value) => value + 1)}><Icon name="refresh" size={15} /> {t('action.retry')}</Button>
          </div>
        ) : listState === 'empty' || listState === 'filtered' ? (
          // M1: an answered zero is an EmptyState - no dashed token, no NO_DATA, no "0".
          // The zeros are different facts with different remedies, so they are different copy:
          // a filtered miss is the page's own filters, and the other three come from the scope
          // the kernel sent. `data-empty-state` is the derived kind itself, so a harness reads
          // the same value the copy was chosen from instead of re-deriving it.
          <div
            data-empty-state={emptyKind}
            // The payload value itself, not a verdict about it: 'owner' or 'none' (this read
            // applied no owner narrowing). Absent when the body carried no scope at all, so an
            // unreadable body and an unnarrowed read stay distinguishable in the DOM too.
            data-narrowed-to={data?.scope ? data.scope.narrowedTo ?? 'none' : undefined}
            data-testid="incidents-empty"
          >
            <EmptyState
              icon="inbox"
              title={t(INCIDENT_EMPTY_COPY[emptyKind].title)}
              description={t(INCIDENT_EMPTY_COPY[emptyKind].description)}
              action={emptyKind === 'filtered'
                ? <Button variant="secondary" onClick={clearFilters}>{t('ui.clearFilters')}</Button>
                // Secondary, not primary: the page header already carries the one primary CTA
                // (page-template §2.2), and two "Record an incident" buttons stacked on an empty
                // page is the same action drawn twice with two different weights. This is the
                // in-context repeat of it, so it takes the lesser weight.
                //
                // Gated by the SAME value as the header primary. Two independent decisions for
                // one capability is how one of them ends up offering what the server refuses -
                // this page already shipped that defect once with the empty-state copy. The
                // explanation for a blocked account is the empty-state description itself, which
                // names the missing membership; no second sentence is repeated here.
                : canCreate
                  ? <Button variant="secondary" onClick={() => setCreateOpen(true)} data-testid="incident-create-open-empty">{t('incidents.action.create')}</Button>
                  : emptyKind === 'workspace' || createGate.kind === 'workspace'
                    ? undefined
                    : <span className="muted small" data-testid="incident-create-blocked-empty" data-create-blocked={createGate.kind === 'unknown' ? 'unknown' : createGate.kind}>{t(createGate.reason)}</span>}
            />
          </div>
        ) : (
          <>
            <Table className={stackTable} data-testid="incidents-table">
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={colGrow}>{t('table.incident')}</TableHead>
                  {/* §2.2: only the columns the plan kept are rendered at all. A header for a
                      column that holds one value on every row is a header that earns no width. */}
                  {plan.visible.map((column) => <TableHead key={column}>{t(INCIDENT_COLUMN_LABEL_KEYS[column])}</TableHead>)}
                  {/* The action cell is chrome, not a data column, so its heading carries no text
                      node: the metrics harness counts a labelled `th` as a column, and a sixth
                      one here would report this table over §2.2's cap of five while it renders
                      exactly five facts. `aria-label` keeps the heading announced. */}
                  <TableHead aria-label={t('table.actions')} />
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {runs.map((run) => {
                  const incident = run.head;
                  const repeated = run.rows.length > 1;
                  const identity = formatIdentity({
                    name: incident.title,
                    id: incident.id,
                    at: incident.startedAt,
                    locale,
                    nameIsUnique: titleCount === items.length,
                    rowsOnPage: items.length,
                  });
                  const href = '/app/incidents/' + incident.id;
                  // Both ends of the run, rendered once each so the render can tell whether the
                  // range actually says anything. A range whose ends read alike is not a range.
                  const firstAge = ageMessage(locale, run.firstAt) || run.firstAt;
                  const lastAge = ageMessage(locale, run.lastAt) || run.lastAt;
                  const runSpan = firstAge === lastAge
                    ? ''
                    : t('incidents.table.runSpan', { first: firstAge, last: lastAge });
                  return (
                    <TableRow
                      key={incident.id}
                      className={cn(stackRow, cardTwoLineRow)}
                      data-incident-row={incident.id}
                      data-row-key={run.key}
                      data-run-size={run.rows.length}
                      onClick={() => navigate(href)}
                    >
                      <IdentityCell label={t('table.incident')} identity={identity} href={href} className={colGrow}>
                        <span className="ow-key" data-testid="incident-source" data-source={incident.source}>{t(incidentSourceKey(incident.source))}</span>
                        {incident.relatedEntity ? <span className="ow-key" data-testid="incident-related" title={incident.relatedEntity}>{shortLocator(incident.relatedEntity)}</span> : null}
                        {/* §2.4: the run is stated on the row it collapsed into, with the span of
                            the occurrences, so no occurrence is hidden and none is invented.
                            A single occurrence has no span to state: when both ends render the
                            same age ("from 12h ago to 12h ago") the span is dropped rather than
                            drawn as a degenerate range, and the row keeps the count alone. */}
                        {repeated ? (
                          <span className="ow-run-badge" data-testid="incident-run" data-run-size={run.rows.length}>
                            <Icon name="rotate" size={11} />
                            {t('incidents.table.runLabel', { count: run.rows.length })}
                            {runSpan ? (
                              <span className="muted" data-testid="incident-run-span"> {runSpan}</span>
                            ) : null}
                          </span>
                        ) : null}
                      </IdentityCell>

                      {shows('severity') ? (
                        <StackCell label={t('table.severity')} className={cardLineAfter}><Status code={incident.severity} /></StackCell>
                      ) : null}
                      {shows('status') ? (
                        <StackCell label={t('table.status')} className={cardLineAfter}><Status code={incident.status} /></StackCell>
                      ) : null}
                      {shows('evidence') ? (
                        <StackCell label={t('table.evidence')} className={cardLineAfter}>
                          {/* M1: zero evidence is an answered zero, so it reads as words, not as a
                              dashed NO_DATA token and not as a bare "0" beside real counts. */}
                          <span data-testid="incident-evidence-count" data-evidence-refs={incident.evidenceRefs.length}>
                            {incident.evidenceRefs.length === 0
                              ? <span className="muted">{t('incidents.table.evidenceNone')}</span>
                              : t('incidents.table.evidenceRefs', { count: incident.evidenceRefs.length })}
                          </span>
                        </StackCell>
                      ) : null}
                      {shows('started') ? (
                        <StackCell label={t('table.started')} className={cardLineAfter}>
                          <span title={incident.startedAt}>{ageMessage(locale, incident.startedAt) || incident.startedAt}</span>
                        </StackCell>
                      ) : null}
                      {shows('owner') ? (
                        <StackCell label={t('table.owner')} className={cardLineAfter}>
                          <span className="mono" title={incident.owner} data-testid="incident-owner">{ownerName(incident.owner)}</span>
                        </StackCell>
                      ) : null}

                      <StackCell label={t('table.actions')} className={cardActionCell}>
                        <RowActions
                          label={t('incidents.table.rowActions', { name: incident.title })}
                          actions={[
                            copyIdAction(incident.id, t('table.copyIdentifier'), {
                              onCopied: () => toast.push({ tone: 'ok', title: t('incidents.table.copied') }),
                              onFailed: () => toast.push({ tone: 'danger', title: t('action.copy'), detail: t('incidents.table.copyFailed') }),
                            }),
                            { id: 'open', label: t('incidents.table.openAria', { name: incident.title }), icon: 'arrowRight', onSelect: () => navigate(href) },
                          ]}
                        />
                      </StackCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {/* The facts the table carries once instead of per row (M1), in reading order. */}
            <div className="ow-table-notes">
              {demotedLabels.length > 0 ? (
                <p className="table-footnote" data-testid="incidents-demoted-note">
                  {t('incidents.table.demotedNote', { columns: demotedLabels.join(' · ') })}
                </p>
              ) : null}
              {runs.some((run) => run.rows.length > 1) ? (
                <p className="table-footnote" data-testid="incidents-run-note">{t('incidents.table.runNote')}</p>
              ) : null}
              <p className="table-footnote">{t('incidents.table.evidenceNote')}</p>
            </div>
          </>
        )}
      </section>

      {/* A cursor pager is only meaningful once rows exist; drawing two dead buttons under an
          error panel invites a click that cannot change anything. */}
      {hasRows ? (
        <div className="pagination-row">
          <Button variant="secondary" data-testid="incidents-pagination-first" disabled={!cursor} onClick={() => setCursor(null)}>{t('pipelines.pagination.first')}</Button>
          <Button variant="secondary" data-testid="incidents-pagination-next" disabled={!data?.nextCursor} onClick={() => setCursor(data?.nextCursor ?? null)}>{t('pipelines.pagination.next')}</Button>
        </div>
      ) : null}

      {/* page-template §2.1: the secondary panel, last and at most two. The boundary declaration
          belongs here rather than above the table - it is the page's footnote about what the slice
          cannot do, not the answer to "what needs me now". It stays verbatim (the task's point 2). */}
      <section className="panel" data-testid="incidents-boundary">
        <details className="ow-boundary">
          <summary>
            <Icon name="info" size={14} />
            {t('incidents.boundary.summary')}
            <span className="muted">{t('incidents.boundary.expand')}</span>
          </summary>
          <ul className="detail-list pad">
            <li><span>{t('incidents.boundary.sources')}</span></li>
            <li><span data-testid="incidents-boundary-collectors">{t('incidents.boundary.collectors')}</span></li>
            <li><span>{t('incidents.boundary.noAi')}</span></li>
            <li><span>{t('incidents.boundary.closed')}</span></li>
            <li><span>{t('incidents.boundary.search')}</span></li>
            <li><span>{t('incidents.boundary.owner')}</span></li>
          </ul>
        </details>
      </section>

      <CreateIncidentDialog
        open={createOpen && canCreate}
        gate={createGate}
        workspaces={workspaceList.workspaces ?? []}
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
function CreateIncidentDialog({
  open,
  gate,
  workspaces,
  onClose,
  onCreated,
}: {
  open: boolean;
  gate: IncidentCreateGate;
  workspaces: BusinessWorkspace[];
  onClose: () => void;
  onCreated: (incident: IncidentView) => void;
}) {
  const t = useT();
  const [title, setTitle] = React.useState('');
  const [severity, setSeverity] = React.useState<string>('MAJOR');
  const [startedAt, setStartedAt] = React.useState(() => toLocalInputValue(new Date()));
  const [relatedEntity, setRelatedEntity] = React.useState('');
  // The workspace the record is filed under. A single membership is pre-filled from the gate and
  // never asked about; several memberships MUST be answered here, because the kernel refuses a
  // body that leaves it out (`INCIDENT_WORKSPACE_REQUIRED`) and will not guess which one was meant.
  const writable = workspaces.filter((workspace) => workspace.member);
  const [workspaceId, setWorkspaceId] = React.useState<string>('');
  const [submitting, setSubmitting] = React.useState(false);
  const [failure, setFailure] = React.useState<unknown>(null);
  const [fieldError, setFieldError] = React.useState<string | null>(null);

  const needsChoice = gate.kind === 'allowed' && gate.needsChoice;
  React.useEffect(() => {
    if (!open) return;
    setWorkspaceId(gate.kind === 'allowed' && !gate.needsChoice ? gate.workspaceId ?? '' : '');
  }, [open, gate]);

  const reset = () => { setTitle(''); setSeverity('MAJOR'); setStartedAt(toLocalInputValue(new Date())); setRelatedEntity(''); setWorkspaceId(''); setFailure(null); setFieldError(null); };
  const close = () => { reset(); onClose(); };

  const trimmedTitle = title.trim();
  const submit = async () => {
    setFieldError(null);
    if (needsChoice && !writable.some((workspace) => workspace.workspaceId === workspaceId)) {
      setFieldError(t('incidents.create.workspaceRequired'));
      return;
    }
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
        // Named only when this account has several memberships: with exactly one the kernel
        // resolves it, and sending it anyway would be the page asserting a scope it was only
        // told about. A body that names a workspace the caller cannot enter is 404, not a grant.
        ...(needsChoice ? { workspaceId } : {}),
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
        {/* Several memberships: the kernel will not choose, so the form asks. One membership is
            not shown at all - a field with one option is a question whose answer is not in doubt. */}
        {needsChoice ? (
          <Field label={t('incidents.create.field.workspace')} hint={t('incidents.create.workspaceHint')} htmlFor="incident-create-workspace">
            <Select value={workspaceId} onValueChange={setWorkspaceId}>
              <SelectTrigger id="incident-create-workspace" data-testid="incident-create-workspace" aria-label={t('incidents.create.field.workspace')}><SelectValue placeholder={t('incidents.create.workspacePlaceholder')} /></SelectTrigger>
              <SelectContent>
                {writable.map((workspace) => (
                  <SelectItem key={workspace.workspaceId} value={workspace.workspaceId} data-testid={'incident-create-workspace-option-' + workspace.key}>{workspace.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
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
