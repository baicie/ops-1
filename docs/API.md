# Implemented HTTP API (0.0.1)

All paths are same-origin. User routes accept the `opsweave_session` HttpOnly cookie (with `X-CSRF-Token` for mutations) or `Authorization: Bearer <session-token>` for `opsctl`. Error bodies are `{ code, message, requestId, retryable }`.

## Authentication

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/auth/login` | `{ email, password }` → user + CSRF token + session cookie |
| POST | `/api/v1/auth/logout` | deletes session |
| GET | `/api/v1/auth/me` | current user + CSRF token |

## Operator surface

| Method | Path | Notes |
|---|---|---|
| GET | `/livez`, `/readyz` | Kernel liveness/readiness |
| GET | `/api/v1/overview` | dashboard counts, attention, recent audit |
| GET | `/api/v1/health` | alias of overview |
| GET | `/api/v1/plugins` | summary list including Ops Center system plugin |
| POST | `/api/v1/plugins/packages` | raw signed ZIP; `Idempotency-Key` required |
| GET | `/api/v1/plugins/{id}` | manifest, versions, deployments, capabilities, permissions |
| GET | `/api/v1/plugins/{id}/packages` | version list |
| POST | `/api/v1/plugins/{id}/deployments` | desired replicas/placement |
| GET | `/api/v1/plugins/{id}/deployments` | deployment + instance observations |
| POST | `/api/v1/plugins/{id}/activations` | `{ version, expectedRevision }` |
| POST | `/api/v1/plugins/{id}/disable` | revokes effective routes |
| POST | `/api/v1/plugins/{id}/enable` | requests redeploy, does not activate |
| POST | `/api/v1/plugins/{id}/rollback` | `{ targetVersion, expectedRevision }` |
| POST | `/api/v1/plugins/{id}/uninstall` | retains data |
| GET | `/api/v1/nodes` | node summaries with stale flag |
| GET | `/api/v1/nodes/{id}` | node detail |
| GET | `/api/v1/nodes/{id}/instances` | instances placed on node |
| POST | `/api/v1/nodes/enrollment-tokens` | admin; one-time token |
| DELETE | `/api/v1/nodes/{id}` | admin; revoke credential |
| GET | `/api/v1/instances/{id}` | instance detail |
| GET | `/api/v1/instances/{id}/logs/live` | operator SSE; `cursor` query |
| GET | `/api/v1/audit` | filter `subjectType`, `subjectId`, `limit` |
| GET | `/api/v1/diagnostics` | admin bootstrap diagnostics |
| GET | `/bootstrap` | server-rendered recovery page (operator+) |
| GET | `/api/v1/capabilities` | active capability registrations |
| GET | `/api/v1/extensions` | active signed frontend contributions |
| ANY | `/api/v1/gateway/{pluginId}/{path}` | authorized gateway; path must be under manifest `apiPrefix` |
| GET | `/api/v1/users` | admin |
| POST | `/api/v1/users` | admin |
| PATCH | `/api/v1/users/{id}` | admin |
| GET | `/api/v1/publishers` | trusted publisher list |
| POST | `/api/v1/publishers` | admin; add/rotate trust |
| DELETE | `/api/v1/publishers/{id}` | admin; revoke |

## Node internal API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/node-enrollment/redeem` | one-time token → node id, control credential, data token |
| POST | `/internal/v1/nodes/{id}/heartbeat` | node bearer; heartbeat + observations → desired state |
| GET | `/internal/v1/instances/{id}/logs` | node data token; bounded log batch |
| ANY | `/internal/v1/proxy/{id}/{path}` | node data token; private plugin proxy |

## Static assets

`GET /assets/{publisher}/{pluginId}/{version}/frontend/...` serves immutable, content-addressed frontend files from the package store with `Cache-Control: immutable`.
