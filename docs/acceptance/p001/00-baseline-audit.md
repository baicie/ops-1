# P001 Phase 0 — Baseline Audit

Status: **DRAFT**. Facts here are measured against the checkout; items this session
could not reach are marked `BLOCKED (tooling)`, never inferred.

Audit date: 2026-11-10. Auditor: automated session (no human acceptance implied).

---

## 0. Method and honesty statement

Three kinds of statement appear below and they are not interchangeable:

| Marker | Means |
|---|---|
| **Measured** | Read from this checkout, from git objects present locally, or from live GitHub/CI output. Reproducible with the command shown. |
| **BLOCKED (tooling)** | The command that would answer it was refused by the session's command-safety classifier. Not "passing", not "failing". |
| **NOT_RUN** | The check needs infrastructure this session did not have (a real Linux host, a rootless daemon, mTLS peers). Stated so it is never read as passed. |

This matters because the brief explicitly forbids substituting "the page rendered"
or "the check did not fail" for evidence, and the same rule applies to this audit
of the audit.

> Note on §1.3–§1.7: those sections were initially `BLOCKED` while the session's
> command classifier was rejecting `gh`/network calls. The classifier recovered and
> every one of them is now **Measured**. The section text records the measured values,
> not the earlier blockage.

---

## 1. Repository baseline

### 1.1 Revisions (Measured)

```
$ git rev-parse HEAD
827421df12210d08f95d420fcee7d96f9c77f9dc

$ git rev-parse origin/main
4b270c5aea73e9c9eacddb4bc9bfb0038e0de853

$ git log --oneline -3 origin/main
4b270c5 fix(static-site): a missing asset is a 404, not the shell (#73)
5fbc851 fix(ui): send a signed-in admin to its surface, not through / (#72)
56268c1 Merge pull request #71 from baicie/fix/staging-image-two-bundles
```

| Fact | Value | Note |
|---|---|---|
| Task-supplied baseline SHA | `4b270c5aea73e9c9eacddb4bc9bfb0038e0de853` | **MATCHES** `origin/main` exactly |
| New commits since the brief was written | **none** | The brief's warning about a stale SHA resolved to: the SHA is current |
| Working tree branch | `fix/missing-asset-must-404` @ `827421d` | Pre-squash ancestor of `origin/main`; its content landed as `4b270c5` |
| Local checkout vs `origin/main` divergence | not measured | `git rev-list --left-right` was BLOCKED (tooling) at audit time |

**Consequence for the brief's premise.** The brief says not to treat the historical
SHA as current HEAD. Measured: the historical SHA *is* current `origin/main`, so the
baseline the brief was written against is the same tree the audit examined. This is
stated because the opposite result (drift) would have invalidated every finding below.

### 1.2 Remote branches (Measured — cached refs)

```
origin/main                              4b270c5
origin/feat/g14-app-authz                a131b71
origin/feat/g14-platform-app-boundary    c91518e
origin/feat/g14-two-apps                 684dfed
origin/fix/b2-data-workspace-isolation   60501a6
origin/fix/b2-plugin-identity-and-workspace 9990f79
origin/fix/b2-reliability                0c6ffee
origin/fix/staging-image-two-bundles     b819c50
```

All non-`main` branches are already-merged G14/B2 work; none is an open line of
development. `git fetch --prune` and `git ls-remote` were **BLOCKED (tooling)**, so
this list is the local ref cache, not a live remote read. A branch created after the
last fetch would not appear.

### 1.3 Open pull requests (Measured)

```
$ gh pr list --state open --json number,title,headRefName,isDraft,url,updatedAt
[]
```

**Zero open pull requests.** Nothing is in flight against `main`.

### 1.4 GitHub Actions status on `4b270c5` (Measured)

| Workflow | Run | Conclusion |
|---|---|---|
| `ci` | 42638784742 | **success** |
| `g12-acceptance` | 42638784682 | **success** |
| `reliability` | 42638784468 | **success** |
| `staging-preview` | 42638784615 | **failure** |

`staging-preview` job breakdown: `plan` success, `build image` success, `deploy to
staging host` success, **`smoke the preview` failure**, `record the acceptance
evidence` success, three `seeded-data` jobs skipped (marked known-flaky in the
workflow), `report to pull request` success.

