# ADR-G12-003 · The incident operation lifecycle: closure and handover

| | |
|---|---|
| Status | Accepted (G12 Phase C) |
| Supersedes | nothing; extends ADR-G11-001 §3 (the state machine) |
| Contract | `contracts/openapi/incident-v1.yaml` (`/close`, `/owner`, `/timeline`) |
| Migration | `apps/kernel/migrations/0019_g12_lifecycle.sql` (additive) |
| Code | `apps/kernel/src/incidents.rs` (`close_incident_record`, `transfer_incident_owner`, `query_timeline`) |
| Permissions | unchanged by this ADR — see `permission-model-decision.md` |

## 1. The defect this closes

G11 built `OPEN → INVESTIGATING → CONCLUDED` and stated `CLOSED` in the contract and the CHECK
constraint. Nothing produced it. Three consequences followed, and each is what this phase removes:

1. **an incident could not end.** CONCLUDED had to carry both "the investigation reached a
   conclusion" and "this is over", so a record that everyone had stopped caring about looked exactly
   like one under active review;
2. **because nothing closed an incident, nothing had decided what a closure must stand on** — the
   question "may an operator end an incident without a signed verdict?" had no answer because no
   code asked it;
3. **ownership was set once at creation** (0016: "Accountability, not authorship"). Since the owner
   column is also the operator read scope, a departed owner left an incident that only an admin or a
   viewer could read — and the person actually on call could not.

## 2. C1 — the controlled closure

### 2.1 A dedicated route, not a writable status field

`POST /incidents/{id}/close` with `{ expectedRevision, note, idempotencyKey? }`. A closure is a
decision with prerequisites, so it is not one assignable column among five: a `PATCH status` would
have to re-implement the verdict gate, the revision check, the idempotency key and the audit row
inside a general-purpose writer, and the first caller that used it for `INVESTIGATING` would be
tempted to use it for `CLOSED` too.

### 2.2 Four gates, in this order (and the order is the contract)

| # | Gate | Refusal |
|---|---|---|
| 1 | the caller may operate at all | `403 FORBIDDEN` |
| 2 | visible to the caller, and status is `CONCLUDED` | `404 INCIDENT_NOT_FOUND` / `409 INCIDENT_CLOSE_REQUIRES_CONCLUDED` |
| 3 | a signed Human Verdict exists | `409 INCIDENT_CLOSE_REQUIRES_VERDICT` |
| 4 | `expectedRevision` still matches | `409 INCIDENT_VERSION_CONFLICT` |

The state gate comes **before** the version gate on purpose: "this is not concludable" is the real
obstacle, and "your revision is stale" would misdescribe it — a caller that reloaded would get the
same refusal and learn nothing.

### 2.3 No shortcut: `OPEN ≠ CLOSED`

`CLOSED` is reachable only from `CONCLUDED`, and `CONCLUDED` is reachable only through a signed
verdict (`insert_verdict`, write-once since 0016). Both halves are enforced in the schema as well as
in the handler (`0019`, `kernel.incident_closure_guard()`), so a hand-written `UPDATE` hits the same
wall — see §6, which asserts it with psql.

### 2.4 Idempotency: per key, not per URL

`idempotencyKey` is optional and does exactly one thing: it distinguishes **a retry of my closure**
from **a second closure**. With a matching key, a request that arrives after the closure already
committed answers `200` with the closure of record (same `closedAt`, same note, same revision).
Without a key, or with a different one, the same request is `409 INCIDENT_ALREADY_CLOSED`.

Why not "200 for any repeat": the second operator to press Close has made a *different* decision
about a record it has not re-read; answering 200 would tell it the decision it never made is in
force. Why not "409 for every repeat": a client whose first attempt timed out would be told its own
successful write failed. The key is the only fact that separates the two, so it is the only thing
that decides which answer is honest.

The UI generates one key per form instance (`newIdempotencyKey`) and rotates it after a definitive
`409`, so a retry after a timeout replays while a retry after a refusal is a new attempt.

### 2.5 Concurrency: exactly one closure of record

The write is `SELECT … FOR UPDATE` (two closers are serialized) followed by a compare-and-set:

