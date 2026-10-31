export type Role = 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface AttentionItem {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  link: string;
}

export interface AuditEvent {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string;
  subjectType: string;
  subjectId: string;
  action: string;
  result: string;
  details: Record<string, unknown>;
  requestId?: string | null;
  occurredAt: string;
}

export interface Overview {
  health: string;
  nodesTotal: number;
  nodesReady: number;
  pluginsInstalled: number;
  pluginsAvailable: number;
  instancesReady: number;
  instancesTotal: number;
  activeDeployments: number;
  attention: AttentionItem[];
  recentEvents: AuditEvent[];
}

export interface PluginSummary {
  id: string;
  name: string;
  publisher?: string | null;
  latestVersion?: string | null;
  activeVersion?: string | null;
  state: string;
  signatureState?: string | null;
  hasFrontend: boolean;
  hasBackend: boolean;
  imageRef?: string | null;
  desiredReplicas: number;
  readyInstances: number;
  totalInstances: number;
  updatedAt?: string | null;
  isSystem: boolean;
}

export interface Capability {
  pluginId: string;
  version: string;
  name: string;
  major: number;
  direction: 'PROVIDES' | 'REQUIRES';
  activationRevision?: number | null;
}

export interface PackageVersion {
  version: string;
  status: string;
  signatureState: string;
  bundleDigest: string;
  artifactDigest: string;
  imageRef?: string | null;
  createdAt: string;
}

export interface InstanceView {
  id: string;
  deploymentId: string;
  nodeId: string;
  nodeName?: string | null;
  slot: number;
  generation: number;
  desiredAction: string;
  state: string;
  observedAt?: string | null;
  containerId?: string | null;
  imageDigest?: string | null;
  hostPort?: number | null;
  restartCount: number;
  lastError?: string | null;
  runtimeAdapterVersion?: string | null;
  nodeStatus?: string | null;
  nodeLastSeenAt?: string | null;
}

export interface DeploymentView {
  id: string;
  pluginId: string;
  version: string;
  desiredReplicas: number;
  generation: number;
  status: string;
  statusReason?: string | null;
  placement: Record<string, unknown>;
  resources: { cpuMillis: number; memoryMiB: number };
  readyInstances: number;
  totalInstances: number;
  createdAt: string;
  updatedAt: string;
  activatedAt?: string | null;
  drainUntil?: string | null;
  instances: InstanceView[];
}

export interface PluginDetail {
  id: string;
  name: string;
  publisher?: string | null;
  state: string;
  activeVersion?: string | null;
  activeRevision?: {
    id: string;
    version: string;
    generation: number;
    status: string;
    activatedAt?: string | null;
  } | null;
  manifest?: any;
  permissions: string[];
  provides: Capability[];
  requires: Capability[];
  resources?: { cpuMillis: number; memoryMiB: number } | null;
  packageVersions: PackageVersion[];
  deployments: DeploymentView[];
  isSystem: boolean;
}

export interface PackageResult {
  packageId: string;
  pluginId: string;
  version: string;
  publisher: string;
  status: string;
  signatureState: string;
  artifactDigest: string;
  bundleDigest: string;
  payloadDigest: string;
  imageRef?: string | null;
  frontendIndex?: unknown;
  manifest: any;
  rejectionReason?: string | null;
  createdAt: string;
}

export interface NodeView {
  id: string;
  name: string;
  generation: number;
  os: string;
  arch: string;
  labels: Record<string, string>;
  capabilities: string[];
  status: string;
  lastSeenAt?: string | null;
  dataEndpoint?: string | null;
  runtimeAdapterVersion?: string | null;
  resourceSnapshot?: {
    sampledAt: string;
    cpuUtilization?: number | null;
    memoryUsedBytes?: number | null;
    memoryTotalBytes?: number | null;
    filesystemUsedBytes?: number | null;
    filesystemTotalBytes?: number | null;
  } | null;
  enrolledAt: string;
  revokedAt?: string | null;
  stale: boolean;
  instancesReady: number;
  instancesTotal: number;
}