**The staging image builds and deploys.** The failure is entirely in the browser
acceptance tier, and it is one file:

| Spec | Result |
|---|---|
| `admin-shell.spec.ts` (7 tests) | **7/7 pass** |
| `dual-surface.spec.ts` (9 tests) | **9/9 pass** |
| `staging-smoke.spec.ts` (5 tests) | **5/5 pass** |
| `ui-table-audit.spec.ts:722` (`r1440-light-en`, `r390-light-en`, `r390-light-zh`) | **3 failed** |
| `ui-table-audit.spec.ts:808` (`usable`) | pass |
| `ui-table-audit.spec.ts:990` (`row keyboard`) | pass |
| `ui-table-audit.spec.ts:1135` (`clipped-probe`) | pass |

Core smoke is **21/21**, not 20/20 as the brief states, and the geometry suite is
**3 passed / 3 failed**, not 3/6. The brief's numbers are close but not exact; the
measured counts are the ones this audit carries forward.

### 1.5 Root cause of the staging failure (Measured — log, not inference)

All three failures are the same line:

```
TimeoutError: page.waitForURL: Timeout 20000ms exceeded.
waiting for navigation until "load"
> 755 |   await page.waitForURL((url) => url.pathname === target.route, { timeout: 20_000 });
    at tests/ui/ui-table-audit.spec.ts:755:20
```

The test drives the router directly (`history.pushState` + `PopStateEvent('popstate')`,
`ui-table-audit.spec.ts:748-753`) instead of a full page load, then waits for the URL
to equal the target route.

Facts that constrain the diagnosis:

1. **All ten target routes exist** in `apps/platform-console/src/App.tsx:133-152`
   (`/admin/jobs`, `/admin/activity`, `/admin/nodes`, `/admin/nodes/:id`,
   `/admin/plugins`, `/admin/governance`, `/admin/access`,
   `/admin/settings/diagnostics`, `/admin/plugins/:id`, `/admin/jobs/:jobId`).
   **This is not a missing route.**
2. The three tests in the same file that use `page.goto(...)` — `usable`,
   `row keyboard`, `clipped-probe` — **all pass**. `usable` even navigates to
   `/admin/nodes/<id>` (`:937`) successfully.
3. The failure is at the *navigation wait*, before any geometry is measured, which is
   why the brief's report lists "11 routes not measured" plus one unmeasured row
   height: the measurements were never taken, they were not taken and found bad.

A `pushState` changes `location` synchronously, so `waitForURL` should match on its
first poll. It timing out means the URL **stopped matching after the test set it** —
i.e. the application redirected the path away. The candidates are the console's own
guards (`LegacyOrNotFound` at `App.tsx:157`, the surface-access redirect, and the
`/login?next=` bounce). **Identifying which guard redirects, and why only under
`pushState` and not under `page.goto`, needs the Playwright trace** (the workflow
uploads `test-results/metrics/ui-table-audit-*-chromium/trace.zip`).

> **Verdict: NOT diagnosed this session.** The trace artifact was not downloaded.
> What is established is the negative space the brief asked for: not a missing route,
> not a CSS/layout violation, not a warm-vs-cold bundle problem, and not a global
> login failure (21 other tests log in and pass on the same host). Recording it as
> "CSS is broken" or raising the timeout would both be wrong, and neither is done here.

### 1.6 Staging deployment SHA (Measured indirectly)

The deployed image is built from `4b270c5` (`build image` step consumed that SHA) and
`staging-smoke.spec.ts:53` — *"the preview serves exactly the commit this run built"* —
**passed**. So the host serves `4b270c5`. `GET /api/v1/version` was not called
directly; this is the workflow's own identity assertion, which is the stronger check.

### 1.7 Branch protection (Measured)

```
$ gh api repos/baicie/ops-1/branches/main/protection
{"message":"Branch not protected","status": 404}

$ gh api repos/baicie/ops-1/rulesets
[]
```

**`main` has no branch protection and no repository ruleset.** Nothing blocks a
direct push, a force-push, or a merge with red checks. The `staging-preview` failure
above is itself proof of the consequence: a red required-by-intent workflow sits on
`main` and nothing stops the next merge.

This is unchanged from the G14 measurement of 2026-11-09. It is a repository setting,
not a code change: this session **cannot** enable it with the credentials available,
so it is reported with configuration steps rather than claimed as done (§10).

