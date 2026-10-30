import { describe, expect, it } from 'vitest';
import { translate } from '../i18n';
import { deployReadbackFailure, verifyDeployAfterWrite } from './deploy-readback';

/**
 * The deploy write, proven by the GET that follows it.
 *
 * Every case here is the wizard as it used to behave: it rendered the POST response. The first
 * test hands the verb a POST body that claims READY and hands the readback a deployment that is
 * still PENDING, and the assertion is on which of the two reaches the screen.
 */
interface FakeDeployment {
  id: string;
  status: string;
  readyInstances: number;
}

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate('en', key, params);

/** A clock the test owns: sleep advances it, so a timeout costs no wall time. */
function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    sleep: async (ms: number) => { current += ms; },
    advance: (ms: number) => { current += ms; },
  };
}

/** Each read pops the next list; the last entry repeats when the queue runs out. */
function scripts(lists: FakeDeployment[][]) {
  let index = 0;
  return async () => {
    const list = lists[Math.min(index, lists.length - 1)];
    index += 1;
    return list;
  };
}

const spec = (over: Partial<Parameters<typeof verifyDeployAfterWrite<FakeDeployment>>[0]> = {}) => ({
  write: async () => ({ id: 'dep-1' }),
  read: async () => [{ id: 'dep-1', status: 'READY', readyInstances: 2 }],
  idOf: (item: FakeDeployment) => item.id,
  statusOf: (item: FakeDeployment) => item.status,
  ...over,
});

describe('deploy readback', () => {
  it('verifies only on the state a fresh GET reports, never on the POST body', async () => {
    const clock = fakeClock();
    // The POST body claims success; the platform is still placing the deployment.
    const read = scripts([
      [{ id: 'dep-1', status: 'PENDING', readyInstances: 0 }],
      [{ id: 'dep-1', status: 'READY', readyInstances: 2 }],
    ]);
    const result = await verifyDeployAfterWrite<FakeDeployment>({
      write: async () => ({ id: 'dep-1', status: 'READY', readyInstances: 2 } as unknown as { id: string }),
      read,
      idOf: (item) => item.id,
      statusOf: (item) => item.status,
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 5000,
      intervalMs: 500,
    });
    expect(result.outcome).toBe('verified');
    expect(result.state).toBe('READY');
    expect(result.reads).toBe(2);
    // The rendered deployment is the re-read one - the numbers on screen are the platform's.
    expect(result.deployment?.readyInstances).toBe(2);
  });

  it('reports not-expected with the state that is actually there', async () => {
    const clock = fakeClock();
    const result = await verifyDeployAfterWrite<FakeDeployment>({
      ...spec(),
      read: async () => [{ id: 'dep-1', status: 'FAILED', readyInstances: 0 }],
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 5000,
      intervalMs: 500,
    });
    expect(result.outcome).toBe('not-expected');
    expect(result.state).toBe('FAILED');
    const failure = deployReadbackFailure(result, t);
    expect(failure?.message).toContain('FAILED');
  });

  it('gives up at the deadline and reports the last state it saw', async () => {
    const clock = fakeClock();
    const result = await verifyDeployAfterWrite<FakeDeployment>({
      ...spec(),
      read: async () => [{ id: 'dep-1', status: 'PENDING', readyInstances: 0 }],
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 1000,
      intervalMs: 500,
    });
    expect(result.outcome).toBe('timeout');
    expect(result.state).toBe('PENDING');
    expect(result.reads).toBe(3);
    expect(result.deployment?.status).toBe('PENDING');
    expect(deployReadbackFailure(result, t)?.message).toBe(translate('en', 'install.toast.deployUnconfirmed'));
  });

  it('times out with no state when the deployment never appears in the list', async () => {
    const clock = fakeClock();
    const result = await verifyDeployAfterWrite<FakeDeployment>({
      ...spec(),
      read: async () => [],
      now: clock.now,
      sleep: clock.sleep,
      timeoutMs: 600,
      intervalMs: 300,
    });
    expect(result.outcome).toBe('timeout');
    expect(result.state).toBe('');
    expect(result.deployment).toBeNull();
  });

  it('does not read at all when the write is rejected, and does not read twice for a readback that fails', async () => {
    const clock = fakeClock();
    let reads = 0;
    const writeFailed = await verifyDeployAfterWrite<FakeDeployment>({
      ...spec(),
      write: async () => { throw new Error('409 conflict'); },
      read: async () => { reads += 1; return []; },
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(writeFailed.outcome).toBe('write-failed');
    expect(writeFailed.reads).toBe(0);
    expect(reads).toBe(0);

    const unreadable = await verifyDeployAfterWrite<FakeDeployment>({
      ...spec(),
      read: async () => { throw Object.assign(new Error('boom'), { status: 503 }); },
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(unreadable.outcome).toBe('readback-failed');
    expect(deployReadbackFailure(unreadable, t)?.message).toBe(translate('en', 'verify.readbackFailed'));
  });
});
