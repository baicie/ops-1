import React, { useMemo, useState } from 'react';
import { api } from '../api';
import type { AuditEvent } from '../types';
import { Icon } from '../components/Icons';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { EmptyState, TimeAgo } from '../components/Ui';
import { AsyncBoundary, NoticeBar, isStale, useObservedPolling } from '../components/app/async-boundary';
import { PageHeader } from '../components/app/page-header';
import { formatDate } from '../format';
import { useI18n, useT } from '../i18n';
import { cn } from '../lib/utils';
import { IdentityCell, StackCell, StatusPill, cardCellClass, collapseRuns, formatIdentity, rankCardFacts, relativeAge, stackBody, stackHead, stackRow, stackTable } from './table-kit';

/** The subject filter has an "all subjects" state, which Radix Select cannot express
 *  (an item value is never "no value"): the empty string the API expects is mapped here. */
const ALL_SUBJECTS = 'ALL';

/** The page's own polling cadence; `isStale` compares the last observation against it. */
const POLL_INTERVAL_MS = 8000;

/**
 * Rows per page. The ledger asked the API for 200 events and rendered all of them: measured
 * 32,895px of page at 390px wide with no way to reach the middle. The window is a page now.
 */
const PAGE_SIZE = 25;

/** table-spec §2.4: three identical rows in a row can only be a poller, a fan-out or a retry loop. */
const RUN_THRESHOLD = 3;

