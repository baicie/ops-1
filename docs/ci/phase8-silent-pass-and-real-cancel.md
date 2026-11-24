# Phase 8 TASK-29 / TASK-13: two suites that ran zero assertions, and a cancel that never landed

Measured 2026-11-24 against main `33c324ac`.

## TASK-29: a green step that asserted nothing

`plugin-lifecycle.yml` ran five times on 2026-11-23 and every run was SUCCESS:

| run | SHA | `phase7_publish_failures.sh` | `phase7_two_node_failure.sh` |
|---|---|---|---|
| 45172963410 | `a039cf6c` | `0 passed, 0 failed, 1 skipped` | `0 passed, 0 failed, 1 skipped` |
| 45183654404 | `d3c57d52` | same | same |
| 45190236157 | `fd6a6258` | same | same |
| 45197291594 | `bd096628` | same | same |
| 45203998931 | `32326958` | same | same |

The messages were:

    skip no local images to push; TASK-01..06 need a built bundle
    skip the data-catalog:0.0.3 image is not local; run scripts/build-plugins.sh first

Both scripts then `exit 0`.

### Why

`scripts/build-plugins.sh` builds hello-ops, hello-go and hello-java. The data
plugins come from `scripts/build-data-plugins.sh`, and its only CI caller is
`data-foundation.yml` - a different workflow, a different job, a different
runner. `plugin-lifecycle.yml` never produced
`dist/plugins/data-catalog-0.0.3.plugin.zip` or the images it names, so both
suites took their "artifact missing" branch on every run.

`docs/engineering/publish-failure-coverage.md` cites these two scripts as the
INTEGRATION_VERIFIED evidence for rows 6-11. Those rows were real on a
developer machine. On CI they were never executed.

### The defect class

A suite that skips and a suite that passes are indistinguishable when both exit
0. The workflow had the call sites, the steps ran, the job was green - and
nothing was asserted. This is "a spec with no workflow is not a gate" one level
up: the call site is necessary and not sufficient; what matters is whether the
call reaches an assertion.

### What changed

1. A build step in `plugin-lifecycle.yml` produces the data-plugin images, the
   0.0.3 bundles, **and a 0.0.4 bundle**. Nothing in the repository had ever
   produced 0.0.4, which is why TASK-06 had no second version to roll back to.
2. Both suites exit **3 (BLOCKED)** when their artifact is missing.
   `--allow-skip` restores the old behaviour and CI does not pass it.
3. `tests/ci/phase7_suites_cannot_silently_pass.test.sh` asserts the property
   directly: missing artifact means exit 3, the escape hatch still works, and the
   build step precedes the consumers. 11 assertions.

## TASK-13: the rollback that was never interrupted

### What the old case actually measured

`TASK-06` sent SIGTERM to `opsctl rollback` after `sleep 0.15`. EIGHT separate
reasons meant nothing was cancelled, only one of which was known:

1. **It rolled back to the version already active.** `rollback` takes its
   idempotent branch, returns in well under a second, and the signal arrives
   after the process has exited. `wait` reports the rollback's own success.
   The row-11 note in the coverage doc recorded this.
2. **No 0.0.4 bundle existed anywhere**, so the "make the rollback do work"
   preamble could never run. Measured in every local and CI run before this
   change: `skip 0.0.4 could not be activated`.
3. **TASK-02's injected `--selector` was still on the 0.0.4 deployment row.**
   The clean-up redeployed `$V1` with an empty selector, but the injection had
   been applied to the 0.0.4 row, which was `PENDING`. `create_deployment_inner`
   short-circuits on PENDING and never rewrites `placement`, so the clean-up
   changed nothing and every later 0.0.4 deploy timed out with
   `SELECTOR_MISMATCH`. Found by querying the live database mid-run:

       0.0.3 | ACTIVE  | {"nodeSelector": {}, ...}
       0.0.4 | PENDING | {"nodeSelector": {"no-such-label": "no-such-value"}, ...}

4. **The 0.0.4 image was never pushed to the registry the suite starts.**
   The push list named only the two 0.0.3 images. Once (2) and (3) were fixed the
   deployment got as far as pulling and failed:

       failed to resolve reference "...data-catalog@sha256:7d39c50a...": not found  attempt=4

   The same defect shape as the original, one layer down: the artifact existed
   on disk and not where the platform looks for it. Each of the four was found
   by running the case and reading where it stopped, not by reading the script.

5. **The 0.0.4 image was built with zero placeholder digests.** Once it pulled and
   started, the node refused it:

       Runtime Info does not match signed manifest: plugin=opsweave.data-catalog/0.0.4
       capability=sha256:0000...0000

   The plugin reports the capability digest baked into the image; the manifest
   carried the same zero value, so the two agreed with each other and not with
   the capability set the plugin actually provides. The deployment reached
   `DEGRADED 0/1 ready (1 failed)` and TASK-06 would have skipped again.

   This one was NOT a harness bug in the suite - it was my own build command, and
   the same mistake was in the workflow step I had just written. Both now compute
   the digest the way `scripts/build-data-plugins.sh` does:

       sha256:cf10cb3a7e053ba48d3aa5c6da510366983e995f13d8082ba043d83f09d182d3

   Recorded because it is the most instructive of the five: a placeholder that
   satisfies a schema is still a placeholder, and the platform's signature check
   is what caught it. Had this shipped as "0.0.4 exists, TASK-06 ran", the case
   would have measured a degraded deployment and called it a rollback.

