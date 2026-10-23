# 0.0.3 Typed Pipeline Foundation — Final Runtime Gate

Date: 2026-10-23 (Asia/Shanghai)  
Branch: `feat/0.0.3-typed-pipeline`  
Verified HEAD: `a964dbb`  
Base `main`: `a434a79`  
PR: [`#2`](https://github.com/baicie/ops-1/pull/2) — **Draft / Open / not merged**

## 1. Gate Matrix

| Gate | Status |
|---|---|
| Live Catalog Schema | **PASS** |
| Dynamic Dataset E2E | **PASS** |
| Node-managed Worker | **PASS** |
| Atomic Claim-Next | **PARTIAL** |
| Continuous Heartbeat | **PARTIAL** |
| Kernel Restart | **NOT_RUN** |
| Two-Node Automatic Takeover | **NOT_RUN** |
| Authoritative Effect Completion | **PASS** |
| Source Security | **PARTIAL** |
| Catalog Fencing Concurrency | **PARTIAL** |
| Legacy Regression | **PASS** |

**Conclusion: `PARTIAL_NOT_READY`.**

## 2. Implemented in this closeout

### Atomic Claim-Next

`claim_next` now performs discovery, exhausted-job termination, Lease creation and
Fence increment in one PostgreSQL transaction. Candidate selection uses
`FOR UPDATE SKIP LOCKED`, ordered by `created_at, job_id`; `QUEUED`, expired
`CLAIMED` and expired `RUNNING` jobs are eligible. Attempts-exhausted expired jobs
are moved to `FAILED`.

Remaining gap: no dedicated PostgreSQL two-connection concurrency acceptance was
added for `claim_next`; the existing Node-managed test exercises only the QUEUED path.

### Independent Heartbeat

Worker now starts a separate heartbeat task after Claim:

- 10 second period against a 60 second lease;
- shares an `AtomicBool` cancellation flag with execution;
- heartbeat failure stops further checkpoint/sink writes;
- forward progress checks the cancellation flag before each batch;
- heartbeats are aborted on normal completion and cancellation.

Remaining gap: no 60+ second Source acceptance and no explicit heartbeat-rejection
E2E; therefore Continuous Heartbeat is `PARTIAL`.

### Authoritative Effect Completion

Kernel `result()` for SUCCEEDED now:

1. loads the pinned PipelineRevision and sink;
2. recomputes stable Effect IDs for `batch-1..N`;
3. rejects duplicate, missing or extra Effect IDs;
4. calls the restricted Catalog service identity for each Receipt;
5. verifies:
   - `status=COMMITTED`;
   - `jobId`;
   - `pipelineId` and Revision;
   - Sink Node;
   - Dataset and Schema Revision;
   - request digest.
6. only then inserts the Result.

A fabricated `effects` array can no longer produce SUCCEEDED without matching
Catalog Receipts.

### Supervisor lifecycle

Node Supervisor now stops the live Worker when:

- the enable marker is removed;
- Node is quarantined;
- the bound Instance is no longer READY.

It uses bounded exponential backoff and reaps children.

## 3. CI evidence

- Data Foundation OCI CI [39963403270](https://github.com/baicie/ops-1/actions/runs/39963403270) — **SUCCESS**
- Standard CI [39963403462](https://github.com/baicie/ops-1/actions/runs/39963403462) — **SUCCESS**
- Typed Pipeline Contract CI [39963403288](https://github.com/baicie/ops-1/actions/runs/39963403288) — **SUCCESS**
- 0.0.1 Legacy: `PASS=21 FAIL=0`
- 0.0.2 Data Foundation: PASS

Retained real assertions:

```text
PASS  dynamic dataset -> live schema pin -> job SUCCEEDED records=2 effect=efx:5e3e5f...
PASS  unknown Catalog dataset rejected
PASS  unpublished schema revision rejected
PASS  Node Runtime auto-claimed and completed job without manual worker invocation
Dynamic Catalog Pipeline Golden Path: PASS
Node-managed Worker Golden Path: PASS
Pipeline Worker Advanced Golden Path: PASS
```

## 4. Not run / incomplete

### P0

No P0 in the exercised single-Node path.

### P1

- Kernel process kill/restart E2E: `NOT_RUN`.
- Two independent Node Runtime automatic takeover: `NOT_RUN`.
- `claim_next` two-connection PostgreSQL concurrency test: `MISSING`.
- Independent long Source/slow Catalog heartbeat test: `MISSING`.
- Supervisor quarantine/instance-stop/revocation E2E: `MISSING`.
- Dedicated `.github/workflows/typed-pipeline-runtime.yml`: `MISSING`.
- Catalog lock `pg_blocking_pids()` proof: `MISSING`.
- Complete HTTP redirect/DNS-rebinding/chunked/slow matrix: `MISSING`.

### P2

- Worker concurrency/backpressure.
- Multi-host acceptance.
- Full provider/identity failure matrix.

## 5. Boundary

The live Catalog, dynamic Dataset, immutable Schema Pin, single-Node automatic
scheduling and Kernel-side Receipt verification are real and pass CI.

The final distributed recovery gates (Kernel restart, two-Node automatic takeover)
and the dedicated concurrency/heartbeat acceptance are not implemented. Therefore
PR #2 is **not ready for formal review yet**.

PR #2 remains Draft. No merge, tag move, force-push or release was performed.
