# P001 Phase 1 — Platform / Business Decoupling

Status: **implemented, verified locally on both builds; NOT merged, NOT reviewed.**

Branch: `feat/p001-platform-only-build` (Draft PR opened from it).
Depends on: `docs/acceptance/p001/00-baseline-audit.md` (gap register G-01…G-06).

---

## 1. What was wrong, restated as a measurement

The baseline audit established three facts and this phase answers them:

| Baseline finding | Evidence there |
|---|---|
| No platform-only build mechanism existed: no `[features]`, no `[[bin]]`, zero `cfg(feature)` in the Kernel | §2.1, G-01 |
| Nine business modules were unconditional compile units of the one Kernel crate | §3.1, G-02 |
| One business worker and one business registry sync started on every boot, with no switch | §3.2, G-03 |

The frontend split (G14.2) was real, and `OPSWEAVE_OPS_WEB_DIST` being optional
already let the console serve without the ops bundle. What was missing is the layer
below it: the binary still contained every incident/investigation/automation handler
and still ran the automation worker. "Do not ship the ops bundle" hid the UI and left
the API live — the substitution the brief forbids.

---

## 2. What changed

### 2.1 A real compile-time boundary

`apps/kernel/Cargo.toml` gains one feature:

```toml
[features]
default = ["business-ops"]
business-ops = []
```

`business-ops` is **on by default**, so every existing build, test suite, CI job and
deployment is byte-for-byte unaffected in behaviour. Turning it off is the
platform-only build:

```bash
cargo build -p opsweave-kernel --no-default-features
```

With it off, these modules are **not compiled**: `automation`, `automation_flow`,
`automation_worker`, `incident_claims`, `incidents`, `investigations`,
`ops_observability`, `telemetry_events`, `telemetry_sources`
(`apps/kernel/src/main.rs:34-52`).

This is the distinction that matters: not "the routes refuse", but "the handlers do
not exist". There is no code path to reach, and no guard to misconfigure.

### 2.2 Startup

`main.rs` now starts the automation worker and reconciles the telemetry-source
registry **only in a business build**. The platform worker
(`deployments::spawn_reconciler`, `nodes::spawn_resource_retention`) runs in both —
node reconciliation and resource retention are about the platform's own substrate.

Measured on a platform-only boot: no `automation job worker` line, no
`telemetry_sources` write on an empty configuration.

### 2.3 Route surface

`routes::build` was restructured from one chained expression into a platform router
plus a feature-gated business router merged into it. Three groups are gated:

| Group | Paths | Platform-only answer |
|---|---|---|
| public business | `POST /api/v1/telemetry/events`, `POST /internal/v1/nodes/{id}/automation-principals` | `404 BUSINESS_ROUTE_NOT_BUILT` |
| protected business | `/api/v1/incidents*`, `/api/v1/business-workspaces*`, `/api/v1/telemetry/sources`, `/api/v1/automation-principals/*` | same |
| application surface | `/api/v1/apps/opsweave.ops/*` | route group not merged at all |

**Why `404 BUSINESS_ROUTE_NOT_BUILT` and not `403`.** They are different facts.
`403` means "this deployment has the application and you may not use it", and an
operator would go looking for a grant that would not help. The stable code tells the
difference without parsing prose, and the platform's own `403 APPLICATION_FORBIDDEN`
is untouched in a business build.

### 2.4 The signing key moved to Core

`capabilities.rs` published `OPSWEAVE_AUTOMATION_PUBLIC_KEY` by calling
`automation::public_key_hex`. That was a Core → business edge that would have made a
platform-only build fail to compile the Capability Gateway.

The derivation now lives in a new Core module `signing.rs`, and `automation.rs`
delegates to it, so there is exactly one derivation and no chance of two keys
drifting apart. `signing.rs` carries three tests: the key is stable for one secret,
different for another, and a signature verifies only against the payload that was
signed.

### 2.5 `/app` is refused in a platform-only build

Measured before the fix: `GET /app/incidents` returned **200** on a platform-only
binary, because `/app` is in the console's client-route prefix table and the console
shell answered it. The browser would mount a router that owns none of those routes and
render a not-found page — a page that loads and does nothing.

Now `static_site::resolve_primary` returns `Missing` for the `/app` prefix when
`business-ops` is off. Measured after: `/app` and `/app/incidents` are **404**, while
`/` and `/admin/overview` stay **200**.

### 2.6 Application registry reports only what the binary can serve

The registry is data and survives a rollback, so a database that ran the full product
and then switched binaries still has `opsweave.ops` rows and grants. Reporting them
as enabled advertises a surface the binary cannot route.

