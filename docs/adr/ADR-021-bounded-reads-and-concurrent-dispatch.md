# ADR-021: Bounded response reads and concurrent job dispatch

- Status: Accepted (B2.2)
- Date: 2026-11-08
- Related: [ADR-013](ADR-013-typed-pipeline-and-durable-jobs.md) (durable jobs), [ADR-020](ADR-020-plugin-identity-hardening.md)

## 1. Context

Two independent reliability defects, both found by reading the code rather than
by a failure report, and both confirmed still present at `8f0431ce`.

### 1.1 The response limit was applied after the read

Six call sites read an upstream body with `response.bytes().await` and compared
the result against a limit **afterwards**:

| File | What it reads |
|---|---|
| `apps/kernel/src/gateway.rs` | plugin response through the Gateway |
| `apps/kernel/src/capabilities.rs` | capability provider response |
| `apps/kernel/src/automation_flow.rs` | plugin response for an automation call |
| `apps/node/src/api.rs` | plugin response through the Node data proxy |
| `apps/pipeline-worker/src/main.rs` (×2) | Kernel responses and Catalog responses |

Each had an earlier `Content-Length` check, which an untrusted upstream
controls and may simply omit (chunked) or misstate. `bytes()` materialises the
whole body before returning, so the limit did not bound memory at all: it only
decided what to do *after* the allocation. The pipeline worker had no bound
whatsoever.

### 1.2 One job at a time

`Worker::run_auto` claimed a job and awaited it to completion before claiming
again. A single slow source request held the entire worker, and the queue behind
it grew with nothing to distinguish "slow" from "stuck".

## 2. Decision

### 2.1 One bounded reader, in its own crate

`crates/http-body-guard` exposes:

```rust
pub async fn read_bounded(
    response: reqwest::Response,
    limit: usize,
    idle_timeout: Option<Duration>,
) -> Result<Vec<u8>, ReadFailure>;
```

- A declared `Content-Length` over the limit is refused before the first byte
  (cheap, honest-case only).
- The body is then consumed **chunk by chunk**; the read fails with `TooLarge`
  the moment `accumulated + chunk > limit`, and the response is dropped rather
  than drained. The buffer never exceeds the bound.
- `idle_timeout` bounds the **gap** between chunks, not the whole transfer: a
  large but steadily streaming body is legitimate, a silent one is not.
- Three outcomes, all distinguishable: `TooLarge`, `Interrupted`, `Idle`. A
  caller reports a size error, a body error, or a timeout — never a partial
  success.

It lives in a crate rather than in `apps/kernel` because the Kernel, the Node and
the worker all need it, and three copies of a security-relevant read would drift.

**Why not stream to the client instead?** The Gateway's contract is a buffered
response: it forwards the plugin's `Content-Type`, sets `no-store`/`Vary`, and
attaches a request id. Streaming would change every one of those and the retry
logic that inspects the status before committing to a response. The requirement
was to stop the *unbounded* buffering, and a bounded buffer achieves that with no
observable API change.

### 2.2 Bounded, per-source concurrency in the worker

- `OPSWEAVE_WORKER_CONCURRENCY` (default 4) and
  `OPSWEAVE_WORKER_CONCURRENCY_PER_SOURCE` (default 1), both clamped to `1..=64`
  and logged when a value is rejected rather than silently accepted.
- A semaphore bounds in-flight jobs. The worker **does not claim a job it cannot
  start**: claiming first and queueing would burn the lease while the job waits.
- A per-source gate counts in-flight jobs per **pipeline source node**, read from
  the pinned definition the Kernel serves for a claimed lease. Raising the global
  limit therefore cannot multiply load on one upstream.

**What this must not change, and does not.** Lease acquisition, fencing,
receipt-first writes and Evidence exactly-once are owned by the Kernel and the
Catalog's fenced sink; the worker never decides them. Running two jobs
concurrently cannot let either claim a lease it does not hold: `claim-next`
hands out one lease per call, and the fence is re-checked at the sink under a row
lock. The concurrency change is confined to *when the worker asks for work*.

**A rejected alternative.** Claiming into an in-memory queue and executing later
would improve "backlog" numbers while violating the lease window: the claim's
expiry would tick down before execution began, and a crash would leave a lease
held for a job nobody is running. Not claiming is the correct backpressure.

### 2.3 Job-queue metrics

`GET /api/v1/diagnostics` (admin-only) gains a `jobs` object:

| Field | Meaning |
|---|---|
| `backlog` | jobs in `QUEUED` |
| `inFlight` | jobs in `CLAIMED`/`RUNNING` |
| `failed`, `cancelled` | terminal states |
| `expiredActiveLeases` | leases still marked `ACTIVE` past `expires_at` — the signature of a dead worker |
| `avgWaitSeconds24h` | `JOB_STARTED.occurred_at - job.created_at` |
| `avgRunSeconds24h` | `result.completed_at - JOB_STARTED.occurred_at` |
| `retryRate24h` | share of jobs in the window with `attempts > 1` |

Every value is read from the tables the dispatcher writes, not from in-memory
counters that a restart would reset. A window with no jobs reports `null`, not
`0`: zero would read as "instant" rather than "nothing to measure".

## 3. Module structure (part of the same phase)

`incidents.rs` (8603 lines) and `investigations.rs` (4969 lines) were two thirds
and 97% test code respectively. Both test modules moved to
`incidents_tests.rs` / `investigations_tests.rs` and are pulled in with
`include!`, which keeps them in the same module scope so every `use super::*`
and private item resolves exactly as before.

This is a **move, not a rewrite**: no business rule, type or handler changed, and
the full suite (264 kernel tests) passes unchanged across the split. Splitting
the *production* code by state machine / persistence / API was deliberately not
done here — that is a rewrite of the modules whose behaviour B2.1 and B2.1a just
changed, and it belongs in its own change with its own review.

## 4. Verification

| Claim | Evidence |
|---|---|
| no unbounded read remains | `tests/acceptance/b2_response_bounds.sh`, which greps every binary's source |
| the bound is hit by size, not timeout, against an endless chunked upstream | `crates/http-body-guard` test with a real socket |
| a declared length over the bound is refused before reading | same suite, real listener |
| a stalled upstream times out instead of hanging | same suite |
| the per-source gate admits its limit and no more, and does not couple sources | `pipeline-worker` unit test |
| a bad concurrency value falls back rather than stalling the worker | `pipeline-worker` unit test |
| the metrics query is valid against the real schema and reports `null` (not `0`) for an empty window | DB-gated kernel test |

## 5. Residual risk

- **Throughput was not benchmarked.** The concurrency change is verified
  correct, not measured faster; no load test was run, and none is claimed. The
  defaults (4 global, 1 per source) are conservative starting points, not tuned
  values.
- **`read_bounded` bounds memory, not CPU or time**: a body just under the limit
  that arrives slowly is still bounded by the caller's outer request timeout.
- **The worker's own state** (in-flight count, per-source counts) is per process.
  Two workers on one node each get their own limits; the Kernel's lease is what
  prevents double execution.
