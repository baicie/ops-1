# Phase 9C — TASK-12: a redeploy used to claim slots before the planner looked

Baseline after `e0f774ae`. Every claim is a test in
`apps/kernel/src/deployments.rs` (module `redeploy_capacity`) run against real
PostgreSQL, or a line of source named beside it.

## The defect, reproduced before it was fixed

`create_deployment_inner` has a branch for `FAILED`/`DEGRADED`/`DISABLED`/
`DRAINING` that returns a deployment to `PENDING`. In the **same request**, a second
statement rewrote every instance row:

```sql
UPDATE kernel.plugin_instances
   SET deployment_generation=$2, desired_action='START', state='STARTING', ...
 WHERE deployment_id=$1
```

The capacity aggregates count `desired_action='START'` on deployments in the planned
set, and `PENDING` is in that set. So the old rows re-entered the count immediately —
**before anything evaluated whether they would fit**.

Measured (`a_redeploy_counts_its_old_instances_before_placement_runs`), on a node
already at its per-node limit, with one FAILED deployment whose instance row is
`desired_action='STOP'`:

| | planner occupancy |
|---|---|
| before the redeploy | `limit` |
| after the redeploy | **`limit + 1`** |

And the consequence is not internal bookkeeping
(`the_phantom_slot_is_visible_to_the_preflight`): `placement_preflight::gather` —
which runs the same `evaluate_node` the scheduler runs — reported the node as
over-committed. That is the number an operator reads and the number that refuses the
next deploy.

The brief is explicit that a fix comes **after** a reproduction, and that it hands
placement back to the planner:

> 「只有真实复现后才修改。」
> 「若需要修复，建议将 Redeploy 的新一轮实例放置统一交回既有 Planner。不要在 API 层另外复制调度逻辑。」

## The fix

The statement now releases the rows instead of claiming them:

```sql
UPDATE kernel.plugin_instances
   SET deployment_generation=$2, desired_action='STOP', observed_at=NULL, ...
 WHERE deployment_id=$1
```

Nothing is deleted: the row, its slot, its container id and its history are all kept.
What changes is that a `STOP` row is invisible to every occupancy aggregate **and**
to `reconcile_deployment`'s `existing_node_ok`, which requires
`desired_action == 'START'`. So the row is placed by the planner's ordinary path —
`evaluate_node` included — like any other new placement.

This is the smallest change that satisfies "hand it back to the planner": one word in
one statement, and the existing machinery does the rest. No placement logic was
copied into the API layer.

## What could have gone wrong, and is asserted against

A fix that simply stopped instances from ever returning would pass every capacity
assertion and break every deploy. So `a_redeploy_places_again_when_there_is_room`
frees one slot, redeploys, reconciles, and asserts the instance comes back as
`desired_action='START'`. Both halves are needed: "never places" passes the refusal
half, "always places" passes the room half.

## Counterfactual

Restoring the old statement (the mutation is one string) fails exactly two of the
three tests:

| test | with the fix | with the old statement |
|---|---|---|
| `a_redeploy_counts_its_old_instances_before_placement_runs` | pass | **FAIL** |
| `the_phantom_slot_is_visible_to_the_preflight` | pass | **FAIL** |
| `a_redeploy_places_again_when_there_is_room` | pass | pass |

The third passing in both directions is the point: it measures a different failure
mode, so it is not a duplicate of the others.

## What this does not cover

- **The same statement exists for `enable`** (`deployments.rs:1005`). It was left
  unchanged: an `enable` is an operator asking for a version that was deliberately
  disabled, and whether it should also go through placement is a product question
  this task does not answer. Recorded rather than changed silently.
- **No staging observation.** staging has no `FAILED`/`DISABLED` deployment that
  anyone is redeploying today; its four occupants are three `ACTIVE` and one
  `DEGRADED` (`capacity.json`, run 45799322906).
- **Not TASK-13/14/15/16.** Generation fencing on the observation path already exists
  (`INSTANCE_OBSERVATION_SQL`, `nodes.rs:412`, guarded on `deployment_generation` and
  `observed_at`); the concurrent activate/reclaim case and the physical-release
  measurement are separate tasks.

## Three fixture bugs, all mine

Each produced a failure that looked like the defect and was not:

1. `manifest: '{}'` made `create_deployment_inner` fail at the manifest parse and
   return a generic 500 — the measured behaviour never ran.
2. `"memoryMib"` instead of `"memoryMiB"`. The contract field carries an explicit
   `#[serde(rename = "memoryMiB")]` and the struct is `deny_unknown_fields`, so the
   wrong capital was a hard parse failure three layers from the symptom.
3. `$7` bound in the fourth position: sqlx binds positionally, so the manifest landed
   on `artifact_digest` and PostgreSQL answered `invalid input syntax for type json`.

All three are the same shape — **a fixture that fails for its own reasons and gets
read as the product failing.**