export interface Publisher {
  publisherId: string;
  fingerprint: string;
  trustState: string;
  note?: string | null;
  createdAt: string;
  revokedAt?: string | null;
}

/** One contribution the server refused to honor; it is never mounted, only reported. */
export interface ContributionRejection {
  /** Stable code (MISSING_SURFACE, NAMESPACE_ESCAPE, UNEXPECTED_FIELD, ...). */
  code: string;
  pluginId: string;
  contributionId: string;
  kind: string;
  detail: string;
}

export interface ExtensionContribution {
  kind: string;
  id: string;
  path: string;
  /** Stamped by the server on every shipped contribution; a v1 item reads 'admin'. */
  surface?: 'admin' | 'workspace';
  titleKey?: string;
  requiredCapabilities?: string[];
}

export interface Extension {
  pluginId: string;
  publisher: string;
  version: string;
  activationRevision: number;
  assetBase: string;
  remoteEntry: string;
  contributions: ExtensionContribution[];
  /** Contract violations only - an unauthorized contribution is withheld, not rejected. */
  rejections?: ContributionRejection[];
}

export interface Diagnostics {
  kernel: {
    version: string;
    apiMajor: number;
    runtimeProtocol: string;
    uptimeSeconds: number;
    database: string;
    dataDir: string;
    webDist: string;
  };
  counts: {
    packages: number;
    installedPlugins: number;
    deployments: number;
    readyInstances: number;
    auditEvents: number;
  };
  nodes: Array<{ id: string; name: string; status: string; lastSeenAt?: string | null }>;
  recentEvents: AuditEvent[];
  policies: Record<string, number>;
  bootstrap: { availableWithoutPlugins: boolean; recoveryCli: string; note: string };
}

export interface LogEvent {
  eventId: string;
  streamId: string;
  streamEpoch: number;
  sequence: number;
  occurredAt?: string | null;
  observedAt: string;
  nodeId: string;
  instanceId: string;
  channel: string;
  level: string;
  message: string;
  truncated: boolean;
}

export interface InstanceDetail {
  id: string;
  deploymentId: string;
  nodeId: string;
  nodeName: string;
  nodeStatus: string;
  nodeLastSeenAt?: string | null;
  slot: number;
  state: string;
  observedAt?: string | null;
  containerId?: string | null;
  imageDigest?: string | null;
  restartCount: number;
  lastError?: string | null;
  pluginId: string;
  version: string;
  deploymentStatus: string;
  streamId: string;
}