---

## 2. Build structure (Measured)

### 2.1 Cargo workspace

`Cargo.toml` members: `crates/contracts`, `crates/http-body-guard`, `crates/bundle`,
`crates/pipeline-transform`, `apps/kernel`, `apps/node`, `apps/pipeline-worker`,
`apps/opsctl`. Workspace version `0.0.1`.

| Question | Answer | Evidence |
|---|---|---|
| Any `[features]` in `apps/kernel/Cargo.toml`? | **No** | file contains only `[package]` and `[dependencies]` |
| Any `[[bin]]` target? | **No** | single implicit `opsweave-kernel` binary |
| Any `cfg(feature = …)` anywhere in `apps/kernel/src`? | **Zero occurrences** | `grep -rn "cfg(feature" apps/kernel/src` → no matches |

**Conclusion (Measured): no platform-only build configuration exists.** There is
presently no mechanism — feature flag, second binary, second crate — by which the
Kernel could be compiled without the business modules. A "platform-only build" today
can only mean "the same binary, with the business routes present but unused". That is
exactly the "hide it in the UI" substitution `Phase 1` forbids.

### 2.2 Kernel compile units

`apps/kernel/src/main.rs:1-35` declares 35 modules in one crate. Classified:

| Class | Modules |
|---|---|
| **Platform Core** | `applications`, `assets`, `audit`, `auth`, `capabilities`, `config`, `db`, `deployments`, `diagnostics`, `error`, `gateway`, `logs`, `nodes`, `packages`, `plugins`, `publishers`, `receipts`, `routes`, `scope`, `state`, `static_site`, `storage`, `users`, `workspaces` |
| **Business domain** | `incidents` (+`incidents_tests`), `incident_claims`, `investigations` (+`investigations_tests`), `ops_observability`, `telemetry_events`, `telemetry_sources`, `automation`, `automation_flow`, `automation_worker`, `pipeline`, `jobs` |

Line counts (`wc -l apps/kernel/src/*.rs`, sorted desc, top 12):

```
5625 incidents_tests.rs      3266 investigations.rs      1253 audit.rs
4331 jobs.rs                 3018 incidents.rs           1183 automation.rs
1708 investigations_tests    2147 deployments.rs         1032 incident_claims.rs
1521 automation_worker.rs    1470 telemetry_events.rs      901 pipeline.rs
```

Business modules are the majority of the crate. A platform-only release is therefore
a real subtraction, not a cosmetic one.

### 2.3 Web applications (Measured)

| App | Package | Role | Independent build |
|---|---|---|---|
| `apps/platform-console` | `@opsweave/platform-console` | Platform Console, `basename="/console"` | yes (own `vite build`) |
| `apps/ops-web` | `@opsweave/ops-web` | Ops application, `basename="/app"` | yes |
| `packages/ui` | `@opsweave/ui` | design system | shared |
| `packages/platform-client` | `@opsweave/platform-client` | HTTP client, contracts, i18n | shared |

`apps/platform-web` (the pre-split single SPA) is **absent** from the tree and from
`pnpm-workspace.yaml` — consistent with the G14.2 retirement note.

---

## 3. Kernel → business coupling (Measured)

This is the crux of Phase 0: the brief warns that the frontend split does **not**
prove Kernel independence. It does not, and here is the measured proof.

### 3.1 Compile-time edges

| Edge | Kind | Evidence |
|---|---|---|
| `main.rs` declares every business module | **production** | `apps/kernel/src/main.rs:1-35` |
| `routes.rs` imports and mounts all business routers | **production** | `routes.rs:4,10-13,16,23`; mounts at `routes.rs:275-372` (legacy) and `routes.rs:398-453` (`/api/v1/apps/opsweave.ops/*`) |
| `capabilities.rs` uses the business automation key | **production** | `capabilities.rs:577` → `crate::automation::public_key_hex(&state)` |
| `automation_flow.rs` uses `incidents::AutomationLeaseHandle`, `committed_automation_evidence`, `append_automation_evidence` | **production** | `automation_flow.rs:205,211,377` |
| `automation_worker.rs` constructs `incidents::AutomationLeaseHandle` | **production** | `automation_worker.rs:370,1230,1327` |
| `telemetry_events.rs` calls `incidents::audit_automation_event`, `query_incidents`, `query_incident`, `IncidentListQuery` | **production** | `telemetry_events.rs:412,746,758,813` |
| `audit.rs` calls `incidents::incident_status` | **TEST-ONLY** (`#[cfg(test)] mod` starting `audit.rs:370`) | `audit.rs:940` |
| `workspaces.rs` → `incidents::workspace_not_found` | **REMOVED already** | constructor now lives in `workspaces.rs:41-47`, with a comment recording the move (G14.1) |

