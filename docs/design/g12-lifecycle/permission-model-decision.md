# G12 C · Incident permission model — decision record (NOT a policy change)

| | |
|---|---|
| Status | **Open — 7 DECISION REQUIRED items below; no policy has been changed by G12 C** |
| Scope | Who may read and write `kernel.incidents` and everything hanging off it |
| Code | `apps/kernel/src/incidents.rs`, `apps/kernel/src/auth.rs`, `apps/kernel/src/jobs.rs` |
| Contract | `contracts/openapi/incident-v1.yaml` |
| Date | 2026-10-31 |
| Author-role | Principal Engineer + Security Reviewer (G12 C) |

## 0. What this document is, and what it deliberately is not

Phase C was asked to review the permission model, **not to replace it**. The model in force is
inherited from the Jobs slice and has been in the product since G11; changing it because a reviewer
prefers another one would rewrite the authorization posture of every existing incident, job and
deployment row without a single line of evidence that the current one is wrong for the users it
has. So this document does exactly three things:

1. **states what the code actually does today**, with a file/line and a test for every claim — the
   sections marked 「proved」 name the artefact that proves them;
2. **names the questions that engineering must not answer on its own** (product/security decisions),
   each with a recommendation and the single fact that would overturn it;
3. **forbids a claim the current version cannot support** (§6: there is no provable cross-business
   isolation in this release, so nobody may describe it as production multi-tenant isolation).

Nothing in §1 is aspirational. If it is written here, a test asserts it.

---

## 1. The model in force (proved)

### 1.1 Two independent mechanisms, and they are not the same thing

| Mechanism | Question it answers | Where |
|---|---|---|
| **Role gate** | *May this account perform this kind of write at all?* | `AuthUser::require_operator()` (`auth.rs:35`), `require_admin()` (`auth.rs:45`) |
| **Data scope predicate** | *Which rows may this account see and act on?* | `Caller::sees_all` (`incidents.rs:120`), applied in every read and every locked write |

The role gate is a closed set of three roles (`Role::{Admin,Operator,Viewer}`, `crates/contracts/src/lib.rs:745`).
The data scope is one boolean computed once:

```rust
// apps/kernel/src/incidents.rs:120 - verbatim, and deliberately identical to the job list
sees_all: auth.role.is_admin() || !auth.role.can_operate(),
```

`can_operate()` is `Admin | Operator`, so `sees_all` is **true for admin and viewer, false for
operator**. That single line is the whole ownership model: **an operator reads and writes only the
incidents it owns; a viewer reads every incident; an admin reads and writes every incident.**

It is not invented by this slice. It is the same predicate the job list has used since G08
(`jobs.rs`, the job list query binds `auth.role.is_admin() || !auth.role.can_operate()`), and
`incidents.rs:1-11` records the copy on purpose so the two resources cannot drift apart.

### 1.2 Every surface applies it (proved)

| Surface | Role gate | Data scope | Artifact |
|---|---|---|---|
| `POST /incidents` | `require_operator` | — (owner = caller) | `incidents.rs:522` |
| `GET /incidents` (list) | any authenticated | `($1::boolean OR i.owner=$2)` | `incidents.rs:975` |
| `GET /incidents/{id}` | any authenticated | `($1::boolean OR i.owner=$2)` | `incidents.rs:975` |
| `POST …/evidence` | `require_operator` | `incident_status()` predicate | `incidents.rs:561`, `incidents.rs:1678` |
| `GET …/evidence` | any authenticated | same predicate | `incidents.rs:1678` |
| `GET …/evidence/{id}/content` | any authenticated | same predicate | `incidents.rs:1678` |
| `POST …/verdict` | `require_operator` | locked `SELECT … OR owner=$3` | `incidents.rs:718`, `incidents.rs:1500` |
| `GET …/verdict` | any authenticated | same predicate | `incidents.rs:1678` |
| `POST …/close` (**G12 C**) | `require_operator` | locked `SELECT … OR owner=$3` | `incidents.rs:754`, `incidents.rs:1500` |
| `POST …/owner` (**G12 C**) | `require_operator` | locked `SELECT … OR owner=$3` | `incidents.rs:774`, `incidents.rs:1500` |
| `GET …/timeline` (**G12 C**) | any authenticated | same predicate as the incident | `incidents.rs:1678` |

