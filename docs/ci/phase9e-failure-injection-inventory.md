# Phase 9E TASK-22: what the failure-injection inventory found

An inventory of every deploy-lifecycle fault test in the repository, run as three
parallel investigations (node boundary, capacity/scheduling, lifecycle). **40+
conditions have code and no test.** This document records what was fixed first and
the method that made the fixes worth anything.

## The three fixed in this pass

### 1. The observation generation fence had no test

TASK-13's document says:

> a delayed observation must not overwrite a newer one — **already fenced and
> tested** — module `observation_order`

The fence exists (`AND deployment_generation = $11` in `INSTANCE_OBSERVATION_SQL`).
Nothing exercised it: the helper every test in that module calls bound the
generation to a **constant 1**, against fixtures that were **also generation 1**.
The predicate was true in every test by construction.

**Measured, by deleting the line: all three existing tests still passed.**

What it protects: a redeploy bumps `deployment_generation` (TASK-12) and starts a
new container. The node's report about the OLD container is still in flight.
Without the fence it lands on the new attempt, and the row starts naming a
container it does not own — and `container_id` is load-bearing for reclamation
(ADR-030 D4).

### 2. `verify_digest` had no test at all

The check between a signed manifest and a container running content that is not
what was signed, and the one place that refuses a tag-only reference. The e2e
suites publish by digest and never present a wrong one, so neither behaviour was
exercised anywhere.

Three tests, each with its own counterfactual:

| test | counterfactual that makes it fail |
|---|---|
| `a_mismatched_digest_is_refused` | accept any digest |
| `a_tag_only_reference_is_refused_before_any_inspection` | fall through on an unpinned ref |
| `a_matching_digest_is_accepted` | (the control — without it the first passes on a function that refuses everything) |

The tag test runs against a fake whose digests **would** match, so a function that
fell through to the comparison could still have succeeded. It fails anyway, which
is the point.

### 3. A node revoked mid-deploy

Every existing revocation test revokes a node whose deployment is already READY.
None revokes the **only candidate** for a deployment still in flight.

### 4. A node filled to its CPU budget, not its slot limit

The instance-count budget had many tests. The CPU/memory side had only a pure
function test and a whole-node one that asks for more than the host has. Neither
covered the shape staging had: **one plugin's instance already holding the
reservation, and a SECOND plugin refused because of what the first one reserved**,
on a node with free instance slots.

The node reports 2 cores (budget 1800m). The incumbent reserves 1000m; the
candidate asks 1000m. Two assertions, and the second is what makes it about
resources rather than occupancy:

- the candidate does not become READY;
- the reason does **not** say `INSTANCE_CAPACITY_EXCEEDED` — only one instance
  exists on a node whose limit is 4.

The control runs the identical request beside a 100m incumbent and requires it to
be **placed**. Counterfactual: `NodeUsage::of` reporting zero reserved fails it.

## The part that matters: three attempts to make one counterfactual bite

This is the most useful result in the document. Each attempt passed, and each
passed for a reason unrelated to what it claimed to measure.

**Attempt 1 — the test re-implemented the query.**

```rust
// the test's own copy
SELECT count(*) FROM kernel.nodes WHERE revoked_at IS NULL AND status='READY' ...
```

Removing `revoked_at IS NULL` from the **production** query changed nothing.
Fixed by extracting `PLACEMENT_CANDIDATE_NODES_SQL` and running the constant —
the exact defect `INSTANCE_OBSERVATION_SQL` already documents in its own comment.

**Attempt 2 — the predicate was never consulted.**

Even running the production query, the test passed with the fence removed, because
`revoke_node` sets `revoked_at` **and** `status='UNREACHABLE'`. The `status='READY'`
predicate alone excluded the node, so `revoked_at IS NULL` did no work in the test.

A mutation that removes a protection and changes no result does not prove the
protection is unnecessary — it proves **something else was doing the job.**

**Attempt 3 — isolate the predicate.**

The test now restores `status='READY'` after the revocation while leaving
`revoked_at` set. That is a shape the handler does not produce on its own, and it
is the only shape that answers the question. Removing `revoked_at IS NULL` fails
the test.

