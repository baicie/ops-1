import { describe, expect, it } from 'vitest';
import { PLACEMENT_REASON_CODES, describePlacementReason, parsePlacementReason, type PlacementTranslate } from './placement-reason';
import { translate } from './i18n';

/** Verbatim from `placement_failure_reason` in apps/kernel/src/deployments.rs. */
const PREFIX = 'No eligible healthy node matches the placement selector';

function statusReason(code: string, node: string, detail: string): string {
  return `${PREFIX} [${code}] node ${node}: ${detail}`;
}

const DETAILS: Record<string, string> = {
  NODE_NOT_READY: 'node status is STOPPING, placement requires READY with a recent heartbeat',
  SELECTOR_MISMATCH: 'selector role=node does not match node label role=worker',
  RESOURCE_SNAPSHOT_MISSING: 'resource snapshot has no cpuCores',
  MEMORY_INSUFFICIENT: 'requested 512 MiB but only 256 MiB of the 1024 MiB available are budgetable (90% headroom)',
  CPU_INSUFFICIENT: 'requested 1000m of CPU but only 900m of 1 cores are budgetable (90% headroom)',
  INSTANCE_CAPACITY_EXCEEDED: '2 instances already scheduled on this node against a per-node limit of 2',
};

/** Key plus its interpolation values, so a failure names the params instead of a sentence. */
const spy: PlacementTranslate = (key, params) => (params ? `${key} ${JSON.stringify(params)}` : key);

const en = (key: Parameters<PlacementTranslate>[0], params?: Parameters<PlacementTranslate>[1]) => translate('en', key, params);
const zh = (key: Parameters<PlacementTranslate>[0], params?: Parameters<PlacementTranslate>[1]) => translate('zh-CN', key, params);

describe('placement reason parsing', () => {
  it('recovers the code, node and detail for every published code', () => {
    for (const code of PLACEMENT_REASON_CODES) {
      const parsed = parsePlacementReason(statusReason(code, 'staging-node', DETAILS[code]));
      expect(parsed?.code, code).toBe(code);
      expect(parsed?.node, code).toBe('staging-node');
      expect(parsed?.detail, code).toBe(DETAILS[code]);
    }
  });

  it('keeps the numbers behind each refusal', () => {
    const cpu = parsePlacementReason(statusReason('CPU_INSUFFICIENT', 'n1', DETAILS.CPU_INSUFFICIENT));
    expect(cpu?.values).toEqual({ requested: '1000', budgetable: '900', cores: '1' });

    const memory = parsePlacementReason(statusReason('MEMORY_INSUFFICIENT', 'n1', DETAILS.MEMORY_INSUFFICIENT));
    expect(memory?.values).toEqual({ requested: '512', budgetable: '256', available: '1024' });

    const capacity = parsePlacementReason(statusReason('INSTANCE_CAPACITY_EXCEEDED', 'n1', DETAILS.INSTANCE_CAPACITY_EXCEEDED));
    expect(capacity?.values).toEqual({ instances: '2', scope: 'per-node', limit: '2' });

    const ready = parsePlacementReason(statusReason('NODE_NOT_READY', 'n1', DETAILS.NODE_NOT_READY));
    expect(ready?.values).toEqual({ status: 'STOPPING' });

    const snapshot = parsePlacementReason(statusReason('RESOURCE_SNAPSHOT_MISSING', 'n1', 'resource snapshot has no cpuCores'));
    expect(snapshot?.values).toEqual({ field: 'cpuCores' });
  });

  it('reads both selector shapes the kernel can emit', () => {
    const mismatched = parsePlacementReason(statusReason('SELECTOR_MISMATCH', 'n1', DETAILS.SELECTOR_MISMATCH));
    expect(mismatched?.titleKey).toBe('placement.reason.selectorMismatch');
    expect(mismatched?.values).toEqual({ key: 'role', expected: 'node', actual: 'worker' });

    const missing = parsePlacementReason(statusReason('SELECTOR_MISMATCH', 'n1', 'selector role=node does not match: node has no label role'));
    expect(missing?.titleKey).toBe('placement.reason.selectorMismatch.missingLabel');
    expect(missing?.values).toEqual({ key: 'role', expected: 'node' });
  });

  it('reads a node that never reported a snapshot', () => {
    const parsed = parsePlacementReason(statusReason('RESOURCE_SNAPSHOT_MISSING', 'n1', 'node has not reported a resource snapshot'));
    expect(parsed?.titleKey).toBe('placement.reason.resourceSnapshotMissing.noSnapshot');
    expect(parsed?.values).toEqual({});
  });

  it('falls back to a generic but still localized title when the detail wording changes', () => {
    const parsed = parsePlacementReason(statusReason('CPU_INSUFFICIENT', 'n1', 'the kernel reworded this in a later release'));
    expect(parsed?.code).toBe('CPU_INSUFFICIENT');
    expect(parsed?.titleKey).toBe('placement.reason.cpuInsufficient.generic');
    expect(parsed?.values).toEqual({});
  });

  it('refuses to invent a code it does not know', () => {
    expect(parsePlacementReason(statusReason('DISK_INSUFFICIENT', 'n1', 'whatever'))).toBeNull();
    expect(parsePlacementReason(`${PREFIX}`)).toBeNull();
    expect(parsePlacementReason(statusReason('CPU_INSUFFICIENT', 'n1', DETAILS.CPU_INSUFFICIENT).replace('[CPU_INSUFFICIENT] node n1: ', ''))).toBeNull();
    expect(parsePlacementReason('')).toBeNull();
    expect(parsePlacementReason(null)).toBeNull();
    expect(parsePlacementReason(undefined)).toBeNull();
    expect(parsePlacementReason('3 of 4 instances healthy, 1 UNREACHABLE')).toBeNull();
  });
});

