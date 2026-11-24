# TASK-19: publish failure-recovery acceptance — what is covered, what is not

Written 2026-11-23 against main `a6115753`; **revised 2026-11-24 against `4cd95d93`** after
Phase 7 Batch A. Five rows moved from NOT_COVERED to INTEGRATION_VERIFIED, and the
reason they moved is recorded rather than just the new state. Every row states the test that proves
it, or that nothing does. Nothing here was inferred from "the code looks right".

## The eleven conditions

| # | Condition | State | Evidence |
|---|---|---|---|
| 1 | Build fails | **ALREADY_COVERED** | `scripts/build-plugins-retry.test.sh` — 12 cases, including a compilation error failing on the FIRST attempt (no retry) and a test failure doing the same |
| 2 | Push fails | **ALREADY_COVERED** | `scripts/verify-registry-digest.test.mjs` — a 404 tag and a 500 registry answer are each refused, and a 500 is reported as an ERROR rather than "no such tag" |
| 3 | Registry unreachable | **ALREADY_COVERED** | same file — `the registry could not be asked: fetch failed`, verdict REFUSED. Measured end to end against a real `registry:2` on a stopped port |
| 4 | Digest mismatch | **ALREADY_COVERED** | same file — the measured staging defect (`sha256:d9e853e8` vs `sha256:45e09956`) is a case, and `local` vs `remote` disagreement is a SEPARATE case with its own message |
| 5 | Bundle signature fails | **ALREADY_COVERED** | `crates/bundle` — `rejects_tampered_payload` and `manifest_image_reference_is_covered_by_signature` |
| 6 | Install succeeds, deploy fails | **INTEGRATION_VERIFIED** | `tests/ci/phase7_publish_failures.sh` TASK-02: an unsatisfiable `--selector` on an undeployed version is refused, the refusal NAMES the placement reason, and the ACTIVE version does not move |
| 7 | READY but activate fails | **INTEGRATION_VERIFIED** | same script, TASK-03: a stale `--expected-revision` is refused (rc=1), the previous version keeps serving, and the serving container is still running afterwards |
| 8 | Activate succeeds but the read-back differs | **INTEGRATION_VERIFIED** | same script, TASK-04: deploying a version the kernel does not have is refused (rc=1), and the active version does not move. **Partial**: the mismatch is 'version absent', not 'kernel read back a different version than asked' — that second shape has no injection yet |
| 9 | One plugin succeeds, another fails | **INTEGRATION_VERIFIED** | `tests/ci/phase7_publish_failures.sh` TASK-08: with data-catalog active, data-integration's deploy is made to fail. The FIRST plugin stays active at 0.0.3, its container count is unchanged, the failing plugin's package is still registered (install and deploy are separate), and it does NOT report active. `publish-untried-report.test.sh` still covers the EXIT trap's report |
| 10 | Re-run after a failure | **INTEGRATION_VERIFIED** | same script, TASK-05: after the injected failures a re-run succeeds (rc=0), registers no extra package, and converges to the same active version |
| 11 | Cancelled during rollback | **INTEGRATION_VERIFIED (narrow)** | same script, TASK-06: SIGTERM reaches the rollback (rc=143), the kernel still lists its plugins, a later deploy converges, and the final active version is the expected one. **Narrow**: on that run the rollback was a no-op, so the platform recovered from a signal during an operation that had little to interrupt |

## What changed in the revision, and why

The first version of this document said rows 6–11 needed a KERNEL and marked them
NOT_COVERED. **That was right about the tests and wrong about what is possible
here.** `tests/ci/p001c_up.sh` brings up a real kernel, a real PostgreSQL and two
real node processes on one host, isolated by run id; `plugin-lifecycle.yml` already
runs it. Nothing about the missing coverage required staging - it required driving
that kernel.

`tests/ci/phase7_publish_failures.sh` does, in 24 assertions with 1 honest skip.
Every case checks the ABSENCE as well as the failure: "the deploy was refused" and
"the active version did not move" are separate claims, and only the second is about
production.

