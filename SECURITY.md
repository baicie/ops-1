# Security Policy

This repository is an internal experimental platform. Do not deploy it to the public internet or expose the Docker socket, PostgreSQL, or Node data endpoints.

## Reporting

Report suspected vulnerabilities privately to the platform owner. Do not include live secrets, session tokens, or enrollment tokens in reports.

## Implemented controls

- Argon2id passwords, HttpOnly SameSite=Strict session cookies, CSRF checks for cookie-authenticated mutations.
- Role-separated admin/operator/viewer checks on every server route.
- One-time, short-lived node enrollment with atomic token consumption; hashed node control credentials; revocable identity; separate, rotated node data token.
- Node control lease plus fail-closed quarantine: a rejected credential or an unreachable Kernel beyond the lease stops managed workloads instead of leaving stale Desired State running.
- Node data endpoints are allowlisted by host; plaintext HTTP is accepted only for loopback development, never for a remote host.
- Failed logins are throttled; public login/enrollment bodies are capped at 64 KiB and the global API body at 2 MiB (package upload is the explicit 80 MiB exception).
- Signed plugin bundles (Ed25519) with canonical payload + manifest digest; ZIP traversal/symlink/compression-bomb limits.
- OCI images pinned by digest; no tag fallback; container read-only rootfs, cap-drop ALL, no-new-privileges, forced non-root UID 65532, CPU/memory/PID limits, no host bind mounts or host network.
- Gateway strips browser-supplied `X-OpsWeave-*` identity headers; plugins never receive a user session token. Path traversal and oversized upstream responses are rejected.
- Trusted-publisher model: Remote Extensions run same-origin in the Shell. Manifest permission strings are declaration/review metadata, not an OS sandbox or a user-scoped grant.
- Log cursors are HMAC-signed and stream-bound; SSE requires authorization.
- Audit events redact secrets; enrollment tokens are never logged.

## Known gaps (must close before production)

- Kernel↔Node mTLS and certificate rotation are not implemented; bearer credentials must only travel over a trusted private network/TLS. The reference Node data listener is HTTP, so it must not be exposed beyond loopback until an authenticated tunnel/mTLS terminator is placed in front of it.
- OCI image signature verification, SBOM/vulnerability enforcement and secret brokerage are not implemented.
- Multi-tenant isolation, OIDC/MFA, external CA/KMS, backup encryption and penetration testing are out of scope for 0.0.1.
- The Docker CLI adapter relies on a protected local socket; Node system service permissions must be reviewed per host.
