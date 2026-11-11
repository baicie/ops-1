# P001-C0 — Plugin Lifecycle Baseline

Status: **INVENTORY COMPLETE.** This document records what exists, what is
tested, what has actually been observed running, and what is missing — as of the
current `main`. It is a baseline, not a pass. Nothing here is a new capability
claim.

| Fact | Value |
|---|---|
| Baseline commit | `84be53a8d888f229ef3fea2c271e754fd820a81a` (`origin/main`) |
| Open pull requests at audit time | none |
| Ruleset `26958761` | active, `bypass_actors: []`, 9 required contexts |
| Audit date | 2026-11-11 |

---

## 0. The one number that governs this document

`docs/acceptance/EVIDENCE.md` records real, passing plugin evidence:
three-language runtime conformance (`0 failure(s)`) and a full lifecycle
(`PASS=21 FAIL=0`). **That evidence is dated against `ca56462` (2026-10-22).**

Since then:

```
commits on main between ca56462 and 84be53a : 217
plugin-path diffstat                        : 2,859 insertions, 108 deletions
```

and critically:

```
$ git cat-file -e ca56462:apps/kernel/src/capabilities.rs
  -> the file DID NOT EXIST
```

**The entire capability-grant subsystem post-dates the evidence that is cited
for it.** `capabilities.rs` was added in `a434a79`; `run_conformance.py` was last
changed in `9990f79` (B2.1 identity hardening). Both are ancestors of the
evidence commit's descendants, not of the evidence itself.

So `EVIDENCE.md` is not wrong — it was true when written. It is **not evidence
about the current tree**, and no row below treats it as such. This is the single
most important finding in the audit and the reason Phase C exists.

---

## 1. Existing implementation

All five kernel modules are real code, not scaffolding. No `TODO`, `FIXME`,
`todo!()`, `unimplemented!()` or `stub` markers exist in any of them.

| Area | State | Where |
|---|---|---|
| Bundle format, signing, verification | **real** | `crates/bundle/src/lib.rs` (Ed25519 detached sig over `artifact_digest` + `manifest_digest`) |
| Upload, trust gate, immutability | **real** | `apps/kernel/src/packages.rs:76-262` |
| Publisher trust store | **real** | `kernel.trusted_publishers`, `apps/kernel/src/publishers.rs` |
| Deploy / activate / atomic switch | **real** | `apps/kernel/src/deployments.rs:418-615` |
| Rollback | **real, delegating** | `deployments.rs:898-954` |
| Disable / enable | **real** | `deployments.rs:655-763` |
| Uninstall (retains data) | **real** | `deployments.rs:860-896` |
| Capability grants + revoke | **real** | `apps/kernel/src/capabilities.rs` |
| Gateway routing | **real, DB-derived** | `apps/kernel/src/gateway.rs:267-295` |
| Runtime info verification (executor side) | **real** | `apps/node/src/runtime.rs:967-1001` |

### 1.1 Lifecycle state is five separate string columns, not one state machine

This matters for how the phase is described. `crates/contracts/src/lib.rs:785-831`
declares `PackageState` and `DeploymentStatus` enums, but they have **zero
references anywhere in `apps/`**. Runtime logic is `String` comparison against
SQL `CHECK` constraints:

| Concept | Table.column | Variants |
|---|---|---|
| Package | `plugin_packages.status` | `UPLOADED`, `VERIFIED`, `STAGED`, `INSTALLED`, `REJECTED` |
| Signature | `plugin_packages.signature_state` | **no CHECK constraint**; only `VERIFIED` is ever written |
| Installation | `plugin_installations.state` | `STAGED`, `INSTALLED`, `DISABLED`, `UNINSTALLED` |
| Deployment | `plugin_deployments.status` | `PENDING`, `PREPARING`, `READY`, `ACTIVE`, `DRAINING`, `DISABLED`, `DEGRADED`, `FAILED` |
| Instance observed | `plugin_instances.state` | `STARTING`, `READY`, `UNHEALTHY`, `UNREACHABLE`, `STOPPED`, `UNKNOWN` |
| Activation revision | `activation_revisions.status` | `ACTIVE`, `SUPERSEDED`, `DISABLED` |
| Grant | `capability_grants.state` | `ACTIVE`, `REVOKED`, `EXPIRED` |

