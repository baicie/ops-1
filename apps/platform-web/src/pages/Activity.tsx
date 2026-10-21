import React, { useMemo, useState } from 'react';
import { api } from '../api';
import { usePolling } from '../hooks';
import type { AuditEvent } from '../types';
import { Icon } from '../components/Icons';
import { EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge, TimeAgo } from '../components/Ui';
import { formatDate } from '../format';

export function ActivityPage() {
  const [subjectType, setSubjectType] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const { data, error, loading, reload } = usePolling(() => api.get<AuditEvent[]>(`/api/v1/audit?limit=200${subjectType ? `&subjectType=${encodeURIComponent(subjectType)}` : ''}`), 8000);
  const events = useMemo(() => (data || []).filter((event) => !query || `${event.eventType} ${event.action} ${event.subjectId} ${event.actorId}`.toLowerCase().includes(query.toLowerCase())), [data, query]);

  return (
    <div className="page-stack">
      <PageHeader title="Activity" description="Audited lifecycle, deployment and trust actions. Event time is not receive time." actions={<button className="btn btn-secondary" onClick={() => void reload()}><Icon name="refresh" size={15} /> Refresh</button>} />
      <section className="toolbar">
        <div className="search-box"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search event, subject or actor" aria-label="Search audit events" /></div>
        <select value={subjectType} onChange={(event) => setSubjectType(event.target.value)} aria-label="Filter subject type">
          <option value="">All subjects</option><option value="plugin">Plugin</option><option value="deployment">Deployment</option><option value="node">Node</option><option value="publisher">Publisher</option><option value="enrollment_token">Enrollment token</option>
        </select>
        <span className="toolbar-count">{events.length} events</span>
      </section>
      {loading && !data ? <Skeleton rows={7} /> : error ? <ErrorState error={error} onRetry={() => void reload()} /> : events.length === 0 ? <EmptyState icon="activity" title="No audit events" description="Actions performed through the Kernel will appear here." /> : (
        <section className="panel table-panel">
          <table className="data-table activity-table">
            <thead><tr><th>Event</th><th>Result</th><th>Subject</th><th>Actor</th><th>Occurred</th><th aria-label="Details" /></tr></thead>
            <tbody>{events.map((event) => (
              <React.Fragment key={event.id}>
                <tr className="clickable" onClick={() => setExpanded(expanded === event.id ? null : event.id)} tabIndex={0} onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter') setExpanded(expanded === event.id ? null : event.id); }}>
                  <td data-label="Event"><strong>{event.eventType}</strong><div className="muted small">{event.action}</div></td>
                  <td data-label="Result"><StatusBadge status={event.result} /></td>
                  <td data-label="Subject"><span className="muted small">{event.subjectType}</span><div className="mono small">{event.subjectId}</div></td>
                  <td data-label="Actor"><span className="muted small">{event.actorType}</span><div className="mono small">{event.actorId.slice(0, 12)}</div></td>
                  <td data-label="Occurred"><TimeAgo value={event.occurredAt} /><div className="muted small">{formatDate(event.occurredAt)}</div></td>
                  <td className="row-action"><Icon name={expanded === event.id ? 'down' : 'chevron'} size={15} /></td>
                </tr>
                {expanded === event.id && <tr className="expanded-row"><td colSpan={6}><div className="event-detail"><div className="event-detail-meta"><span>Event ID <code>{event.id}</code></span>{event.requestId && <span>Request <code>{event.requestId}</code></span>}</div><pre>{JSON.stringify(event.details, null, 2)}</pre></div></td></tr>}
              </React.Fragment>
            ))}</tbody>
          </table>
        </section>
      )}
      <p className="table-footnote"><Icon name="access" size={13} /> Audit details are redacted at write time. Raw session tokens, enrollment tokens and plugin secrets are never recorded.</p>
    </div>
  );
}