export function ActivityPage() {
  const t = useT();
  const { formatDateTime, locale } = useI18n();
  const [subjectType, setSubjectType] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const { data, error, loading, reload, observedAt } = useObservedPolling(
    () => api.get<AuditEvent[]>(`/api/v1/audit?limit=200${subjectType ? `&subjectType=${encodeURIComponent(subjectType)}` : ''}`),
    POLL_INTERVAL_MS,
  );
  const events = useMemo(() => (data || []).filter((event) => !query || `${event.eventType} ${event.action} ${event.subjectId} ${event.actorId}`.toLowerCase().includes(query.toLowerCase())), [data, query]);

  // The polling loader reaches subjectType through a ref, so a filter change has to ask for its
  // own reload; otherwise the new filter would only apply at the next 8s tick and the select
  // would look broken for eight seconds.
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
  const filtered = Boolean(query || subjectType);
  const noRowsFromSource = Boolean(data && data.length === 0);
  const clearFilters = () => { setQuery(''); setSubjectType(''); };

  // A filter that shrinks the result set must not leave the reader on a page that no longer
  // exists; the window clamps rather than rendering an empty table.
  React.useEffect(() => { setPage(0); }, [query, subjectType]);
  const pageCount = Math.max(1, Math.ceil(events.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  /**
   * table-spec §2.4 / migration S3: collapse runs of >= 3 identical (eventType, action,
   * subjectId) over the WHOLE filtered set, then slice - collapsing after the slice would
   * split a run across two pages and make the count wrong on both.
   */
  const groups = React.useMemo(() => collapseRuns(
    events,
    (event) => event.eventType + '\u0000' + event.action + '\u0000' + event.subjectId,
    (event) => event.occurredAt,
    RUN_THRESHOLD,
  ), [events]);
  const pageGroups = groups.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);
  /**
   * table-spec §2.2: result and action are two halves of one answer - what happened - so they are
   * one column, not two. Measured, the pair separates rows four times better than `result` alone
   * did (0.94 against 0.18): a status word beside its verb is what a reader compares.
   */
  const cardFacts = rankCardFacts({
    outcome: events.map((event) => event.action + '\u0000' + event.result),
    occurred: events.map((event) => event.occurredAt),
  });
  /** §2.1: the disambiguator appears only when the page carries the same name twice. */
  const eventTypeCount = new Set(events.map((event) => event.eventType)).size;
  /**
   * §2.2: one actor across every row on the page is a column read once, so it is *read* here and
   * stated once above the table - with the whole id, which the 8-character column could not give.
   * A page of mixed actors keeps the per-row reading in each row's detail panel.
   */
  const actorKeys = Array.from(new Set(events.map((event) => event.actorType + '\u0000' + event.actorId)));
  const singleActor = actorKeys.length === 1 ? events[0] : null;

  return (
    <div className="page-stack">
      <PageHeader title={t('page.activity')} description={t('activity.description')} actions={<Button variant="secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> {t('action.refresh')}</Button>} />
      <section className="toolbar">
        <div className="relative flex min-w-[260px] max-w-[460px] flex-1 items-center">
          <Icon name="search" size={16} className="absolute left-[10px] text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('activity.search.placeholder')} aria-label={t('activity.search.aria')} className="pl-[33px]" />
        </div>
        <Select value={subjectType || ALL_SUBJECTS} onValueChange={(value) => setSubjectType(value === ALL_SUBJECTS ? '' : value)}>
          <SelectTrigger aria-label={t('activity.filter.aria')} className="w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SUBJECTS}>{t('activity.filter.allSubjects')}</SelectItem>
            <SelectItem value="plugin">{t('activity.filter.plugin')}</SelectItem>
            <SelectItem value="deployment">{t('activity.filter.deployment')}</SelectItem>
            <SelectItem value="node">{t('activity.filter.node')}</SelectItem>
            <SelectItem value="publisher">{t('activity.filter.publisher')}</SelectItem>
            <SelectItem value="enrollment_token">{t('activity.filter.enrollmentToken')}</SelectItem>
          </SelectContent>
        </Select>
        <span className="toolbar-count">{t('activity.count.events', { count: events.length })}</span>
      </section>
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
        {events.length === 0 ? (
          filtered ? (
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
            <div data-empty-state={noRowsFromSource ? 'none' : 'filtered'}>
              <EmptyState icon="activity" title={t('activity.empty.title')} description={t('activity.empty.description')} />
            </div>
          )
        ) : (
          <section className="panel table-panel">
            {/* table-spec §2.2 says a demoted column is stated above the table, once. */}
            <p className="stat-note" data-table-note="demoted">
              {singleActor
                ? <>{t('activity.table.note.single', { type: singleActor.actorType })} <code>{singleActor.actorId}</code></>
                : t('activity.table.note.many')}
            </p>
            <Table className={stackTable}>
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('table.event')}</TableHead>
                  <TableHead>{t('table.outcome')}</TableHead>
                  <TableHead>{t('table.occurred')}</TableHead>
                  <TableHead aria-label={t('table.details')} />
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {pageGroups.map((group, index) => {
                  const event = group.row;
                  const open = expanded === String(index);
                  const identity = formatIdentity({
                    name: event.eventType,
                    id: event.subjectId,
                    at: event.occurredAt,
                    locale,
                    nameIsUnique: eventTypeCount === events.length,
                    rowsOnPage: events.length,
                  });
                  const members = group.count > 1
                    ? events.filter((candidate) => candidate.eventType === event.eventType && candidate.action === event.action && candidate.subjectId === event.subjectId && candidate.occurredAt >= event.occurredAt && candidate.occurredAt <= group.lastAt)
                    : [event];
                  return (
                    <React.Fragment key={String(index)}>
                      <TableRow className={cn('cursor-pointer focus-visible:outline-offset-[-2px] max-[768px]:relative', stackRow)} data-row-key={group.key} onClick={() => setExpanded(open ? null : String(index))} tabIndex={0} onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter') setExpanded(open ? null : String(index)); }}>
                        <IdentityCell label={t('table.event')} identity={identity} cardFact>
                          {/* §2.4: the run renders the first occurrence, its count and its span. */}
                          {group.count > 1 ? (
                            <>
                              <span>{t('table.runCount', { count: group.count })}</span>
                              <span>{t('table.runSpan', { first: relativeAge(locale, event.occurredAt), last: relativeAge(locale, group.lastAt) })}</span>
                            </>
                          ) : undefined}
                        </IdentityCell>
                        {/* §2.2: the two-column result and action are one answer, so they are one
                            cell - the 13px status pill and the 11px verb it applied. */}
                        <StackCell label={t('table.outcome')} className={cardCellClass(cardFacts.includes('outcome'))}>
                          <div className="ow-cell">
                            <StatusPill status={event.result} />
                            <span className="ow-cell-meta">{event.action}</span>
                          </div>
                        </StackCell>
                        {/* §2.3: one timestamp, not two. The relative age and the absolute date are
                            the same fact; the second line made this cell 43.2px against §4.2's 42 and
                            the card 141.6 against §2.5's 140. The absolute moment stays reachable on
                            the cell (title) and in the row's own detail panel below. */}
                        <StackCell label={t('table.occurred')} className={cardCellClass(cardFacts.includes('occurred'))} title={formatDate(event.occurredAt)}><TimeAgo value={event.occurredAt} /></StackCell>
                        {/* §2.5: the disclosure rides the identity line at 390. */}
                        <TableCell className="row-action max-[768px]:absolute max-[768px]:right-1 max-[768px]:top-0 max-[768px]:w-auto max-[768px]:border-0 max-[768px]:p-0"><Icon name={open ? 'down' : 'chevron'} size={15} /></TableCell>
                      </TableRow>
                      {open && (
                        <TableRow className="expanded-row">
                          <TableCell colSpan={4}>
                            <div className="event-detail">
                              <div className="event-detail-meta">
                                <span>{t('activity.detail.subject')} <code>{event.subjectId}</code></span>
                                <span>{t('table.occurred')} <code>{formatDate(event.occurredAt)}</code></span>
                                <span>{t('table.actor')} <code>{event.actorId}</code></span>
                                <span>{t('activity.detail.eventId')} <code>{event.id}</code></span>
                                {event.requestId && <span>{t('activity.detail.request')} <code>{event.requestId}</code></span>}
                              </div>
                              {group.count > 1 ? (
                                <ol className="detail-list">
                                  {members.map((member) => <li key={member.id}><span>{member.eventType}</span><code>{member.id}</code><TimeAgo value={member.occurredAt} /></li>)}
                                </ol>
                              ) : (
                                <pre>{JSON.stringify(event.details, null, 2)}</pre>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
            {pageCount > 1 && (
              <div className="table-pager" data-testid="activity-pager">
                <span className="table-pager-summary">{t('activity.pagination.summary', { page: currentPage + 1, pages: pageCount, total: events.length })}</span>
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
