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
import { StackCell, StatusPill, stackBody, stackHead, stackRow, stackTable } from './table-kit';

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

export function ActivityPage() {
  const t = useT();
  const { formatDateTime } = useI18n();
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
  const pageEvents = events.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

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
            <Table className={stackTable}>
              <TableHeader className={stackHead}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('table.event')}</TableHead>
                  <TableHead>{t('table.result')}</TableHead>
                  <TableHead>{t('table.subject')}</TableHead>
                  <TableHead>{t('table.actor')}</TableHead>
                  <TableHead>{t('table.occurred')}</TableHead>
                  <TableHead aria-label={t('table.details')} />
                </TableRow>
              </TableHeader>
              <TableBody className={stackBody}>
                {pageEvents.map((event) => (
                  <React.Fragment key={event.id}>
                    <TableRow className={cn('cursor-pointer focus-visible:outline-offset-[-2px]', stackRow)} onClick={() => setExpanded(expanded === event.id ? null : event.id)} tabIndex={0} onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter') setExpanded(expanded === event.id ? null : event.id); }}>
                      <StackCell label={t('table.event')}><strong>{event.eventType}</strong><div className="text-sm text-muted-foreground">{event.action}</div></StackCell>
                      <StackCell label={t('table.result')}><StatusPill status={event.result} /></StackCell>
                      <StackCell label={t('table.subject')}><span className="text-sm text-muted-foreground">{event.subjectType}</span><div className="mono text-sm">{event.subjectId}</div></StackCell>
                      <StackCell label={t('table.actor')}><span className="text-sm text-muted-foreground">{event.actorType}</span><div className="mono text-sm">{event.actorId.slice(0, 12)}</div></StackCell>
                      <StackCell label={t('table.occurred')}><TimeAgo value={event.occurredAt} /><div className="text-sm text-muted-foreground">{formatDate(event.occurredAt)}</div></StackCell>
                      <TableCell className="row-action max-[768px]:hidden"><Icon name={expanded === event.id ? 'down' : 'chevron'} size={15} /></TableCell>
                    </TableRow>
                    {expanded === event.id && <TableRow className="expanded-row"><TableCell colSpan={6}><div className="event-detail"><div className="event-detail-meta"><span>{t('activity.detail.eventId')} <code>{event.id}</code></span>{event.requestId && <span>{t('activity.detail.request')} <code>{event.requestId}</code></span>}</div><pre>{JSON.stringify(event.details, null, 2)}</pre></div></TableCell></TableRow>}
                  </React.Fragment>
                ))}
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
