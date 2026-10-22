# ADR-011: Node lease quarantine and data-endpoint policy

- Status: Accepted for 0.0.1 remediation
- Date: 2026-10-22
- Owner: Platform / Node Runtime

## Context

A revocable Node credential alone does not stop code already running on a Node. A Node that loses the Kernel can also keep executing the last Desired State indefinitely, and the Kernel previously trusted a Node-reported `dataEndpoint` without validating its scheme, host scope or path. That creates stale-workload and SSRF risk.

## Decision

1. The Node Runtime keeps a control lease (`OPSWEAVE_NODE_LEASE_SECONDS`, default 30). A successful heartbeat renews it. A `400/401/403/409` heartbeat response, or a transport failure beyond the lease, puts the Node into **quarantine**.
2. Quarantine drains supervisor tasks, stops and removes every managed container for that Node, and refuses to start new tasks. Recovery requires a deliberate Node restart/re-enrollment; stale desired state is never silently resumed.
3. Node control credentials remain hashed and revocable. On revoke the Kernel also rotates the data token and removes the Node from Gateway/SSE/asset selection.
4. The Kernel accepts a Node data endpoint only if it is an origin URL (no userinfo, query, fragment or path), on an allowlisted host (`OPSWEAVE_ALLOWED_NODE_DATA_HOSTS`), and uses HTTPS for non-loopback hosts. Plaintext HTTP is limited to loopback development (`OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT=false` by default). The same validation is repeated in the Gateway before each upstream request.
5. The reference Node data listener remains loopback-only in the local profile. Production must place an authenticated TLS/mTLS terminator or tunnel in front of it. Kernel↔Node mTLS and certificate rotation remain `NOT_RUN` and a production release blocker.

## Consequences

- A revoked or partitioned Node stops side-effecting workloads instead of continuing on stale state.
- A malicious heartbeat cannot make the Kernel probe an arbitrary internal URL with a bearer token.
- A Node process kill (`SIGKILL`) cannot execute local cleanup; host-level cleanup and true mTLS remain release gates.
- Lease expiry is fail-closed; operators see the Node as UNREACHABLE and must restart/re-enroll it after connectivity is restored.
