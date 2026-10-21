import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { InstanceDetail, LogEvent } from '../types';
import { Icon } from '../components/Icons';
import { EmptyState, ErrorState, StatusBadge, TimeAgo } from '../components/Ui';
import { formatDate } from '../format';

type Gap = { code: string; message: string; firstSequence?: number | null; lastSequence?: number | null };

export function InstanceLogsPage() {
  const { id = '' } = useParams();
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [detailError, setDetailError] = useState<Error | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [gap, setGap] = useState<Gap | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [streamError, setStreamError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [level, setLevel] = useState('ALL');
  const [contains, setContains] = useState('');
  const [reconnectKey, setReconnectKey] = useState(0);
  const [lastCursor, setLastCursor] = useState<string | null>(null);
  const [freezeCount, setFreezeCount] = useState(0);
  const terminalRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  useEffect(() => {
    let cancelled = false;
    api.get<InstanceDetail>(`/api/v1/instances/${id}`).then((result) => { if (!cancelled) setDetail(result); }).catch((cause) => { if (!cancelled) setDetailError(cause); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    const url = `/api/v1/instances/${id}/logs/live${lastCursor ? `?cursor=${encodeURIComponent(lastCursor)}` : ''}`;
    const source = new EventSource(url, { withCredentials: true });
    setConnection('connecting');
    setStreamError(null);
    source.addEventListener('open', () => setConnection('connected'));
    source.addEventListener('status', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data);
        if (payload.code) setStreamError(`${payload.code}: ${payload.message}`);
        else setConnection('connected');
      } catch { /* ignore malformed status */ }
    });
    source.addEventListener('log', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as LogEvent;
        setEvents((current) => [...current.slice(-999), payload]);
        if ((event as MessageEvent).lastEventId) setLastCursor((event as MessageEvent).lastEventId);
      } catch { /* ignore malformed log event */ }
    });
    source.addEventListener('gap', (event) => {
      try { setGap(JSON.parse((event as MessageEvent).data)); } catch { setGap({ code: 'GAP', message: 'The stream has a gap.' }); }
      if ((event as MessageEvent).lastEventId) setLastCursor((event as MessageEvent).lastEventId);
    });
    source.addEventListener('heartbeat', () => setConnection('connected'));
    source.onerror = () => {
      setConnection('disconnected');
      setStreamError('The log stream disconnected. The cursor is retained; reconnect to resume or accept an explicit gap.');
    };
    return () => source.close();
  }, [id, reconnectKey]);

  useEffect(() => {
    if (!paused && follow && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [events.length, paused, follow]);

  useEffect(() => {
    if (paused) setFreezeCount(events.length);
  }, [paused]);

  const visible = useMemo(() => events
    .slice(0, paused ? freezeCount : events.length)
    .filter((event) => level === 'ALL' || event.level === level)
    .filter((event) => !contains || event.message.toLowerCase().includes(contains.toLowerCase())), [events, paused, freezeCount, level, contains]);

  if (detailError) return <ErrorState error={detailError} />;
  if (!detail) return <div className="skeleton" style={{ height: 320 }} />;

  return (
    <div className="log-page">
      <header className="log-header">
        <div>
          <p className="eyebrow"><Link to={`/plugins/${detail.pluginId}`} className="text-link">{detail.pluginId}</Link> · {detail.version}</p>
          <h1>Instance logs</h1>
          <div className="log-meta">
            <span className="mono">{detail.id}</span>
            <span><Icon name="server" size={13} /> {detail.nodeName}</span>
            <span>slot #{detail.slot}</span>
            <StatusBadge status={detail.state} />
            <span className={connection === 'connected' ? 'text-ok' : 'text-warn'}><span className={`live-dot ${connection}`} /> {connection}</span>
          </div>
        </div>
        <div className="log-actions">
          <button className={`btn btn-secondary ${paused ? 'btn-warn' : ''}`} onClick={() => setPaused(!paused)}><Icon name={paused ? 'play' : 'pause'} size={15} /> {paused ? `Resume (${Math.max(0, events.length - freezeCount)} buffered)` : 'Pause view'}</button>
          <button className={`btn btn-secondary ${follow ? 'btn-active' : ''}`} onClick={() => setFollow(!follow)}><Icon name="logs" size={15} /> Follow</button>
          <button className="btn btn-secondary" onClick={() => setReconnectKey((key) => key + 1)}><Icon name="refresh" size={15} /> Reconnect</button>
        </div>
      </header>

      <div className="log-toolbar">
        <div className="search-box"><Icon name="search" size={15} /><input value={contains} onChange={(event) => setContains(event.target.value)} placeholder="Filter messages (case-insensitive)" aria-label="Filter log messages" /></div>
        <select value={level} onChange={(event) => setLevel(event.target.value)} aria-label="Filter by level">
          {['ALL', 'INFO', 'WARN', 'ERROR', 'DEBUG', 'TRACE', 'UNKNOWN'].map((value) => <option key={value}>{value}</option>)}
        </select>
        <span className="log-count">{visible.length} shown · {events.length} buffered</span>
        <button className="btn btn-small" onClick={() => navigator.clipboard.writeText(visible.map((event) => `${event.observedAt} ${event.level} ${event.message}`).join('\n')).catch(() => undefined)}><Icon name="copy" size={14} /> Copy</button>
      </div>

      {gap && (
        <div className="gap-banner" role="alert">
          <Icon name="warning" size={18} />
          <div><strong>Gap: {gap.code}</strong><p>{gap.message}</p></div>
          <button className="btn btn-small" onClick={() => { setGap(null); setReconnectKey((key) => key + 1); }}>Reconnect from earliest available</button>
        </div>
      )}
      {streamError && !gap && <div className="inline-error"><Icon name="warning" size={16} /> {streamError}</div>}

      <div className="terminal" ref={terminalRef} role="log" aria-live="polite" aria-relevant="additions">
        {visible.length === 0 ? (
          <EmptyState icon="logs" title={events.length ? 'No events match this filter' : 'Waiting for log events'} description={events.length ? 'Clear the filters to see the buffered stream.' : 'Only authorized operators can subscribe. The Node keeps a bounded ring buffer; lost history is reported as a gap, never fabricated.'} />
        ) : visible.map((event) => (
          <div className={`log-line level-${event.level.toLowerCase()}`} key={event.eventId}>
            <span className="log-time" title={formatDate(event.observedAt)}>{new Date(event.observedAt).toLocaleTimeString(undefined, { hour12: false })}</span>
            <span className="log-level">{event.level}</span>
            <span className="log-channel">{event.channel}</span>
            <span className="log-message">{event.message}{event.truncated && <span className="log-truncated"> [truncated]</span>}</span>
          </div>
        ))}
      </div>
      <footer className="log-footer">
        <span>Stream {detail.streamId.slice(0, 8)}… · cursor is opaque and permission-bound</span>
        {lastCursor && <span className="mono">last cursor {lastCursor.slice(0, 18)}…</span>}
        <span>Buffer is bounded on the Node; expired cursors produce an explicit gap.</span>
      </footer>
    </div>
  );
}
