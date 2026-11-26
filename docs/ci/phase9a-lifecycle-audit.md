# Phase 9A — lifecycle audit

Baseline `18a1e5a1889cac22625b4176ebe620eedac65601`. Every claim below is read
from the source at that SHA or from a run named beside it.

**No staging operation was performed to produce this document.** The staging
values come from `capacity.json` in the `staging-deploy` artifact of run
**45750074444** (the push run for the baseline commit), downloaded and read.

## TASK-01 — the baseline, refreshed

| item | value | source |
|---|---|---|
| main | `18a1e5a1889cac22625b4176ebe620eedac65601` | `git log -1` |
| `ci` | success, run **45750074424** | `gh api .../runs?head_sha=18a1e5a1` |
| `staging-preview` | failure, run **45750074444** | same |
| `verify-main` | **FAILED** — one workflow (`staging-preview`) | `node tests/ci/verify-main.mjs --sha 18a1e5a1` |
| open PRs | 0 | `gh pr list --state open` |
| local / remote branches beyond `main` | none | `git branch -vv`, `git branch -r` |

`ci-gate`, `platform-linux-acceptance` and `plugin-lifecycle` all passed on this
commit; `verify-main` names `staging-preview` as the only failure and lists the
path-filtered workflows it does not require.

The Phase 8 numbers in the task brief are a historical snapshot, and this
document does not reuse them: everything in TASK-05 below was re-read from the
run above.

## TASK-02 — the lifecycle state machine, as the code implements it

### The six machines, which are not interchangeable

The brief is right that these are different state machines, and the code bears
that out. Conflating them is how a "DEGRADED" row gets released while it is
serving.

| machine | where it lives | what it decides |
|---|---|---|
| **Deployment status** | `kernel.plugin_deployments.status` | what the platform intends to do with this version |
| **Instance desired_action** | `kernel.plugin_instances.desired_action` | whether the scheduler wants a container |
| **Instance observed state** | `kernel.plugin_instances.state` | what the Node last reported |
| **Container** | outside PostgreSQL | whether a process is actually running |
| **Activation revision** | `kernel.activation_revisions.status` | **what the Gateway routes on** |
| **Gateway route** | computed per request | the rows `route_candidates` returns right now |

### The transition table

Every row below is a write in `apps/kernel/src/deployments.rs` at the baseline
SHA. "Plans instances" means the deployment is in
`('PENDING','PREPARING','READY','ACTIVE','DEGRADED')`, the set the reconciler
selects (`:1915`) and the capacity aggregates count (`:1961`, `:1982`).