```sql
UPDATE kernel.incidents
   SET status='CLOSED', closed_at=now(), closed_by=$2, closure_note=$3, closure_key=$4,
       revision=revision+1, updated_at=now()
 WHERE incident_id=$1 AND status='CONCLUDED' AND revision=$5
```

Of two simultaneous closes, one commits; the other observes the closed row and answers
`INCIDENT_ALREADY_CLOSED`, `INCIDENT_VERSION_CONFLICT` or `INCIDENT_STATE_CONFLICT` — never a 500,
and never a second closure. Asserted twice: in-process with `tokio::join!`
(`two_simultaneous_closes_produce_exactly_one_closure`) and over real HTTP with two concurrent
`curl`s (`g12_lifecycle.sh` C1.6, one closure of record in the audit table).

### 2.6 Audit and state are one transaction

The `INCIDENT_CLOSED` audit row is written on the same transaction (`audit_in_tx`), after the
compare-and-set and before the commit. A closure that cannot be described is a closure that did not
happen: `a_failed_audit_rolls_the_closure_back` forces the audit insert to fail with a real
constraint and asserts the incident is still `CONCLUDED` with `closed_at IS NULL` and an unchanged
revision, and that the same request then succeeds once the audit table accepts it.

### 2.7 A closure is final, and reopening is not a path

- no endpoint moves an incident out of `CLOSED`;
- the schema refuses it (`incident_closure_guard`: `OLD.status='CLOSED' AND NEW.status<>'CLOSED'` →
  `restrict_violation`), so psql cannot either;
- the worst case the rule names — **delete the verdict, then reset the status** — is refused by the
  same trigger, because the guard checks the *previous status*, not the presence of a verdict.

`a_closed_incident_refuses_every_write_and_cannot_be_reopened` walks all of it: evidence, verdict,
second close, handover, a hand-written `UPDATE … status='INVESTIGATING'`, and the same update after
deleting the verdict row. The incident is still `CLOSED` at the end.

### 2.8 What a closed incident still accepts

Reads, and nothing else. The refusal is uniform — `INCIDENT_CLOSED` from evidence, verdict and
handover; `INCIDENT_ALREADY_CLOSED` from a second close — so a client can branch on one code family
instead of parsing prose. `CONCLUDED` **does** still accept evidence (ADR-G11-001 §3.1); that
asymmetry is deliberate: an investigation may keep collecting facts, an ending may not.

---

## 3. The revision column, and why it is not a content hash

`kernel.incidents.revision` (bigint, `>= 1`, default 1) moves on every write that changes what a
reader would have to re-read: the `OPEN → INVESTIGATING` transition, the `CONCLUDED` transition, the
closure and the handover. It is the token two operations arbitrate on.

It is deliberately **not** a hash of the row: evidence appends already have their own idempotency
key (`(incident_id, kind, source, content_ref)`, 0016), and a hash would force every write to
recompute a projection it does not otherwise need. The question the revision answers is narrow and
honest: *is the record you looked at the record you are writing to?*

## 4. C2 — the handover

### 4.1 The five facts, and the one it does not carry

`POST /incidents/{id}/owner` with `{ expectedRevision, toOwner, reason }` records: who had it, who
gets it, why, when (`owner_assigned_at` + the audit row), and the version it was decided against.
It carries **no group, no team, no tenant and no IAM**: this is a transfer between two accounts, and
the ADR states that rather than implying a richer model exists.

### 4.2 Why the response is not the incident

The answer is `IncidentOwnerTransfer`, not `Incident`. The owner column *is* the operator read scope
(`permission-model-decision.md` §1.1), so after a successful handover the transferring operator can
no longer read the record. Returning the incident would either leak a row the caller just lost
access to, or have to be built as if the caller still had it. The UI responds by telling the
operator that access ended (`losesAccessAfterHandover`), instead of reloading into a 404 it cannot
explain.

### 4.3 Authorization, target eligibility, and the no-op

| Rule | Refusal |
|---|---|
| caller may operate | `403 FORBIDDEN` |
| caller is the current owner, or `sees_all` (admin) | `404 INCIDENT_NOT_FOUND` |
| the incident is not `CLOSED` | `409 INCIDENT_CLOSED` |
| `expectedRevision` matches | `409 INCIDENT_VERSION_CONFLICT` |
| target ≠ current owner | `409 INCIDENT_OWNER_UNCHANGED` |
| target exists / is enabled / can operate | `400 INCIDENT_OWNER_UNKNOWN` / `_DISABLED` / `_ROLE_INELIGIBLE` |

