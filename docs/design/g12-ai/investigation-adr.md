# ADR-G12-004 · The bounded read-only AI Investigator

- **Status**: Accepted for Phase E; the real-model path is **BLOCKED** (see §7)
- **Phase**: G12/E, on top of the A/B/C/D slices already merged
- **Supersedes**: nothing. Extends ADR-G11-001 (incident) and ADR-G12-003 (lifecycle)
- **Migration**: `apps/kernel/migrations/0020_g12_ai_investigator.sql` (additive, non-destructive)
- **Code**: `apps/kernel/src/investigations.rs`
- **Contract**: `contracts/openapi/investigation-v1.yaml`
- **Acceptance**: `tests/acceptance/g12_ai_investigator.sh`, plus the `investigations` test module

---

## 0. What this phase is allowed to be

An investigator is a **reader**. It may look at an incident the operator could already look
at, in the way the operator could already look at it, and write down what it thinks. It may
not write, execute, fetch, conclude or close. Everything below is either a mechanism that
keeps that true or an honest statement of where it is not yet true.

The precedent for the shape is the incident slice itself: the Kernel is the single writer of
the incident record, a Human Verdict is write-once, and a closure stands on a signed verdict.
Phase E adds a participant that must be visible in that record **without being able to change
it**.

---

## 1. The seven questions E1 requires, answered

### Q1. What may the AI read?

Exactly what the operator who started the run may read, through five tools and nothing else:

| Tool | Reads | Bound |
|---|---|---|
| `get_incident` | one incident's record | one row |
| `list_evidence` | that incident's evidence metadata | 25 rows, truncation reported |
| `read_evidence` | one evidence row plus its stored bytes | 4000 characters, fixity verified |
| `get_incident_timeline` | that incident's audit trail | 100 events, truncation reported |
| `get_related_context` | a related-context source **this deployment authorised** | 10 rows, refusing entirely when unconfigured |

There is no sixth tool. `TOOL_NAMES` is the closed set the executor checks before it
touches a query, and `a_tool_the_investigator_invented_is_not_in_the_catalogue` asserts that
`run_shell`, `sql` and `http_get` are not in it, and that the published catalogue and
the executor agree on the same five.

### Q2. What may it not read?

- **Anything the operator cannot read.** Every tool reaches the database through the same
  predicate the HTTP read endpoints use — `query_incident`, `query_evidence`,
  `query_timeline`, `query_incidents`, `incident_status` — and those functions became
  `pub(crate)` in this phase precisely so the investigator re-uses them instead of writing a
  second, unaudited copy of the rule. Measured:
  `every_tool_refuses_an_incident_another_operator_owns` drives all five at an incident
  owned by somebody else and requires `REFUSED` + `INCIDENT_NOT_FOUND` from each.
- **Evidence belonging to another incident.** `an_evidence_id_from_another_incident_is_refused_even_with_the_right_incident`.
- **A related-context source that was not authorised.** `SOURCE_UNAVAILABLE`, with no data
  read at all — not an empty page, which would be a fabricated success.
- **Anything that requires a write.** No tool implementation contains an `INSERT`,
  `UPDATE` or `DELETE` against a business table. The only writes in the module are the
  run's own bookkeeping rows and its audit rows.
- **Anything at a URL it chose.** The one outbound call goes to the provider's configured base
  URL, and `state.http` is built with `redirect::Policy::none()`, so a redirect cannot be
  used to reach a second host.

### Q3. Which real Evidence did each conclusion cite?

`kernel.investigation_hypothesis_evidence.evidence_id` is a foreign key onto
`kernel.incident_evidence` with `ON DELETE RESTRICT`, **and** a trigger
(`kernel.investigation_citation_guard`) refuses a row whose evidence does not belong to the
incident the run is about. So a citation is a real row of the real incident, or it is not
stored at all. Measured: `a_hypothesis_cannot_cite_evidence_from_another_incident` requires
the trigger's refusal, then shows the same citation being accepted once it points at the
incident's own evidence.

Each citation also carries the `invocation_id` of the tool call that returned it, so a
reader can walk from "the model cited this row" back to "this read produced it". That link is
`ON DELETE SET NULL`: losing the pointer must not delete the citation.

