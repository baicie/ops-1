# ADR-027: A plugin upgrade must release the old version's instances

**Status: WITHDRAWN — the premise was false. One genuine defect found while
investigating it was extracted and kept (see "What survived").**

> **Correction, 2026-11-19.** This ADR claimed that "nothing disables the previous
> version's deployment". That is wrong, and I did not check before writing it.
> `activate` has released the previous deployment since #50 (commit `67966aa`):
>
> ```sql
> UPDATE kernel.plugin_deployments
> SET status='DRAINING', status_reason='Superseded by activation revision',
>     drain_until=now()+interval '15 seconds'
> WHERE id=$1 AND status IN ('ACTIVE','READY')
> ```
>
> A 15-second grace period, so the old version keeps serving while the route
> moves. The platform already did what this ADR proposed to add.

## What actually happened

The ADR was written from the shape of a failure — `4 instances already scheduled
on this node against a per-node limit of 4` — plus a reading of `deploy_plugin`
that did not mention draining. Both were true statements that added up to a false
conclusion. `grep -n 'Superseded by activation revision'` would have settled it in
one command, and I did not run it until after two PRs and a broken acceptance run.

PR #148 then added a second drain with `drain_until` in the past. The consequence
was immediate and is the clearest evidence in this whole round:

```
FAIL  10/10 requests left v1 while v2 was not activated
```

Blue/green is deploy-then-activate. A drain with no grace period stops the old
instances before the route has moved, so every publish became downtime. My "fix"
for that moved the duplicate into `activate`, beside the real write. PR #151
removes it; `activate` is back to one write.

## What survived

One defect was real, and it was hiding underneath the false premise:

**A `DISABLED` deployment's instances were never stopped.** `reconcile_once` plans
only the active set, so an instance whose deployment had just been disabled was
never looked at again — `desired_action` stayed `START` and it held a node slot
with nothing running on it. `git show 4baa4fb^:...` has zero references to that
statement, so this was genuinely missing.

Same shape as the ghost defect this round started with, one level up: a row
describing work that will never happen, still counted. It is kept, with a test
(`a_drained_version_frees_its_node_slots_after_the_grace_period`) that asserts
both halves — still serving inside the grace window, released after it.

## What the staging failure actually is

Not cross-version leakage. Each version's `activate` already released the
previous one, so a normal upgrade never accumulates deployments.

Those four instances belong to deployments that were **never activated at all**.
On staging the publish has never reached `ACTIVATED`: `deploy --wait` times out
first. So no `activate` runs, so no drain runs, so the instances that an earlier,
failed attempt left behind stay.

That is a different problem from the one this ADR described, and it is the one
that matters:

- Is a retry of the same version supposed to reuse its containers or rebuild
  them? (Container identity is `opsweave-{node}-{instance_id}`, so reusing is the
  natural answer — but the instance is reset to `STARTING` and the node has no
  path to terminate the previous attempt's container.)
- And what does `DEPLOYING → failed` mean for the next run — retry, or recreate?

Both belong to ADR-026's publish state machine, which is where they are recorded.
This ADR does not answer them and should not have been written as if it did.

## Decisions, restated honestly

1. ~~Should an upgrade release the old version?~~ **Already does.** Not a
   decision.
2. ~~Is a brief downtime acceptable?~~ **Moot.** The existing implementation
   gives 15 seconds of overlap; that was already the answer.
3. `placement.rollout` (stop-then-start vs surge) — still unimplemented, still an
   open design question, but not blocking anything.
4. What `uninstall` does to history — unchanged and unrelated.

## The lesson worth keeping

Two PRs, one acceptance failure and one duplicated SQL statement came from
reading two true facts and concluding a third. The specific check that would have
caught it takes one command and should be the first thing done when writing an
ADR that says "nothing does X":

```bash
grep -rn 'DRAINING\|drain_until' apps/kernel/src/
```

Recorded in the findings register as B-15 alongside the two mistakes.