Note what the predicate does for a **write**: the `SELECT … FOR UPDATE` that decides whether a close
or a handover is allowed is the *same query* that filters reads. An operator cannot close, hand over
or append to an incident it cannot read, and the answer is `404 INCIDENT_NOT_FOUND` rather than
`403` — the refusal does not confirm that the record exists (`incidents.rs:1341`, `incidents.rs:1479`).

### 1.3 The role × operation matrix, as tested

| Actor | Read any incident | Read any trail | Evidence | Verdict | Close | Handover |
|---|---|---|---|---|---|---|
| **admin** | yes | yes | yes | yes | yes (any incident) | yes (any incident) |
| **operator, owner** | yes | yes | yes | yes (once) | yes, from CONCLUDED | yes |
| **operator, not owner** | **no (404)** | **no (404)** | no (404) | no (404) | no (404) | no (404) |
| **viewer** | yes | yes | **no (403)** | **no (403)** | **no (403)** | **no (403)** |

Proved by, in order:

- `incidents::tests::viewer_is_refused_at_the_handler_and_operator_and_admin_are_not` — drives the
  real axum handler with a real `AuthUser` per role; viewer → `403 FORBIDDEN`, operator/owner and
  admin → `201`.
- `incidents::tests::viewer_is_refused_at_the_handler_for_close_and_handover` — the same for the two
  new endpoints, and it re-reads the incident afterwards to prove the refused write wrote nothing.
- `incidents::tests::only_the_owner_or_a_role_that_sees_everything_may_close_or_hand_over` — another
  operator gets `404 INCIDENT_NOT_FOUND` on both new endpoints; an admin may do both.
- `incidents::tests::a_handover_moves_the_read_and_write_scope_between_the_two_operators` — the full
  matrix for read (GET), trail, list membership and write, **before and after** a handover.
- `incidents::tests::the_timeline_is_scoped_like_the_incident_and_read_in_order` — a stranger cannot
  read the trail of an incident it cannot read.
- `tests/acceptance/g12_lifecycle.sh` steps `C2.1`, `C2.4`, `C4` — the same matrix over real HTTP
  against a real kernel (88 checks, 0 failures; log in `artifacts/g12c/acceptance.log`).
- `tests/ui/g12-lifecycle.spec.ts` — a viewer in a real browser is never shown a write form, and
  the operator's handover is visible in the new owner's browser session.

### 1.4 Two facts that are easy to get wrong

1. **`viewer` reading everything is not an oversight in the incident slice.** It is what
   `sees_all` says, it predates this slice, and a viewer is the role the product uses for
   read-only stakeholders today. D5 asks whether that is still the intent.
2. **Ownership is the operator's scope, so a handover is an authorization change.** G12 C's
   handover moves `kernel.incidents.owner`; for an operator this is the difference between `200`
   and `404`. That is why the handover needs a revision check, an audit row and an eligible target
   — see `lifecycle-adr.md` §4.

---

## 2. Findings — what the review found, with the evidence attached

These are observations about the code as it stands. Each one is either routed to §3 (a decision)
or to §4 (a defect with a named owner).

### 2.1 `GET /api/v1/audit` has no data-scope predicate (defect, cross-scope read)

`diagnostics::audit_events` (`apps/kernel/src/diagnostics.rs:115`) requires only an authenticated
session and then filters on `subjectType` / `subjectId` from the query string. Its viewer branch is
an empty `if` block with a comment, so there is no scope predicate at all.

Observed against a real kernel (G12 C, scratch DB, 2026-10-31):