The response separates the two roles the vocabulary needs — `supportingEvidence` and
`contradictingEvidence` — because a conclusion that only counts agreeing evidence is not a
conclusion. Measured in S3 of the acceptance script: an evidence row collected three hours
before the incident's recorded start is cited as **contradicting** while a later row is cited
as **supporting**, and the stance is `CONFLICTED`.

### Q4. How does it say the data is missing?

Four mechanisms, all visible on the wire:

1. **A stance that can express it.** `UNCERTAIN` and `CONFLICTED` are first-class values,
   not an empty hypothesis list. A run that cannot conclude says so.
2. **`gapCodes`**, a closed set: `NO_EVIDENCE_ROWS`, `EVIDENCE_PREDATES_INCIDENT`,
   `EVIDENCE_UNVERIFIED`, `TOOL_REFUSED`, `TOOL_FAILED`, `TOOL_TIMED_OUT`,
   `SOURCE_UNAVAILABLE`, `BUDGET_EXHAUSTED`. The UI renders a cause from the code, so no
   server sentence reaches a user (AGENTS.md).
3. **A required sentence.** `investigation_uncertain_has_gap_check` refuses an
   `UNCERTAIN` or `CONFLICTED` hypothesis carrying no uncertainty text and no gap code.
   Measured: `an_uncertain_hypothesis_must_say_what_is_missing`.
4. **A run status that is not `SUCCEEDED`.** `PARTIAL`, `BUDGET_EXHAUSTED`, `EXPIRED`,
   `CANCELLED` and `FAILED` each name a different reason the answer is not whole, and
   `detail` is mandatory for `PARTIAL`.

### Q5. Why did the model reach a hypothesis?

`hypothesis.reasoning` is a required, bounded field (10–4000 characters) stored with the
hypothesis. For the test adapter it is generated from the comparison actually performed:
"Each evidence row's collectedAt was compared with the incident's startedAt. 1 row(s) precede
it…". For a real model it is whatever the model answered, kept verbatim — including the case
where it gives none, recorded as `the model gave no reasoning` rather than filled in.

Alongside it, the run document carries the **whole transcript**: every invocation with the
arguments the model produced, the outcome, the error code, the duration, the bytes returned,
the evidence ids returned, and the name of the predicate that authorised it. A hypothesis is
explainable because the reads behind it are on the record, not because the model's own account
is trusted.

### Q6. Which inferences must not be treated as fact?

This is the sharpest question in the phase, and the answer is structural:

- A hypothesis **cannot** be stored with a verdict's word. The stance set
  (`SUPPORTED | CONTRADICTED | UNCERTAIN | CONFLICTED`) and the verdict set
  (`CONFIRMED | REFUTED | INCONCLUSIVE`) are disjoint, enforced by
  `investigation_hypotheses_stance_check`. Measured:
  `a_hypothesis_cannot_speak_the_verdict_vocabulary`.
- A hypothesis **cannot** become a verdict: there is no foreign key, trigger or function from
  `investigation_hypotheses` into `incident_verdicts`, and the only writer of
  `incident_verdicts` is `POST /api/v1/incidents/{id}/verdict`, which requires an operator
  session and a rationale that operator wrote.
- A **review** of an investigation cannot become a verdict either: its vocabulary is
  `ACCEPTED | REJECTED`, and §2 shows the measured null result.
- `confidence` is about the evidence set, not about the world. The fixture's highest
  confidence is `HIGH` for "every cited row's timestamp is consistent with the incident's
  start", which is a statement about the record — and `statement` and `reasoning` say so.
- The response states `isHumanVerdict: false` on the run, on every hypothesis and on every
  review. A consumer that reads only JSON is told what it is holding.

What remains a human judgement, and is deliberately not modelled as an inference: whether the
incident is real, whether the evidence is trustworthy in substance, and whether the incident is
over.

### Q7. Who owns the final human conclusion?

The operator, through the paths that already existed before this phase:

- **The verdict**: `POST /api/v1/incidents/{id}/verdict`, operator role, write-once, one per
  incident, with the considered evidence set snapshotted at signing time (ADR-G12-003).
