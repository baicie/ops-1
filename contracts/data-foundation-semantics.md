# 0.0.2 Data Foundation — Protocol Semantics

This document is normative for the contracts in `contracts/openapi/capability-v1.yaml`,
`data-catalog-v1.yaml`, `data-integration-v1.yaml` and the matching JSON Schemas.
It does not claim the endpoints are implemented yet.

## 1. Capability Fabric

### Identity

A capability is identified by `(name, major)`. A concrete provider is identified by
`(pluginId, version, activationRevision, apiDigest)`. Callers must never use a
provider's Node address or container port as the logical identity.

### Dependency and selection

- `required` dependencies must have a compatible READY provider at activation and
  must block disable of the last provider.
- `optional` dependencies may be absent; the consumer must expose a clear degraded
  state, not silently substitute a mock.
- Provider selection chooses a READY provider with a matching major and compatible
  API digest. If several exist, selection is deterministic (prefer the active
  default provider, then lexicographic plugin id, then activation revision).
- No compatible provider: `CAPABILITY_UNAVAILABLE` (HTTP 503); no fallback.

### Caller identity and authorization

- A workload token is issued by Kernel for one consumer plugin, capability, audience,
  scope and short expiry. It also binds the exact `instanceId`, `nodeId` and Node
  generation. Verification must reject a token after the instance stops, the node is
  revoked, the node generation changes, or the node becomes stale.
- `X-OpsWeave-*` request headers are never a trust root. The provider must validate
  the Kernel-signed context before using caller identity.
- A capability call without an active grant returns `CAPABILITY_FORBIDDEN` (403).
- An expired workload token may be refreshed only at the internal workload-token
  refresh endpoint, inside a bounded grace window, after re-checking the live
  instance/node/generation, active grant and scope. Refresh is not a new grant; a
  revoked Node or stopped instance must reject both refresh and old-token calls.
- If a grant names `providerPluginId`, invocation must select and call exactly that
  provider. A selection that resolves to another provider returns
  `CAPABILITY_PROVIDER_MISMATCH` (403); it must not silently use another provider.
- Backend plugin authorization uses the authenticated role's scope list. A user
  identity is never a wildcard: `viewer` is read-only, `operator`/`admin` may write,
  and unknown roles are denied. The plugin must not infer permissions from UI state.
- User-session Gateway routes remain separate; a remote Web Extension receives only
  the host API client and never a raw session token.

### Timeout, retries and idempotency

- The caller declares a deadline; the Gateway enforces a bounded timeout and does not
  retry a side-effecting call automatically.
- `GET`/read-only calls may be retried on another READY provider.
- Side-effecting calls require `Idempotency-Key`; the request digest is stored with
  the receipt. A duplicate key + same digest returns the original receipt; different
  digest returns `409 IDEMPOTENCY_CONFLICT`.
- A transport timeout is `UNKNOWN_OUTCOME`; the caller must query the original
  request/receipt rather than generate a new key.

### Audit

Every grant/revoke and every denied capability call is recorded in
`kernel.audit_events` with `requestId` and optional `traceId`. Provider selection and
the provider activation revision are included in the audit details.

## 2. Plugin Storage Ownership

- A plugin's private schema is `plugin_<safe_id>` and its role has privileges only on
  that schema. It has no `kernel.*` or other plugin schema privileges.
- The Kernel is the only component that creates roles/schemas and runs migration
  gates. A plugin cannot execute arbitrary SQL through the Kernel API.
- Migration records are `(pluginId, version, migrationId, checksum, phase, status)`.
  A migration with an already-applied id but a different checksum is rejected.
- Migration SQL and its `APPLIED` ledger update commit in one transaction, guarded by
  a per-plugin PostgreSQL advisory transaction lock. A failed SQL rolls back both the
  DDL and the `PENDING` row, then records `FAILED`; a committed SQL can never exist
  without an `APPLIED` ledger row. Transaction-control statements in submitted SQL
  are rejected.
- The current runner validates the SQL checksum supplied in the request. It does not
  yet validate a migration plan carried inside a signed package; that remains a
  known 0.0.2 limitation.
- `EXPAND` adds backward-compatible structures. `MIGRATE` backfills/transforms.
  `CONTRACT` may remove old structures only after old instances have drained and the
  rollback window is closed. Automatic rollback is not promised.
- Disable/uninstall defaults to retaining data. Purge requires separate high privilege
  and a backup acknowledgement.
- Storage credentials must never be returned by plugin detail, logs, audit, browser
  responses or errors. The local development setup is DEV_ONLY.

## 3. Data Catalog (`data.catalog.v1`)

### Schema revisions

- `schemaRevision` is a monotonically increasing positive integer per Dataset.
- A published revision is immutable. A draft may be updated/replaced before publish;
  a published revision cannot be edited or deleted.
- `digest` is SHA-256 over the canonical JSON form: fields sorted by `name`, keys
  sorted lexicographically, no insignificant whitespace. The exact canonicalization
  is part of the contract and must be tested cross-language.
- Field names must be unique; ordinals are unique and contiguous from zero.
- Supported types: `string`, `integer`, `number`, `boolean`, `timestamp`, `json`.