The `audit` edge is inside a test module, so it does not, by itself, force business
code into a release binary. The `capabilities`, `automation_*` and `telemetry_events`
edges do.

### 3.2 Startup effects (Measured)

`apps/kernel/src/main.rs:62-77` runs unconditionally, regardless of which plugins or
applications are installed:

| Step | Line | Business effect |
|---|---|---|
| `db::connect` + `db::migrate` | 62-63 | applies **all 35 migrations**, creating every business table (`incidents`, `telemetry_sources`, `pipeline_jobs`, `automation_*`, …) even on a platform-only install |
| `db::init` → `seed_admin`, `seed_trusted_publisher` | 66 | platform-only; both no-op without env configuration |
| `telemetry_sources::sync` | 67-74 | **writes `kernel.telemetry_sources`**: disables every source not named in `OPSWEAVE_AUTOMATION_SOURCES` (`telemetry_sources.rs:132-139`). On a platform-only box this runs against an empty config and touches business data |
| `deployments::spawn_reconciler` | 75 | platform-only (node/deployment reconciliation) — correctly scoped |
| `automation_worker::spawn` | 76 | **business Worker**, runs forever: claims and executes automation jobs, appends Evidence to incidents |
| `nodes::spawn_resource_retention` | 77 | platform-only (node sample retention) |

So the claim "no business background tasks run on a platform-only install" is
**FALSE today**: one business worker and one business registry sync start on every
boot, with no configuration switch.

### 3.3 Built-in business rows (Measured)

`apps/kernel/migrations/0035_applications_and_grants.sql`:

- Inserts **two** `kernel.applications` rows: `opsweave.ops` (`surface_prefix=/app`)
  and `opsweave.console` (`/console`).
- Grants `opsweave.console` to **every existing user** and `opsweave.ops` to every
  workspace member **plus every admin**.

`opsweave.console` is arguably platform. `opsweave.ops` is a business application
registered unconditionally at migration time — on a platform-only install it exists
with no bundle behind it, which is a dangling surface. This is additive-data, not
destructive, so the fix can be a migration + seed policy, not a schema rewrite.

`applications.rs:33` hard-codes `pub const OPS_APPLICATION: &str = "opsweave.ops"` in
Core and `applications.rs:163-178` exposes `require_ops_application` as a Core
middleware. That is a Core module naming one business application — the same class of
inversion ADR-022 §2.2 forbids, just expressed as a constant rather than an import.

### 3.4 Node Runtime and pipeline worker (Measured)

- `apps/node/Cargo.toml` depends only on `opsweave-contracts` and `opsweave-http-body-guard` — **no business crate**. Node is platform-clean at the crate level.
- `apps/node` does spawn a pipeline worker supervisor (`worker_supervisor.rs`), gated by `OPSWEAVE_NODE_WORKER_ENABLED` + a marker file (documented in `deployments/staging/README.md` §6). Gate default is off in the binary, on in staging compose. **Configurable, but the business binary is baked into the shipped image** (`deployments/staging/Dockerfile:74`).

---

## 4. Packaging and installation (Measured)

### 4.1 What the shipped image contains

`deployments/staging/Dockerfile`:

| Component | Path | Business? |
|---|---|---|
| `opsweave-kernel` | `/usr/local/bin` | mixed (see §3) |
| `opsweave-node` | `/usr/local/bin` | platform |
| `opsctl` | `/usr/local/bin` | platform/recovery CLI |
| `opsweave-pipeline-worker` | `/usr/local/bin` | **business** |
| Platform Console bundle | `/app/web` | platform |
| Ops Web bundle | `/app/ops-web` | **business** |
| `docker` CLI | `/usr/local/bin` | required by Node adapter |