### 5. The restart budget was a literal written twice

`supervise` has two error branches - the container exited, and the runtime call
itself failed - and each compared its own counter against the literal `3`. Two
copies of a threshold drift apart the moment one is edited, and **each reads as
correct on its own**: a container that cannot start and one that crashes on exit
would simply have different budgets, with nothing to notice.

The decision is now `exhausted_restart_budget()` called from both, over one
`MAX_RESTART_ATTEMPTS`. The tests pin the **boundary** (three failures still
retry; the fourth gives up) and the **value** (it is part of the failure contract:
the Kernel is told `FAILED` after this many).

Counterfactual: changing `>` to `>=` fails the boundary test — the container would
get one fewer attempt than the contract says.

**A first version of this test asserted only that the constant equalled 3.** That
test cannot fail for the reason it exists — it does not know there are two call
sites. It was deleted rather than shipped.

## Attempted, and not delivered: `diagnose_placement`

`diagnose_placement` is the second pass that runs when no slot found a candidate.
It re-evaluates **every** node and reports the refusal that got furthest, so an
operator learns the real obstacle instead of "no eligible healthy node". It had no
test, and three attempts to write one all failed — for a reason that is a finding
about the code, not about the tests.

**The query has no selector.**

```sql
SELECT * FROM kernel.nodes WHERE revoked_at IS NULL ORDER BY name
```

`reconcile_deployment` — its caller — filters candidates by the deployment's
`nodeSelector`. `diagnose_placement` does not. So in a shared database, a node
belonging to a different plugin (or a different test) competes for "furthest
refusal", and can be reported as the reason **this** deployment did not place.

Concretely, the three attempts:

1. assert a specific node wins — failed against another test's leftover node;
2. assert the revoked node is not named — cannot distinguish "it was excluded"
   from "something else outranked it";
3. narrow to the part that is stable — still failed in the full suite, because a
   foreign one-core node outranked the fixture's.

**This is not only a test problem.** A deployment refused because its label
selector matches nothing can be reported as a CPU shortage on a node it was never
eligible for. That is worse than no diagnosis: it sends the operator to the wrong
host.

The fix is a product decision — should the diagnosis be scoped to the deployment's
selector, or should it keep reporting the whole cluster? Both are defensible, and
neither is mine to choose unilaterally. **No test was shipped rather than shipping
one that fails at random.** Recorded here as an open question with a reproduction.

## Measured, and recorded rather than assumed

A revoked node's instance that **holds a container** does not count as a ghost
(`is_ghost_instance` requires no container), so it **still occupies capacity**
after revocation:

```
count = 1   after revoke, for an instance with container_id
```

Whether revocation *should* release those slots is a product decision. The test
records the current behaviour and says so, rather than asserting it is correct.

## Still open, by area

| area | most significant gaps |
|---|---|
| node boundary | `docker pull` failure and its 300 s timeout; `pull` interaction with quarantine; the `supervise()` LOOP itself (all three decisions it makes are now unit-tested; the loop that calls them is not driven end to end); node heartbeating with an old generation at the API (409 path); observation for an unknown instance |
| capacity | scale-down releasing a slot; the preflight's `reserved`/`deployment_counts` inputs always empty in tests; revoked node excluded from the preflight's node list |
| lifecycle | uninstall has **no** Kernel-level test at all; `REPLICAS_NOT_READY` on activation; rollback to a staged-but-never-deployed version; redeploy while the old version is DRAINING; enable/disable repeated cycles |
| diagnosis | `diagnose_placement` is untested AND unscoped — see the section above; the query has no selector, so it can blame a node the deployment was never eligible for |

**This is not "add a few tests".** Three of the four release paths Phase 9C fixed
have a test; the fault conditions that *cause* them mostly do not.

## Method note

The inventory was worth more than any single test it produced. Every one of the
three fixes above was in code that already looked tested — one of them in code
whose own documentation said "already fenced and tested". **A test whose fixture
makes its assertion vacuously true reads exactly like a test that works**, and the
only way to tell them apart is to break the code and watch.