export interface PipelineSummary {
  pipelineId: string;
  name: string;
  latestRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineList {
  items: PipelineSummary[];
  nextCursor?: string | null;
}

export interface PipelinePort {
  name: string;
  dataType: string;
  required?: boolean;
  nullable?: boolean;
  schemaRevision?: number;
  description?: string;
}

export interface PipelineNode {
  nodeId: string;
  type: string;
  typeVersion: number;
  inputs: PipelinePort[];
  outputs: PipelinePort[];
  config: Record<string, unknown>;
}

export interface PipelineEdge {
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
  dataType: string;
}

export interface PipelineDefinition {
  schemaVersion: string;
  pipelineId: string;
  name: string;
  revision: number;
  status: 'DRAFT' | 'PUBLISHED';
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  createdAt: string;
  digest: string;
}

export interface PipelineRevision {
  pipelineId: string;
  revision: number;
  digest: string;
  status: string;
  publishedAt: string;
  definition: PipelineDefinition;
  plan: Record<string, unknown>;
}

export interface PipelineDetail {
  pipelineId: string;
  name: string;
  latestRevision: number;
  createdAt: string;
  updatedAt: string;
  latest?: PipelineRevision | null;
  revisions: Array<{ revision: number; digest: string; status: string; publishedAt: string }>;
}

export interface PipelineDraft {
  draftId: string;
  pipelineId: string;
  baseRevision: number;
  definition: PipelineDefinition;
  definitionDigest: string;
  version: number;
  status: string;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  port?: string;
}

export interface PipelineValidation {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  canonicalOrder: string[];
  planDigest?: string | null;
  digest?: string | null;
}

export interface JobView {
  jobId: string;
  pipelineId: string;
  pipelineRevision: number;
  status: string;
  currentFence: number;
  currentLeaseId?: string | null;
  attempts: number;
  maxAttempts: number;
  lastErrorCode?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobList {
  items: JobView[];
  nextCursor?: string | null;
}

export interface JobResultView {
  jobId: string;
  status: string;
  output: Record<string, unknown>;
  errorCode?: string | null;
  errorMessage?: string | null;
  resultDigest?: string | null;
  completedAt: string;
}

export interface PreviewIssue {
  code: string;
  message: string;
  nodeId?: string;
}

export interface PreviewNodeOutput {
  nodeId: string;
  nodeType: string;
  inputCount: number;
  outputCount: number;
  sampleRows: Array<Record<string, unknown>>;
  durationMs: number;
  errors: PreviewIssue[];
}

export interface PipelinePreview {
  previewId: string;
  status: string;
  nodeOutputs: PreviewNodeOutput[];
  errors: PreviewIssue[];
  processedRecords: number;
  elapsedMs: number;
  truncated: boolean;
}

export interface JobEventView {
  eventId: number;
  eventType: string;
  fromStatus?: string | null;
  toStatus?: string | null;
  fencingSequence?: number | null;
  details: Record<string, unknown>;
  occurredAt: string;
}

export interface JobAttemptView {
  attemptNumber: number;
  workerId: string;
  nodeId: string;
  instanceId: string;
  leaseId: string;
  fencingSequence: number;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  errorCode?: string | null;
}

export interface JobLeaseView {
  leaseId: string;
  attemptNumber: number;
  fencingSequence: number;
  status: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface JobCheckpointView {
  checkpointId: string;
  attemptNumber: number;
  sequence: number;
  fencingSequence: number;
  inputCursor?: string | null;
  stateDigest: string;
  createdAt: string;
}

export interface JobDiagnostics {
  jobId: string;
  events: JobEventView[];
  attempts: JobAttemptView[];
  leases: JobLeaseView[];
  checkpoints: JobCheckpointView[];
  result?: JobResultView | null;
  truncated: boolean;
}

/* ── G11 incident slice (contracts/openapi/incident-v1.yaml) ─────────────────────────── */

/**
 * One incident as the kernel derives it. `evidenceRefs` is capped at the newest 100 by the
 * shared projection, so it is a reference list and never a total: the evidence endpoint is the
 * complete set, and the UI must not print a count derived from this field as if it were all.
 */
export interface IncidentView {
  id: string;
  title: string;
  severity: string;
  status: string;
  source: string;
  nativeId: string | null;
  relatedEntity: string | null;
  startedAt: string;
  updatedAt: string;
  owner: string;
  /** When the current owner was assigned; equal to createdAt for a row never handed over. */
  ownerAssignedAt: string;
  /**
   * G12 C: the version the lifecycle writes arbitrate on. Every close and handover sends it as
   * `expectedRevision`, so a decision taken against a record that has since changed is refused
   * (409 INCIDENT_VERSION_CONFLICT) instead of overwriting what the caller never saw.
   */
  revision: number;
  /**
   * The closure of record. Non-null if and only if status is CLOSED - the database enforces it
   * (migration 0019), so a UI can decide whether to render a closure from these three fields.
   */
  closedAt: string | null;
  closedBy: string | null;
  closureNote: string | null;
  evidenceRefs: string[];
  humanVerdict: IncidentVerdict | null;
}

export interface IncidentVerdict {
  incidentId: string;
  verdict: string;
  rationale: string;
  decidedBy: string;
  decidedAt: string;
  /**
   * G12 A3: how many evidence rows the signing transaction actually read. This is the number the
   * verdict stands on. It is not, and must never be recomputed as, the number the incident holds
   * now - evidence is still accepted after CONCLUDED.
   */
  consideredEvidenceCount: number;
  /** sha256 (hex) over that set, or null when the kernel recorded no set. */
  consideredEvidenceDigest: string | null;
  /**
   * RECORDED means the set above is a record. PRE_MIGRATION_UNRECORDED means the verdict was
   * signed before the snapshot existed: the set was never stored, so it is unknown and the UI
   * must say so rather than reconstruct it from timestamps.
   */
  snapshotKind: 'RECORDED' | 'PRE_MIGRATION_UNRECORDED' | string;
}

/**
 * G12 A1: two fields, two questions.
 *
 * claimedTrust is what the submitter said about its own row. verifiedTrust is what the kernel
 * established, and it is the only field that may be rendered as provenance. They can disagree,
 * and when they do the disagreement is the interesting fact.
 */
export interface IncidentEvidence {
  id: string;
  incidentId: string;
  kind: string;
  source: string;
  collectedAt: string;
  /**
   * For a STORED row this is the kernel's own sha256:<hex> over the bytes it stored; for a
   * LEGACY_REFERENCE row it is whatever the submitter typed. The kernel never fetches it, so
   * neither may the UI - it is a string to display, never a link.
   */
  contentRef: string;
  /** G12 B: STORED when the kernel holds the bytes; LEGACY_REFERENCE when it holds only a locator. */
  contentStatus: string;
  /** text/plain or application/json; null for a legacy reference. */
  contentType: string | null;
  contentBytes: number | null;
  /** sha256 the kernel computed over the bytes it stored - never a value that came from a client. */
  contentSha256: string | null;
  /** When the kernel accepted the bytes (server clock); the fact half of the capture window. */
  contentCapturedAt: string | null;
  /** capturedAt + 365 days. After this the content endpoint answers 410. */
  contentRetentionExpiresAt: string | null;
  claimedTrust: string;
  verifiedTrust: string;
  /** NONE | OPERATOR_IDENTITY | SOURCE_ADAPTER. */
  verificationMethod: string;
  verifiedAt: string | null;
  /** The authenticated adapter that vouched, for SOURCE_ADAPTER rows. */
  verifierIdentity: string | null;
  submittedBy: string | null;
  verificationNote: string | null;
  createdAt: string;
  /** G12 A3: true when the row was appended after the verdict was signed. */
  afterVerdict: boolean;
}

export interface IncidentList {
  items: IncidentView[];
  nextCursor: string | null;
}

export interface IncidentEvidenceList {
  items: IncidentEvidence[];
}

/**
 * G12 C: one row of an incident's own audit trail (GET /incidents/{id}/timeline).
 *
 * The endpoint is scoped by the incident read predicate, so a trail exists exactly where its
 * record does. `details` is the write's own facts and its shape depends on `eventType` - it is
 * rendered field by field, never dumped.
 */
export interface IncidentTimelineEvent {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string;
  subjectType: string;
  subjectId: string;
  action: string;
  result: string;
  details: Record<string, unknown>;
  requestId: string | null;
  occurredAt: string;
}

export interface IncidentTimeline {
  items: IncidentTimelineEvent[];
  /** True when the incident holds more audit rows than this page: the OLDEST were dropped. */
  truncated: boolean;
}

/**
 * What a completed handover answers with. Deliberately not the incident: after a handover the
 * transferring operator may no longer read it, so this is the handover itself.
 */
export interface IncidentOwnerTransfer {
  incidentId: string;
  previousOwner: string;
  owner: string;
  ownerAssignedAt: string;
  reason: string;
  transferredBy: string;
  transferredAt: string;
  revision: number;
}
