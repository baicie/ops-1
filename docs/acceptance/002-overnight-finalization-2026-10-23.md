# OpsWeave 0.0.2 — Overnight PR Finalization Report

Date: 2026-10-23 (Asia/Shanghai)  
Branch: `feat/0.0.2-data-foundation`  
PR: [#1](https://github.com/baicie/ops-1/pull/1)  
Reporting HEAD: `33c5058`  
Frozen baseline: `v0.0.1-dev.1` (unchanged)

## 1. Overall Status

**READY_FOR_REVIEW_CANDIDATE**

Reason: the P0/P1 security fixes and all major requested acceptance paths now have real Kernel/PostgreSQL/OCI/Gateway/Chromium evidence. D06 remains explicitly `PARTIAL` for fault-injection/UNKNOWN, retention enforcement and restart-recovery scenarios; those are documented limitations, not silently converted to PASS. This is not a production-readiness claim. PR remains Draft; it was not marked Ready and was not merged.

## 2. Stage Status

| Stage | Result |
|---|---|
| Multi Provider E2E | PASS |
| Migration Concurrent E2E | PASS |
| Catalog UI Flow | PASS |
| Integration UI Flow | PASS |
| UI Screenshot Matrix | PASS |
| Token File Security | PASS |
| D06 Reliability | PARTIAL |
| 0.0.1 Regression | PASS |

## 3. Actual Results

### Files and code

- Added `plugins/data-catalog-alt/manifest.template.json` and alternate-provider bundle generation in `scripts/build-data-plugins.sh`.
- Added real multi-provider acceptance: `tests/acceptance/capability_multi_provider.sh`.
- Added deterministic migration concurrency acceptance: `tests/acceptance/storage_migration_concurrency.sh`.
- Added token-file security checks: `tests/acceptance/data_token_security.sh`.
- Added bounded D06 reliability checks: `tests/acceptance/data_reliability.sh`.
- Added full browser flows: `tests/ui/data-foundation-flows.spec.ts`.
- Added responsive card tables and stable test IDs in both data extensions.
- Kernel migration execution now uses a quote-aware statement splitter and the `APPLIED`-protecting failure upsert.
- Node runtime maintains an atomically updated, read-only mounted capability-token file; Integration has an idle keepalive and refreshes before use.

### Tests and CI

- `cargo test --workspace`: **32 passed**
  - bundle 4, contracts 3, kernel 17, node 8.
- `cargo clippy --workspace --all-targets -- -D warnings`: PASS.
- `cargo fmt --all -- --check`: PASS.
- Contract validation: 10 schemas, PASS.
- Data frontend typecheck/build: PASS.
- Data Foundation OCI CI [`39827988081`](https://github.com/baicie/ops-1/actions/runs/39827988081): success.
- Standard CI [`39827988127`](https://github.com/baicie/ops-1/actions/runs/39827988127): success.
- 0.0.1 legacy job: `PASS=21 FAIL=0`.

### Real acceptance evidence

- Multi-provider: bound A reached A; natural switch selected B and returned `403 CAPABILITY_PROVIDER_MISMATCH`; unbounded grant reached B; revoke/restore immediate; no-provider resolution returned `CAPABILITY_UNAVAILABLE`; mismatch audit present.
- Migration concurrency: A failed, B applied once, late FAILED did not overwrite APPLIED; replay with same checksum `replay=true`; changed checksum rejected; CONTRACT blocked with live instance.
- Token file: mode 644, per-instance isolation, no Node control credential in plugin env, no token in unauthenticated response, expiry/refresh and Node revocation tests.
- Browser: full Catalog and Integration business flows passed with real signed Remote Extensions, real Gateway, PostgreSQL and active OCI plugins.
- Screenshots: `artifacts/ui/data-foundation/` from artifact `data-foundation-screenshots` (run `39827988081`).

### Screenshot review

The final artifact was inspected for:
- Catalog list/detail/schema editor/diff/records/lineage.
- Integration sources/create/test/discovery/preview/mapping/run/quality/lineage.
- 1440x900, 1024x768, 390x844 in light/dark themes.

Mobile tables were found to clip columns in the first pass. They were converted to stacked card rows with data labels, re-run, and re-inspected. No horizontal document overflow or page errors remained in the automated matrix. Desktop flow screenshots use element captures to avoid fixed-sidebar full-page artifacts.

## 4. Unresolved / NOT_RUN

- D06 UNKNOWN/timeout outcome and forced Catalog transport failure: `NOT_RUN`.
- Retention policy actual enforcement/purge: `NOT_RUN`; only visibility and bounded semantics are tested.
- Kernel restart recovery for in-flight data/run state: `NOT_RUN`.
- Signed migration plan validation: `NOT_RUN` (current gate checks request SQL checksum).
- Production security: mTLS, Fencing, KMS/Secret Manager, Rootless Docker, physical multi-host, OCI signatures/SBOM: `NOT_RUN`.
- Local Docker Desktop OCI run remains `NOT_RUN`; CI Linux Docker is the actual OCI evidence.

## 5. Final Recommendation

PR #1 **can enter formal Review as an Experimental Data Foundation Review Candidate**, but should remain Draft until the reviewer accepts the documented D06 `PARTIAL` limitations. It should **not** be merged or called production-ready automatically. No PR state was changed by this report.
