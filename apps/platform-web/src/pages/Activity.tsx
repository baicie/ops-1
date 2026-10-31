import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Icon } from '../components/Icons';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { EmptyState, TimeAgo } from '../components/Ui';
import { Status } from '../components/app/status';
import { AsyncBoundary, NoticeBar, isStale, useObservedPolling } from '../components/app/async-boundary';
import { PageHeader } from '../components/app/page-header';
import { formatDate } from '../format';
import { useI18n, useT } from '../i18n';
import { ageMessage, clockMessage } from '../lib/age';
import { auditEmptyKind, readAuditList } from '../lib/audit-scope';
import { cn } from '../lib/utils';
import { actorName, detailFact, presentEvents, subjectName, type PresentedRow } from './activity-facts';
import { IdentityCell, StackCell, StatusPill, cardActionCell, stackBody, stackHead, stackRow, stackTable } from './table-kit';

/** Radix Select cannot express "no value", so every "all" state is a sentinel the page maps back. */
const ALL = 'ALL';

/** The page's own polling cadence; \`isStale\` compares the last observation against it. */
const POLL_INTERVAL_MS = 8000;

/** Rows per page. The window is a page, not the whole log: 167 rows in one scroll is not a table. */
const PAGE_SIZE = 25;

/**
 * How much of the log the page holds. The API filters by subject server-side and offers no clock,
 * actor or event-type predicate, so the four narrow filters below are answered over the window the
 * page actually loaded - and the count says so, out loud, instead of implying it filtered 167 rows
 * it never saw.
 */
const WINDOW = 200;

const RANGES = [
  { id: 'all', hours: 0, label: 'activity.filter.range.all' },
  { id: '1h', hours: 1, label: 'activity.filter.range.1h' },
  { id: '24h', hours: 24, label: 'activity.filter.range.24h' },
  { id: '7d', hours: 24 * 7, label: 'activity.filter.range.7d' },
] as const;

/** Where a subject can actually be read. A subject type with no page is printed, not linked. */
const SUBJECT_ROUTE: Record<string, (id: string) => string> = {
  plugin: (id) => '/admin/plugins/' + encodeURIComponent(id),
  node: (id) => '/admin/nodes/' + encodeURIComponent(id),
  job: (id) => '/admin/jobs/' + encodeURIComponent(id),
  pipeline: (id) => '/admin/pipelines/' + encodeURIComponent(id),
};

/** The payload ids that are themselves pages. */
const DETAIL_ROUTE: Record<string, (id: string) => string> = {
  pluginId: (id) => '/admin/plugins/' + encodeURIComponent(id),
  pipelineId: (id) => '/admin/pipelines/' + encodeURIComponent(id),
};

