import type { JobView, NodeView, Publisher } from '../types';
import { ABSENT_STATE } from './verify-after-write';

/**
 * What each verb on the admin surface promises, expressed as a question about the resource that
 * a fresh GET returns - never about the write's own response body.
 *
 * These live next to `verify-after-write.ts` because they are the part of a verified write that
 * can be wrong on its own: a predicate that is true for the wrong resource turns a broken verb
 * into a green toast, and a `describe` that invents a value turns a NO_DATA into a lie. The
 * pages import both halves, the tests drive them through `verifyAfterWrite`.
 */

/** The user rows the read-back is checked against (`GET /api/v1/users`). */
export interface ManagedUserRow {
  id: string;
  email: string;
  role: string;
  /** The Kernel's column is `disabled`; the screen prints it as Active / Disabled. */
  disabled: boolean;
}

export const USER_ACTIVE = 'ACTIVE';
export const USER_DISABLED = 'DISABLED';
/** The page's effective-state word for a node whose `revokedAt` is set (see `nodeState`). */
export const NODE_REVOKED = 'REVOKED';

/** PATCH /users/{id} {disabled} landed: the row the list returns carries the requested flag. */
export function userStateLanded(users: ManagedUserRow[], id: string, disabled: boolean): boolean {
  const found = users.find((item) => item.id === id);
  return found ? found.disabled === disabled : false;
}

export function describeUserState(users: ManagedUserRow[], id: string): string {
  const found = users.find((item) => item.id === id);
  if (!found) return ABSENT_STATE;
  return found.disabled ? USER_DISABLED : USER_ACTIVE;
}

/** POST /users landed: the list now carries that address, with the role that was asked for. */
export function userCreatedLanded(users: ManagedUserRow[], email: string, role: string): boolean {
  const wanted = email.trim().toLowerCase();
  return users.some((item) => item.email.trim().toLowerCase() === wanted && item.role === role);
}

export function describeUserRole(users: ManagedUserRow[], email: string): string {
  const wanted = email.trim().toLowerCase();
  return users.find((item) => item.email.trim().toLowerCase() === wanted)?.role ?? ABSENT_STATE;
}

/** POST /jobs/{id}/cancel landed: the job route reports the terminal state the verb promises. */
export function jobCancelledLanded(job: JobView): boolean {
  return job.status === 'CANCELLED';
}

export function describeJobStatus(job: JobView): string {
  return job.status || ABSENT_STATE;
}

/**
 * DELETE /nodes/{id} landed: the node route reports the revocation. A node the Kernel has since
 * dropped answers 404 instead, and the spec passes `absentIsExpected` for exactly that case -
 * an absent node is a revoked node, and nothing else.
 */
export function nodeRevokedLanded(node: NodeView): boolean {
  return Boolean(node.revokedAt);
}

export function describeNodeState(node: NodeView): string {
  return node.revokedAt ? NODE_REVOKED : node.status;
}

/** POST /publishers landed: the publisher list trusts the key that was just sent. */
export function publisherTrustedLanded(publishers: Publisher[], publisherId: string): boolean {
  return publishers.some((item) => item.publisherId === publisherId && item.trustState === 'TRUSTED');
}

export function describePublisherTrust(publishers: Publisher[], publisherId: string): string {
  return publishers.find((item) => item.publisherId === publisherId)?.trustState ?? ABSENT_STATE;
}