`applications::servable_application` is now the gate: an application is reported (and
usable) only when the row says enabled **and** this binary contains its handlers. The
rows are deliberately **not** deleted or disabled — application registration is
deployment data (ADR-022 §2.4), and rolling back to the full binary must restore the
surface without a re-seed.

`require_application` answers `404 APPLICATION_NOT_BUILT` for such an application
before consulting any grant, for the same reason as §2.3.

### 2.7 A pre-existing defect this phase found and fixed

While verifying the platform-only boot, `GET /api/v1/applications` reported the
bootstrap administrator as **denied** `opsweave.console` on a fresh database.

Root cause, and it is not about features: migrations run before `seed_admin`
(`main.rs:78` then `:81`), and migration `0035` grants `opsweave.console` to the
accounts that existed **when it ran**. A deployment created afterwards therefore had
an administrator with no console grant. The console does not gate on that grant today
(its guard is the `platform:access` surface, which the admin role carries), so nothing
was blocked — but the platform reported its own administrator as not permitted to open
the platform console.

Fixed additively in `migrations/0036_admin_holds_console_grant.sql`: it repairs
existing admin accounts and adds a trigger so an account created later through any
path holds the grant. It inserts a grant and never deletes one; permissions stay
`ARRAY[]::text[]`, exactly as 0035 wrote them, so it cannot widen a verb.

> This defect exists on `main` today and is independent of this branch. It is
> recorded here because this phase's verification is what surfaced it.

---

## 3. Verification (real, reproducible)

All commands below were run in this checkout. Nothing is inferred.

### 3.1 Builds

| Command | Result |
|---|---|
| `cargo build -p opsweave-kernel` | **pass**, 0 warnings |
| `cargo build -p opsweave-kernel --no-default-features` | **pass**, 0 warnings |
| `cargo clippy -p opsweave-kernel --all-targets -- -D warnings` | **pass** |
| `cargo clippy -p opsweave-kernel --no-default-features --all-targets -- -D warnings` | **pass** |
| `cargo fmt --all -- --check` | **pass** |

### 3.2 Tests

| Suite | Result |
|---|---|
| `cargo test -p opsweave-kernel` (full product) | **279 passed**, 0 failed (was 276 on `main`; +3 signing tests) |
| `cargo test -p opsweave-kernel --no-default-features` | **113 passed**, 0 failed |
| Repeat runs, full product ×5 | 279/279 each time |
| Repeat runs, platform-only ×10 | 113/113 each time |

Business-only suites (`incidents_tests` 74, `investigations_tests` 43, automation
worker 17, telemetry 15, …) **still exist and still run** in the full product. None
was deleted or skipped to make the light build pass; the light build simply does not
contain them, and the heavy build runs all of them.

**One test had to be gated, and why it is not a relaxation.** `scope`'s
`the_old_predicate_is_gone_from_the_kernel` reads `incidents.rs` through
`include_str!`. In a build where that file's module is not compiled, it is a
source-analysis test about a file the build does not ship. It is gated on
`business-ops`, so **the product build still runs it against the same file**. The same
is true of `audit`'s ledger/incident parity test, which compares two implementations
and one of them is the Ops module.

### 3.3 Real boot — platform-only

Started `target/debug/opsweave-kernel` (built `--no-default-features`) against a
fresh PostgreSQL database, `OPSWEAVE_OPS_WEB_DIST` unset:

| Probe | Result |
|---|---|
| `GET /livez` | `200 {"status":"live"}` |
| `GET /readyz` | `200 {"database":"connected","status":"ready"}` |
| `POST /api/v1/auth/login` (bootstrap admin) | `200`, session cookie + CSRF issued |
| `GET /api/v1/auth/me` | `200`, `allowedSurfaces: ["workspace","admin"]` |
| `GET /api/v1/applications` | `{"applications":[{"applicationId":"opsweave.console",…}], "denied":[]}` |
| `GET /api/v1/plugins` | `200`, one system plugin (`dev.opsweave.ops-center`) |
| `GET /api/v1/nodes` | `200 []` |
| `GET /api/v1/diagnostics` | `200`, `bootstrap.availableWithoutPlugins: true` |
| `GET /` | `200` (console shell) |
| `GET /admin/overview` | `200` |
| `GET /app` | **`404`** |
| `GET /app/incidents` | **`404`** |
| `POST /api/v1/telemetry/events` | **`404 BUSINESS_ROUTE_NOT_BUILT`** |
| `GET /api/v1/incidents` (with a valid session) | **`404`** — no handler, not a 403 |