- **The closure**: `POST /api/v1/incidents/{id}/close`, operator role, `CONCLUDED` only,
  revision-checked, and refused by a trigger when no verdict exists.
- **The review of an investigation**: `POST .../investigations/{runId}/review`, operator
  role, write-once per run, `ACCEPTED | REJECTED`, recorded in
  `investigation_human_reviews`. It says "I find this reasoning usable for triage". It says
  nothing about the incident.

Who *ran* the investigation is recorded too: `requestedBy` is the operator whose session
started it, and `scopeUserId` is the account whose authority every read was performed under.
When an admin starts a run, both are the admin — there is no "investigate as somebody else"
capability, because that would be a privilege-delegation feature wearing a convenience
costume.

---

## 2. AI hypothesis and Human Verdict are different things, in the schema

This is the claim the phase is judged on, so here is the whole of it.

| | AI hypothesis | Human verdict |
|---|---|---|
| Table | `kernel.investigation_hypotheses` | `kernel.incident_verdicts` |
| Key | `hypothesis_id`, many per run, many runs per incident | one row per `incident_id`, which is its primary key |
| Vocabulary | `SUPPORTED / CONTRADICTED / UNCERTAIN / CONFLICTED` | `CONFIRMED / REFUTED / INCONCLUSIVE` |
| Who may write | the Kernel, inside a run, from a model's validated answer | an operator, once, through one endpoint |
| Required content | statement, reasoning, confidence, gap codes when not settled | rationale 10–4000 chars, `decided_by`, `decided_at` |
| Can it move the incident? | no | yes: `CONCLUDED`, and only then `CLOSED` |
| Lifetime | many, forever | one, write-once (0016) |

And the negative evidence, measured rather than argued — S6 of the acceptance script:

```
PASS  S6 the review was recorded
PASS  S6 the review decision is ACCEPTED
PASS  S6 the review says it is not a verdict
PASS  S6 the run still says it is not a verdict
PASS  S6 the verdict table gained nothing
PASS  S6 the incident still reports no human verdict
PASS  S6 the incident status did not move
PASS  S6 the incident revision did not move either
PASS  S6 the AI's work cannot close the incident
PASS  S6 and the refusal names the missing human step   (INCIDENT_CLOSE_REQUIRES_CONCLUDED)
PASS  S6 a review cannot use the verdict's vocabulary   (400 INVESTIGATION_REVIEW_DECISION_INVALID)
PASS  S6 a second review of the same run is refused     (409 INVESTIGATION_ALREADY_REVIEWED)
PASS  S6 after all of that the verdict table is still empty
```

The verdict table is read with `psql` before and after, so the null result is a fact about
the database and not about a status code.

---

## 3. The five tools: how each one's scope is enforced

Every tool follows the same three steps, in this order:

1. **Re-read the scope account's role from `kernel.users`, now.** `scope_caller` does a
   primary-key read on every single invocation. Nothing is cached from the run's start, so an
   account deleted or re-roled between two calls is treated as it is at the moment of the read.
   Measured: `an_unknown_scope_account_cannot_be_substituted`.
2. **Call the shared predicate.** Not a copy of it.
3. **Record which predicate answered.** `authorization_predicate` is required for a successful
   invocation — `investigation_invocation_success_check` refuses an `OK` row without one —
   so "the investigator read something" always answers "under which authority".

| Tool | Backend predicate re-used | Recorded predicate | Negative test |
|---|---|---|---|
| `get_incident` | `incidents::query_incident` | `INCIDENT_READ_PREDICATE` | S4 + Rust |
| `list_evidence` | `incidents::query_evidence` (begins with `incident_status`) | `INCIDENT_READ_PREDICATE` | S4 + Rust |
| `read_evidence` | `incident_status` + `query_evidence` + `verify_stored_content` | `EVIDENCE_CONTENT_FIXITY_CHECK` | S4 + Rust |
| `get_incident_timeline` | `incidents::query_timeline` (begins with `incident_status`) | `INCIDENT_READ_PREDICATE` | S4 + Rust |
| `get_related_context` | `query_incident` then `query_incidents` (carries `($1 OR owner=$2)`) | `INCIDENT_READ_PREDICATE` | S4, S8 + Rust |