A claim of "typed lifecycle state machine" would be false. The states are real
and enforced; the Rust types are decorative.

### 1.2 "Upgrade" is not a primitive

There is no upgrade endpoint, no `upgrade` function, no upgrade request variant.
Upgrade is the emergent sequence:

```
POST /plugins/packages          (new version)
POST /plugins/{id}/deployments  (new version)
POST /plugins/{id}/activations  (atomic switch)
```

**No document in this phase may claim an upgrade API exists.** It is a workflow
composed of three calls, and its guarantees are exactly those of `activate_inner`.

### 1.3 What activation actually guarantees

`activate_inner` (`deployments.rs:506-587`) does, in one transaction:

1. requires the target deployment `READY` with **every replica READY**;
2. marks the old revision `SUPERSEDED`, inserts the new one `ACTIVE`;
3. writes `PROVIDES` / `REQUIRES` registrations;
4. sets the new deployment `ACTIVE`;
5. marks the old deployment `DRAINING` with `drain_until = now() + 15s`.

Gateway routing reads `activation_revisions.status='ACTIVE'` live, so the route
switch is atomic at transaction commit. The old instances keep serving until the
drain window expires, then `reconcile_once` sets the old deployment `DISABLED`
and the node removes the container as an orphan.

The 15-second drain is **hard-coded** (`deployments.rs:580`), not configurable.

---

## 2. Existing tests — and what kind each one is

The distinction below is the point of this section. "Test exists" is not one
thing.

| Test | Kind | Runs in CI? |
|---|---|---|
| `tests/contract/run_conformance.py` | **real containers**, TS + Go + Java | **NO — absent from every workflow** |
| `tests/acceptance/e2e_platform.sh` | **real containers**, full lifecycle | yes, `data-foundation.yml` (PR-only, path-filtered) |
| `tests/acceptance/capability_multi_provider.sh` | **real kernel + real container**, grant/revoke | **not wired to any workflow** |
| `tests/ci/g13a1_gateway_e2e.sh` | **real OCI container** via gateway | yes, `ci.yml` `g13a1-gateway` |
| `tests/acceptance/container_security.py` | inspects **live** containers | via e2e path |
| `apps/kernel/src/deployments.rs` (12 tests) | unit — **placement arithmetic only** | yes |
| `apps/kernel/src/capabilities.rs` (9 tests) | unit — token/scope/narrowing | yes |
| `apps/kernel/src/gateway.rs` (2 tests) | unit — header stripping, traversal | yes |
| `crates/bundle/src/lib.rs` (4 tests) | unit — tamper, traversal, imageRef binding | yes |
| `tests/ci/p001_upgrade_behaviour.sh` | **grep over installer source** | yes |
| `tests/ui/plugin-surfaces.spec.ts` | browser, **stubbed** `/api/v1/extensions` | yes |

### 2.1 `run_conformance.py` covers all three languages — and gates nothing

```python
for plugin in ["dev.opsweave.hello", "dev.opsweave.hello-go", "dev.opsweave.hello-java"]:
    probe(plugin)
```

Per instance it asserts runtime identity, version, `http-json-v1`, capability
digest against the canonical `provides`, liveness 200, readiness 200, unknown
path 404 — plus a forged-header test proving the unsigned role header is
stripped and a Kernel-signed context is delivered.

This is exactly the C3 deliverable. **It has never run in CI.** `grep -rn
run_conformance .github/` returns nothing. `IMPLEMENTATION_STATUS.md:42` labels
its result `PASS (local)`, which is accurate and is not a gate.

### 2.2 The e2e script swallows intermediate failures

`e2e_platform.sh` contains **8** `|| true` on real commands:

