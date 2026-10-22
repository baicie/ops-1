# ADR-011: Node lease quarantine and data-endpoint policy

- Status: Accepted for 0.0.1 remediation
- Date: 2026-10-22
- Owner: Platform / Node Runtime

## Context

A revocable Node credential alone does not stop code already running on a Node. A Node that loses the Kernel can also keep executing the last Desired State indefinitely, and the Kernel previously trusted a Node-reported `dataEndpoint` without validating its scheme, host scope or path. That creates stale-workload and SSRF risk.

## Decision

1. The Node Runtime keeps a control lease (`OPSWEAVE_NODE_LEASE_SECONDS`, default 30). A successful heartbeat renews it. A `400/401/403/409` heartbeat response, a transport failure beyond the lease, or an independent monotonic-clock watchdog deadline puts the Node into **quarantine**. The watchdog runs even if the heartbeat HTTP request is stuck.
2. Quarantine drains supervisor tasks, stops and removes every managed container for that Node, re-enumerates labels to verify none remain, and refuses to start new tasks. Node setup and quarantine serialize through a lifecycle mutex, so an in-flight inspect/pull/create/start must leave before the final sweep. All Docker operations used by this path are timeout-bounded. Docker operations have bounded timeouts and failures set `QUARANTINE_CLEANUP_FAILED` instead of being reported as success. Recovery requires a deliberate Node restart/re-enrollment; stale desired state is never silently resumed.
3. Node control credentials remain hashed and revocable. On revoke the Kernel also rotates the data token and removes the Node from Gateway/SSE/asset selection.
4. The Kernel accepts a Node data endpoint only if it is an origin URL (no userinfo, query, fragment or path), on an allowlisted host (`OPSWEAVE_ALLOWED_NODE_DATA_HOSTS`), and uses HTTPS for non-loopback hosts. Plaintext HTTP is limited to loopback development (`OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT=false` by default; `scripts/demo_up.sh` explicitly enables loopback development). The same validation is repeated in the Gateway and SSE log path before each upstream request.
5. The reference Node data listener remains loopback-only in the local profile. Production must place an authenticated TLS/mTLS terminator or tunnel in front of it. Kernel↔Node mTLS and certificate rotation remain `NOT_RUN` and a production release blocker.

## Consequences

- A revoked or partitioned Node stops side-effecting workloads instead of continuing on stale state.
- A malicious heartbeat cannot make the Kernel probe an arbitrary internal URL with a bearer token.
- A Node process kill (`SIGKILL`) cannot execute local cleanup; host-level cleanup and true mTLS remain release gates.
- Lease expiry is fail-closed; operators see the Node as UNREACHABLE and must restart/re-enroll it after connectivity is restored.
