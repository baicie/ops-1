/**
 * G13-B1.4: the workspace claim queue, as data and decisions the page can be tested on.
 *
 * An automation incident is owned by the non-login automation service user, which the
 * operator row rule (`owner = caller`) can never match. The kernel therefore exposes one
 * bounded second read - membership in the incident's workspace AND origin AUTOMATION AND
 * the service owner AND a live status - and one atomic claim. This module holds the wire
 * shapes and the pure decisions; the page only renders them.
 *
 * Nothing here decides authorization. A missing or refused role produces the same
 * sentence the kernel's 403 produces; the claim itself is still the handler's decision.
 */
import type { MessageKey } from '@opsweave/platform-client/i18n';

/** One row of `GET /api/v1/incidents/claimable` - the minimal summary. */
export interface ClaimableIncident {
  id: string;
  title: string;
  severity: string;
  status: string;
  nativeId: string | null;
  workspaceId: string;
  startedAt: string;
  updatedAt: string;
  revision: number;
}

export interface ClaimableIncidentList {
  items: ClaimableIncident[];
}

/** What a claim answers with: the incident as the caller may now read it. */
export interface ClaimedIncident {
  id: string;
  owner: string;
  revision: number;
}

/** What a release answers with - deliberately not the incident, whose read access ended. */
export interface ReleasedIncident {
  incidentId: string;
  revision: number;
  releasedAt: string;
}

export type ClaimQueueState = 'loading' | 'forbidden' | 'failed' | 'empty' | 'ready';

/**
 * The queue's state, kept apart for the same reason the incident list's is: a failed
 * read must not be drawn as an answered zero, and a 403 is a permission wall rather than
 * a failure to retry. `items` is null until a read answers; `loading` outranks `failed`
 * only while a read is in flight, because a retry is a new question.
 */
export function claimQueueState(input: {
  items: ClaimableIncident[] | null;
  error: unknown;
  loading: boolean;
  status: number | null;
}): ClaimQueueState {
  if (input.loading) return 'loading';
  if (input.error) return input.status === 403 ? 'forbidden' : 'failed';
  if (input.items === null) return 'loading';
  return input.items.length === 0 ? 'empty' : 'ready';
}

/**
 * The stable error code decides the sentence; the kernel's English message is never
 * rendered (rules/06). A code with no copy is reported as the code plus a generic
 * sentence, which is true and translatable, instead of a server sentence in one language.
 */
export function claimFailureKey(code: string | null): MessageKey | null {
  switch (code) {
    case 'INCIDENT_CLAIM_TAKEN':
    case 'INCIDENT_CLAIM_CONFLICT':
      return 'incidents.claim.conflict';
    case 'INCIDENT_CLAIM_NOT_AVAILABLE':
    case 'INCIDENT_RELEASE_NOT_AVAILABLE':
    case 'INCIDENT_RELEASE_NOT_AUTOMATION':
      return 'incidents.claim.unavailable';
    case 'FORBIDDEN':
      return 'incidents.claim.error.forbidden';
    case 'INCIDENT_NOT_FOUND':
      return 'incidents.claim.error.notFound';
    default:
      return null;
  }
}

/** Whether a failed claim needs the queue re-read before the operator tries again. */
export function claimFailureNeedsRefresh(code: string | null): boolean {
  return (
    code === 'INCIDENT_CLAIM_TAKEN' ||
    code === 'INCIDENT_CLAIM_CONFLICT' ||
    code === 'INCIDENT_CLAIM_NOT_AVAILABLE'
  );
}

/**
 * What the detail page may offer, from the payload the kernel sent.
 *
 * `claimable` is the kernel's own derived field (origin AUTOMATION + service owner +
 * live status), so the button cannot appear for a row the claim route would refuse.
 * Release is offered only to the account that currently owns an automation incident;
 * a non-owner does not even read this page for an operator, and an admin does not own it.
 */
export function claimActions(input: {
  claimable: boolean;
  origin: string | null;
  owner: string;
  userId: string | null;
  role: string | null;
  status: string;
}): { canClaim: boolean; canRelease: boolean } {
  const canOperate = input.role === 'operator' || input.role === 'admin';
  const live = input.status === 'OPEN' || input.status === 'INVESTIGATING';
  return {
    canClaim: canOperate && input.claimable && live,
    canRelease:
      canOperate &&
      live &&
      input.origin === 'AUTOMATION' &&
      Boolean(input.userId) &&
      input.owner === input.userId,
  };
}

export function claimPayload(expectedRevision: number): { expectedRevision: number } {
  return { expectedRevision };
}
