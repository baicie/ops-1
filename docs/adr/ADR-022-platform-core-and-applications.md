# ADR-022: Platform Core and business applications

- Status: Accepted (G14.1) — contract first, code follows in G14.2–G14.4
- Date: 2026-11-08
- Related: [ADR-012](ADR-012-capability-fabric-and-plugin-storage.md), [ADR-018](ADR-018-automation-principal.md), [ADR-020](ADR-020-plugin-identity-hardening.md), `docs/design/g13-b0/permission-matrix.md`

## 1. Context

OpsWeave is one product today, and its code says so. The Kernel is a single Rust
binary in which platform concerns and the operations domain are the same
`crate` namespace, and the web application is one Vite bundle in which the
platform console and the ops workspace are two route trees.

Measured at `8f0431ce`, the coupling is concrete rather than stylistic: eight
Kernel modules import the operations domain.

| Core module | Imports from the ops domain | What it actually needs |
|---|---|---|
| `audit` | `incidents::incident_status` | "may this caller read this subject" — a visibility predicate |
| `automation_flow` | `AutomationLeaseHandle`, `committed_automation_evidence`, `append_automation_evidence` | evidence append with a lease |
| `automation_worker` | `AutomationLeaseHandle` | the lease handle type |
| `telemetry_events` | `audit_automation_event`, `query_incidents`, `IncidentListQuery` | event → incident, and a list view |
| `workspaces` | `incidents::workspace_not_found` | a 404 constructor |
| `incident_claims` | `incidents` | — (both are ops) |
| `investigations` | `incidents` | — (both are ops) |
| `routes` | all three | route table |

Read the first column against the third and the architectural fault is visible:
`workspaces` — the module that owns business-workspace membership — is a platform
concern that reaches into the ops domain to build a 404. `audit` — the ledger for
every subject type — reaches into ops to answer a visibility question that is
really a generic predicate over any subject. The direction of dependency is
*inverted* wherever it exists, and `IncidentListQuery` is an ops type appearing
in the telemetry event path.

Two further facts matter for the split:

- **Nothing about the ops domain is in the Kernel's protocol layer.** The
  plugin runtime (`http-json v1`), the Capability fabric, workload/user/automation
  identity (ADR-018, ADR-020), node/OCI lifecycle, storage bindings and the
  durable job engine are all subject-agnostic already. They are used by the ops
  application; they do not require it.
- **The ops domain is already a coherent, separately-tested body of code.**
  `incidents` (8603 lines), `investigations` (4969), `incident_claims` and the
  automation chain are about Incident / Evidence / Verdict / RCA. Nothing else in
  the Kernel is.

## 2. Decision

### 2.1 Three things, never conflated

| Concept | Definition | Owns |
|---|---|---|
| **Platform Core** | the subject-agnostic substrate | identity, workspaces (as containers), authorization primitives, application registry, plugin lifecycle, Node/OCI, Capability Gateway, generic jobs, audit, secrets/storage bindings |
| **Application** | a product built on Core | its own domain model, its own API surface, its own frontend, its own navigation |
| **Plugin** | a signed unit extending a Host | routes/nav contributions **bound to one application**, a backend capability implementation |
| **Workspace** | the tenant boundary for business data | membership; it is *not* an application, a plugin, or a role |

The distinction that the rest of this ADR rests on:

- An **application** is a *product surface*: it owns the routes, the navigation,
  and the domain objects a user files and reads.
- A **plugin** is a *capability provider or a UI extension*. It is not an
  application, and contributing a route does not make it one.
- A **workspace** is a *data boundary*. Two applications can both be used inside
  one workspace (an ops incident and a data catalogue dataset filed under the
  same business unit), and one application can be used across many workspaces.
  Conflating these three is what produces "two sidebars = two apps" — the
  failure mode this phase exists to prevent.

### 2.2 Dependency direction, enforced