6. **The switch back was attempted with `opsctl deploy`, which is the wrong verb.**
   After 0.0.4 activated, the harness tried to return to 0.0.3 with `deploy` and
   was refused:

       opsweave.data-catalog@0.0.3 is DRAINING - a stopped deployment is not
       redeployed by a publish; run `opsctl enable` or `opsctl uninstall`

   The platform is right and the harness was wrong: `deploy` is the publish path
   and deliberately does not resurrect a version it has released. `rollback` is
   the operation that means "put this version back in service", and it walks the
   same redeploy-then-activate path the case exists to interrupt.

   The SAME wrong verb then appeared a second time, in the restore after the
   convergence check: `ops deploy 0.0.3 || true` silently failed, the `|| true`
   swallowed the exit code, and the next assertion reported

       FAIL the plugin is on 0.0.4, but later cases assume 0.0.3

   with nothing in the output saying why. Two lessons, both now in the code: a
   `|| true` on a restore hides the reason a later case fails, and the verb for
   "bring a superseded version back" is `rollback` everywhere, not just once.

8. **(local only) The 0.0.4 image was amd64 and the developer machine is
   arm64.** After (4) the pull got one step further and failed with:

       no matching manifest for linux/arm64/v8 in the manifest list entries

   This one is an environment limit, not a product or harness defect, and CI on
   `ubuntu-24.04` (amd64) would not hit it. It is recorded because it cost a run
   and because it is the kind of thing that gets mistaken for a platform bug: the
   image *existed*, the registry *served* it, and the node still could not start
   a container. The fix is to build the image on the machine that will run it,
   which is what the workflow step does natively.


### The barrier

The Phase 8 brief forbids replacing a sleep with a longer sleep. The kernel
already exposes a real serialisation point: `reconcile_once_scoped` takes a
PostgreSQL advisory lock per cycle and skips the cycle when it cannot get it
(`pg_try_advisory_lock`). Holding the same key from a second session therefore
freezes placement deterministically.

Verified directly before being relied on:

    while a session held key 257818626:   pg_try_advisory_lock -> f
    after release:                        pg_try_advisory_lock -> t

Important detail found while wiring it: a two-int advisory lock appears in
`pg_locks` as `classid = key1, objid = key2, objsubid = 2`. Filtering on
`objid = 257818626` matches nothing, so the barrier would have "failed to
acquire" while actually holding the lock. The check uses `classid`.

### The sequence

    a. activate 0.0.4, then ROLL BACK to 0.0.3 so 0.0.4 is DRAINING/DISABLED
    b. take the planner lock
    c. start `rollback 0.0.4` - it writes the redeploy (PENDING, generation+1)
       and blocks in `wait_for_ready`, which cannot reach READY while no planner
       runs
    d. wait for the row to BE PENDING (a database condition, not a sleep),
       assert the ACTIVE revision is still 0.0.3, then SIGTERM the client
    e. release the lock, then retry the rollback and assert it completes and
       moves the route to 0.0.4

### Measured result

All eleven assertions pass against a real kernel, PostgreSQL and two node
processes:

    ok   0.0.4 is DRAINING, so a rollback to it must redeploy and wait
    ok   the barrier uses the kernel's own planner-lock namespace
    ok   the planner lock is held: placement is frozen at a known point
    ok   the rollback is mid-transition: 0.0.4 is PENDING 2
    ok   the frozen rollback has NOT activated 0.0.4; the route is still 0.0.3
    ok   the planner lock is released; reconciliation can resume
    ok   the kernel still describes its plugins after the cancel
    ok   the interrupted rollback, retried, completes
    ok   the retried rollback moved the route to 0.0.4
    ok   the plugin is back on 0.0.3 for the cases below
    ok   the rollback was interrupted mid-transition (signal delivered, rc=143)

`PENDING 2` is the deployment status and its new generation: the rollback's
redeploy write happened, the activation after it did not. `rc=143` is SIGTERM.
The frozen window was bounded by two database polls, not by a clock.


The step (d) assertion is the one the freeze buys: while the transition is
frozen, nothing activated. A rollback that moved the route before its work was
done would show up there.

### Bounded hazard, stated rather than hidden

The staleness sweep (`UPDATE kernel.nodes SET status='UNREACHABLE' ... WHERE
last_seen_at < now() - node_stale_seconds`) runs **under the same lock**. So it
does not run while the barrier is held - which is what keeps the instances alive
through the frozen window - and it runs on the first cycle after release. Node
heartbeats are every 5 s and the staleness threshold is 25 s, so a barrier held
for seconds is safe and a barrier held for minutes would turn this case into a
node-failure test. The window is bounded by database polling, not a sleep.

### What it still does not prove

The freeze is on the PLANNER, not inside a single transaction. A rollback killed
a microsecond after committing its activation would leave a state this sequence
does not reproduce. What it does prove, which the previous version did not, is
that a rollback was genuinely interrupted partway, the platform stayed
describable, nothing half-activated, and a retry converges.