```
52: deploy dev.opsweave.hello 0.0.1 ... || true
53: activate dev.opsweave.hello 0.0.1  || true
84: deploy "$plugin" 0.0.1 ... || true      (loop over go, java)
85: activate "$plugin" 0.0.1  || true
91: deploy dev.opsweave.hello 0.0.2 ... || true
92: activate dev.opsweave.hello 0.0.2  || true
```

The script does end with `[ "$FAIL" = "0" ]`, so it cannot go green with a
failed assertion. But a failed *deploy* is not an assertion — it surfaces later
as a gateway failure, which misattributes the root cause. It also means the
script cannot distinguish "activate failed" from "activate succeeded but routing
lagged".

### 2.3 `data-foundation.yml` cannot gate `main`

```yaml
on:
  workflow_dispatch:
  pull_request:          # no push: trigger
    paths: [...]         # does not include tests/acceptance/e2e_platform.sh
```

Two consequences: it never runs on `main`, and editing the acceptance script
alone does not run it. `data-foundation / golden-path` was deliberately left
out of the ruleset for this reason (see `08-branch-protection-proposal.md` §2.2).

---

## 3. What has actually been verified (真实验证)

Only these have observed runtime evidence *anywhere*, at *some* commit:

| Capability | Evidence | Commit |
|---|---|---|
| TS/Go/Java runtime conformance | `EVIDENCE.md` — `0 failure(s)` | `ca56462` — **stale** |
| Full lifecycle incl. upgrade/rollback | `EVIDENCE.md` — `PASS=21 FAIL=0` | `ca56462` — **stale** |
| Gateway → real OCI container, digest-pinned, no socket mount | `g13a1_gateway_e2e.sh` in `ci.yml` | current |
| Container security posture (not privileged, loopback, no bind) | `container_security.py` | current |
| Grant revoke → 403 `CAPABILITY_FORBIDDEN` | `capability_multi_provider.sh` | current, **not in CI** |

**At the current `main`, nothing in this table has been re-run.** That is the
C1/C3 work: not "build it", but "run it against this tree and put it in CI".

---

## 4. Missing contracts

| # | Gap | Evidence |
|---|---|---|
| M1 | **OCI image signature is not verified.** Bundle signature binds `imageRef`, but nothing verifies the image itself. | `crates/bundle/src/lib.rs:27-30` signs bundle only; no cosign/notation code exists |
| M2 | `publish-demo-hello-plugin.sh` builds with `--provenance=false --sbom=false` | `scripts/publish-demo-hello-plugin.sh:60` |
| M3 | No `signature_state` CHECK constraint; only `VERIFIED`/`SYSTEM` can ever appear | `0001_init.sql:50`, `packages.rs:197` |
| M4 | `payload_digest` is bound to `artifact_digest` — two columns, one value | `packages.rs:206-208` |
| M5 | `act`-time grant binding trusts the client's `provider_plugin_id`, which is nullable | see §5 F1 |
| M6 | No grant-expiry sweeper; `EXPIRED` is declared but never written | `0002_data_foundation.sql:11` |

---

## 5. Findings that block a "grant/revoke works" claim

Two were reported as high severity by a review pass and **independently
re-verified here**. A third was reported and **refuted** — it is recorded so the
refutation is auditable.

### F1 — a grant can be created with **no** provider binding (re-graded: policy question, not a vulnerability)

> **Graded down by `03g-c0-errata.md`.** The code behaviour below is accurate; the
> HIGH severity and the "blocks C2" conclusion were wrong. `NULL` is a deliberate
> wildcard, whether it should be allowed is undecided, and C2 cases 5/6 exercise
> bound grants and are not blocked by this.

```rust
let provider = resolve_provider(&state, &payload.name, payload.major).await?;
if let Some(requested) = &payload.provider_plugin_id {
    if requested != &provider.plugin_id { return Err(PLUGIN_MISMATCH) }   // only if Some
}
...
.bind(payload.provider_plugin_id)     // the CLIENT value, possibly NULL
```

`provider_plugin_id` is `text` (nullable) in `0002_data_foundation.sql:9`. Sending
`null` skips the mismatch check and stores `NULL`.