`deployments/staging/compose.yaml` sets `OPSWEAVE_OPS_WEB_DIST=/app/ops-web`
unconditionally, so the deployed staging instance always serves the business bundle.

**There is exactly one distribution artifact today, and it is the full product.**

### 4.2 Installer defaults

| Entry point | Default behaviour | Business install? |
|---|---|---|
| `scripts/opsweave.sh up` | `WITH_DATA` defaults to **`1`** (`opsweave.sh:162`); builds and activates Data Catalog + Data Integration (`install_data` at `:85-92`). An opt-out exists — `WITH_DATA=0 ./scripts/opsweave.sh up` is documented at `:315` — but the default installs business plugins | **YES, by default** |
| `scripts/opsweave.sh start` | `WITH_DATA` defaults to `0` | no, unless `WITH_DATA=1` |
| `scripts/demo_up.sh` | builds both web apps (`:43`), starts Kernel + 2 Nodes, loads Hello reference plugins | reference plugins, by design |
| `scripts/demo_data_up.sh` | installs Data plugins | **YES** |

`opsweave.sh` also refuses to start without the four Hello plugin bundles on disk
(`check_bundles`, `opsweave.sh:57-66`), and `ensure_plugins` rebuilds them if missing.
So even `start` cannot run on a machine without plugin artifacts — a platform-only
operator must produce Go/Maven/Docker builds first.

`opsweave.sh` prints a fixed demo credential in its success message
(`opsweave.sh:82`, `admin: admin@opsweave.local / <fixed>`) and `demo_up.sh:9-10`
defaults `ADMIN_EMAIL`/`ADMIN_PASSWORD` to that same fixed pair. Recorded as a gap,
not repeated here; see §7.

### 4.3 Release engineering

| Capability | Status | Evidence |
|---|---|---|
| SHA-tagged immutable image | **PARTIAL** | `staging-preview.yml` builds `ghcr.io/baicie/opsweave:<sha>`; no `latest` per README §1 |
| Image digest pinning in compose | **MISSING** | compose uses `${OPSWEAVE_IMAGE}` (a tag), not `@sha256:` |
| Image signature (cosign or equivalent) | **MISSING** | no occurrence in workflows |
| SBOM generation | **MISSING** | no occurrence in workflows |
| Vulnerability scan gate | **MISSING** | no trivy/grype/snyk in workflows |
| Versioned platform-only artifact | **MISSING** | no second image, no tarball target |
| Release notes / changelog per release | **PARTIAL** | `CHANGELOG.md` exists; not tied to an artifact digest |
| Upgrade/rollback runbook | **PARTIAL** | staging README §5 states rollback = previous SHA; forward-only migrations noted |
| Backup/restore drill | **PARTIAL** | `scripts/backup.sh` / `scripts/restore.sh` exist; coverage not verified this session |

---

## 5. Gate structure (Measured — file inventory only)

`.github/workflows/`: `ci.yml`, `data-foundation.yml`, `g12-acceptance.yml`,
`reliability.yml`, `staging-preview.yml`, `typed-pipeline-contracts.yml`,
`typed-pipeline-runtime.yml` — seven workflows.

| Job (ci.yml) | What it proves |
|---|---|
| `rust` | fmt, clippy `-D warnings`, `cargo test --workspace` **against a real PostgreSQL 17 service**, plus a post-run assertion that DB-backed tests actually connected |
| `web` | per-package typecheck + build for both applications and both plugins; i18n, status-vocabulary, UI-token ratchet, retired-path gates and their counterfactual suites |
| `web-unit` | vitest for `platform-client`, `ui`, `platform-console`, `ops-web` |
| `zabbix-plugin` | real socket + real PostgreSQL for the Zabbix plugin |

Two structural observations relevant to P001:

1. **No workflow builds the staging image on a pull request.** The G14 report §3a
   admits this cost a merge-time breakage once. A platform-only packaging change
   would be verified for the first time on `main`.
2. **No workflow asserts a platform-only boot** (Kernel running with
   `OPSWEAVE_OPS_WEB_DIST` unset and no business plugins installed). That is the
   single most important missing gate for this release, and it is missing today.

Test inventory (Measured, static grep):

```
$ grep -c "#\[tokio::test\]" apps/kernel/src/*.rs   → sum = 184
$ grep -c "#\[test\]"       apps/kernel/src/*.rs   → sum = 118
```