Business tables exist (the migrations are shared) and hold **zero** rows:
`incidents 0`, `telemetry_sources 0`, `pipeline_jobs 0`. No business background
worker logged a line.

### 3.4 Real boot — full product (regression)

Same checkout, default features, fresh database, both bundles mounted:

| Probe | Result |
|---|---|
| `GET /api/v1/applications` | console granted, `opsweave.ops` denied to an admin with no workspace (correct: application access is not a workspace grant) |
| `GET /app/incidents` | `200` |
| `GET /api/v1/incidents` (authenticated) | `200` |
| `GET /api/v1/apps/opsweave.ops/incidents` | `401` unauthenticated (route exists, auth required) |
| `POST /api/v1/telemetry/events` | `415` (route exists, body required) |

So the split is real in both directions: the light build has no business surface, the
heavy build is unchanged.

---

## 4. What this phase deliberately did **not** do

Stated explicitly so the next phase is not built on a false premise.

1. **`jobs` and `pipeline` remain in both builds.** ADR-022 §2.1 assigns the generic
   durable job engine to Platform Core, and `jobs` is a 4 331-line engine that the
   platform's own diagnostics read. Separating "generic job runtime" from "pipeline
   business capability" is a larger refactor than a feature flag, and pretending
   otherwise by gating `jobs` would break `/api/v1/diagnostics`. Recorded as **G-30**.
2. **Migrations are still shared and unconditional** (G-04). A platform-only boot
   creates `kernel.incidents`, `kernel.pipeline_jobs` and the rest. They stay empty and
   nothing reads them, but the schema is not split. Splitting it needs a migration
   ownership decision (which migrations belong to which application) that ADR-022 does
   not make. Recorded as **G-04**.
3. **`scope` has no platform consumer** in the light build. It is Core vocabulary and
   stays compiled, with an explicit module note rather than a silent allowance.
4. **No installer or packaging work.** `scripts/opsweave.sh up` still defaults to
   installing Data plugins (G-08), and the staging image still bakes both bundles
   (G-11). That is Phase 2.
5. **No CI gate yet.** No workflow builds `--no-default-features` or boots it. That is
   the single highest-value follow-up and is named in §5.

---

## 5. Required follow-ups, in order

| # | Follow-up | Why it must come first/next |
|---|---|---|
| 1 | **A CI job that builds and boots `--no-default-features`**, asserting the table in §3.3 | Without it this boundary can regress silently; it is the gate that makes every later claim checkable |
| 2 | `scripts/opsweave.sh` platform-only profile (no Data, no Hello, no toolchain) | Phase 2; needs a binary that has nothing to install |
| 3 | Platform-only image + compose profile without `/app/ops-web` and without the pipeline worker | Phase 2 packaging |
| 4 | Split migration ownership (G-04) | Needs an ADR decision before code |
| 5 | Separate the generic job engine from the pipeline capability (G-30) | Largest remaining Core→business question |

---

## 6. Risk and rollback

| Risk | Mitigation |
|---|---|
| A default build changes behaviour | Every change is behind `business-ops`, which is **on** by default. Full-product tests: 279/279, and the live regression in §3.4. |
| `sqlx::migrate!` embeds migrations at compile time | Observed during verification: a new `.sql` file needs a rebuild. Operationally this already held (the binary applies its own embedded set); it is called out because it confused a live check in this session. |
| Migration 0036 adds a trigger | Additive, `ON CONFLICT DO NOTHING`, inserts only. Rollback = drop the trigger and function; no grant is removed by the forward path, so no data is lost either way. |
| An operator switches to the light binary with business data present | Nothing is deleted. The business rows stay; the application is reported as not built and its routes are absent. Switching back restores both, because the rows were never touched. |

---

## 7. Evidence index

| Artifact | Location |
|---|---|
| Baseline audit and gap register | `docs/acceptance/p001/00-baseline-audit.md` |
| Feature declaration and rationale | `apps/kernel/Cargo.toml` |
| Module gating and startup | `apps/kernel/src/main.rs` |
| Route gating and `BUSINESS_ROUTE_NOT_BUILT` | `apps/kernel/src/routes.rs` |
| Signing key moved to Core | `apps/kernel/src/signing.rs`, `apps/kernel/src/automation.rs` |
| `/app` refusal | `apps/kernel/src/static_site.rs` |
| Servability gate | `apps/kernel/src/applications.rs` |
| Admin console grant fix | `apps/kernel/migrations/0036_admin_holds_console_grant.sql` |
