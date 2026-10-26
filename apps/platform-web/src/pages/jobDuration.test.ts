import { describe, expect, it } from 'vitest';
import { executionLabel, spanLabel } from './jobDuration';
import type { JobView } from '../types';

const base: JobView = {
  jobId: 'j', pipelineId: 'p', pipelineRevision: 1, status: 'QUEUED', currentFence: 0,
  currentLeaseId: null, attempts: 0, maxAttempts: 3, lastErrorCode: null,
  startedAt: null, finishedAt: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

describe('job execution duration', () => {
  it('does not call queue wait execution time', () => {
    expect(executionLabel({ ...base, status: 'QUEUED' }, Date.parse('2026-01-01T00:10:00Z'))).toBe('Queued');
  });
  it('shows claimed without a start as claimed', () => {
    expect(executionLabel({ ...base, status: 'CLAIMED' })).toBe('Claimed');
  });
  it('shows elapsed running without a terminal result', () => {
    const job = { ...base, status: 'RUNNING' as const, startedAt: '2026-01-01T00:00:10Z' };
    expect(executionLabel(job, Date.parse('2026-01-01T00:00:12Z'))).toBe('2.0 s running');
  });
  it('uses the execution window for a successful job', () => {
    const job = { ...base, status: 'SUCCEEDED' as const, startedAt: '2026-01-01T00:00:10Z', finishedAt: '2026-01-01T00:00:11Z' };
    expect(executionLabel(job)).toBe('1.0 s');
  });
  it('uses the execution window for failed and cancelled jobs', () => {
    const job = { ...base, startedAt: '2026-01-01T00:00:10Z', finishedAt: '2026-01-01T00:00:10.500Z' };
    expect(executionLabel({ ...job, status: 'FAILED' })).toBe('500 ms');
    expect(executionLabel({ ...job, status: 'CANCELLED' })).toBe('500 ms');
  });
  it('marks missing timestamps as not computable', () => {
    expect(executionLabel({ ...base, status: 'SUCCEEDED' })).toBe('—');
    expect(spanLabel(undefined, '2026-01-01T00:00:00Z')).toBe('—');
    expect(spanLabel('invalid', '2026-01-01T00:00:00Z')).toBe('—');
  });
  it('does not produce a negative duration for invalid ordering', () => {
    expect(spanLabel('2026-01-01T00:00:10Z', '2026-01-01T00:00:00Z')).toBe('0 ms');
  });
});
