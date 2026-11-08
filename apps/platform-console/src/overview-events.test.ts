import { describe, expect, it } from 'vitest';
import en from '@opsweave/platform-client/i18n/catalogs/en.json';
import zhCN from '@opsweave/platform-client/i18n/catalogs/zh-CN.json';
import { EVENT_LABELS, eventLabelKey } from './overview-events';

/**
 * The incident lifecycle writes its audit rows in the Kernel's UPPER_SNAKE vocabulary
 * (apps/kernel/src/incidents.rs:960, :1281, :1452, :1594, :1751), so the Overview ledger used to
 * print `INCIDENT_CREATED` in mono beside localized pipeline rows. This test pins the mapping to
 * both catalogs rather than to an English sentence: a key missing from zh-CN already fails
 * `tsc --noEmit` through the `Record<MessageKey, string>` guard, and a code that loses its
 * mapping must fall back to the raw token instead of inventing a label.
 */
const INCIDENT_CODES = [
  'INCIDENT_CLOSED',
  'INCIDENT_CREATED',
  'INCIDENT_EVIDENCE_ADDED',
  'INCIDENT_OWNER_DISABLED',
  'INCIDENT_OWNER_NOT_IN_WORKSPACE',
  'INCIDENT_OWNER_ROLE_INELIGIBLE',
  'INCIDENT_OWNER_TRANSFERRED',
  'INCIDENT_OWNER_UNCHANGED',
  'INCIDENT_OWNER_UNKNOWN',
  'INCIDENT_VERDICT_RECORDED',
] as const;

describe('overview event vocabulary', () => {
  it('maps every incident lifecycle audit event to a key present in both catalogs', () => {
    for (const code of INCIDENT_CODES) {
      const key = eventLabelKey(code);
      expect(key, `${code} must have a catalog key`).toBeTruthy();
      expect(en[key!], `en.${key}`).toBeTruthy();
      expect(zhCN[key!], `zh-CN.${key}`).toBeTruthy();
    }
  });

  it('leaves a code it does not know verbatim', () => {
    expect(eventLabelKey('INCIDENT_SOMETHING_NEW')).toBeUndefined();
    expect(EVENT_LABELS['INCIDENT_SOMETHING_NEW']).toBeUndefined();
  });
});
