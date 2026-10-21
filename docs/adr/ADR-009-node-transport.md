# ADR-009 — Node control/data transport in 0.0.1

- **Status:** partially implemented; production blocker
- **Date:** 2026-10-22
- **Context:** The blueprint requires Node-initiated mTLS control sessions and a private mTLS Gateway→Node data route. The 0.0.1 local reference had to remain runnable on a single development host without a CA/rotation service.
- **Decision:** Implement authenticated Node-initiated heartbeat/desired-state pull with a one-time enrolled, revocable control credential (SHA-256 stored), plus a separate data token for the private proxy. Require TLS termination on a trusted private ingress in deployment; do not describe this as mTLS.
- **Consequences:** Identity binding, revocation, replay resistance and audit are present at the application layer. Certificate issuance, rotation, expiry enforcement and mutual authentication are **NOT_RUN** and must be implemented before production. C07 cannot be signed off on this implementation.
- **Alternatives rejected for 0.0.1:** embedding a CA in the Kernel without rotation/testing; pretending a bearer token is mTLS; exposing the Node data port to browsers.