The target rules are about the grant being moved: assigning an incident to a **viewer** would hand
it to a role that cannot act on it (and would not narrow what the viewer can see), and assigning it
to a **disabled** account creates work nobody can pick up.

### 4.4 Where the handover history lives

In the audit trail (`INCIDENT_OWNER_TRANSFERRED` with `fromOwner`, `toOwner`, `reason`,
`revisionFrom`, `revisionTo`), read back through the new scoped endpoint. No second table: the audit
ledger is already the record of who did what, and a parallel `incident_owner_assignments` table
would be a second copy of the same fact that could disagree with it.

### 4.5 What was deliberately not built

Teams, rotations, multi-tenant scopes and a full IAM. `permission-model-decision.md` D3/D4/D7 hold
the analysis and the reasons; the short version is that a team owner is an ACL and an ACL without a
scope model is a second boolean in disguise.

## 5. The audit timeline read

`GET /incidents/{id}/timeline` returns the incident's audit rows, newest page in chronological order,
with `truncated` when older events were dropped. It is scoped by **the incident's own read
predicate**, not by a filter on the audit table, because `GET /api/v1/audit` has no scope predicate
and an operator could otherwise read the trail of an incident it cannot open — that defect is
recorded (and routed) as `permission-model-decision.md` R1/D6, and this endpoint exists so the new
surface does not inherit it.

## 6. Migration 0019 — additive, and what it costs to undo

Adds to `kernel.incidents`: `revision`, `owner_assigned_at`, `closed_at`, `closed_by`,
`closure_note`, `closure_key`; two CHECK constraints; one trigger function and one trigger. No row is
deleted, no id changes, no evidence or verdict row is touched, and 0018 is untouched because sqlx
checksums it.

Two backfills, both stated where they run:

- `owner_assigned_at = created_at` for existing rows (not `now()`, which would claim every historical
  incident was handed over during the migration);
- existing `CLOSED` rows get `closed_at = updated_at`, `closed_by = owner` and a note saying exactly
  that: those rows were closed before any endpoint could produce the status, so the authority behind
  them was never recorded and is not invented.

Rollback is forward-only and **not free**: dropping the columns destroys every closure and every
handover timestamp while `status` would keep saying `CLOSED` — a row claiming a closure whose
authority no longer exists. The reverse DDL is in the migration header and may only run as an
accepted loss of that record.

## 7. Verification (real database, real HTTP, real browser)

| Gate | Command | Result |
|---|---|---|
| Kernel tests, no skip | `OPSWEAVE_TEST_DATABASE_URL=… OPSWEAVE_REQUIRE_TEST_DATABASE=1 cargo test -p opsweave-kernel -- --test-threads=1` | 125 passed, 0 failed |
| Lifecycle acceptance | `tests/acceptance/g12_lifecycle.sh` against a scratch kernel on `127.0.0.1:18199` | 88 checks, 0 failures (`artifacts/g12c/acceptance.log`) |
| Browser | `npx playwright test tests/ui/g12-lifecycle.spec.ts` (Chromium) | 1 passed; screenshots in `artifacts/g12c/` at 1440/1024/390, light and dark |
| Web unit | `pnpm --filter @opsweave/platform-web test` | 247 passed |
| Typecheck / i18n / contracts / fmt / clippy | see the delivery report | all clean |

What the acceptance script asserts that a unit test cannot: the refusal **codes** over the wire, the
404-vs-403 distinction between "not yours" and "not allowed", the scope matrix before and after a
handover, and — with psql — that the schema refuses a hand-written closure, a hand-written reopen and
a reopen after the verdict row is deleted.

## 8. Open items inherited from this design

- **D1–D7** in `permission-model-decision.md` (who may close, whether handover should be a share,
  private incidents, the viewer's breadth, the audit feed's scope, the business-scope model).
- The revision is a single counter shared by all writes: a client that only cares about the closure
  must re-read after an evidence append. Accepted for now (the page re-reads on every write); a
  per-facet version is a larger model that nothing has asked for yet.