```
$ curl -b <operator B cookies> /api/v1/incidents/<A's incident>   -> 404 INCIDENT_NOT_FOUND
$ curl -b <operator B cookies> '/api/v1/audit?subjectType=INCIDENT&subjectId=<A's incident>'
  -> 200, 4 rows: INCIDENT_CLOSED, INCIDENT_VERDICT_RECORDED, INCIDENT_EVIDENCE_ADDED, INCIDENT_CREATED
```

So operator B cannot read the incident but can read its entire audit trail, including the closure
note. G12 C did **not** change that endpoint (it is platform-wide by design and other surfaces read
it), and it did not route the new UI through it: the incident page uses the scoped
`GET /incidents/{id}/timeline` precisely so the new surface cannot inherit the leak. The endpoint
itself is still open — see DECISION REQUIRED **D6**.

### 2.2 The user directory is admin-only, so an operator cannot pick a handover target by name

`users::list_users` (`apps/kernel/src/users.rs:27`) calls `require_admin`. Verified: operator → `403`,
admin → `200`. Consequence for G12 C, stated on the form itself rather than worked around: an
operator types the target account id, an admin gets a picker (`IncidentDetail.tsx`,
`OwnerTransferForm`). It is a poor affordance, not a security problem — the kernel validates the
target either way (`INCIDENT_OWNER_UNKNOWN` / `_DISABLED` / `_ROLE_INELIGIBLE`).

### 2.3 There is no notion of business scope anywhere in the schema

`kernel.incidents` has `owner uuid`, `severity`, `source`, `related_entity text` and nothing that
names a business unit, tenant or workspace. `related_entity` is free text (`CHECK length 3..200`),
indexed by nothing, and is *not* used by any predicate. Therefore:

- every isolation claim the product can make today is a claim about **one owner column**;
- "show me the incidents of business unit X" cannot be answered by the database, only by filtering
  what the caller is already allowed to read (which for an operator is its own rows only — i.e. the
  question is unanswerable for the exact role that would want to ask it).

### 2.4 Ownership is single-valued, so "the team" has no representation

`owner` is one `uuid`. A shift, a team or a rotation has no place in the record. The only way to
share an incident today is to hand it to somebody (which removes it from the previous owner's
view) or to be an admin/viewer. This is the structural reason G12 C's handover is a *transfer* and
not a *share* — see DECISION REQUIRED **D3**.

### 2.5 The admin role is a data-scope role, not an administrative role

`sees_all` is true for admin because it is true for "everyone who cannot operate" too — the two
roles were folded into one boolean. An account that exists to manage users and plugins therefore
also reads and closes every incident. There is no separation between *platform administration* and
*incident authority*, and nothing in the code expresses the difference. DECISION REQUIRED **D1**.

### 2.6 Closing and handing over require the same authority as adding a note

All four write endpoints call `require_operator` and the same owner predicate; there is no
distinct "may close" or "may command" capability. An operator that may add evidence may also end
an incident (given a signed verdict) and move it to another account. That may well be correct for a
small on-call team, but it is an assumption, not a decision. DECISION REQUIRED **D2**.

### 2.7 "Private incident" does not exist and is not cheap to add

Everything readable is readable by every viewer and every admin because `sees_all` is a boolean
computed from the role alone. A private incident needs a *second* dimension (a visibility column or
an ACL table) and a predicate that combines it with the owner rule; it cannot be expressed by
tightening the existing boolean without changing the viewer's contract. DECISION REQUIRED **D4**.

---

## 3. DECISION REQUIRED

Each item is a product or security decision. None of them was taken by this phase; the
recommendation says what engineering would do *if* the decision goes that way, and the last line of
each item says what would overturn the recommendation.

### D1 — Is the role that administers the platform also the role that may close any incident?

- **Question.** Today `admin` gets `sees_all`, so an account created to manage users, plugins and
  nodes also reads, closes and reassigns every incident (§2.5). Should incident authority be a
  separate grant from platform administration?