```
        ┌───────────────────────────────┐
        │         Platform Core         │   ← knows about NO application
        │ identity · workspaces · authz │
        │ apps registry · plugins · OCI │
        │ capability gateway · jobs     │
        │ audit · secrets · storage     │
        └───────────────┬───────────────┘
                        │ (allowed: Core ← App)
        ┌───────────────┴───────────────┐
        │       Ops Application         │
        │ incident · evidence · verdict │
        │ investigation · RCA · report  │
        └───────────────────────────────┘
```

**Rule: `core → ops` is forbidden.** Concretely, the eight imports in section 1
must be resolved in one of three ways, and this ADR fixes which:

1. **Invert to a trait or a registry entry.** `audit::incident_status` becomes a
   *visibility resolver* registered by the application; audit asks the registry.
   `workspaces::workspace_not_found` becomes a Core error constructor (it never
   needed the ops domain at all).
2. **Move the type to Core.** `AutomationLeaseHandle` is a lease handle — a
   Core concept — and belongs beside the job engine, not in `incidents`.
3. **Accept an application callback.** `automation_flow` appending evidence is
   the automation engine performing an application-defined effect; the shape is
   a Core trait with the ops implementation registered at startup.

What is explicitly **not** decided here: splitting the Kernel into services. The
Kernel stays one process. The boundary is a compile-time module boundary plus a
stable internal interface, because a network boundary would add failure modes
this phase cannot verify.

### 2.3 Data model

```
Tenant (deployment-scoped, implicit today)
  └── Workspace (business data boundary; membership decides visibility)
        └── rows of business data (owned by ONE application)
Application (registered, versioned; owns routes, nav, domain objects)
  └── Capability (provided by a plugin or by Core)
        └── Plugin (signed unit; implements capabilities, contributes UI)
Grant (consumer plugin → capability name+major → scope; optional workspace binding)
```

Invariants:

- A business row names exactly one `workspace_id` (already true since 0022 for
  incidents and since B2.1a for catalogue/sources/jobs) **and** exactly one
  owning application. The application column does not exist yet; it is added
  when a second application registers, not speculatively now.
- A `Grant` never implies a workspace; workspace placement is a separate signed
  claim (ADR-020 §4a). Keeping these apart is what stopped a platform admin from
  inheriting business data.
- A plugin's UI contribution is bound to `(application, namespace, capability)`.
  A plugin that requires `data.catalog.v1` cannot inject a route into an
  application that does not hold that capability.

### 2.4 Application registration contract

An application is registered with Core, not hard-coded into it:

| Field | Meaning |
|---|---|
| `applicationId` | stable key, e.g. `opsweave.ops` |
| `displayName`, `key` | for the console |
| `capabilities[]` | what the application requires from Core/plugins |
| `surfaces[]` | the origin(s) it is served from (G14.3) |
| `version`, `compatibility.kernelApiMajor` | same rules as plugins |

Registration is data. Core must serve a new application without a Kernel code
change; that is the acceptance test for this whole phase, and the reason
"新增应用不能要求修改 Platform Console 的静态路由代码" appears in the brief.

### 2.5 API boundaries

| Surface | Owner | Examples |
|---|---|---|
| **Platform API** `/api/v1/...` (platform routes) | Core | auth, users, workspaces+membership, nodes, plugins, deployments, capability grants, jobs, audit, diagnostics |
| **Application API** `/api/v1/apps/{applicationId}/...` | the application | `.../incidents`, `.../investigations` |
| **Capability API** `/api/v1/capabilities/{name}/{major}/...` | Core routes to a provider plugin | `data.catalog.v1` |
| **Plugin API** `/api/{plugin-prefix}/...` via `/api/v1/gateway` | the plugin | `data-catalog`, `data-integration` |

### 2.6 Compatibility for the existing ops routes

The brief requires that `GET /api/v1/incidents/*` and `/api/v1/investigations/*`
keep working. They **move** to `/api/v1/apps/opsweave.ops/...` and the old paths
remain as **permanent aliases** that forward to the same handlers:

