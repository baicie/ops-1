import { describe, expect, it } from 'vitest';
import { auditEmptyKind, readAuditList, type AuditScope } from './audit-scope';

/** The scope the kernel sends a caller who may not read plugin, node or deployment events. */
const OPERATOR: AuditScope = {
  seesAll: false,
  readableSubjectTypes: ['INCIDENT', 'job'],
  requested: { subjectType: 'plugin', mayRead: false },
};

/** The same caller, asking about a kind the ledger does scope: empty is then not a refusal. */
const OPERATOR_ASKING_FOR_INCIDENTS: AuditScope = {
  seesAll: false,
  readableSubjectTypes: ['INCIDENT', 'job'],
  requested: { subjectType: 'INCIDENT', mayRead: true },
};

const ADMIN: AuditScope = { seesAll: true, readableSubjectTypes: [], requested: null };

describe('reading one ledger response', () => {
  it('keeps the rows and the scope the kernel sent', () => {
    const list = readAuditList({ events: [{ id: 'e1' }], scope: OPERATOR });
    expect(list.events).toHaveLength(1);
    expect(list.scope).toBe(OPERATOR);
  });

  it('still reads a bare array, and then holds no scope at all', () => {
    // The shape the endpoint answered before the scope travelled with it, and the shape the
    // UI fixtures still fulfil. Reading it is not the same as believing it says who may read.
    const list = readAuditList([{ id: 'e1' }]);
    expect(list.events).toHaveLength(1);
    expect(list.scope).toBeNull();
  });

  it('treats a body it cannot read as an empty list with no scope', () => {
    expect(readAuditList(null)).toEqual({ events: [], scope: null });
    expect(readAuditList({})).toEqual({ events: [], scope: null });
  });
});

describe('the three reasons an empty list is empty', () => {
  it('says restricted when the kernel will not answer this kind for this caller', () => {
    expect(auditEmptyKind({ scope: OPERATOR, subjectType: 'plugin' })).toBe('restricted');
  });

  it('does not blame the filters for a kind that is refused, because clearing them cannot help', () => {
    expect(auditEmptyKind({ scope: OPERATOR, subjectType: 'plugin', narrowed: true })).toBe('restricted');
  });

  it('says filtered when the rows exist and the page hid them', () => {
    expect(auditEmptyKind({ scope: ADMIN, narrowed: true })).toBe('filtered');
  });

  it('says none when an unrestricted ledger simply has nothing in it', () => {
    expect(auditEmptyKind({ scope: ADMIN })).toBe('none');
  });

  it('does not call an owner-scoped kind restricted: emptiness there is about ownership', () => {
    expect(auditEmptyKind({ scope: OPERATOR_ASKING_FOR_INCIDENTS, subjectType: 'INCIDENT' })).toBe('none');
  });
});

describe('the page never claims a permission the kernel did not report', () => {
  it('falls back to "none" when the response carried no scope', () => {
    // An older kernel, or a fixture. Telling the reader "you cannot read this" here would be a
    // permission report invented by the browser.
    expect(auditEmptyKind({ scope: null, subjectType: 'plugin', narrowed: false })).toBe('none');
  });

  it('follows the kernel’s answer for the type that was asked about, not the whitelist', () => {
    // A caller that can read some events of a kind, but the kernel refused this request.
    const asked: AuditScope = { ...OPERATOR, readableSubjectTypes: ['plugin'], requested: { subjectType: 'plugin', mayRead: false } };
    expect(auditEmptyKind({ scope: asked, subjectType: 'plugin' })).toBe('restricted');
  });

  it('treats a kind the kernel did not list as unreadable, matching the kernel default deny', () => {
    const scope: AuditScope = { seesAll: false, readableSubjectTypes: ['INCIDENT', 'job'], requested: null };
    expect(auditEmptyKind({ scope, subjectType: 'publisher' })).toBe('restricted');
  });

  it('never restricts anything for a caller the kernel said reads everything', () => {
    const scope: AuditScope = { seesAll: true, readableSubjectTypes: [], requested: { subjectType: 'plugin', mayRead: true } };
    expect(auditEmptyKind({ scope, subjectType: 'plugin' })).toBe('none');
  });
});
