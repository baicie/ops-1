import type { MessageKey } from '@opsweave/platform-client/i18n';

/**
 * The audit vocabulary the Overview ledger can read as sentences.
 *
 * The Kernel writes two naming shapes into `kernel.audit_events`: dot-path names for platform
 * events (`pipeline.created`, `node.enrollment_token.created`) and UPPER_SNAKE names for incident
 * events (`INCIDENT_CREATED`, `INCIDENT_EVIDENCE_ADDED`, ...; apps/kernel/src/incidents.rs:960,
 * :1281, :1452, :1594, :1751). Both are protocol data, and a code this table does not know must
 * stay verbatim - inventing a sentence for an unknown event would be worse than showing the code.
 *
 * This table is the only place the mapping lives so the page does not grow a second copy, and so
 * a unit test can check the known codes against both catalogs.
 */
export const EVENT_LABELS: Record<string, MessageKey> = {
  'pipeline.created': 'event.pipeline.created',
  'pipeline.draft_created': 'event.pipeline.draftCreated',
  'pipeline.draft_updated': 'event.pipeline.draftUpdated',
  'pipeline.draft_published': 'event.pipeline.draftPublished',
  'pipeline.revision_published': 'event.pipeline.revisionPublished',
  'pipeline.job_completed': 'event.pipeline.jobCompleted',
  'pipeline.job_failed': 'event.pipeline.jobFailed',
  'pipeline.job_terminalized': 'event.pipeline.jobTerminalized',
  'plugin.activated': 'event.plugin.activated',
  'plugin.staged': 'event.plugin.staged',
  'plugin.disabled': 'event.plugin.disabled',
  'plugin.uninstalled': 'event.plugin.uninstalled',
  'plugin.rejected': 'event.plugin.rejected',
  'deployment.created': 'event.deployment.created',
  'node.enrolled': 'event.node.enrolled',
  'node.revoked': 'event.node.revoked',
  'node.enrollment_token.created': 'event.node.enrollmentTokenCreated',
  'publisher.added': 'event.publisher.added',
  'publisher.revoked': 'event.publisher.revoked',
  'user.created': 'event.user.created',
  'user.updated': 'event.user.updated',
  'capability.granted': 'event.capability.granted',
  'capability.revoked': 'event.capability.revoked',
  'capability.service_invoke': 'event.capability.serviceInvoke',
  // Incident lifecycle events use the Kernel's UPPER_SNAKE vocabulary, not a dot path.
  'INCIDENT_CLOSED': 'event.incident.closed',
  'INCIDENT_CREATED': 'event.incident.created',
  'INCIDENT_EVIDENCE_ADDED': 'event.incident.evidenceAdded',
  'INCIDENT_OWNER_DISABLED': 'event.incident.ownerDisabled',
  'INCIDENT_OWNER_NOT_IN_WORKSPACE': 'event.incident.ownerNotInWorkspace',
  'INCIDENT_OWNER_ROLE_INELIGIBLE': 'event.incident.ownerRoleIneligible',
  'INCIDENT_OWNER_TRANSFERRED': 'event.incident.ownerTransferred',
  'INCIDENT_OWNER_UNCHANGED': 'event.incident.ownerUnchanged',
  'INCIDENT_OWNER_UNKNOWN': 'event.incident.ownerUnknown',
  'INCIDENT_VERDICT_RECORDED': 'event.incident.verdictRecorded',
};

/** The catalog key for an audit event, or `undefined` when the code must stay verbatim. */
export function eventLabelKey(eventType: string): MessageKey | undefined {
  return EVENT_LABELS[eventType];
}
