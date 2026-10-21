# Security Policy

This repository is an internal experimental platform. Do not deploy it to the public internet or expose the Docker socket, PostgreSQL, or Node data endpoints.

## Reporting

Report suspected vulnerabilities privately to the platform owner. Do not include live secrets, session tokens, or enrollment tokens in reports.

## Implemented controls

- Argon2id passwords, HttpOnly SameSite=Strict session cookies, CSRF checks for cookie-authenticated mutations.
- Role-separated admin/operator/viewer checks on every server route.
- One-time, short-lived node enrollment; hashed node control credentials; revocable identity; separate node data token.
- Signed plugin bundles (Ed25519) with canonical payload + manifest digest; ZIP traversal/symlink/compression-bomb limits.
- OCI images pinned by digest; no tag fallback; container read-only rootfs, cap-drop ALL, no-new-privileges, CPU/memory/PID limits, no host bind mounts or host network.
- Gateway strips browser-supplied `X-OpsWeave-*` identity headers; plugins never receive a user session token.
- Log cursors are HMAC-signed and stream-bound; SSE requires authorization.
- Audit events redact secrets; enrollment tokens are never logged.

## Known gaps (must close before production)

- Kernel↔Node mTLS and certificate rotation are not implemented; bearer credentials must only travel over a trusted private network/TLS.
- OCI image signature verification, SBOM/vulnerability enforcement and secret brokerage are not implemented.
- Multi-tenant isolation, OIDC/MFA, external CA/KMS, backup encryption and penetration testing are out of scope for 0.0.1.
- The Docker CLI adapter relies on a protected local socket; Node system service permissions must be reviewed per host.