export function ActivityPage() {
  const t = useT();
  const { formatDateTime, locale } = useI18n();
  const [subjectType, setSubjectType] = useState('');
  const [query, setQuery] = useState('');
  const [range, setRange] = useState<string>('all');
  const [eventType, setEventType] = useState('');
  const [actor, setActor] = useState('');
  const [result, setResult] = useState('');
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const { data, error, loading, reload, observedAt } = useObservedPolling(
    () => api
      .get<unknown>('/api/v1/audit?limit=' + WINDOW + (subjectType ? '&subjectType=' + encodeURIComponent(subjectType) : ''))
      .then(readAuditList),
    POLL_INTERVAL_MS,
  );
  /**
   * The kernel's own account of what it will show this caller, carried by the same answer as the
   * rows. Nothing below derives it from the user's role: the page renders the refusal the kernel
   * reported, and an answer that carries no scope explains nothing rather than guessing.
   */
  const scope = data?.scope ?? null;
  const loaded = useMemo(() => data?.events ?? [], [data]);

  /**
   * The four narrow filters, answered over the loaded window. Each one is a fact the reader can
   * see on a row (when, what, who, how it ended), so none of them asks the page to guess.
   */
  const events = useMemo(() => {
    const cutoff = RANGES.find((entry) => entry.id === range)?.hours ?? 0;
    const since = cutoff ? Date.now() - cutoff * 3600_000 : 0;
    const needle = query.trim().toLowerCase();
    return loaded.filter((event) => {
      if (since) {
        const at = Date.parse(event.occurredAt);
        if (Number.isNaN(at) || at < since) return false;
      }
      if (eventType && event.eventType !== eventType) return false;
      if (result && event.result !== result) return false;
      if (actor && event.actorType + ' ' + actorName(event.actorId) !== actor) return false;
      if (!needle) return true;
      return [event.eventType, event.action, event.subjectId, event.actorId, event.result, JSON.stringify(event.details)].join(' ').toLowerCase().includes(needle);
    });
  }, [loaded, range, eventType, actor, result, query]);

  // The polling loader reaches subjectType through a ref, so a filter change has to ask for its
  // own reload; otherwise the new filter would only apply at the next 8s tick.
  const appliedSubject = React.useRef(subjectType);
  React.useEffect(() => {
    if (appliedSubject.current === subjectType) return;
    appliedSubject.current = subjectType;
    void reload();
  }, [subjectType, reload]);

  /**
   * Two different reasons for "not current": the newest successful observation is older than the
   * polling window, or a refresh was refused while rows from the last good observation are still
   * on screen. Both are STALE with the moment we actually saw the payload, never a green list.
   */
  const stale = isStale(observedAt, POLL_INTERVAL_MS) || Boolean(error && data);
  const observing = Boolean(data);
  const narrowed = Boolean(query || subjectType || eventType || actor || result || range !== 'all');
  /**
   * Whether this read named a subject type. With the filter clear it asked the ledger for every
   * kind at once, and the kernel dropped each kind this caller cannot read - so an empty answer
   * here cannot be told apart from a refused one, and the helper is told which read this is.
   * Without this input the page reported the widest possible read and an operator with nothing
   * readable got "No audit events", which is the one claim an empty permission slice must not
   * make (measured: 8 events in the ledger, 0 readable by an operator, data-empty-state=none).
   */
  const spansSubjectTypes = !subjectType;
  const emptyKind = auditEmptyKind({ scope, subjectType: subjectType || null, narrowed, spansSubjectTypes });
  /** The kinds the kernel said can reach this caller, printed verbatim rather than summarised. */
  const readableKinds = (scope?.readableSubjectTypes ?? []).join(', ');
  const clearFilters = () => { setQuery(''); setSubjectType(''); setEventType(''); setActor(''); setResult(''); setRange('all'); };

  // A filter that shrinks the result set must not leave the reader on a page that no longer
  // exists; the window clamps rather than rendering an empty table.
  React.useEffect(() => { setPage(0); }, [query, subjectType, eventType, actor, result, range]);

  /** §2.4 / §1.6: fold runs and repeated requests BEFORE slicing, so a run never splits a page. */
  const rows = useMemo(() => presentEvents(events), [events]);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  const options = useMemo(() => ({
    eventType: Array.from(new Set(loaded.map((event) => event.eventType))).sort(),
    result: Array.from(new Set(loaded.map((event) => event.result))).sort(),
    actor: Array.from(new Set(loaded.map((event) => event.actorType + ' ' + actorName(event.actorId)))).sort(),
  }), [loaded]);

  return (
    <div className="page-stack">
      <PageHeader title={t('page.activity')} description={t('activity.description')} actions={<Button variant="secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>} />

      <section className="toolbar" data-testid="activity-filters">
        <div className="relative flex min-w-[220px] max-w-[380px] flex-1 items-center">
          <Icon name="search" size={16} className="absolute left-[10px] text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('activity.search.placeholder')} aria-label={t('activity.search.aria')} className="pl-[33px]" />
        </div>
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger aria-label={t('activity.filter.rangeAria')} className="w-auto" data-testid="filter-range">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map((entry) => <SelectItem key={entry.id} value={entry.id}>{t(entry.label)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={eventType || ALL} onValueChange={(value) => setEventType(value === ALL ? '' : value)}>
          <SelectTrigger aria-label={t('activity.filter.eventType.aria')} className="w-auto" data-testid="filter-event-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('activity.filter.eventType.all')}</SelectItem>
            {options.eventType.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={actor || ALL} onValueChange={(value) => setActor(value === ALL ? '' : value)}>
          <SelectTrigger aria-label={t('activity.filter.actor.aria')} className="w-auto" data-testid="filter-actor">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('activity.filter.actor.all')}</SelectItem>
            {options.actor.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={result || ALL} onValueChange={(value) => setResult(value === ALL ? '' : value)}>
          <SelectTrigger aria-label={t('activity.filter.result.aria')} className="w-auto" data-testid="filter-result">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('activity.filter.result.all')}</SelectItem>
            {options.result.map((value) => <SelectItem key={value} value={value}><Status code={value} /></SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={subjectType || ALL} onValueChange={(value) => setSubjectType(value === ALL ? '' : value)}>
          <SelectTrigger aria-label={t('activity.filter.aria')} className="w-auto" data-testid="filter-subject">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('activity.filter.allSubjects')}</SelectItem>
            <SelectItem value="plugin">{t('activity.filter.plugin')}</SelectItem>
            <SelectItem value="deployment">{t('activity.filter.deployment')}</SelectItem>
            <SelectItem value="node">{t('activity.filter.node')}</SelectItem>
            <SelectItem value="publisher">{t('activity.filter.publisher')}</SelectItem>
            <SelectItem value="enrollment_token">{t('activity.filter.enrollmentToken')}</SelectItem>
          </SelectContent>
        </Select>
        <span className="toolbar-count" data-testid="activity-count">{t('activity.count.summary', { shown: events.length, total: loaded.length, window: WINDOW })}</span>
        {narrowed ? <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="activity-clear"><Icon name="close" size={14} /> {t('ui.clearFilters')}</Button> : null}
      </section>

      {/*
        A narrowed ledger that is NOT empty explains itself too. An operator who sees two rows
        and knows the platform is busier than that should not have to open an empty filter to
        find out why: the answer is the same fact, printed once, from the kernel's scope.
      */}
      {scope && !scope.seesAll ? (
        <div className="callout" data-testid="activity-scope" data-sees-all="false">
          <Icon name="access" size={16} />
          <p><strong>{t('audit.scope.title')}</strong> {t('audit.scope.detail', { types: scope.readableSubjectTypes.join(', ') })}</p>
        </div>
      ) : null}

      {stale ? (
        <div data-observed-at={observedAt ?? undefined}>
          <NoticeBar
            state="stale"
            title={t('ui.stale.title')}
            detail={t('ui.stale.detail', { at: observedAt ? formatDateTime(observedAt) : t('ui.notObserved') })}
            action={<Button variant="secondary" size="sm" onClick={() => void reload()}><Icon name="refresh" size={14} /> {t('action.refresh')}</Button>}
          />
        </div>
      ) : null}

      <AsyncBoundary
        loading={loading}
        // Rows from the last good observation outrank a failed refresh: they stay on screen and
        // the notice above ages them, instead of a wall that hides the only data there is.
        error={data ? null : error}
        hasData={observing}
        skeletonRows={7}
        onRetry={() => void reload()}
      >
        {rows.length === 0 ? (
          /*
            Three empty lists, three sentences, and only the kernel decides which one this is
            (lib/audit-scope.ts). A refused kind outranks a filter: the exit offered is "stop
            asking for this kind", because the clear-filters button cannot produce a row.
          */
          emptyKind === 'restricted' ? (
            // Two refusals, two sentences. A named kind is refused outright, so the exit is
            // "stop asking for it". An unnamed read spans every kind: what it reports is a
            // boundary, and offering "all subjects" there would be a button that changes
            // nothing because the filter is already clear.
            <div data-empty-state="restricted" data-restricted-ask={spansSubjectTypes ? 'every-kind' : 'one-kind'}>
              {spansSubjectTypes ? (
                <EmptyState
                  icon="access"
                  title={t('activity.empty.restricted.title')}
                  description={t('activity.empty.restricted.description', { kinds: readableKinds })}
                  action={narrowed
                    ? <Button variant="secondary" onClick={clearFilters}>{t('ui.clearFilters')}</Button>
                    : undefined}
                />
              ) : (
                <EmptyState
                  icon="access"
                  title={t('audit.empty.restricted.title', { subject: subjectType })}
                  description={t('audit.empty.restricted.detail')}
                  action={<Button variant="secondary" onClick={() => setSubjectType('')}>{t('activity.filter.allSubjects')}</Button>}
                />
              )}
            </div>
          ) : emptyKind === 'filtered' ? (
            // A filter that matches nothing is not an empty audit log: say so and offer the exit.
            <div data-empty-state="filtered">
              <EmptyState
                icon="search"
                title={t('activity.empty.filtered.title')}
                description={t('activity.empty.filtered.description')}
                action={<Button variant="secondary" onClick={clearFilters}>{t('ui.clearFilters')}</Button>}
              />
            </div>
          ) : (
            <div data-empty-state="none">
              <EmptyState icon="activity" title={t('activity.empty.title')} description={t('activity.empty.description')} />
            </div>
          )
        ) : (
          <section className="panel table-panel">
            {/*
              §2.2 says a column that carries one value on every row has not earned its width, and
              the actor column measured 3 distinct values over 25 rows - so it is not a column. The
              actor rides the qualifier line of every row instead, where it costs no width and is
              visible at 390, which is where the review found it missing on all 25 cards.
            */}
            <Table className={stackTable}>
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('table.event')}</TableHead>
                  <TableHead>{t('table.outcome')}</TableHead>
                  <TableHead>{t('table.occurred')}</TableHead>
                  {/* The trailing cell is the disclosure button's slot, not a column: an empty header
                      above it was a hole in the band. A titled column would enter the audit's
                      min(distinctRatio) and the ratio of a column of identical buttons is 0.07, so
                      the header cell goes and the header row keeps the band filled. */}
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {pageRows.map((row, index) => {
                  const event = row.event;
                  const open = openRow === row.identityKey;
                  return (
                    <React.Fragment key={row.identityKey}>
                      {/* A disclosure row is not a destination, so the keyboard control is the
                          disclosure button in the last cell - aria-expanded, aria-controls, native
                          Enter and Space. The row used to be a second Tab stop with an Enter handler
                          as well, which announced nothing and duplicated the button one stop later. */}
                      <TableRow
                        className={cn('cursor-pointer max-[768px]:relative', stackRow)}
                        data-row-key={row.foldKey}
                        data-expanded={open ? 'true' : 'false'}
                        onClick={() => setOpenRow(open ? null : row.identityKey)}
                      >
                        {/*
                          The identity the reader is actually comparing: the name, the subject, who
                          did it, the payload field that differs, and the clock. The meta line puts
                          the ACTOR first so it survives the ellipsis at 390, where the review found
                          it on none of the 25 cards.
                        */}
                        <IdentityCell
                          label={t('table.event')}
                          cardFact
                          identity={{
                            key: row.identityKey,
                            name: row.name,
                            disambiguator: row.disambiguator,
                            age: ageMessage(locale, row.firstAt),
                            fullId: event.subjectId,
                          }}
                        >
                          <span className="event-actor" data-actor={event.actorType}>{event.actorType} {row.actor.name}</span>
                          {row.detail ? <span className="event-detail-fact"><code>{row.detail.key}</code> {row.detail.value}</span> : null}
                          {row.count > 1 ? <span className="event-run">{t('table.runCount', { count: row.count })} {t('table.runSpan', { first: ageMessage(locale, row.firstAt), last: ageMessage(locale, row.lastAt) })}</span> : null}
                        </IdentityCell>
                        {/* max-[768px]:block is deliberately NOT passed: a block cell put the
                            label and its value on two lines with the label alone and right-aligned
                            ("Outcome" above the pill, "Occurred1m ago 05:02:45" with no gap). The
                            cell keeps table-kit's stacked flex row, which is what every other card
                            at 390 uses: label left, value right, 14px between them. */}
                        <StackCell label={t('table.outcome')}>
                          <div className="ow-cell">
                            <StatusPill status={event.result} />
                            <span className="ow-cell-meta">{event.action}</span>
                          </div>
                        </StackCell>
                        {/*
                          §2.3: one timestamp, not two - one line, both halves of it. The age is how
                          long ago; the clock is WHEN, and it is the half that separates two rows a
                          poller wrote in the same minute. A six-row fan-out used to render as six
                          cards whose text was byte-identical, clock included, because the fan-out
                          half was not printed at all.
                        */}
                        <StackCell label={t('table.occurred')} title={formatDate(event.occurredAt)}>
                          <span className="event-when" data-when={event.occurredAt}>
                            <TimeAgo value={event.occurredAt} />
                            <span className="ow-cell-meta mono">{clockMessage(locale, event.occurredAt)}</span>
                          </span>
                        </StackCell>
                        <TableCell className={cn('row-action', cardActionCell)}>
                          <button
                            type="button"
                            className="icon-btn"
                            data-testid="activity-disclosure"
                            data-expanded={open ? 'true' : 'false'}
                            aria-expanded={open}
                            aria-controls={'activity-detail-' + index}
                            aria-label={t(open ? 'activity.detail.collapse' : 'activity.detail.expand')}
                            title={t('table.details')}
                            onClick={(event2) => { event2.stopPropagation(); setOpenRow(open ? null : row.identityKey); }}
                          >
                            <Icon name={open ? 'down' : 'chevron'} size={15} />
                          </button>
                        </TableCell>
                      </TableRow>
                      {open ? <DetailPanel row={row} index={index} formatDateTime={formatDateTime} /> : null}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
            {pageCount > 1 && (
              <div className="table-pager" data-testid="activity-pager">
                <span className="table-pager-summary">{t('activity.pagination.summary', { page: currentPage + 1, pages: pageCount, total: rows.length })}</span>
                <div className="table-pager-actions">
                  <Button variant="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('pipelines.pagination.previous')}</Button>
                  <Button variant="secondary" disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>{t('pipelines.pagination.next')}</Button>
                </div>
              </div>
            )}
          </section>
        )}
      </AsyncBoundary>
      <p className="table-footnote"><Icon name="access" size={13} /> {t('activity.footnote')}</p>
    </div>
  );
}

/**
 * What a row opens into: the whole event, once.
 *
 * The panel is the answer to "is this the one I am looking for", so it holds every field the row
 * shortened rather than a second copy of the row: the subject with the page it lives on, the actor
 * whole, the exact moment, the request that caused it, every member of a folded run with its own
 * timestamp, and the payload exactly as it was written to the table.
 */
function DetailPanel({ row, index, formatDateTime }: { row: PresentedRow; index: number; formatDateTime: (value: string) => string }) {
  const t = useT();
  const event = row.event;
  const subjectTo = SUBJECT_ROUTE[event.subjectType]?.(event.subjectId);
  const details = event.details && typeof event.details === 'object' ? Object.entries(event.details as Record<string, unknown>) : [];
  return (
    <TableRow className="expanded-row" data-testid="activity-detail">
      <TableCell id={'activity-detail-' + index} colSpan={4}>
        <div className="event-detail">
          <dl className="event-facts">
            <dt>{t('activity.detail.subject')}</dt>
            <dd>
              <code>{event.subjectType}</code>{' '}
              {subjectTo ? <Link to={subjectTo}><code>{event.subjectId}</code></Link> : <code>{event.subjectId}</code>}
            </dd>
            <dt>{t('table.actor')}</dt>
            <dd><code>{event.actorType}</code> <code>{event.actorId}</code></dd>
            <dt>{t('activity.detail.outcome')}</dt>
            <dd><StatusPill status={event.result} /> <code>{event.action}</code></dd>
            <dt>{t('activity.detail.exact')}</dt>
            <dd><span>{formatDateTime(event.occurredAt)}</span> <code>{event.occurredAt}</code></dd>
            <dt>{t('activity.detail.eventId')}</dt>
            <dd><code>{event.id}</code></dd>
            {event.requestId ? (<><dt>{t('activity.detail.request')}</dt><dd><code>{event.requestId}</code></dd></>) : null}
            {row.count > 1 ? (<><dt>{t('activity.detail.folded')}</dt><dd>{t('activity.detail.foldedCount', { count: row.count })}</dd></>) : null}
          </dl>
          {row.count > 1 ? (
            <ol className="detail-list" data-testid="activity-members">
              {row.members.map((member) => (
                <li key={member.id}>
                  <code className="mono">{member.occurredAt}</code>
                  <span>{detailFact(member)?.value ?? subjectName(member)}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {details.length ? (
            <>
              <h4>{t('activity.detail.payload')}</h4>
              <dl className="event-facts" data-testid="activity-payload">
                {details.map(([key, value]) => {
                  const to = typeof value === 'string' ? DETAIL_ROUTE[key]?.(value) : undefined;
                  return (
                    <React.Fragment key={key}>
                      <dt><code>{key}</code></dt>
                      <dd>{to ? <Link to={to}><code>{String(value)}</code></Link> : <code>{formatDetailValue(value)}</code>}</dd>
                    </React.Fragment>
                  );
                })}
              </dl>
              <pre>{JSON.stringify(event.details, null, 2)}</pre>
            </>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/** A payload value as text: strings stay bare, everything else keeps its JSON shape. */
function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