- **Evidence.** `incidents.rs:120`; `users.rs:27` (admin-only directory); no capability names an
  incident permission anywhere in `crates/contracts`.
- **Recommendation.** Keep them together for this release, and say so in the product: one
  "incident commander" role today is the same account as the platform administrator, and a
  deployment that needs separation deploys a second admin account used only for incidents. Add a
  dedicated capability (`incidents.command`) only when a real deployment has asked for it, because
  a capability nobody uses is a new way for the matrix to be wrong.
- **Overturned by.** A deployment where the person who manages nodes must *not* be able to close an
  incident (e.g. an MSP whose platform operator is not the customer's incident owner). That single
  requirement makes the split necessary rather than theoretical.

### D2 — May every operator close and hand over, or only a designated one?

- **Question.** Closing is the end of an incident's life and handing it over moves who can read it,
  yet both require only `require_operator` plus ownership (§2.6). Should closing require a stronger
  grant than appending evidence?
- **Evidence.** The role × operation matrix in §1.3; `close_incident` and `transfer_owner` both call
  `auth.require_operator()?` (`incidents.rs:754`, `incidents.rs:774`).
- **Recommendation.** Keep it as it is for 0.0.x: an operator that owns the incident may close it
  after a signed verdict, and the *verdict* is the real control — a closure cannot happen without a
  human conclusion that is itself write-once and audited. Revisit when a deployment has more than
  one on-call group, because from then on "any operator" means "a stranger to this service".
- **Overturned by.** An incident whose closure was contested *within* the same operator role (one
  operator closing another's investigation) where the owner column did not prevent it — that is the
  case the current model cannot express.

### D3 — Is a handover the right primitive, or does the product need a share/team owner?

- **Question.** G12 C built a **transfer**: one owner at a time, the previous owner loses access
  (§2.4). Should an incident instead support several accountable people, a team, or a rotation?
- **Evidence.** `kernel.incidents.owner uuid NOT NULL` (0016), the operator predicate
  `($1::boolean OR owner=$2)`, and the acceptance matrix in which the old owner's read turns from
  `200` to `404` (`g12_lifecycle.sh` C2.1 → C2.4).
- **Recommendation.** Transfer is the right primitive *now*, because it is the only one the current
  predicate can express without a new authorization dimension. Teams arrive with D4 (a visibility
  dimension), not before: a team owner is an ACL, and an ACL without a scope model is a second
  boolean in disguise.
- **Overturned by.** A deployment in which two people must both be able to act without an admin
  doing the handover every shift — i.e. a real rotation. Then the record needs an assignment set and
  the audit needs to say which member acted, which changes the predicate and the trail together.

### D4 — Is there such a thing as a private incident, and who may hide one from viewers?

- **Question.** Every viewer and every admin reads every incident (`sees_all`). Should an incident
  be restrictable, e.g. a security incident visible only to the responder and the commander?
- **Evidence.** §2.7 and `incidents.rs:120`; no column exists to express it.
- **Recommendation.** Do not add privacy by narrowing `sees_all`. If private incidents are required,
  add an explicit `visibility` dimension (column or ACL table) *plus* an ADR that states what a
  viewer is for, because today's viewer contract ("read everything, write nothing") is what makes
  the product auditable by stakeholders. A privacy flag added quietly turns every existing viewer
  into "reads whatever was not marked", which is a different product.
- **Overturned by.** Any regulation or customer requirement that specific incident content must not
  be readable by a read-only stakeholder population — that makes the current viewer contract
  untenable and forces the dimension.

### D5 — Should a viewer still read every incident?

- **Question.** The broadest grant in the model belongs to the role with no write ability at all
  (`sees_all = ... || !can_operate()`, `incidents.rs:120`). Is "viewer sees everything" still the
  intent, or should a viewer be scoped like an operator (own/assigned only)?
- **Evidence.** §1.1, §1.3; G11 already documented the copy from the job list
  (`docs/design/g11-incident/incident-adr.md` §6), so the behaviour is inherited, not new.
- **Recommendation.** Keep it. A read-only stakeholder is the one role that must be able to see the
  whole picture — narrowing it makes the role useless while adding no confidentiality (an operator
  already reads the incidents it owns, and an admin reads everything). If confidentiality is the
  goal, D4 is the lever, not the viewer's predicate.
- **Overturned by.** A deployment that hands `viewer` to an external party (customer, auditor,
  contractor). At that point "reads everything" becomes an inter-organization disclosure and D4
  becomes mandatory before that account is created.

### D6 — What is `GET /api/v1/audit` allowed to answer?

- **Question.** The platform audit endpoint has no data-scope predicate (§2.1): any authenticated
  account can read the trail of any subject by id, including incidents it cannot open. Should it be
  admin-only, subject-scoped like `/incidents/{id}/timeline`, or left as the platform-wide feed it
  is today?
- **Evidence.** `diagnostics.rs:115`; the live request in §2.1 (`404` on the incident, `200` and four
  rows on its audit trail, for the same operator).
- **Recommendation.** Restrict it to `admin` (it is a platform-observability surface, and the
  Admin Console is where it is rendered), and keep the per-resource scoped endpoints
  (`/incidents/{id}/timeline`) as the way a non-admin reads a trail. This is a **one-line gate**
  plus a test; it is not done in G12 C because it changes the authorization posture of an endpoint
  outside the incident slice, which this phase may not decide on its own.
- **Overturned by.** A non-admin surface that legitimately needs the platform feed (e.g. an
  operator's "my recent activity" page). Then the answer is a scoped variant of the endpoint, not a
  wider feed, because the feed itself cannot express a scope it was never given.

### D7 — What is the business-scope model, and when does it ship?

- **Question.** Nothing in the schema names a business unit, tenant or workspace (§2.3). Is the
  product's next step a business scope on incidents ("the payments incidents"), a workspace
  boundary, or neither until a real multi-team deployment exists?
- **Evidence.** The 0016/0019 schema; `related_entity` is free text and appears in no predicate.
- **Recommendation.** Do not add a scope column yet. The first deployment that has two teams will
  describe the shape it actually needs (a team, a service tree, a workspace), and guessing it now
  creates a column that is wrong for that deployment and cannot be removed without a migration that
  is not reversible. Until then, the honest statement is the one in §6.
- **Overturned by.** A second team sharing one kernel. From that moment the current model produces
  an operational defect (every operator of the new team is a stranger to every incident; every
  viewer sees both teams' records) and D7 becomes blocking, not optional.

---

## 4. Defects and gaps routed from this review

| # | What | Evidence | Routed to | Why not fixed here |
|---|---|---|---|---|
| R1 | `GET /api/v1/audit` answers for any subject to any authenticated account | §2.1, live request | **D6** (decision) + the gate is a one-line change | It changes an endpoint outside the incident slice; the decision is a policy one |
| R2 | An operator cannot resolve a handover target by name | §2.2 (`/api/v1/users` → 403 for operator) | Product backlog (`ui-ux`) | A widened directory is a privacy decision (`user.read`), not an incident fix. G12 C states the limitation on the form instead of inventing a second directory |
| R3 | No business scope in the schema | §2.3 | **D7** | Adding a guessed scope column is a non-reversible migration |
| R4 | Ownership is single-valued | §2.4 | **D3** / **D4** | A team owner is an ACL, and needs the visibility model first |
| R5 | The Admin Console activity page reads the unscoped feed | §2.1 (`/api/v1/audit` is the only consumer) | follows **D6** | Same endpoint, same decision |

None of R1–R5 is introduced by G12 C. R1 is the one with a security consequence, and it is
reachable today without any of the new endpoints.

---

## 5. Evolution options for business scope and multiple workspaces (analysis, no decision)

Three shapes have been discussed. Each is described with what it costs to add **later**, because the
cost of a scope model is paid by every predicate, every index and every acceptance test at once.

### 5.1 Option A — a `scope` column on incidents, filtered by a membership table

`ALTER TABLE kernel.incidents ADD COLUMN scope_id uuid` plus `kernel.scope_members(scope_id,user_id)`,
and the predicate becomes `sees_all OR owner=$caller OR scope_id IN (SELECT …)`. Cheap to add,
expressible in the existing `Caller` struct, and it composes with the owner rule. It does **not**
isolate anything by itself: membership is a grant, and a viewer with `sees_all` still reads across
scopes unless `sees_all` is redefined — i.e. Option A forces D5 to be answered first.

### 5.2 Option B — a workspace boundary (`kernel.workspaces`, incidents carry `workspace_id`)

Every query gains `AND workspace_id = $current`, every unique index gains the column (the
`(source, native_id)` natural key in 0016 becomes per-workspace), and the audit table needs the same
partition or the trail crosses boundaries again. This is the shape a real multi-team deployment
needs, and it is a *release-sized* change: migrations, contract, seeds, acceptance and the Admin
Console. It cannot be started without D7.

### 5.3 Option C — separate kernels per business unit

Nothing to build. The isolation is a deployment boundary, and the current model is exactly right
inside each kernel. The cost is operational (N databases, N upgrades, no cross-unit view) and it is
the only option that is *provable* today, because the boundary is not code.

**Recommendation for the next release planning round:** keep Option C as the supported answer, and
treat Option A as the first increment only when a deployment asks for a cross-unit view (a kernel
that must show two teams' incidents without an admin). Until then, no scope column.

---

## 6. The claim this version may not make

> **This release has no provable cross-business isolation.** `kernel.incidents` carries an `owner`
> column and nothing else; the only isolation the system can demonstrate is "an operator sees what
> it owns", which is account-level, not organization-level. Every viewer and every admin reads every
> record. Therefore this version must **not** be described as supporting production multi-tenant
> isolation, nor deployed as a shared kernel for parties that must not read each other's incidents.
> A deployment that needs that boundary must use one kernel per boundary (Option C) until D7 is
> decided.

This paragraph is the reason the section exists: the difference between "we have roles" and "we
isolate tenants" is exactly the difference these predicates do not implement.

---

## 7. What G12 C actually changed in the permission model

**Nothing about who may do what.** The three additions are all inside the existing posture:

1. `POST /incidents/{id}/close` and `POST /incidents/{id}/owner` call `require_operator` and the
   **same** owner-or-sees_all predicate as every write before them (`incidents.rs:754`, `:774`,
   `:1500`). No new role, no new capability, no widened scope.
2. `GET /incidents/{id}/timeline` reads with the **same** predicate as the incident itself
   (`incidents.rs:1678`), which makes it strictly narrower than the `/api/v1/audit` feed it replaces
   for this surface.
3. The handover is the first operation that *moves* an authorization boundary. It is therefore the
   first one that requires a revision, an eligible target, a reason and an audit row — the controls
   in `lifecycle-adr.md` §4 exist because the change is an authorization change.

The front-end additions (a read-only explanation for viewers, disabled-with-a-reason write panels)
are presentation. The server-side 403/404 proofs named in §1.3 are unchanged by them.

---

## 8. How to revisit this document

- Any change to a predicate in `Caller::from_auth` or to a `require_*` call invalidates §1 and must
  re-run the five kernel tests named in §1.3 plus `tests/acceptance/g12_lifecycle.sh`.
- A decision in §3 that is taken moves to a new ADR (with its own rollback story) and this document
  keeps a one-line pointer to it; it does not get edited in place, because "what we decided" and
  "what was once true" are different records.
- The §6 paragraph is a release note, not a caveat: it must appear in any description of this
  release that mentions roles, permissions, isolation or multi-tenancy.

## Change log

| Date | Change |
|---|---|
| 2026-10-31 | First version. Records the inherited model, routes D1–D7, and states the §6 prohibition. No policy changed. |