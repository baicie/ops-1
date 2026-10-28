import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { InstanceDetail, LogEvent } from '../types';
import { Icon } from '../components/Icons';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { EmptyState, ErrorState } from '../components/Ui';
import { formatDate } from '../format';
import { useT } from '../i18n';
import { cn } from '../lib/utils';
import { StatusPill } from './table-kit';

type Gap = { code: string; message: string; firstSequence?: number | null; lastSequence?: number | null };

const LEVELS = ['ALL', 'INFO', 'WARN', 'ERROR', 'DEBUG', 'TRACE', 'UNKNOWN'];

export function InstanceLogsPage() {
  const t = useT();
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
      try { setGap(JSON.parse((event as MessageEvent).data)); } catch { setGap({ code: 'GAP', message: t('instanceLogs.gap.defaultMessage') }); }
      if ((event as MessageEvent).lastEventId) setLastCursor((event as MessageEvent).lastEventId);
    });
    source.addEventListener('heartbeat', () => setConnection('connected'));
    source.onerror = () => {
      setConnection('disconnected');
      setStreamError(t('instanceLogs.error.disconnected'));
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
          <p className="eyebrow"><Link to={`/admin/plugins/${detail.pluginId}`} className="text-link">{detail.pluginId}</Link> · {detail.version}</p>
          <h1>{t('page.instanceLogs')}</h1>
          <div className="log-meta">
            <span className="mono">{detail.id}</span>
            <span><Icon name="server" size={13} /> {detail.nodeName}</span>
            <span>{t('instanceLogs.slot', { slot: detail.slot })}</span>
            <StatusPill status={detail.state} />
            <span className={connection === 'connected' ? 'text-ok' : 'text-warn'}><span className={`live-dot ${connection}`} /> {connection === 'connected' ? t('instanceLogs.connection.connected') : connection === 'disconnected' ? t('instanceLogs.connection.disconnected') : t('instanceLogs.connection.connecting')}</span>
          </div>
        </div>
        <div className="log-actions">
          <Button variant="secondary" className={cn(paused && 'border-warning text-warning')} onClick={() => setPaused(!paused)}><Icon name={paused ? 'play' : 'pause'} size={15} /> {paused ? t('instanceLogs.action.resume', { count: Math.max(0, events.length - freezeCount) }) : t('instanceLogs.action.pause')}</Button>
          <Button variant="secondary" className={cn(follow && 'border-ring bg-accent text-accent-foreground')} onClick={() => setFollow(!follow)}><Icon name="logs" size={15} /> {t('instanceLogs.action.follow')}</Button>
          <Button variant="secondary" onClick={() => setReconnectKey((key) => key + 1)}><Icon name="refresh" size={15} /> {t('instanceLogs.action.reconnect')}</Button>
        </div>
      </header>

      <div className="log-toolbar">
        <div className="search-box"><Icon name="search" size={15} /><Input value={contains} onChange={(event) => setContains(event.target.value)} placeholder={t('instanceLogs.search.placeholder')} aria-label={t('instanceLogs.search.aria')} /></div>
        <Select value={level} onValueChange={setLevel}>
          <SelectTrigger aria-label={t('instanceLogs.filter.aria')} className="h-8 w-[132px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {LEVELS.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="log-count">{t('instanceLogs.count', { shown: visible.length, buffered: events.length })}</span>
        <Button variant="secondary" size="sm" onClick={() => navigator.clipboard.writeText(visible.map((event) => `${event.observedAt} ${event.level} ${event.message}`).join('\n')).catch(() => undefined)}><Icon name="copy" size={14} /> {t('action.copy')}</Button>
      </div>

      {gap && (
        <div className="gap-banner" role="alert">
          <Icon name="warning" size={18} />
          <div><strong>{t('instanceLogs.gap.title', { code: gap.code })}</strong><p>{gap.message}</p></div>
          <Button variant="secondary" size="sm" onClick={() => { setGap(null); setReconnectKey((key) => key + 1); }}>{t('instanceLogs.gap.reconnect')}</Button>
        </div>
      )}
      {streamError && !gap && <div className="inline-error"><Icon name="warning" size={16} /> {streamError}</div>}

      <div className="terminal" ref={terminalRef} role="log" aria-live="polite" aria-relevant="additions">
        {visible.length === 0 ? (
          <EmptyState icon="logs" title={events.length ? t('instanceLogs.empty.filtered.title') : t('instanceLogs.empty.waiting.title')} description={events.length ? t('instanceLogs.empty.filtered.description') : t('instanceLogs.empty.waiting.description')} />
        ) : visible.map((event) => (
          <div className={`log-line level-${event.level.toLowerCase()}`} key={event.eventId}>
            <span className="log-time" title={formatDate(event.observedAt)}>{new Date(event.observedAt).toLocaleTimeString(undefined, { hour12: false })}</span>
            <span className="log-level">{event.level}</span>
            <span className="log-channel">{event.channel}</span>
            <span className="log-message">{event.message}{event.truncated && <span className="log-truncated"> {t('instanceLogs.truncated')}</span>}</span>
          </div>
        ))}
      </div>
      <footer className="log-footer">
        <span>{t('instanceLogs.footer.stream', { id: detail.streamId.slice(0, 8) })}</span>
        {lastCursor && <span className="mono">{t('instanceLogs.footer.cursor', { cursor: lastCursor.slice(0, 18) })}</span>}
        <span>{t('instanceLogs.footer.buffer')}</span>
      </footer>
    </div>
  );
}