Business test files dominate: `incidents_tests.rs` 65 async + 9 sync,
`investigations_tests.rs` 23 + 20. Any platform-only build must keep those suites
running for the **full** product; it must not delete them to make a lighter build.

---

## 6. Gap register

Each row: **EXISTS** (capability present and adequate), **PARTIAL** (present but
insufficient for a platform-only release), **MISSING** (absent), **BLOCKED** (could
not be determined).

| # | Gap | Status | Evidence |
|---|---|---|---|
| G-01 | Platform-only compile target (feature/binary/crate) | **MISSING** | no `[features]`, no `[[bin]]`, 0 `cfg(feature)` |
| G-02 | Kernel independent of business modules | **MISSING** | `main.rs:1-35`, `routes.rs:4-25`, `capabilities.rs:577` |
| G-03 | Boot without business background workers | **MISSING** | `main.rs:67,76` unconditional |
| G-04 | Boot without business DB objects | **MISSING** | 35 migrations always applied; a platform-only binary would still create `incidents`, `pipeline_jobs`, … |
| G-05 | Boot without an ops application row | **MISSING** | `0035_applications_and_grants.sql` inserts `opsweave.ops` unconditionally |
| G-06 | Core has no business constant | **PARTIAL** | `OPS_APPLICATION` + `require_ops_application` live in Core |
| G-07 | Serves console without the ops bundle | **EXISTS** | `OPSWEAVE_OPS_WEB_DIST` is `Option` (`config.rs:16,122`); `routes.rs:463-467` mounts only when present |
| G-08 | Installer defaults to platform-only | **MISSING** | `opsweave.sh:162` `WITH_DATA` defaults `1`; opt-out documented at `:315` but not the default |
| G-09 | Installer runs without plugin bundles on disk | **MISSING** | `check_bundles` `opsweave.sh:57-66` |
| G-10 | Installer runs without a Rust/Go/Maven toolchain | **MISSING** | `ensure_build`/`ensure_plugins` compile from source |
| G-11 | Platform-only distribution artifact | **MISSING** | one image, both bundles + worker |
| G-12 | Image digest pinning | **MISSING** | tag only, `compose.yaml` |
| G-13 | Signature / SBOM / vulnerability gate | **MISSING** | absent from all workflows |
| G-14 | No fixed demo credential in install instructions | **MISSING** | `opsweave.sh:82`, `demo_up.sh:9-10` |
| G-15 | Bootstrap admin requires a supplied password | **EXISTS** | `auth.rs:445-484` — aborts if email set without password |
| G-16 | Persisted node identity across restart | **EXISTS** | staging README §3; `node-identity.json` |
| G-17 | Postgres persistent volume | **EXISTS** | `compose.yaml` postgres volume |
| G-18 | Health checks (`/livez`, `/readyz`) | **EXISTS** | `diagnostics.rs:10-37` |
| G-19 | Graceful shutdown | **EXISTS** | `main.rs:88-95`, `shutdown_signal` at `:111-131` |
| G-20 | Backup / restore documented and drilled | **PARTIAL** | scripts exist; drill not evidenced |
| G-21 | CI gate for platform-only boot | **MISSING** | no workflow |
| G-22 | CI builds the staging image on PRs | **MISSING** | `staging-preview.yml` triggers on `main` push only |
| G-23 | Plugin golden path as an automated suite | **PARTIAL** | `tests/acceptance/*.sh`, `runtime/` exist; a single end-to-end path (upload→stage→deploy→activate→call→upgrade→rollback→disable→uninstall) not identified |
| G-24 | Multi-language runtime conformance | **PARTIAL** | Hello Go/Java/TS plugins exist; black-box parity suite not located this session |
| G-25 | mTLS Kernel↔Node | **MISSING** | ADR-009 describes transport; no cert lifecycle in code found this session |
| G-26 | Rootless Docker enforcement | **PARTIAL** | Node drives `docker` CLI (`apps/node/src/docker.rs`); rootless not enforced |
| G-27 | Branch protection | **MISSING** | measured `404 Branch not protected`, `rulesets: []` (§1.7) |
| G-28 | Staging browser acceptance green on `main` | **MISSING** | `staging-preview` run 42638784615 failed; `ui-table-audit.spec.ts:755` ×3 (§1.5) |
| G-29 | Staging failure root-caused with a trace | **MISSING** | trace artifact not downloaded; diagnosis narrowed but not concluded (§1.5) |