### Compatibility

Allowed without a version break:

- adding a nullable field;
- adding an optional field with a default compatible with existing rows;
- increasing a string max length (when represented);
- adding semantic tags or descriptions.

Rejected:

- removing a field from the current storage contract;
- changing a field type in an incompatible direction;
- making a nullable field required;
- changing an immutable revision digest.

A rejected publish returns `409 SCHEMA_INCOMPATIBLE` with a `SchemaDiff`; it does not
create a new revision.

### Dataset writes

- A write targets one published `schemaRevision`.
- `sourceBatchKey` is stable for one logical external batch. The same key + same
  request digest returns the original `DatasetWriteReceipt`; different content with
  the same key returns `409`.
- Records are bounded (max 1000 per request). Invalid records are rejected with
  per-record error codes; valid records may be accepted as `PARTIAL`.
- A storage timeout where commit outcome is unknown returns `UNKNOWN` and must be
  reconciled by receipt lookup; no automatic re-key.
- Catalog is a semantic registry with a bounded storage adapter, not a general
  warehouse. The first adapter stores only small batches.

## 4. Data Integration (`data.source.v1` / HTTP-JSON)

### Source and credentials

- `CredentialReference` contains only a reference, kind and masked hint. The secret
  itself is resolved by the Integration process from a secret store; it is never
  included in API responses, logs or audit.
- The first connector is `http-json`; no arbitrary scripting or custom headers from
  untrusted users.

### SSRF / network policy

Before connecting, Integration must:

1. allow only `http`/`https`;
2. resolve DNS and reject loopback, link-local, private, multicast, unspecified,
   metadata and IPv6 equivalents, including IPv4-mapped IPv6 in both dotted and
   hexadecimal forms (`::ffff:127.0.0.1`, `::ffff:7f00:1`, `::ffff:a9fe:a9fe`),
   IPv6 ULA (`fc00::/7`), link-local (`fe80::/10`), documentation and other
   non-global ranges;
3. use the resolved address for the request (prevent DNS rebinding);
4. disable redirects by default, or revalidate every redirect hop under the same
   policy and a small maximum;
5. bound request body, response body (8 MiB max), headers and total timeout;
6. never forward user-supplied `Host`, `Authorization` or internal headers.

Any policy failure is a typed `SOURCE_SSRF_BLOCKED`/`SOURCE_LIMIT_EXCEEDED` result and
no Dataset write is attempted.

### Preview vs ingestion

- Preview is read-only by contract and by implementation; it cannot call the Catalog
  sink.
- Preview returns at most 10 records and a bounded snapshot; it is not an ingestion
  dry-run that mutates data.
- Ingestion pipeline is exactly `Source → Parse → Map → Validate → Dataset Sink`.
- Connection test only proves the endpoint is reachable; it does not imply that field
  discovery or ingestion will succeed.

### Runs and UNKNOWN

- An `IngestionSpec` pins source revision, target schema revision, mappings and
  limits. Manual mode only in 0.0.2.
- A run has `QUEUED/RUNNING/SUCCEEDED/PARTIAL/FAILED/UNKNOWN` and counts
  input/accepted/rejected/unknown.
- If the external source read or Catalog write outcome cannot be determined, the run
  is `UNKNOWN`, with a stable `sourceBatchKey`. It must not be automatically retried
  with a new key.
- Quality results are computed over a bounded sample and state the denominator;
  `NO_DATA` is not a success.

## 5. Compatibility and error model

- All errors: `code`, `message`, `requestId`, `retryable`; optional redacted `details`.
- Stable capability errors: `CAPABILITY_UNAVAILABLE`, `CAPABILITY_FORBIDDEN`,
  `CAPABILITY_TIMEOUT`, `CAPABILITY_PROVIDER_MISMATCH`,
  `WORKLOAD_IDENTITY_REVOKED`, `DEPENDENCY_BLOCKED`, `IDEMPOTENCY_CONFLICT`,
  `UNKNOWN_OUTCOME`, `MIGRATION_TRANSACTION_CONTROL_FORBIDDEN`.
- Data errors: `SCHEMA_INCOMPATIBLE`, `SCHEMA_REVISION_IMMUTABLE`,
  `DATASET_NOT_FOUND`, `SOURCE_FAILED`, `SOURCE_SSRF_BLOCKED`,
  `SOURCE_LIMIT_EXCEEDED`, `RUN_ALREADY_ACTIVE`.
- No error leaks private host/stack/database credentials or raw secret values.

## 6. Negative test obligations

- Reject unknown/unsupported capability major; reject inactive grant.
- Reject provider disable when a required consumer is active.
- Reject migration checksum change and blocked CONTRACT during old instances.
- Reject unpublished schema revision writes.
- Reject incompatible schema publish with diff.
- Reject duplicate `sourceBatchKey` with changed content.
- Reject SSRF targets including DNS rebinding and redirects.
- Ensure preview performs zero Catalog writes.
- Ensure a Catalog unavailable/timeout result never falls back to direct database
  access or mock success.
