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
| node boundary | `docker pull` failure and its 300 s timeout; `pull` interaction with quarantine; container `supervise()` restart loop never driven; node heartbeating with an old generation at the API (409 path); observation for an unknown instance |
| capacity | resource-budget exhaustion by an incumbent (the exact staging shape, tested only as a pure function); scale-down releasing a slot; the preflight's `reserved`/`deployment_counts` inputs always empty in tests; revoked node excluded from the preflight's node list |
| lifecycle | uninstall has **no** Kernel-level test at all; `REPLICAS_NOT_READY` on activation; rollback to a staged-but-never-deployed version; redeploy while the old version is DRAINING; `diagnose_placement`'s second pass; enable/disable repeated cycles |

**This is not "add a few tests".** Three of the four release paths Phase 9C fixed
have a test; the fault conditions that *cause* them mostly do not.

## Method note

The inventory was worth more than any single test it produced. Every one of the
three fixes above was in code that already looked tested — one of them in code
whose own documentation said "already fenced and tested". **A test whose fixture
makes its assertion vacuously true reads exactly like a test that works**, and the
only way to tell them apart is to break the code and watch.