---

## 7. Findings that change the plan

Three conclusions follow from the measurements and are recorded here because they
alter what Phase 1 must actually do:

**F-1. Frontend independence is real; Kernel independence is not.** G14.2 did split
the bundles, and `OPSWEAVE_OPS_WEB_DIST` being `Option` means the console does serve
without the ops shell (G-07 EXISTS). But every business *handler* is compiled into the
same binary and mounted unconditionally, so "not shipping the ops bundle" hides the
UI while leaving the API live. Per the brief's own rule this is the forbidden
substitution, and it is the state of `main` today.

**F-2. Data separation is the harder half of the work.** Compile-time decoupling is a
module/feature exercise. What makes a platform-only box genuinely independent is that
booting it does not create or mutate incident/telemetry/pipeline rows (G-03, G-04,
G-05). Migrations are forward-only and the brief forbids destructive data changes, so
the resolution has to be additive: feature-gated route mounting, a seed policy that
distinguishes platform rows from application rows, and configurable worker startup —
not a schema fork.

**F-3. The release cannot be judged without a platform-only boot gate.** Right now a
platform-only regression would be invisible: no workflow builds the artifact, none
boots it without business inputs, and branch protection (last measured) does not block
red merges. Writing the gate is cheaper than any future incident it prevents, and it
is the one gate that makes the rest of this programme's claims checkable.

---

## 8. What was not examined

Listed so the next phase does not assume completeness:

- Actual runtime behaviour of a platform-only boot: no Kernel was started for this
  audit; every finding is static (source, manifests, git objects, CI logs).
- The Playwright trace for the `staging-preview` failure. The diagnosis in §1.5 is
  bounded by the workflow log only; the trace would name the exact redirect.
- `tests/acceptance/*.sh` contents beyond filenames; `tests/runtime/`; `tests/contract/`.
- The `plugins/` directory implementations (Data Catalog, Data Integration, Zabbix,
  Hello Go/Java/TS) beyond their existence and build scripts.
- Any performance, capacity, or cost characteristic.
- Real Zabbix, real multi-host, real Rootless Docker: all `NOT_RUN`, as in prior phases.

---

## 9. Next phase input

`Phase 1` can start from this register. The ordering that follows from it:

1. **G-21 first** — a gate that boots the Kernel with no ops bundle and no business
   plugins, asserting `/livez`, `/readyz`, login, `/api/v1/applications`, node and
   plugin API. Without it, every later change is unverified.
2. **G-02/G-03** — feature-gate business route mounting and worker startup; keep the
   full product building by default so existing suites are untouched.
3. **G-04/G-05** — additive seed policy: platform rows always, application rows only
   when that application is enabled.
4. **G-08..G-14** — installer profile and artifact work, which needs the above to
   have something real to install.

---

## 10. Branch protection: configuration steps (not claimed as done)

`main` is unprotected (§1.7). This session cannot change repository settings. The
steps, in the order that actually prevents the failure this phase keeps hitting (a red
workflow on `main` that blocks nothing):

```bash
# Require the checks that already exist and currently only report.
gh api -X PATCH repos/baicie/ops-1/branches/main/protection \
  -F required_status_checks.strict=true \
  -f 'required_status_checks.contexts[]=rust' \
  -F enforce_admins=true \
  -F required_pull_request_reviews.required_approving_review_count=0 \
  -F restrictions= \
  -F allow_force_pushes=false \
  -F allow_deletions=false
```

| Check to require | Why that one |
|---|---|
| `ci / rust` | the only job that runs the Kernel suites against a real PostgreSQL |
| `ci / web` | typecheck + build + i18n/token/retired-path gates |
| `ci / web-unit` | vitest across both applications |
| `staging-preview / smoke the preview` | **currently red** — requiring it before fixing G-28 would block every merge; fix first, then require |

Verification after applying:

```bash
gh api repos/baicie/ops-1/branches/main/protection --jq '.required_status_checks.contexts'
gh api repos/baicie/ops-1/rulesets
```

**Not claimed:** the commands above were not run. Until they are and the output is
pasted into a P001 evidence file, the correct statement is "`main` is unprotected".

---
