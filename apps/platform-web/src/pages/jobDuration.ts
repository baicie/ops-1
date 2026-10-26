import type { JobView } from '../types';

export function spanLabel(start?: string | null, end?: string | null, now = Date.now()) {
  if (!start) return '—';
  const startMs = new Date(start).getTime();
  if (!Number.isFinite(startMs)) return '—';
  const endMs = end ? new Date(end).getTime() : now;
  if (!Number.isFinite(endMs)) return '—';
  const ms = Math.max(0, endMs - startMs);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Execution window; includes retry/recovery gaps, not summed CPU time. */
export function executionLabel(job: JobView, now = Date.now()) {
  if (job.status === 'QUEUED') return 'Queued';
  if (job.finishedAt) return spanLabel(job.startedAt, job.finishedAt, now);
  if (job.startedAt) return `${spanLabel(job.startedAt, null, now)} running`;
  if (job.status === 'CLAIMED') return 'Claimed';
  return '—';
}
