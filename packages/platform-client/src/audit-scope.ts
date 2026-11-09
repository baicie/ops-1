import type { AuditEvent, AuditScope } from './contracts';
export type { AuditScope };


export interface AuditList {
  events: AuditEvent[];
  /** Null when the body carried no scope: an older kernel, or a fixture. Never assumed. */
  scope: AuditScope | null;
}

/**
 * Reads one ledger response.
 *
 * The endpoint answered a bare array until the scope travelled with it, and several UI fixtures
 * (tests/ui/*.spec.ts) still fulfil one. A body without a scope yields `scope: null`, and every
 * consumer then refuses to explain an empty list as a permission: an unknown scope is not an
 * empty scope.
 */
export function readAuditList(body: unknown): AuditList {
  if (Array.isArray(body)) return { events: body as AuditEvent[], scope: null };
  const record = (body ?? {}) as Partial<AuditList>;
  return {
    events: Array.isArray(record.events) ? record.events : [],
    scope: record.scope ?? null,
  };
}

/** Why a list of events is empty: three different facts a reader must never see mixed up. */
export type AuditEmptyKind =
  /** The kernel will never answer this question with rows for this caller. Not a filter. */
  | 'restricted'
  /** Rows came back, and this page's own filters hid every one of them. */
  | 'filtered'
  /** Nothing is there: the ledger is empty, or nothing in it belongs to this caller. */
  | 'none';

/** Whether some event of this subject type can reach this caller, per the kernel's answer. */
function canReadType(scope: AuditScope, subjectType: string): boolean {
  if (scope.seesAll) return true;
  const asked = scope.requested;
  if (asked && asked.subjectType === subjectType) return asked.mayRead;
  // Absent from the list the kernel sent means the kernel drops it: default deny, the same
  // default the predicate implements by omission.
  return scope.readableSubjectTypes.includes(subjectType);
}

/**
 * Which of the three an empty list is, from the kernel's scope and the page's own filters.
 *
 * The precedence is deliberate. A refused kind outranks a filter, because clearing the filters
 * cannot produce a row and blaming them would send the reader to a button that does nothing. A
 * missing scope ranks below both: the one claim this function may make without evidence is the
 * one that needs none.
 */
export function auditEmptyKind(input: {
  scope: AuditScope | null;
  subjectType?: string | null;
  narrowed?: boolean;
  /**
   * The read named no subject type, so it asked the ledger for every kind at once and the
   * kernel dropped every kind this caller cannot read. An empty answer then cannot be told
   * apart from a refused one, and the reader is owed the boundary rather than "nothing
   * happened". Ignored when a subject type is given: that read has one kind to judge.
   */
  spansSubjectTypes?: boolean;
}): AuditEmptyKind {
  const { scope, subjectType, narrowed = false, spansSubjectTypes = false } = input;
  if (!scope) return 'none';
  if (subjectType && !canReadType(scope, subjectType)) return 'restricted';
  // A boundary outranks a filter: clearing a filter cannot produce a row. Both outrank "none",
  // the one claim that needs no evidence - and the one an empty permission slice must not make.
  if (!subjectType && spansSubjectTypes && !scope.seesAll) return 'restricted';
  return narrowed ? 'filtered' : 'none';
}
