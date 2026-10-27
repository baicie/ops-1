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

export interface Extension {
  pluginId: string;
  publisher: string;
  version: string;
  activationRevision: number;
  assetBase: string;
  remoteEntry: string;
  contributions: Array<{ kind: string; id: string; path: string }>;
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