### Three of them are narrower than their state word suggests

- **Row 8** injects "the version does not exist", not "the kernel activated one
  version and the read-back returned another". The second shape needs a fault
  between activation and the read, and there is no injection for it.
- **Row 11**'s rollback was a no-op on the measured run (the target was already
  active), so the signal arrived at a process with little to interrupt. The
  recovery assertions hold; the cancellation assertions did not get a real
  transition to cancel.
- **Row 9** moved to INTEGRATION_VERIFIED, but through the SAME kernel rather than
  through `publish-data-plugins.sh`. What is proven is that one plugin's failed
  deploy leaves the other serving; what is not is a real two-plugin run of the
  publish shell script itself, which needs two images built and pushed.

### And the environment is one host

Two node PROCESSES, not two machines. Nothing here is two-node HA, and the script
says so at the end of every run.

## What IS delivered here instead

`scripts/ci/publish-phases.mjs` answers, for any phase, what a failure there leaves
behind and whether production moved. That does not make 6–11 tested; it makes their
failure modes DESCRIBED and testable, which is what a harness would assert against.

Its `scriptDrift` check makes the description honest: if the publish script grows,
loses or renames a stage, the model is reported as drifting rather than quietly
describing a release that no longer happens.

## The line this file does not cross

None of rows 6–11 is marked PARTIAL or "effectively covered". A condition that has
never been executed is NOT_COVERED, and saying so is the point of writing this
table rather than a design document that reads like an acceptance report.

## Correction, 2026-11-24: rows 6–11 were never executed in CI

Everything above was true of a DEVELOPER MACHINE and false of CI, and this
document did not distinguish the two. Measured on five consecutive
`plugin-lifecycle.yml` runs, every one of them SUCCESS:

| run | what the Phase 7 steps printed |
|---|---|
| 45172963410 | `0 passed, 0 failed, 1 skipped` (both suites) |
| 45183654404 | same |
| 45190236157 | same |
| 45197291594 | same |
| 45203998931 | same |

`phase7_publish_failures.sh` said:

    skip no local images to push; TASK-01..06 need a built bundle

`phase7_two_node_failure.sh` said:

    skip the data-catalog:0.0.3 image is not local; run scripts/build-plugins.sh first

Both then `exit 0`. **Zero assertions ran on every CI run**, and the job reported
success, so a reviewer reading the checks saw two green "Phase 7" steps.

The cause is a build input this job never produced. `scripts/build-plugins.sh`
builds hello-ops, hello-go and hello-java. The data plugins come from
`scripts/build-data-plugins.sh`, whose only CI caller is `data-foundation.yml`.
And TASK-06's second version (`data-catalog-0.0.4.plugin.zip`) was produced by
nothing at all, in any workflow - which is why the rollback it measured was always
a no-op, the exact gap the row-11 note above describes.

So the correct reading of rows 6–11 at the time of writing was not
INTEGRATION_VERIFIED on CI. It was: **verified locally, NOT_RUN in CI.** The
assertions themselves were real - they pass against a real kernel, and the numbers
in this table were measured - but nothing executed them on main.

Three things changed, in `plugin-lifecycle.yml` and the two suites:

1. The job builds the data-plugin images and both bundles, including 0.0.4, in a
   step before the suites that consume them.
2. Both suites now exit **3 (BLOCKED)** when their artifact is missing, instead of
   0. `--allow-skip` restores the old behaviour and is never passed by CI.
3. `tests/ci/phase7_suites_cannot_silently_pass.test.sh` checks that property
   directly, so a step that runs and proves nothing cannot come back green.

Rows 6–11 are INTEGRATION_VERIFIED when that job's Phase 7 steps report a non-zero
assertion count. They are not INTEGRATION_VERIFIED because this document says so.

The general defect this corrects is worth naming: **a suite that skips is
indistinguishable from a suite that passes when both exit 0.** A call site in a
workflow is necessary and not sufficient; what matters is whether the call reaches
an assertion.