| status | written by | when | planned? | Gateway? | START instance? | container? | redeployable? | activatable? | reclaimable? | timeout? | artifact kept? |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `PENDING` | create (`:481`), redeploy (`:369`), enable (`:978`) | a version was accepted but nothing is placed | **yes** | no | no (nothing placed) | no | n/a | no | no | **yes, `attempt_started_at` + 600 s → FAILED** (#227) | yes |
| `PREPARING` | reconcile (`:2368`) | some replicas placed, at least one `STARTING` | **yes** | no | yes | yes | n/a | no | no | **no** — TASK-11 | yes |
| `READY` | reconcile (`:2356`) | `ready == desired_replicas`, no ACTIVE revision | **yes** | **no** | yes | yes | n/a | **yes** | **yes** — the only status the reclaim rule matches | no | yes |
| `ACTIVE` | activate (`:726`), reconcile (`:2354` with `is_effective`) | replicas ready **and** an ACTIVE revision points here | **yes** | **yes** | yes | yes | n/a | n/a | **no** — `activation_revisions` clause | no | yes |
| `DEGRADED` | reconcile (`:2360` with `is_effective`, `:2376` on `failed > 0`) | **two different causes, one label** — see TASK-04 | **yes** | **yes, if a revision is ACTIVE** | yes | yes | yes (`:364`) | no | **no** — never matches the rule | no | yes |
| `DRAINING` | activate (`:734`), reclaim sweep (`:1848`) | a newer version took the route, or a superseded candidate was released | no | no (revision superseded) | for the grace window | yes | no | no | already being released | 15 s (`activate`) / 0 s (`reclaim`) | yes |
| `FAILED` | reconcile (`:2342`, #227) | never placed within the timeout | no | no | no | no | **yes** (`:364`) | no | no | terminal until re-deployed | yes |
| `DISABLED` | disable (`:906`), uninstall (`:1028`), retire (`:1312`), drain elapsed (`:1880`) | operator action, or the drain window closed | no | no | **no** — the sweep writes `STOP` | no | **yes** (`:364`) | no | n/a | terminal | yes |

### What the Gateway actually requires

`route_candidates` (`gateway.rs:349`) joins **six** conditions, and the
deployment's own status is not one of them:

```
r.plugin_id = $1
AND r.status = 'ACTIVE'          -- activation revision, not deployment status
AND tp.trust_state = 'TRUSTED'
AND i.state = 'READY'            -- instance observed state
AND i.desired_action = 'START'
AND n.revoked_at IS NULL AND n.status = 'READY'
AND n.last_seen_at > now() - $2
AND n.data_endpoint IS NOT NULL
```

**This is the single most important fact in this audit**: a deployment whose
status is `DEGRADED` can be serving traffic, and a deployment whose status is
`ACTIVE` can be serving nothing (if no instance is `READY`). Any reclamation
rule keyed on deployment status is therefore evaluating the wrong column.

## TASK-03 — every lifecycle writer

`UPDATE kernel.plugin_deployments` appears **24 times**, and **all 24 are in
`apps/kernel/src/deployments.rs`**. There is no second lifecycle implementation
anywhere in `apps/kernel/src/`.

Production writers (lines below 5000; the rest are tests):

| line | statement | entry point |
|---|---|---|
| `:369` | `status='PENDING', generation+1, attempt_started_at=now()` | `create_deployment_inner`, redeploy branch |
| `:603` | `status='ACTIVE', status_reason=NULL` | activate, **no `activated_at`** |
| `:726` | `status='ACTIVE', activated_at=now()` | `activate_inner`, in a transaction |
| `:734` | `status='DRAINING', drain_until=now()+15s` | `activate_inner`, previous version |
| `:906` | `status='DISABLED', reason=$2` | `disable` |
| `:978` | `status='PENDING', generation+1, attempt_started_at=now()` | `enable` |
| `:1028` | `status='DISABLED', 'Plugin uninstalled; data retained'` | `uninstall` |
| `:1312` | `status='DISABLED', 'Retired by operator…'` | retire, generation-fenced |
| `:1848` | `status='DRAINING', drain_until=now()` | **reclaim sweep**, ready-only |
| `:1880` | `status='DISABLED', 'Drain window elapsed'` | sweep, second statement |
| `:2405` | the computed status write-back | `reconcile_deployment` |

**Two write paths reach `ACTIVE`**, and they differ: `:603` does not set
`activated_at` and `:726` does. Both are inside `activate*`; the second is the
transactional one. This is worth noting for TASK-13 but is not a second
mechanism — they are the inner and outer halves of one operation.

The reconciler is the single owner of `PENDING → PREPARING → READY/ACTIVE/
DEGRADED` and of `DRAINING → DISABLED`. Commands write intents (`PENDING`,
`DISABLED`); only `reconcile_deployment` writes the derived states.

## TASK-04 — `DEGRADED` is two states wearing one label

The brief forbids treating `DEGRADED` as uniformly reclaimable, and the code
shows why in two adjacent branches:

```rust
} else if is_effective {
    ("DEGRADED", Some(format!("{ready}/{} replicas READY", ...)))    // :2360
} else if starting > 0 {
    ("PREPARING", ...)
} else if failed > 0 {
    ("DEGRADED", Some(format!("{ready}/{} replicas READY; {failed} failed", ...)))  // :2376
}
```

`is_effective` is `EXISTS(SELECT 1 FROM kernel.activation_revisions WHERE
deployment_id=$1 AND status='ACTIVE')`.

| brief's case | reachable in code? | how it is distinguished |
|---|---|---|
| **A** activated and serving, some replicas unhealthy | **yes** | `DEGRADED` with `is_effective` true — `:2360`. **Gateway may still route** if any instance is READY |
| **B** was activated, then lost its healthy instances | yes | `DEGRADED` with an ACTIVE revision, but `route_candidates` returns nothing (no `i.state='READY'`) |
| **C** never activated, failed during deploy | **yes** | `DEGRADED` via the `failed > 0` branch — `:2376`, `is_effective` false |
| **D** never activated, still recovering | **not as DEGRADED** | this is `PREPARING`, not `DEGRADED`, while `starting > 0` |
| **E** superseded by a newer candidate | only as a cause, not a status | no column records it; `created_at` ordering is the only evidence |
| **F** unknown | **yes** | if `activation_revisions` is unreadable or the instance rows are gone, the label carries no cause at all |

**Case D is a correction to the brief's own list**: a deployment that is still
preparing is `PREPARING`, never `DEGRADED`. A `DEGRADED` row has either lost
health (`failed > 0`) or lost replicas while effective — both are *after* an
attempt, not during one.

**The decisive evidence for A vs C is `activation_revisions`, not
`activated_at`.** `activated_at` is set on the deployment row at `:726` and is
`NULL` for staging's candidate, but a rollback can leave a stale value; the
revision table is what the Gateway reads and what `is_effective` reads. `DEGRADED`
+ an ACTIVE revision = case A or B and must not be released on status alone.

## TASK-05 — staging's candidate, from the artifact

From `capacity.json`, run **45750074444**, artifact `staging-deploy`:

```json
{
  "deploymentId": "b3c6c3d4-0213-4c2b-a606-9141f9744213",
  "plugin": "opsweave.data-catalog",
  "version": "0.0.3590",
  "status": "DEGRADED",
  "replicas": 2,
  "active": false,
  "activatedAt": null,
  "createdAt": "2026-11-16T14:22:52.864004Z",
  "reason": "0/2 replicas READY; 1 failed"
}
```

And the node, from the same document: `instancesReady: 3`, `instancesTotal: 4`,
`freeSlots: 0`, `verdict: CAPACITY_BLOCKED`, `reason:
INSTANCE_CAPACITY_EXCEEDED`, `replicasPlaceable: 0`.

### What this proves, and what it does not

| claim | status |
|---|---|
| the candidate exists with that id and version | **proven** — the Kernel produced this JSON |
| it is `DEGRADED`, never activated, holds a slot | **proven** — `instancesTotal: 4` with three ACTIVE deployments |
| it is case **C** (never activated, failed) | **supported**: `0/2 replicas READY; 1 failed`, no ACTIVE revision, `activatedAt: null` |
| it is serving traffic | **disproven by construction** — no ACTIVE revision exists for it, and the Gateway requires one |
| it is safe to release | **NOT PROVEN** — see below |

**The fields that would settle safety are absent from this artifact**, and the
brief forbids inferring them:

| missing | why it decides |
|---|---|
| the instance rows (`id`, `state`, `desired_action`, `container_id`) | `0/2 READY; 1 failed` means **one of two replicas may still exist**. If it is `START` with a container, releasing it stops a real container — which is a physical action, not a bookkeeping one |
| whether the 1 failed instance is a ghost (`container_id IS NULL`) | a ghost holds no slot and no process; a real failed container does |
| its `generation` | TASK-13's fencing and TASK-07's eligibility both need it |
| the rollback intent for `data-catalog` — is `0.0.3590` the designated rollback target? | the brief lists "still needed as rollback material" as a protection. The artifact cannot answer it |
| `created_at` of the current PENDING `0.0.65450` | the reclaim rule's `waiting` clause needs a newer sibling; both exist, order must be confirmed |

**Minimal read-only query plan** (not run — no staging authorisation):

```sql
-- 1. the candidate and whatever instances it still owns
SELECT d.id, d.status, d.generation, d.desired_replicas, d.created_at,
       i.id AS instance_id, i.slot, i.state, i.desired_action,
       i.container_id IS NOT NULL AS has_container, i.node_id
FROM kernel.plugin_deployments d
LEFT JOIN kernel.plugin_instances i ON i.deployment_id = d.id
WHERE d.id = 'b3c6c3d4-0213-4c2b-a606-9141f9744213';

-- 2. is it anybody's rollback material, or serving under any revision?
SELECT status, generation, version FROM kernel.activation_revisions
WHERE plugin_id = 'opsweave.data-catalog';

-- 3. what else does the plugin have, and in what order
SELECT id, version, status, created_at FROM kernel.plugin_deployments
WHERE plugin_id = 'opsweave.data-catalog' ORDER BY created_at;
```

All three are `SELECT`s. They answer the five missing fields and nothing else.

## What this audit changes about the plan

1. **The rule cannot be keyed on deployment status.** TASK-04 case A means a
   `DEGRADED` row may be serving. TASK-02's Gateway query shows the authoritative
   fact is `activation_revisions.status = 'ACTIVE'` **plus** a `READY` instance.
   A rule written as `status IN ('READY','DEGRADED')` would release case A.
   Measured: applying exactly that change to the sweep makes the new TASK-06
   tests fail, including `the_new_candidate_cannot_be_placed` — it does not do
   what its author would expect.

2. **The candidate's own instance state is unknown**, and `0/2 replicas READY;
   1 failed` says at least one instance row exists. Releasing it may stop a
   container. That is a physical action and it must be planned as one.

3. **`PREPARING` has no timeout** (TASK-11's subject) and is a *different* state
   from the one #227 fixed. It is not "PENDING with instances".

## TASK-06 — the staging shape, reproduced

`apps/kernel/src/deployments.rs`, module `staging_capacity_shape`, seven tests
against real PostgreSQL. The fixture is isolated behind a unique `nodeSelector`
label — the first version was not, and the PENDING deployment placed itself on a
parallel test's node, passing alone and failing in the suite (the same defect
Phase 8 measured).

| test | asserts |
|---|---|
| `four_start_instances_are_what_the_scheduler_counts` | the node really is at 4/4 by the aggregate the planner uses |
| `the_serving_deployments_have_active_revisions` | the three serving deployments are protected by revisions, not by status |
| `the_degraded_candidate_was_never_activated` | the fact, explicitly not a reason |
| `the_preflight_reports_capacity_blocked` | the same `evaluate_node`, via `gather` |
| `the_ready_only_rule_does_not_release_a_degraded_candidate` | **the defect**: the current rule leaves it DEGRADED and the node at 4/4 |
| `the_active_deployments_are_never_released` | ACTIVE revision + START instance survive a sweep |
| `the_new_candidate_cannot_be_placed` | a fifth deployment gets 0 instances and a capacity reason |

**One gap recorded rather than hidden**: `the_active_deployments_are_never_released`
does not fail when the `activation_revisions` clause is removed from the sweep.
Measured. In this fixture the serving rows' status stays `ACTIVE`, which a
status-keyed rule excludes before the revision clause is ever consulted. The case
that would bite — a row *derived* as `DEGRADED` while an ACTIVE revision points
at it — needs the reconciler to re-plan that deployment, which
`reconcile_once_scoped(Some(pending))` does not do. Constructing it belongs to
TASK-10, where each protection gets its own counterexample.

**Counterfactual run**: replacing `d.status = 'READY'` with
`d.status IN ('READY','DEGRADED')` fails
`the_ready_only_rule_does_not_release_a_degraded_candidate`,
`the_new_candidate_cannot_be_placed` and
`the_preflight_reports_capacity_blocked` (4 passed, 3 failed).

**Suite**: 356 passed, 0 failed. `cargo fmt --all -- --check` clean.

## What Phase 9A does not do

- No staging query was executed. TASK-05 stops at the artifact and publishes the
  three `SELECT`s it would need.
- No reclamation rule is designed here. TASK-07's ADR depends on TASK-05's
  missing fields, and designing it first would be the exact inversion the brief
  forbids: 「不要先执行 staging 回收，再回头找理由证明它是安全的。」
- TASK-11 (PREPARING), TASK-12 (redeploy capacity), TASK-13 (generation
  fencing), TASK-14 (activate/reclaim race), TASK-15 (physical release) and
  TASK-16 (repeated cycle) are not started. They are Phase 9B and 9C.
