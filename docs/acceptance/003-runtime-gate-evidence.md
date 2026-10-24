# 0.0.3 Runtime Gate Evidence — Final

Branch: `feat/0.0.3-typed-pipeline`  
Base: `a434a79`  
Code HEAD: `dfa68ab`  
Report HEAD: this commit  
PR #2: [Draft/Open](https://github.com/baicie/ops-1/pull/2).

## CI runs

All on commit `dfa68ab`:

- Data Foundation OCI: [40089454025](https://github.com/baicie/ops-1/actions/runs/40089454025) — SUCCESS
- Standard CI: [40089454027](https://github.com/baicie/ops-1/actions/runs/40089454027) — SUCCESS
- Typed Pipeline Contracts: [40089454023](https://github.com/baicie/ops-1/actions/runs/40089454023) — SUCCESS
- Runtime workflow: [40089454026](https://github.com/baicie/ops-1/actions/runs/40089454026) — SUCCESS

0.0.1 legacy: `PASS=21 FAIL=0`. 0.0.2 Data Foundation: PASS.

## Gate matrix

| Gate | Status | Evidence |
|---|---|---|
| Live Catalog Schema | PASS | dynamic Dataset + live Schema pin |
| Dynamic Dataset E2E | PASS | `Dynamic Catalog Pipeline Golden Path: PASS` |
| Node-managed Worker | PASS | `Node-managed Worker Golden Path: PASS` |
| Atomic Claim-Next | PASS | 2/8/16/32 direct claims; single=1x200; multi=8 distinct |
| Heartbeat | PASS | 75s job + 15s Kernel pause; `Long Heartbeat Golden Path: PASS` |
| Job Deadline | PASS | expired claim and heartbeat rejection |
| Result Correctness | PASS | authoritative receipt/digest/accepted verification |
| Kernel Restart | PASS | `job=456f5e67... oldFence=1 newFence=2 recovery=62s` |
| Two-Node Takeover | PASS | `job=91924e3b... oldFence=1 newFence=2 takeover=65s` |
| Node Runtime SIGKILL | PASS | `job=cb55bb58... takeover=106s` (victim non-provider Node B; provider A survives) |
| Catalog Lock Proof | PASS | `holder=998 blocked=1 blockers=903 claim=409`; rollback equivalent |
| Authoritative Completion | PASS | Kernel queries Catalog receipts for every batch |
| Supervisor Lifecycle | PARTIAL | marker/stop paths implemented; no full quarantine/instance PID matrix |
| Source Security | PARTIAL | address matrix + redirect/chunked/malformed; DNS/slow/proxy matrix incomplete |
| Terminalization | PARTIAL | Claim Core uniform; Claim-Next reaper still bulk job-only terminalization |
| Runtime CI | PASS | dedicated workflow executes the above |
| Legacy Regression | PASS | CI run above |

## Invariants

- I1 one execution authority per Job: Claim CAS + active-lease uniqueness; concurrency
  tests observed one 200 per Job.
- I2 Fence monotonic: takeover runs show oldFence=1 → newFence=2.
- I3 Deadline: Claim/Heartbeat/Catalog SQL reject after deadline.
- I4 Effect idempotency: 1001 records / 3 effects after crashes and takeover.
- I5 SUCCEEDED authority: Kernel verifies every Catalog Receipt.
- I6 Result uniqueness: one Result row and idempotent replay.
- I7 Kernel restart: Job/Lease/Checkpoint/Snapshot/Receipt survive; Job completes.
- I8 Natural takeover: lease expires without DB expiry manipulation; second Node claims.
- I9 Revoked/stale identity: existing token revocation tests plus Worker cancellation.
- I10 Isolated harness: real Kernel/PostgreSQL/Node processes, cleanup hooks.

## Remaining work

P1: full Supervisor PID matrix, live SSRF redirect/DNS/slow/proxy matrix, uniform
Claim-Next reaper terminalization, dedicated 429/500/503 heartbeat injection.
P2: physical multi-host acceptance and production HA certification.

## Decision

```text
PARTIAL_NOT_READY
```

Core runtime recovery evidence is now real and green, but the remaining P1 gates above
must pass before `READY_FOR_REVIEW`. PR #2 stays Draft.
