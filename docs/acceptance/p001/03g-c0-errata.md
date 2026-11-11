# P001-C0 errata — three findings re-graded after review

Status: **ERRATA, not a pass.** C0 reported F1, F2 and F3 as defects. Reviewing
them against the task's Phase 4 criteria showed that two were graded too
strongly and one was framed wrongly. This file corrects them; it does not delete
the original text, which stays in `03-plugin-baseline.md` as the record of what
was believed at the time.

| Finding | C0 said | This file says |
|---|---|---|
| F1 provider binding | HIGH, "no check at all" | **design question, not a confirmed vulnerability** |
| F2 assets after uninstall | MEDIUM defect | **correct for old tabs; the defect is the missing retention policy** |
| F3 disable/drain | MEDIUM defect | **real, but two different operations were conflated** |

---

## F1 — provider binding is a policy question, not a vulnerability

### What C0 claimed

> `create_grant` binds `provider_plugin_id` from the client payload, and the
> column is nullable. … `NULL` is a wildcard … a grant created without one is
> never pinned.

That reading of the code is accurate. The **grading** was not.

### Why the grade was wrong

C0 treated an unpinned grant as a defect. It is a legitimate mode:

- `provider_matches_grant(bound, selected)` accepts `None` for any provider —
  that is a deliberate wildcard, expressed as `Option::is_none_or`, not an
  oversight.
- `tests/acceptance/capability_multi_provider.sh` resolves a provider and then
  grants **with** `providerPluginId` set (line 71), asserting the grant is bound
  (line 73). Nothing in the suite relies on the wildcard, but nothing forbids it
  either.

So the question is not "is this broken" but **"what should the default be"**, and
that is a decision for the platform owner, not an audit finding.

### What actually needs deciding

| Question | Options |
|---|---|
| Is an unbound grant allowed at all? | **Forbidden** — `providerPluginId` becomes required and the column `NOT NULL`. **Allowed** — keep the wildcard, document it as such. |
| If allowed, what does it mean? | "the caller accepts whichever provider is active", or "bind to the provider resolved at grant time". These differ after a version switch and today's code implements the first. |
| Who may create one? | any operator (today), or admin only |

**Recommendation, stated as a recommendation:** forbid it. A grant that silently
follows whichever provider activates later is hard to reason about during an
incident, and the multi-provider test already grants explicitly. But that must be
decided and written down, not slipped in as a bug fix.

### What C0 should have said

> `providerPluginId` is optional and `NULL` means "any provider". Whether that
> should be permitted is undecided; the column being nullable and the payload
> being trusted is confirmed code behaviour.

**Not a C2 blocker.** C2 cases 5 and 6 (unauthorised call, revoked grant) do not
depend on this: they exercise grants that *are* bound.

### A separate, real inconsistency

`CapabilityGrantView` returns `providerPluginId` as an optional field while the
OpenAPI contract for the same endpoint does not mark it nullable. A generated
client that trusts the spec will fail to deserialize a wildcard grant. Recorded
as **contract drift**, separate from the policy question above and not fixed
here.

---

## F2 — assets after uninstall: the retention window is the missing piece

### What C0 claimed

> `assets::serve_asset` filters on `status <> 'REJECTED'` and publisher trust
> only. After uninstall the frontend bundle is still downloadable. MEDIUM.

### Why the framing was wrong

An already-open browser tab holds a URL and an activation revision. If every
asset from a non-ACTIVE revision 404s the moment a new version activates, that
tab breaks — including during the drain window the platform deliberately
provides. **Serving non-ACTIVE assets is required**, not a bug.

The defect is that there is no retention policy at all: the asset is served
forever, with `Cache-Control: public, max-age=31536000, immutable`, and nothing
distinguishes "old version, still inside its compatibility window" from
"uninstalled a year ago".

### The five things that must be separated

| Concern | Who decides | Today |
|---|---|---|
| **Historical static assets** | retention window, per plugin | never expire |
| **New page loads** for a version | activation state | no check — *this* is the gap |
| **Extension activation** | ACTIVE revision only | enforced elsewhere |
| **Plugin runtime / Gateway calls** | ACTIVE revision + grant | enforced (§C0 F1 discussion aside) |
| **Cleanup after the window** | operator or reaper | does not exist |

The narrow defect is item 2: a *new* page load for an uninstalled plugin's
version succeeds. That should 404 once the plugin is `UNINSTALLED` **and** the
retention window has passed — and the window does not exist yet, so today the
right behaviour is arguably "serve it".

### What was actually observed, and what it bounds

```
GET /assets/trusted-team/dev.opsweave.hello/0.0.2/frontend/remoteEntry.js
  -> HTTP 200, 7,708 bytes of real JavaScript   (after uninstall)
```

This is a **stale-content exposure**, bounded: the backend is stopped, so no code
executes; the bundle is the publisher-signed, digest-verified one. It is not
remote code execution and was never graded as such.

**Recommendation:** define the retention window (start with 24 h after the last
activation, or a fixed 7 days, and make it a manifest-adjacent platform setting),
then have `serve_asset` check `UNINSTALLED AND past window -> 404`. Until that
policy exists, do not simply block non-ACTIVE assets — that breaks the old-tab
requirement C4 is about to test.

---

## F3 — disable does not drain: two operations were conflated

### What C0 claimed

> `activate` sets the superseded deployment `DRAINING` with a 15 s window.
> `disable` sets `desired_action='STOP'` directly with no `drain_until`. MEDIUM.

Confirmed as code behaviour. The framing was too coarse: it treated "disable"
as one operation.

### Two operations with different requirements

| | **Emergency stop** | **Planned disable** |
|---|---|---|
| Intent | stop traffic now, a bad version may be running | take the plugin out of service gracefully |
| Drain | **must not wait** | should drain |
| In-flight requests | dropped, acceptable | completed or refused cleanly |
| Audit | required, with reason | required |
| Today | this is what `disable` does | **no separate path exists** |

`disable` implements the emergency case — and it is correct for that case. What
is missing is the planned variant, and the API does not say which one it is
performing.

### What this phase decides

Per the task, a **design judgement** is enough here; the implementation is not in
scope.

- `disable` keeps its current immediate semantics and is **renamed in
  documentation** to state that it stops traffic without draining.
- A planned disable needs `drain_until` like `activate` uses; that is a new
  request field (`drainSeconds`, default 0 for emergency), not a change to the
  existing path.
- The response gains `drained: bool` so an operator can tell what happened.

Recorded as a design decision for C2/C4, **not** as an implementation in this
phase.

---

## What this errata changes about C0's conclusions

C0's §5 listed F1 as HIGH and blocking C2 cases 5/6. That was wrong:

- C2 cases 5 and 6 remain runnable; they do not depend on the wildcard question.
- F1 is a policy decision with a recommendation, not a defect to fix before C2.
- F2 and F3 stay real but are reframed: one needs a retention policy, the other
  needs a second operation rather than a changed one.

None of this makes the plugin lifecycle more complete. It makes the record
accurate, which is what Phase 4 asks for.
