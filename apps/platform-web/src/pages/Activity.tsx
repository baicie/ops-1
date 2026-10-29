import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { AuditEvent } from '../types';
import { Icon } from '../components/Icons';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { EmptyState, ErrorState, PageHeader, Skeleton, TimeAgo } from '../components/Ui';
import { formatDate } from '../format';
import { useT } from '../i18n';
import { cn } from '../lib/utils';
import { StackCell, StatusPill, stackBody, stackHead, stackRow, stackTable } from './table-kit';

/** The subject filter has an "all subjects" state, which Radix Select cannot express
 *  (an item value is never "no value"): the empty string the API expects is mapped here. */
const ALL_SUBJECTS = 'ALL';

export function ActivityPage() {
  const t = useT();
  const [subjectType, setSubjectType] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data, error, loading, reload } = usePolling(() => api.get<AuditEvent[]>(`/api/v1/audit?limit=200${subjectType ? `&subjectType=${encodeURIComponent(subjectType)}` : ''}`), 8000);
  const events = useMemo(() => (data || []).filter((event) => !query || `${event.eventType} ${event.action} ${event.subjectId} ${event.actorId}`.toLowerCase().includes(query.toLowerCase())), [data, query]);

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
      {loading && !data ? <Skeleton rows={7} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : events.length === 0 ? <EmptyState icon="activity" title={t('activity.empty.title')} description={t('activity.empty.description')} /> : (
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
              {events.map((event) => (
                <React.Fragment key={event.id}>
                  <TableRow className={cn('cursor-pointer focus-visible:outline-offset-[-2px]', stackRow)} onClick={() => setExpanded(expanded === event.id ? null : event.id)} tabIndex={0} onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter') setExpanded(expanded === event.id ? null : event.id); }}>
                    <StackCell label={t('table.event')}><strong>{event.eventType}</strong><div className="text-sm text-muted-foreground">{event.action}</div></StackCell>
                    <StackCell label={t('table.result')}><StatusPill status={event.result} /></StackCell>
                    <StackCell label={t('table.subject')}><span className="text-sm text-muted-foreground">{event.subjectType}</span><div className="mono text-sm">{event.subjectId}</div></StackCell>
                    <StackCell label={t('table.actor')}><span className="text-sm text-muted-foreground">{event.actorType}</span><div className="mono text-sm">{event.actorId.slice(0, 12)}</div></StackCell>
                    <StackCell label={t('table.occurred')}><TimeAgo value={event.occurredAt} /><div className="text-sm text-muted-foreground">{formatDate(event.occurredAt)}</div></StackCell>
                    <TableCell className="row-action max-[760px]:hidden"><Icon name={expanded === event.id ? 'down' : 'chevron'} size={15} /></TableCell>
                  </TableRow>
                  {expanded === event.id && <TableRow className="expanded-row"><TableCell colSpan={6}><div className="event-detail"><div className="event-detail-meta"><span>{t('activity.detail.eventId')} <code>{event.id}</code></span>{event.requestId && <span>{t('activity.detail.request')} <code>{event.requestId}</code></span>}</div><pre>{JSON.stringify(event.details, null, 2)}</pre></div></TableCell></TableRow>}
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      <p className="table-footnote"><Icon name="access" size={13} /> {t('activity.footnote')}</p>
    </div>
  );
}