The cross-scope probe is how the acceptance script asks the tools for somebody else's incident
without inventing a second API: `scenario: CROSS_SCOPE_PROBE` plus
`probeIncidentId`/`probeEvidenceId` makes the **test adapter** hand those ids to the five
tools. The scenario is refused for any provider that is not the fixture, and the probe ids are
refused outside that scenario (`INVESTIGATION_PROBE_INCOMPLETE` /
`INVESTIGATION_PROBE_NOT_APPLICABLE`), so the knob cannot follow a real model.

### The self-assessment the phase asks for

*Which of the five tools did I only validate the parameters of, and not actually authorise
against the backend?*

**`get_related_context`, and it is the only one where the gate that decides whether the tool
may run at all is deployment configuration rather than the caller's permission.**

The other four have nothing but the shared predicate between the model's argument and the row:
whatever `incidentId` the model supplies goes straight into `query_incident(…)`, and the row
comes back or the call is refused. `get_related_context` checks
`config.investigation_related_sources` **first**, before it reads anything — that check is a
configuration lookup, not an authorization predicate, and it is what produced
`SOURCE_UNAVAILABLE` instead of `INCIDENT_NOT_FOUND` in S4 of the run against the shipped
posture. That ordering is defensible (an unauthorised source should be refused before any query
runs, and a source is enabled at deploy time), but it means one of the five tools carries a gate
an operator can widen for everybody by editing an environment variable, with no per-caller
permission involved in that decision.

What keeps it safe is the *second* gate: once the source is authorised, the read goes through
`query_incidents`, whose predicate is the incident list's own. S8 of the acceptance script
measures it (`get_related_context refuses a cross-owner incident through the same predicate as
the incident list`), and `the_incident_index_narrows_the_scope_and_never_widens_it` measures
that the returned page contains the caller's peer incident and neither of a stranger's. So the
data is scoped; the **tool** is gated by configuration. A future phase that wants a per-caller
rule for cross-incident reads should put it on the source as a permission, not in the
environment as an allowlist.

---

## 4. E3: the ten limits, each with the overrun it produces

Each limit is a column, so the ceiling a run was held to is readable afterwards next to what it
used. Each overrun below is an assertion from `tests/acceptance/g12_ai_investigator.sh`, or
from the test module where marked.

| # | Limit | Where | Overrun → observed |
|---|---|---|---|
| 1 | **max steps** | `max_steps`, checked before each turn | `BUDGET_EXHAUSTED` / `STEP_BUDGET`, `stepsUsed == maxSteps`, zero hypotheses |
| 2 | **max tool calls** | `max_tool_calls`, checked before each call | `BUDGET_EXHAUSTED` / `TOOL_CALL_BUDGET`, `toolCalls == 3`, three invocation rows |
| 3 | **per-tool timeout** | `run_bounded` wraps the tool future | firing: `a_tool_that_exceeds_its_timeout_is_reported_as_a_timeout` → `TIMEOUT` + `TOOL_TIMEOUT`; respected: every `durationMs <= toolTimeoutMs` at a 100 ms cap |
| 4 | **total deadline** | `deadline_at` + an `Instant` | `EXPIRED` / `DEADLINE`, `deadlineSeconds == 1` recorded |
| 5 | **token budget** | `token_budget` vs `prompt_tokens + completion_tokens` | `BUDGET_EXHAUSTED` / `TOKEN_BUDGET`, and the spend past the budget explained rather than clamped |
| 6 | **retry cap** | `max_retries`, per call, retryable outcomes only | a refused read is attempted **once** (`attempt == 1`, `retriesUsed == 0`); a clean run spends zero retries; the ceiling is recorded |
| 7 | **idempotent run id** | `UNIQUE (incident_id, idempotency_key)` | a replay answers `200` with `idempotentReplay: true`, and a third start creates no new row |
| 8 | **cancellation** | `cancel_requested_at`, observed between steps | `CANCELLED` / `CANCELLED`, `cancelRequestedAt` recorded, `steps < maxSteps`, and cancelling a finished run is `409` |
| 9 | **audit** | `kernel.audit_events` + the invocation table | the timeline carries `INVESTIGATION_STARTED`, `INVESTIGATION_FINISHED`, `INVESTIGATION_CANCELLED`; every refusal is a row |
| 10 | **failure and partial success** | `status` | `PARTIAL` when a conclusion was reached on reads that were refused; `FAILED` when nothing usable was produced; the five refusals are in the database |

