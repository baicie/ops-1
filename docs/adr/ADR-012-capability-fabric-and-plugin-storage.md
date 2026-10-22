# ADR-012: Capability Fabric and Plugin Storage Ownership (Accepted)

- **Status**: Accepted for 0.0.2 implementation
- **Date**: 2026-10-22
- **Baseline**: `v0.0.1-dev.1` / `4ce130b`
- **Related**: `docs/blueprint/02-kernel-plugin-contract.md`, `docs/blueprint/23-runtime-protocol-and-sdk.md`, `contracts/openapi/capability-v1.yaml`, `contracts/schema/plugin-storage.v1.schema.json`

## Context

0.0.1 registers `provides`/`requires` and routes **user** requests through
`/api/v1/gateway/{pluginId}`. It does not issue a workload identity, enforce a
Capability grant, or provide plugin-owned PostgreSQL schemas. `permissions` in
the manifest is metadata, not runtime authorization. 0.0.2 needs two independent
business plugins that call each other through a versioned capability without
accessing each other's tables.

## Decision

### 1. Capability calls use a dedicated Gateway path, not a new RPC framework

- Add a logical capability contract (`name`, `major`, API digest).
- Resolve a READY provider using the existing deployment/activation/Node
  health model.
- Expose synchronous calls through the existing Kernel HTTP Gateway and Node
  proxy, not provider IPs or ports.
- A caller presents a short-lived **workload bearer token** issued by Kernel.
  The token binds workload/plugin, capability, audience, scope, expiry, exact
  `instanceId`, `nodeId` and Node generation. Kernel verifies the token and
  current instance/node liveness before routing; provider still validates the
  signed caller context for defense in depth. Stopping an instance, revoking a
  node, changing the generation or becoming stale invalidates old tokens.
- User-session Gateway behavior remains unchanged. No user token is exposed to
  a remote extension. Plugin backends derive user scopes from the authenticated
  role only: `viewer` read-only, `operator`/`admin` write, unknown roles denied.

### 2. Grant/revoke is server-side and separate from Manifest metadata

- `kernel.capability_grants` records consumer, capability, major, provider
  binding, scope, state and optional expiry. A bound provider is enforced during
  invocation; a different selected provider returns `CAPABILITY_PROVIDER_MISMATCH`.
- Manifest `permissions` is an installation-time request only. Installation
  does not imply a grant.
- Required dependencies block activation when no compatible provider exists;
  disabling a provider with active required consumers is rejected.
- Every grant/revoke and denied call is audited.

### 3. Plugin storage is a Kernel-provisioned PostgreSQL schema

- Each plugin receives a schema named `plugin_<safe_id>` and a dedicated role
  with `USAGE`/`CREATE` on that schema only.
- The Kernel owns schema creation, role creation and the storage binding. The
  plugin receives a least-privilege connection URL through its workload
  environment; it never receives the Kernel's master credentials.
- Business plugins must not read/write `kernel.*` or another plugin's schema.
  The Kernel migration runner is the only component allowed to create/alter
  plugin schemas.
- Disable/uninstall defaults to `RETAIN`. Purge is a separate high-privilege
  operation requiring backup acknowledgement; it is not part of normal disable.

### 4. Migration plans are signed and checksum-gated

- A package may carry a storage declaration and an ordered migration plan with
  `EXPAND`, `MIGRATE`, `CONTRACT` phases and SHA-256 checksums.
- The Kernel records plan/checksum/status in `kernel.plugin_migrations`, takes
  a migration lock per plugin and refuses a changed checksum for an already
  applied migration.
- `EXPAND` must be backward-compatible; `CONTRACT` requires old instances to
  have drained. The Kernel does not claim arbitrary migrations are reversible.
- A failed migration is `FAILED` or `BLOCKED`; it is never converted into a
  successful rollback. Recovery is an explicit operator action with backup.
  The implementation runs each migration under `SET LOCAL ROLE` to the plugin
  role; `CONTRACT` is refused while the plugin still has desired instances.
- The migration SQL and its `APPLIED` ledger update are committed in one
  transaction. A per-plugin advisory transaction lock serializes concurrent
  attempts. Failure rolls back both DDL and the `PENDING` ledger row, then
  records `FAILED`. Transaction-control statements in migration SQL are rejected.
- The current request checksum gates SQL bytes; validating a signed package
  migration plan is still a known limitation.

### 5. Manifest compatibility

Manifest v1.1 is frozen. It has `additionalProperties: false` in both JSON
Schema and the Rust reader, so new fields must not be added to v1.1.

- 0.0.1 plugins remain on Manifest v1.1.
- 0.0.2 introduces a new manifest schema version for storage/capability
  declarations only when its reader and validator are implemented. A 0.0.2
  Kernel must continue to read v1.1 packages.
- Until the new reader exists, the storage declaration is carried in a signed
  sidecar file and is not silently interpreted as a v1.1 field.
- No existing package is rewritten or re-signed by this ADR.

### 6. Data contracts

- `data.catalog.v1` is the only Catalog capability for 0.0.2.
- `data.source.v1` is reserved as the Integration-facing source capability
  boundary; 0.0.2 implements only HTTP/JSON.
- Catalog owns Dataset/Schema semantics, not a one-to-one physical table model.
- Integration owns Source/Mapping/Run semantics and calls Catalog only through
  the capability.
- Schema revisions are immutable; compatibility is checked before publish.
- Writes use a stable `sourceBatchKey` and a durable receipt. A network timeout
  becomes `UNKNOWN`, not an automatic retry with a new key.

## Alternatives considered

1. **Direct plugin-to-plugin HTTP**: rejected; bypasses Gateway/RBAC and leaks
   provider addresses.
2. **Shared database/master credentials**: rejected; violates ownership and
   lets one plugin read another's private tables.
3. **New message bus / DAG / RPC framework**: rejected for 0.0.2; sync HTTP/JSON
   is sufficient for the Golden Path.
4. **Add fields to Manifest v1.1**: rejected; breaks the frozen v1.1 readers.
5. **Automatic migration rollback**: rejected; not generally safe.

## Consequences and risks

- Need a workload-token issuer/verifier and grant management in Kernel.
- Need Node workload environment injection and secret redaction.
- Need PostgreSQL role/schema provisioning; local development may use a
  development-only database credential, but production must use a secret
  manager/KMS and is **NOT_RUN**.
- Capability callers must be careful with timeout/UNKNOWN semantics; provider
  implementations must not retry side-effecting requests implicitly.
- Existing 0.0.1 APIs remain; 0.0.2 adds endpoints and tables. No historical
  tag or commit is rewritten.

## Validation gates

- Contract schemas/OpenAPI and negative tests pass.
- Capability grant/revoke + provider resolution unit/integration tests pass.
- Migration checksum/phase tests pass.
- Catalog and Integration Golden Path use real containers, real PostgreSQL and
  a real Kernel Gateway.
- Any unimplemented production security item remains `NOT_RUN`.