- Same handler, same auth, same response bytes — an alias, not a shim that
  re-implements anything.
- `Deprecation` and `Link: <new>; rel="successor-version"` headers are emitted
  on the alias from the first release that ships the new path.
- No removal is scheduled in this phase. Removing them requires a separate ADR
  with a measured client inventory, because `tests/acceptance/*` and the web
  client both call them today.
- The application path is the only one the new Ops Web client uses, so the alias
  carries no traffic from our own surfaces once G14.2 ships — which is the
  precondition for ever retiring it.

### 2.7 Independent deployment, login and rollback

- **Today**: one origin, one cookie session (`opsweave_session`), same-origin
  `credentials`, CSRF via `x-csrf-token`.
- **Target**: `console.example.com` (Platform Console) and `ops.example.com`
  (Ops Application), each an independent build and deploy.
- **Cross-origin identity** is OIDC Authorization Code + PKCE, never a shared
  parent-domain cookie. The brief forbids the latter and this ADR agrees: a
  parent-domain cookie makes every application's compromise every other's, and
  it is not a federation design — it is a shared secret.
- **Until OIDC exists** the compatibility behaviour is explicit and must be
  stated in the deployment docs, not implied: two origins are served **behind
  one reverse proxy that presents them under one origin** (path-based:
  `/console`, `/app`), preserving the existing cookie session. This is a
  supported local and staging mode, and it is a bridge, not the target.
- **Rollback**: each application is its own static artifact and its own build
  pipeline. Rolling back the Ops Web artifact cannot break the Platform Console,
  because neither imports the other. Core schema changes remain additive with
  the existing migration discipline.

## 3. Minimum third-application proof

The acceptance criterion for G14 is not a diagram. It is:

> a third application can be registered, built, served and authorised **without
> editing the Ops application's routes, navigation or domain code, and without
> copying Core.**

The proof will be a minimal application (working name `opsweave.data-app`) that:

1. registers against Core through the public registration contract;
2. obtains identity and workspace membership from Core;
3. exposes one domain object of its own and one capability call;
4. contributes a navigation entry **only into its own surface**;
5. is denied when its caller lacks the application grant, and denied across
   workspaces.

If any step requires touching `incidents`, `investigations`, or the Ops Web
router, the boundary is wrong and the phase is not done.

## 4. Consequences

**Positive.** A new business application becomes a build and a registration, not
a fork of the platform. The ops domain stops being load-bearing for Core, so a
Core change cannot silently alter incident semantics and vice versa. The plugin
trust boundary stops being conflated with the application boundary.

**Negative / costs.**

- The eight Core→ops edges become indirection (a trait, a registry entry, or a
  moved type). Indirection costs readability; the ADR accepts that in exchange
  for the direction being checkable.
- Two frontends means two builds, two deploy pipelines and two origins to
  operate. G14.3 addresses the identity bridge.
- The alias routes must be maintained until a separate ADR retires them.

**Rejected alternatives.**

- *Microservices now.* A network boundary between Core and ops adds partial
  failure, retries and a new auth hop — all unverifiable in the current
  environment, and none of it is needed to prove the boundary.
- *Two route trees in one bundle* (what exists). It is the thing the brief
  explicitly forbids as a substitute for a real split: it cannot fail
  independently, cannot deploy independently, and its "two apps" share one
  router.
- *A shared parent-domain cookie for SSO.* Forbidden by the brief; also wrong on
  its merits (section 2.7).
- *Speculative `application_id` columns on every business table now.* A column
  nobody filters on is worse than none. It is added when the second application
  registers, with the migration that needs it.

## 5. What this ADR does not claim

- It does not claim the split is implemented. G14.1 is the contract; G14.2
  (frontends) and G14.3 (authorisation/origin) implement it.
- It does not claim OIDC exists. The bridge in 2.7 is what will actually run
  until it does, and it will be documented as a bridge.
- It does not claim any application is installable by a third party today. The
  registry, the install flow and the trust model for third-party applications
  are G14.3's subject.