Two notes that belong in a design document rather than a test comment:

- **Steps and calls are exact ceilings; tokens are a measurement.** Steps and tool calls are
  refused *before* the operation that would exceed them, so `steps_used <= max_steps` and
  `tool_calls_used <= max_tool_calls` are CHECK constraints. A turn's token usage is only
  known once the provider has answered and cannot be un-spent: the run stops at the first turn
  boundary past the budget, so `tokens_used` may exceed `token_budget` by at most one turn.
  The migration deliberately does **not** enforce `tokens_used <= token_budget`, because the
  only way to satisfy such a constraint would be to clamp a measured number — a lie about cost.
  `a_token_budget_overrun_is_recorded_as_a_measurement_not_clamped` holds the schema to that.
- **Cost is claimed only when it is known.** `cost_micros` is 0 with
  `costBasis: TEST_FIXTURE_NO_COST` for the fixture, `NO_COST` for a real provider without a
  declared price, and `CONFIGURED_PRICE` only when the deployment sets
  `OPSWEAVE_INVESTIGATION_PRICE_MICROS_PER_MTOKEN`. Tokens, calls, retries and steps are always
  recorded, because those are measurements.

---

## 5. E4: what answered, and how a reader can tell

The provider registry has two kinds and the database will not let them blur:

- `TEST_FIXTURE` — the seeded row `test-fixture-v1`. It may not carry an endpoint, a model or
  a credential variable name (`investigation_provider_completeness_check`), and it is always
  enabled.
- `HTTP_OPENAI_COMPATIBLE` — exists only when `OPSWEAVE_INVESTIGATION_PROVIDER_BASE_URL`,
  `…_MODEL` and `…_CREDENTIAL_ENV` are all set. The row stores the **name** of the variable
  holding the secret; the secret is read from the environment at request time, never stored,
  never logged, never returned.

`kernel.investigation_run_adapter_guard` refuses any run whose `adapter_kind` disagrees with
the kind of the provider it names, so a finished run cannot be relabelled after the fact.
Measured: `a_run_cannot_be_relabelled_as_a_different_adapter`.

The discernible marker, in four places:

1. `\"adapter\": \"TEST_FIXTURE\"` — the top-level field of every run document.
2. `\"synthetic\": true` — the boolean form of the same fact.
3. `adapterLabel`: "TEST_FIXTURE - deterministic test adapter output, not a model's conclusion".
4. Every hypothesis row carries its own `adapter_kind`, so a citation-level reader sees it too.

The UI shows it: the investigation panel renders a badge from `adapter` and `synthetic`
(§6), not from a guess.

**The three E4 cases are produced by three states of real data, not by three canned strings.**
That is the point of driving them through the fixture:

| Case | Data that produces it | Stance |
|---|---|---|
| evidence sufficient for a sourced hypothesis | rows exist, all collected at or after the incident's start | `SUPPORTED`, each cited id real |
| evidence insufficient — say so | zero evidence rows, or every read refused | `UNCERTAIN`, `LOW`, gap `NO_EVIDENCE_ROWS` / `TOOL_REFUSED` |
| contradictory evidence — say so | a row collected **before** the incident's recorded start, plus rows after it | `CONFLICTED`, both sides cited, gap `EVIDENCE_PREDATES_INCIDENT` |

---

## 6. E5: what the operator sees, and what it cannot do

The workspace's incident page gains one panel (`apps/platform-web/src/pages/IncidentDetail.tsx`)
showing: the adapter badge, the run status and stop reason, the budget and the usage, the five
tool calls with their outcome codes, the hypotheses with stance, confidence, supporting and
contradicting citations (each openable through the existing evidence content endpoint), the
uncertainty sentence and gap codes, the human review, and the run history. The verdict pane is
untouched by it.