The consequence is not a weakened check — it is **no check at all**, because the
call-time comparison treats `NULL` as a wildcard:

```rust
fn provider_matches_grant(bound: Option<&str>, selected: &str) -> bool {
    bound.is_none_or(|bound| bound == selected)      // capabilities.rs:968-970
}
```

`None` passes for **any** selected provider. So an operator who omits
`providerPluginId` gets a grant that is satisfied by whichever provider is
active at call time — including a provider that later becomes active through a
different plugin's activation.

**Impact:** the provider-pinning guarantee that `capability_multi_provider.sh`
tests (provider mismatch → 403) holds only for grants that *supply* a provider.
A grant created without one is never pinned, and `resolve_provider` is free to
follow capability registration to a different provider after a version switch.

**Corrected by `03g-c0-errata.md`:** this does **not** block C2 cases 5/6. Those
exercise grants that supply a provider, so the wildcard is not on their path. The
open question is a policy one — forbid unbound grants, or document the wildcard —
and it is for the platform owner to decide, not a defect this audit can close.

### F2 — assets remain served after uninstall (MEDIUM, confirmed)

```sql
SELECT ... FROM kernel.plugin_packages p
 JOIN kernel.trusted_publishers tp ON ...
 WHERE p.plugin_id=$1 AND p.version=$2 AND p.status <> 'REJECTED' AND tp.trust_state='TRUSTED'
```

No installation-state or active-revision predicate. After `uninstall` (which
sets everything `DISABLED`/`UNINSTALLED`/`STOP`), the frontend bundle is still
served. The backend is stopped, so this is a stale-asset exposure, not code
execution — but it contradicts "uninstalled".

### F3 — `disable` does not drain (MEDIUM, confirmed)

`activate` sets the superseded deployment `DRAINING` with a 15 s window
(`deployments.rs:577-586`). `disable` sets `desired_action='STOP'` directly
(`deployments.rs:759-764`) with **no `drain_until`**. In-flight requests are
dropped at container stop rather than drained.

### R1 — refuted: "revocation does not invalidate live workload tokens"

Reported against `capabilities.rs:1113-1190`. **This is wrong.** `invoke`
re-queries the grant table on every call:

```sql
SELECT consumer_plugin_id, scope, provider_plugin_id
  FROM kernel.capability_grants
 WHERE consumer_plugin_id=$1 AND name=$2 AND major=$3
   AND state='ACTIVE' AND (expires_at IS NULL OR expires_at > now())
```

and every early-return branch before it (bearer, capability/audience, liveness)
ends at this query. A revoked grant fails here immediately regardless of token
lifetime. Recorded because the refutation is part of the audit, and because a
reviewer who reads only the token code would reach the wrong conclusion.

### Other confirmed findings (not phase-blocking, recorded for C1/C2)

| # | Finding |
|---|---|
| A1 | `PluginSummary.state` falls back to `"AVAILABLE"`, not in the installations CHECK |
| A5 | `Idempotency-Key` is validated but never stored or replayed |
| A7 | Concurrent `activate` hits the partial unique index → `23505` → **500**, not `409` |
| A11 | `rollback` records no audit entry and has no idempotency receipt |
| A12 | `rollback` defaults `desired_replicas: 2` while `max_instances_per_node: 1` |
| A14 | `uninstall` is four un-transacted statements; `dataRetained: true` is hardcoded |
| A24 | "latest" package is `first()` by `created_at`, not semver |

---

## 6. Missing negative tests

Task §C2 lists 14 cases. Current state:

