# G14 Platform/Application Split — Migration Report

Status: **code complete, CI unconfirmed, Playwright NOT_RUN**

Baseline audited: `8f0431ce` (2026-11-08), verified as `origin/main` HEAD with no open
PRs and five green workflows before any work began.

## 1. What the platform can now do that it could not before

| Capability | Before | Now |
|---|---|---|
| A plugin proves who is calling | data plugins accepted an unsigned role header and never verified the signed user context | one resolver; three token kinds; the role header is not read anywhere |
| A caller reads only its own business data | data tables had no `workspace_id`; every query was global | workspace column, single chokepoint, cross-tenant reads answer 404 |
| A response is bounded while it is read | six call sites buffered then compared; the worker had no bound | `crates/http-body-guard`, fails on the byte that crosses the limit |
| A worker runs more than one job | strictly serial | configurable global and per-source concurrency, lease semantics untouched |
| Platform admin is a business operator | implicitly, everywhere | separate `application_grants`; `403 APPLICATION_FORBIDDEN` without one |
| Two products ship independently | one bundle, two route trees | two applications, two builds, two shells |
| The ops product reads fleet health | via the platform console's `/api/v1/nodes` (endpoint + inventory) | its own granted projection: liveness, staleness, instance counts, resource sample |

## 2. What the Ops application depends on, and what a third application would need

**Core it uses** (all subject-agnostic, none aware of Incident):

identity (`AuthUser`, sessions, CSRF) · business workspaces and membership ·
application registration and grants · the Capability Gateway and provider
resolution · Node/OCI lifecycle · the durable job engine · audit · plugin storage
bindings · the static-site mounts.

**Ops-owned**: `incidents`, `incident_claims`, `investigations`, the automation
chain that produces Evidence, and the Ops Web.

**To add a third application** (`data.example.com`), per ADR-022 §3:

1. `INSERT` into `kernel.applications` — registration is data, not a Kernel change.
2. Grant it to accounts (`kernel.application_grants`); membership is what then
   bounds the rows they read.
3. Build a Vite application with its own router and its own `index.html`, under its
   own `basename`, importing `@opsweave/ui` and `@opsweave/platform-client`.
4. Serve it from a `StaticSite` mount; `OPSWEAVE_*_WEB_DIST` already supports it.

**No step requires touching the Ops application's routes, navigation or domain
code, and none requires copying Core.** That is the acceptance criterion, and the
structure now enforces it: `packages/*` cannot import `apps/*`, and the two
applications do not name each other.

## 3. Verified locally (real PostgreSQL 17, real processes)

| Check | Result |
|---|---|
| `cargo test -p opsweave-kernel` | **274/274** |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo fmt --all -- --check` | clean |
| `@opsweave/ui` / `platform-client` / `platform-console` / `ops-web` vitest | **58 / 113 / 62 / 236** |
| both applications build | pass |
| **build independence** (break ops-web, build console) | console **exit 0** |
| `tests/ci/b2_plugin_identity_attack.test.mjs` | **7/7** (pre-fix: **1/7**) |
| `tests/ci/b2_workspace_isolation.test.mjs` | **3/3** (pre-fix: **0/3**) |
| `crates/http-body-guard` | **7/7**, incl. an endless chunked upstream over a real socket |
| `tests/reliability/run.sh --all` | **4/4** |
| contracts / spec-coverage / PNG budget / i18n / status-vocabulary / UI tokens / retired paths | all pass (942 files, 0 retired references) |

## 4. NOT correctly verified — read this before claiming readiness

- **Playwright was never executed locally.** Spec paths and assertions were updated
  and the kernel-side routing has unit tests, but no browser run happened here.
  Every "the E2E is fixed" statement in the PRs means "the assertion and the route
  agree", not "the browser passed".
- **CI state is unconfirmed at the time of writing.** Several rounds of failures
  were fixed; the last push had not completed.
- **No throughput benchmark.** The worker concurrency change is verified correct,
  not measured faster. Defaults (4 global, 1 per source) are conservative starting
  points, not tuned values.
- **staging core-tier vs full-tier were not recorded** in this phase. The brief asks
  for them separately and this report does not have them.

## 5. Production conditions still not met

Each of these was true at the baseline and is true now; none is addressed by G14.

| Condition | Status |
|---|---|
| mTLS / certificate lifecycle for Node transport | **NOT_RUN** |
| OCI image signature verification | **NOT_RUN** (digest pinning is enforced; signatures are not) |
| Real Zabbix against a live server | **NOT_RUN** (fixtures only) |
| Three physical Linux hosts, Rootless Docker | **NOT_RUN** |
| Production secret management | **NOT_RUN** (per-plugin and per-workspace secrets are wired; no vault) |
| OIDC Authorization Code + PKCE across origins | **NOT_IMPLEMENTED** — both applications still share one origin and one cookie session; the single-origin reverse proxy is the documented interim bridge |
| Application-registry UI for third-party install | **NOT_IMPLEMENTED** — installation is a `psql` insert today |

## 6. Known structural gaps this phase deliberately left

- **`Core → ops` edges remain.** Eight were measured; one (`workspaces →
  incidents::workspace_not_found`) was removed because it needed no design. The
  other seven need a trait or a registry and are listed in ADR-022 §2.2. `routes`
  importing all three ops modules is the largest.
- **Pipeline definitions are not workspace-owned.** Two users in different
  workspaces can publish revisions of the same `pipelineId`. The Catalog read is
  scoped to the acting user, but the pipeline resource itself is not.
- **`sources` still reads platform APIs.** The page renders inside the Ops
  application and refuses nothing, but every read is `/api/v1/plugins`,
  `/api/v1/capability-grants` or `/api/v1/publishers`. It is `shipped: false` and
  needs a workspace-scoped source registry.
- **The Ops Web does not yet hide entries from `applications`.** The server
  refuses them (`403`), so it is a UX gap, not an authorization hole.
- **`incidents.rs` / `investigations.rs` production code was not split.** Only the
  test suites moved (via `include!`, behaviour-preserving). Splitting the
  production code would rewrite the modules B2.1/B2.1a just changed.
- **`/api/v1/incidents/*` aliases are permanent for now.** Retiring them needs a
  client inventory and its own ADR (ADR-022 §2.6).

## 7. Evidence trail

| PR | Scope | Local evidence |
|---|---|---|
| #65 | plugin identity | attack suite 1/7 → 7/7; zabbix 25/25; reliability 4/4 |
| #66 | data-plane workspace isolation | isolation 0/3 → 3/3; cross-plugin write propagation |
| #67 | bounded reads + concurrency | endless chunked stream cut by size; worker 20/20 |
| #68 | Core/application boundary ADR | 8 edges measured, 1 removed |
| #69 | two independent applications | build independence proven; retired-path gate 0 |
| #70 | application authz + ops observability | admin without a grant refused; fleet projection leak test |