Everything user-visible is an i18n key. The server's English `detail`, `errorDetail` and
`gapCodes` are **not** rendered: the UI maps codes to messages, per AGENTS.md.

**A run cannot change the verdict.** Measured in S6 (§2). There is no code path from this module
to `incident_verdicts`, and the acceptance script proves it by trying.

---

## 7. The real-model path is BLOCKED, and what that means

No credential, endpoint or model is configured in this environment, and this phase does not add
one. Consequences, stated plainly:

- `POST …/investigations` with `providerId: \"http-openai-compatible-v1\"` answers
  **409 `MODEL_PROVIDER_NOT_CONFIGURED`**, naming the three variables an operator must set.
  Measured in S7.
- The HTTP client path (`http_decide`) is written against the standard
  `POST {base_url}/chat/completions` shape with `response_format: json_object` and a strict
  validator (`parse_model_decision`) that refuses a stance or confidence outside the closed
  sets rather than coercing it. **It has never been exercised against a real model in this
  environment.** That is a BLOCKED deliverable, not a passing one.
- Therefore no claim in this document rests on a real model's output. Every measured behaviour
  above was produced by the deterministic fixture or by the schema.

What is proven without a model: the protocol can express all three required outcomes, the
citation rule holds, the budget rules hold, cancellation is observed, and the verdict is
untouchable. What is unproven: that a real model's answers satisfy the same protocol. To
unblock, set the three variables and re-run the acceptance script — the S1–S3 cases become model
cases with no script change, because they assert the *shape* of the answer and the *reality of
the citations*, not the fixture's wording.

---

## 8. Why the Kernel's Job Runtime is not reused

`kernel.pipeline_jobs` is a leased, fenced, heartbeating workload queue for plugin containers
(`apps/kernel/src/jobs.rs`, migrations 0003–0013). An investigation run is:

- short-lived and request-scoped: it answers inside the HTTP request that starts it, bounded to
  300 s by the largest deadline the API accepts;
- single-writer and in-process: no worker, no lease, no fence, nothing to fail over;
- read-only against business tables, so whatever a reaper would do to an abandoned run, it
  cannot leave the incident half-written.

Putting it in `pipeline_jobs` would mean the run carried a lease and a fence token that mean
nothing, and that an abandoned investigation sat in the same queue operators watch for plugin
work. So this phase re-uses what actually fits — `kernel.audit_events` for the trail, the
incidents predicates for reads, the `UNIQUE (owner, idempotency)` idiom from 0006, the
`clock_timestamp()` deadline idiom from 0008/0009, and `Config::from_env` — and adds one
table family with no scheduler behind it. A stale run is not reaped: it is reported. `stale`
is a derived column (`status = 'RUNNING' AND deadline_at < now()`), which says the run was
abandoned instead of calling it running.

---

## 9. Risks and what is being done about them

| Risk | Posture |
|---|---|
| A real model cites an id it was never given | the citation guard refuses it at the database; the run fails loudly rather than dropping the citation |
| `get_related_context` is gated by configuration, not by a per-caller permission | documented in §3 with its measured negative test; a future per-caller rule belongs on the source, not in the environment |
| An incident with citations cannot be deleted before its runs | the citation is `RESTRICT`, exactly as the 0017 verdict snapshot is. `cleanup` in the test module deletes runs first and documents why |
| The token budget can be exceeded by one turn | stated in §4 and in the migration, with a CHECK that forbids clamping rather than forbidding overshoot |
| A run executes inside a request, so a huge budget is a long request | `MAX_DEADLINE_SECONDS = 300` and `MAX_STEPS = 200` bound it; `MAX_TOKEN_BUDGET = 4_000_000` bounds a paid run |
| The test adapter's output could be mistaken for a model's | four markers on the wire, one badge in the UI, a schema trigger forbidding relabelling, and no claim here that rests on it |

---

## 10. Rollback

Forward-only, as every migration here is. The reverse DDL is in the migration header and is
**not** free: it destroys every run, every invocation, every hypothesis and every review. It may
run only as an accepted loss of that record.
