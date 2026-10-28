import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { AuditEvent } from '../types';
import { Icon } from '../components/Icons';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';
import { formatDate } from '../format';
import { useT } from '../i18n';

export function ActivityPage() {
  const t = useT();
  const [subjectType, setSubjectType] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data, error, loading, reload } = usePolling(() => api.get<AuditEvent[]>(`/api/v1/audit?limit=200${subjectType ? `&subjectType=${encodeURIComponent(subjectType)}` : ''}`), 8000);
  const events = useMemo(() => (data || []).filter((event) => !query || `${event.eventType} ${event.action} ${event.subjectId} ${event.actorId}`.toLowerCase().includes(query.toLowerCase())), [data, query]);

  return (
    <div className="page-stack">
      <PageHeader title={t('page.activity')} description={t('activity.description')} actions={<button className="btn btn-secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> {t('action.refresh')}</button>} />
      <section className="toolbar">
        <div className="search-box"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('activity.search.placeholder')} aria-label={t('activity.search.aria')} /></div>
        <select value={subjectType} onChange={(event) => setSubjectType(event.target.value)} aria-label={t('activity.filter.aria')}>
          <option value="">{t('activity.filter.allSubjects')}</option><option value="plugin">{t('activity.filter.plugin')}</option><option value="deployment">{t('activity.filter.deployment')}</option><option value="node">{t('activity.filter.node')}</option><option value="publisher">{t('activity.filter.publisher')}</option><option value="enrollment_token">{t('activity.filter.enrollmentToken')}</option>
        </select>
        <span className="toolbar-count">{t('activity.count.events', { count: events.length })}</span>
      </section>
      {loading && !data ? <Skeleton rows={7} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : events.length === 0 ? <EmptyState icon="activity" title={t('activity.empty.title')} description={t('activity.empty.description')} /> : (
        <section className="panel table-panel">
          <table className="data-table activity-table">
            <thead><tr><th>{t('table.event')}</th><th>{t('table.result')}</th><th>{t('table.subject')}</th><th>{t('table.actor')}</th><th>{t('table.occurred')}</th><th aria-label={t('table.details')} /></tr></thead>
            <tbody>{events.map((event) => (
              <React.Fragment key={event.id}>
                <tr className="clickable" onClick={() => setExpanded(expanded === event.id ? null : event.id)} tabIndex={0} onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter') setExpanded(expanded === event.id ? null : event.id); }}>
                  <td data-label={t('table.event')}><strong>{event.eventType}</strong><div className="muted small">{event.action}</div></td>
                  <td data-label={t('table.result')}><StatusBadge status={event.result} /></td>
                  <td data-label={t('table.subject')}><span className="muted small">{event.subjectType}</span><div className="mono small">{event.subjectId}</div></td>
                  <td data-label={t('table.actor')}><span className="muted small">{event.actorType}</span><div className="mono small">{event.actorId.slice(0, 12)}</div></td>
                  <td data-label={t('table.occurred')}><TimeAgo value={event.occurredAt} /><div className="muted small">{formatDate(event.occurredAt)}</div></td>
                  <td className="row-action"><Icon name={expanded === event.id ? 'down' : 'chevron'} size={15} /></td>
                </tr>
                {expanded === event.id && <tr className="expanded-row"><td colSpan={6}><div className="event-detail"><div className="event-detail-meta"><span>{t('activity.detail.eventId')} <code>{event.id}</code></span>{event.requestId && <span>{t('activity.detail.request')} <code>{event.requestId}</code></span>}</div><pre>{JSON.stringify(event.details, null, 2)}</pre></div></td></tr>}
              </React.Fragment>
            ))}</tbody>
          </table>
        </section>
      )}
      <p className="table-footnote"><Icon name="access" size={13} /> {t('activity.footnote')}</p>
    </div>
  );
}
