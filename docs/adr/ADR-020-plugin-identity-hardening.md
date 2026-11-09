# ADR-020: Plugin identity is a Kernel-signed context, never a header

- Status: Accepted (B2.1)
- Date: 2026-11-08
- Supersedes: the role-header fallback described in G10's permission ADR (R1)
- Related: [ADR-016](ADR-016-g13-source-persistence-scoped-identity-and-evidence-content.md), [ADR-018](ADR-018-automation-principal.md), `docs/design/g13-b0/permission-matrix.md`

## 1. Context

Every plugin route that answers "who is asking" had a different answer.

`plugins/zabbix-source` verified Kernel-signed `owu1` (user), `oww1` (workload)
and `owa2` (automation) contexts and read no bare header. The two data plugins
verified **only** `oww1` and, when that was absent, accepted the unsigned
`x-opsweave-user-role` header as the caller's role. `data-catalog` mapped
`admin`/`operator` to `dataset:read` + `dataset:write`; `data-integration`
mapped them to `source:read` + `source:write`.

The Kernel Gateway sent **both** `x-opsweave-user-role` and the signed
`x-opsweave-user-context`. The data plugins could not verify `owu1` at all, so
on the production path the signed context was rejected and the unsigned header
became the identity. The audit trail was wrong in the same direction: rule and
run rows recorded `created_by = "admin"` — a role string — instead of a user id.

This was recorded as G10 R1 and again as B18-F4, on the reasoning that the
plugin port was not reachable and "the Gateway sends the signed context anyway".
The second half of that reasoning was false: the plugins never accepted it.

Three properties made the residual worse than a header-reading bug:

1. The header is not a weak credential; it is not a credential. Anything that can
   reach the plugin port (a Node data token holder, a sidecar, a future
   co-tenant) becomes `admin` by typing it.
2. The plugins had **no workspace dimension at all**. `catalog_datasets`,
   `catalog_quality_rules`, `integration_sources` and their siblings had no
   `workspace_id`, and every query was global. Identity alone would not have
   bounded the read.
3. The signed `owu1` context already carries `workspaceIds`; the data plugins
   discarded the token that would have given them one.

## 2. Decision

### 2.1 One verification implementation

`plugins/shared/plugin-identity.mjs` is the canonical resolver. It verifies
exactly three token kinds and returns `null` for everything else:

| Token | Header | Signature | Binds |
|---|---|---|---|
| `owu1` | `x-opsweave-user-context` | HMAC-SHA256, per-plugin key | user, role, **this** plugin, workspace membership |
| `oww1` | `x-opsweave-caller-context` | HMAC-SHA256, per-plugin key | calling plugin, capability, grant scope |
| `owa2` | `x-opsweave-automation-context` | **Ed25519**, Kernel public key | principal, workspace, source, allowed operations |

Every token is rejected unless `v === 1`, `expiresAt` is in the future, and
`issuedAt` is no more than 60 s ahead. `owu1` is additionally rejected when its
`pluginId` is not this plugin's (cross-plugin replay) or when its `role` has no
mapping in this plugin (an unknown role is not "no scopes"; it is a token this
plugin does not understand). `oww1` names the *caller*, not the provider, so only
the signature binds it. With no context key configured, every request is
anonymous — refusing is the only safe direction.

Because each OCI image is built from its own `plugins/<name>/backend` context,
the file cannot be imported across plugins. It is copied by
`scripts/sync-plugin-identity.mjs`, and `--check` runs in CI so three
security-critical copies cannot silently drift.

### 2.2 What each plugin decides for itself

The resolver answers "is this token genuine, for me, and fresh". It does **not**
answer "what is it worth" — that is plugin-specific and stays in the plugin, as
`ROLE_SCOPES`, `scopePrefix` and `automationScopes` arguments. A test that
invented its own mapping would keep passing while production drifted, so the
plugins export their maps and their socket tests build the resolver from them.

### 2.3 The Gateway stops sending the role header

`x-opsweave-user-role` is no longer forwarded. The forwarded identity is
exhaustive and unit-tested (`gateway::identity_headers`):

```
x-opsweave-user-id        (logging convenience; never an authorization input)
x-opsweave-user-context   (the signed owu1 token; the whole identity)
```

`plugins/hello-ops` used to echo the role header and the conformance suite
asserted it *survived* the Gateway. It now reports whether the header arrived at
all, and conformance asserts it did **not** — the test encoded the old contract
and was updated with it.

## 3. Compatibility

**Removed behaviour (intentional, no compatibility window).** A caller that got
its role from the bare header loses access. That access was the vulnerability;
a deprecation period would have kept it open. Callers that legitimately need a
plugin must go through the Gateway (which signs `owu1`) or hold a workload
credential (which signs `oww1`).

**Unchanged:** `oww1` and `owa2` claims, the per-plugin key derivation
(`HMAC(cursor_secret, "caller-context:" + pluginId)`), the token TTLs, and every
plugin route and response shape. `created_by` now records a stable user id, an
`automation:<principalId>` or a `workload:<pluginId>` instead of a role string;
existing rows keep their old value (additive semantics, no backfill — a backfill
would invent an attribution the ledger cannot prove).

**Test and harness changes:** `tests/reliability/run.sh` signed a real context
instead of the raw header (it also gained a non-empty context key; the empty key
was itself part of the hole). `tests/contract/run_conformance.py` asserts the
forged header is stripped.

## 4. Verification

`tests/ci/b2_plugin_identity_attack.test.mjs` drives both data plugins over real
sockets against a real PostgreSQL. It asserts, per plugin:

- an unsigned role header authenticates nothing (401), for every role string
- a forged admin header cannot widen a signed viewer (403)
- contexts minted for another plugin, signed with another key, expired,
  future-issued, wrong-version, unknown-role, or user-id-less are refused (401)
- a tampered payload under the original signature is refused (401)
- a refusal leaves **every** plugin table's row count unchanged

Run on the pre-fix commit the suite fails 6 of 7 tests; run on the fix it passes
7 of 7. That before/after pair is the reproduction and the proof.

## 5. Residual risk and what this ADR does not cover

- **Workspace scoping of plugin data.** `owu1` now carries `workspaceIds` and the
  resolver returns them, but the data tables have no `workspace_id` column yet,
  so a dataset is not yet attributable to a workspace. That is PR-A2 and it is a
  prerequisite for calling the data plane multi-tenant. Until then the *identity*
  is correct and the *data* is still platform-wide.
- **Workload principals carry no workspace.** `service_catalog_get` and the
  pipeline worker's `dataset:read/write` tokens are platform-global; PR-A2 adds
  `workspace:<uuid>` grant entries and the job-attribution they need.
- **Plugin port reachability.** Signature checking makes the key the boundary
  rather than the network position, which is the point; the port still should
  not be published, and Node keeps it loopback-bound.
- **Real Zabbix, mTLS, OCI signing** are unchanged by this ADR and remain
  NOT_RUN/BLOCKED as recorded in `docs/IMPLEMENTATION_STATUS.md`.