describe('placement reason display', () => {
  it('localizes CPU shortage in English and Chinese, with the kernel numbers', () => {
    const reason = statusReason('CPU_INSUFFICIENT', 'staging-node', DETAILS.CPU_INSUFFICIENT);

    const english = describePlacementReason(reason, en);
    expect(english?.title).toContain('1000m');
    expect(english?.title).toContain('900m');
    expect(english?.title).toContain('staging-node');
    expect(english?.title).not.toContain('placement.reason.');
    expect(english?.raw).toBe(reason);

    const chinese = describePlacementReason(reason, zh);
    expect(chinese?.title).toContain('1000m');
    expect(chinese?.title).toContain('900m');
    expect(chinese?.title).toContain('staging-node');
    expect(chinese?.title).not.toContain('placement.reason.');
    expect(chinese?.raw).toBe(reason);
  });

  it('localizes the scope token instead of leaking the kernel word', () => {
    const reason = statusReason('INSTANCE_CAPACITY_EXCEEDED', 'n1', DETAILS.INSTANCE_CAPACITY_EXCEEDED);
    expect(describePlacementReason(reason, en)?.title).toContain('per-node');
    expect(describePlacementReason(reason, zh)?.title).toContain('按节点');

    const unknownScope = statusReason('INSTANCE_CAPACITY_EXCEEDED', 'n1', '1 instances already scheduled on this node against a per-cluster limit of 1');
    const parsed = parsePlacementReason(unknownScope);
    expect(parsed?.titleKey).toBe('placement.reason.instanceCapacityExceeded');
    expect(describePlacementReason(unknownScope, zh)?.title).toContain('per-cluster');
  });

  it('renders every code as a localized title that differs from the server sentence', () => {
    for (const code of PLACEMENT_REASON_CODES) {
      const reason = statusReason(code, 'staging-node', DETAILS[code]);
      for (const t of [en, zh]) {
        const display = describePlacementReason(reason, t);
        expect(display?.title, code).not.toBe(reason);
        expect(display?.title, code).not.toContain('placement.reason.');
        expect(display?.raw, code).toBe(reason);
      }
    }
  });

  it('shows an unrecognized status reason verbatim instead of dropping it', () => {
    const reason = `${PREFIX} [DISK_INSUFFICIENT] node n1: requested 1 GiB but only 100 MiB are free`;
    const display = describePlacementReason(reason, zh);
    expect(display?.title).toBe(reason);
    expect(display?.raw).toBeNull();

    const degraded = '3 of 4 instances healthy, 1 DEGRADED';
    expect(describePlacementReason(degraded, en)?.title).toBe(degraded);
    expect(describePlacementReason(degraded, en)?.raw).toBeNull();
  });

  it('has nothing to render when the deployment has no reason', () => {
    expect(describePlacementReason(null, en)).toBeNull();
    expect(describePlacementReason(undefined, en)).toBeNull();
    expect(describePlacementReason('   ', en)).toBeNull();
  });

  it('routes every published key through a catalog entry in both locales', () => {
    for (const code of PLACEMENT_REASON_CODES) {
      const detailed = parsePlacementReason(statusReason(code, 'n1', DETAILS[code]));
      const generic = parsePlacementReason(statusReason(code, 'n1', 'the kernel reworded this in a later release'));
      for (const key of [detailed?.titleKey, generic?.titleKey]) {
        if (!key) continue;
        expect(translate('en', key), key).not.toBe(key);
        expect(translate('zh-CN', key), key).not.toBe(key);
      }
    }
    expect(translate('en', 'placement.reason.raw')).toBe('Raw kernel reason');
    expect(translate('zh-CN', 'placement.reason.raw')).toBe('内核原始原因');
    expect(translate('en', 'placement.reason.scope.perNode')).toBe('per-node');
    expect(translate('zh-CN', 'placement.reason.scope.perNode')).toBe('按节点');
  });
});