| # | Case | Status | Note |
|---|---|---|---|
| 1 | Unsigned bundle rejected | **LOGIC ONLY** | `BundleError::Missing` exists; no test constructs a signature-less bundle |
| 2 | Untrusted publisher rejected | **TESTED** | `automation_flow.rs:595` (DB); `publisher_revocation.sh` **unwired** |
| 3 | Digest tampering rejected | **TESTED, e2e** | `e2e_platform.sh:35-49` → 400 `SIGNATURE_OR_BUNDLE_INVALID` |
| 4 | Manifest schema incompatibility | **ABSENT** | logic at `contracts:549-559`; no test sets a wrong major |
| 5 | Unauthorized capability call | **TESTED** | `capability_multi_provider.sh:84-110` — but see F1 |
| 6 | Revoked grant rejected | **TESTED** | `capability_multi_provider.sh:105-119` |
| 7 | Runtime info mismatch replays | **PARTIAL** | comparison code exists; **no test feeds a mismatch** |
| 8 | Privileged / host-socket / bad mount | **PARTIAL** | live containers are *inspected*; no manifest can even request these (`BackendSpec` has no such field) |
| 9 | Resource limit exceeded | **PARTIAL** | admission-time only; no runtime OOM test |
| 10 | Incompatible upgrade rejected | **ABSENT** | `validate_requires` untested |
| 11 | Same version, different digest | **PARTIAL** | logic returns `PACKAGE_VERSION_CONFLICT` (`packages.rs:169`); **no test references it** — `grep -rn PACKAGE_VERSION_CONFLICT tests/ scripts/` returns nothing, while `IMPLEMENTATION_STATUS.md:46` lists "version conflict rejected" among its evidence |
| 12 | Failed start must not activate | **PARTIAL** | activation requires all replicas READY — but no test drives a failing start |
| 13 | Provider unavailable → real unavailable, no mock | **TESTED** | `e2e_platform.sh` disabled plugin → 503 `CAPABILITY_UNAVAILABLE` |
| 14 | No unconditional retry after fault/timeout | **NOT FOUND** | gateway retries GET/HEAD only (`gateway.rs:98-110`); non-GET exactly once — **but no test asserts this** |

**Cases 4, 10, 11, 14 need to be written.** Case 11 is the sharpest: one clause
of `IMPLEMENTATION_STATUS.md:46` rests on it. That row is otherwise candid — it
declares itself `PARTIAL` and states plainly that OCI image signature
verification is not implemented — so the defect is that single clause, not the row.

---

## 7. Production blockers

| Blocker | Why it blocks production | Owner |
|---|---|---|
| OCI image signature absent | a registry compromise can swap the image under a valid bundle | **P001-E** |
| Nothing pushes to a registry | no digest-pinned upgrade has ever been exercised against a registry | P001-C5 / E |
| `--provenance=false --sbom=false` | no provenance or SBOM to attest | P001-E |
| Backup has `kernel_files=0` and no registry blobs | plugin restore is unproven; see C5 | **P001-C5** |
| F1 grant provider binding | a grant can be unbound | **P001-C2** |
| Conformance is not a CI gate | regressions in plugin runtime go unnoticed | **P001-C6** |

---

## 8. What C0 changes about the plan

Three of the five phases are **smaller than the brief assumes**, and one is
larger.

| Phase | Revised expectation |
|---|---|
| **C1** TS Golden Path | The lifecycle exists and has run before. The work is: run it **at this commit**, capture per-step evidence, and fix F2/F3/A7/A11 where they surface. Not a rewrite. |
| **C2** Security negatives | 4 of 14 need writing from scratch (4, 10, 11, 14). **F1 must be fixed first** or cases 5/6 are PASS on a broken foundation. |
| **C3** Multi-language conformance | `run_conformance.py` **already covers all three**. The work is wiring it into CI with real containers, not authoring it. |
| **C4** Gateway/version切换 | Atomic switch + drain exist. The genuinely new work is the **old-browser-tab** case, which has no implementation at all. |
| **C5** Recovery | **Larger than briefed.** `kernel_files=0` plus no registry blobs means the current backup cannot restore a plugin. This needs a design before a drill. |

---

## 9. Position

Phase C0 is **complete as an inventory**. Nothing in it is claimed as passing.

The headline is not a defect list — it is that **the evidence this project
cites for plugin capability predates the capability subsystem itself by 217
commits**, and the one multi-language conformance suite that would prove it
today is not run by any workflow.

C1 begins from that: re-establish the baseline on the current tree, in CI,
before adding anything.
