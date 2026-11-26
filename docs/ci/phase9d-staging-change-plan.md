# Phase 9D TASK-17: the staging change plan

**Status: `BLOCKED_AUTH`.** This document is a PLAN. It authorises nothing, and it
was written without touching staging. Every action in the table below needs
TASK-19's explicit authorisation and is listed so the decision can be made about
specific actions rather than about a category.

## What is actually true on staging, and what is inference

| claim | evidence | standing |
|---|---|---|
| the node is at 4/4 | the deploy error names four occupants and the limit | **measured** |
| the four occupants are `hello@0.0.1`, `data-catalog@0.0.2`, `data-catalog@0.0.3590`, `data-integration@0.0.2` | the same error | **measured** |
| `data-catalog@0.0.2` is `ACTIVE` | `capacity.json`, run 45799322906 | **measured** |
| `data-catalog@0.0.3590` is `DEGRADED` | `capacity.json`, same run | **measured** |
| `hello@0.0.1` and `data-integration@0.0.2` are each their plugin's only version | version lists in earlier runs | **measured** |
| none of the four is `READY` | `capacity.json` | **measured** |
| which of the four *could* be released | — | **unknown**, and that is the point of this plan |

The earlier, wrong version of this table is preserved in
`docs/ci/phase8d-staging-state.md` with a note explaining how it was wrong: it
inferred `data-catalog@0.0.2` was superseded from a **version list** and never read
its status column. It is `ACTIVE` and serving. **Acting on that table would have
taken a live route down.** That is the reason this plan separates "measured" from
"inferred" as a column rather than in prose.

## What the merged rule says, applied to these four rows

`reclaim_eligibility` (ADR-030 D3) requires all of: an eligible status
(`READY`/`DEGRADED`), no ACTIVE revision, no routable instance, a newer deployment
of the same plugin, a waiting sibling, and no container that might still be running.

| occupant | reaches the rule? | why |
|---|---|---|
| `hello@0.0.1` | no | only version of its plugin → `NO_SUCCESSOR` |
| `data-catalog@0.0.2` | no | `ACTIVE` → `NOT_A_CANDIDATE_STATUS` |
| `data-catalog@0.0.3590` | **depends on facts not yet read** | `DEGRADED` is eligible; whether it is released depends on `has_active_revision`, `instance_may_have_container`, `superseded_by_newer`, `a_sibling_is_waiting` |
| `data-integration@0.0.2` | no | only version of its plugin → `NO_SUCCESSOR` |

**So at most one of the four is even a candidate**, and whether it is depends on
four booleans nobody has read on the staging database.

## The read-only fact-finding step, which must come first

Before any state change, these reads answer the four booleans. They are `SELECT`s,
they write nothing, and they are what TASK-05 was blocked on.

```sql
-- 1. Is the DEGRADED candidate protected by an ACTIVE revision?
SELECT r.status, r.version, r.activated_at
  FROM kernel.activation_revisions r
  JOIN kernel.plugin_deployments d ON d.id = r.deployment_id
 WHERE d.plugin_id = 'opsweave.data-catalog' AND d.version = '0.0.3590';

-- 2. Does it still reference a container? (ADR-030 D4: physical evidence)
SELECT i.slot, i.state, i.desired_action, i.container_id, i.observed_at
  FROM kernel.plugin_instances i
  JOIN kernel.plugin_deployments d ON d.id = i.deployment_id
 WHERE d.plugin_id = 'opsweave.data-catalog' AND d.version = '0.0.3590';

-- 3. Is there a newer deployment of the same plugin, and is anything waiting?
SELECT d.version, d.status, d.created_at, d.generation
  FROM kernel.plugin_deployments d
 WHERE d.plugin_id = 'opsweave.data-catalog'
 ORDER BY d.created_at;

-- 4. What the rule would decide, for every row, before anything is changed.
--    This is what `placement_preflight` already computes; it is a read.
SELECT * FROM kernel.plugin_deployments d
 WHERE d.status IN ('READY','DEGRADED') ORDER BY d.plugin_id, d.created_at;
```

**If (1) returns an ACTIVE revision, the candidate is protected and this plan has no
state change to make.** That outcome is a legitimate finish, not a failure: it means
the node is full of things that are all supposed to be there, and the answer is
capacity, not reclamation.

## The actions, and what each needs

| # | action | reversible? | what it needs | what it must not do |
|---|---|---|---|---|
| 1 | run the four reads above | n/a (read) | ssh to the staging host, `psql` | write anything |
| 2 | run `opsctl capacity --selector role=node` | n/a (read) | the same | — |
| 3 | if a row is eligible, let the reconciler release it | yes (it is a status transition) | **explicit authorisation**, because the sweep is automatic once the rule matches | delete the row; stop an instance whose container may be running |
| 4 | redeploy the target plugin | yes (a new deployment) | authorisation | raise `max_instances_per_node` |
| 5 | verify the route moved | n/a (read) | — | assume a 200 from `/healthz` proves the plugin serves |

**There is no action in this table that deletes a database row, removes a container
with `docker rm`, or raises a capacity limit.** The brief forbids all three, and none
is needed: the rule releases a slot by a status transition the reconciler already
performs.

## What would make this plan unsafe to execute

- **A `DEGRADED` candidate with an ACTIVE revision.** Releasing it takes the route
  down. (2) in the reads above answers this; if it is ACTIVE, stop.
- **A candidate whose instance still has a container.** `RUNTIME_MAY_BE_RUNNING`
  exists because stopping it is a physical action against a process that might be
  writing. TASK-15 made this protection *lift* when a Node reports `STOPPED`; before
  that fix it never lifted, which made the guard a permanent block. Both directions
  are now measured, and this plan depends on the lift actually working.
- **No waiting sibling.** Releasing a candidate nothing is waiting on frees a slot
  that stays free, and the publish that motivated this may not be the one that uses
  it.
- **Reading the four booleans from a snapshot.** `capacity.json` is from run
  45799322906. If it is stale, the plan is about a topology that no longer exists.

## What this plan does not claim

- **It does not claim the four occupants are the problem.** Three of them are the
  only version of their plugin or `ACTIVE`; that is not "stuck", it is in use.
- **It does not claim reclamation will free a slot.** At most one row is a candidate
  and its eligibility is unknown.
- **It does not authorise anything.** TASK-19 is a separate, explicit step.
- **It is not a staging test.** `ALLOW_STAGING_WRITES` is unset and every claim above
  that could have been measured was taken from an existing artifact.

## The honest summary

The node is full. **Three of the four occupants are there because they are supposed
to be**, and the fourth is `DEGRADED` in a way the rule may or may not release. A
plan that starts from "we must reclaim something" has already assumed its own
conclusion; this one starts from four reads that can come back saying there is
nothing to reclaim, and that is a real possible outcome.
