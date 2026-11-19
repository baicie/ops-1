# ADR-026: Staging publish transactionality

**Status: PROPOSED — not implemented. TASK-06 requires an isolated test first,
and the brief forbids an unauthorised staging publish.**

Baseline: `.github/workflows/staging-preview.yml` at `c3edae4`, `scripts/publish-data-plugins.sh` after #139.

## The defect

The deploy job is ordered:

```
1. build image
2. deploy to staging host        <- Kernel + Node replaced, health-checked
3. Publish the data plugin bundles   <- `set -euo pipefail`
```

Step 3 runs under `set -euo pipefail`, and `publish-data-plugins.sh` itself uses
`die()` on the first failure. So one plugin's failure aborts the whole step and
the run goes red — **with the Kernel already replaced**.

The platform is then in exactly the state the brief names:

```
Kernel New
Node   New
Plugin Old / Partially Installed
```

and the deploy job fails. Two things ARE recorded, and an earlier draft of this
ADR said otherwise:

  - the job log prints the publish script's per-plugin lines (`pushed`, `staged`,
    `PENDING ...`, the `Install`/`deploy` output) - it is piped to the log, not to
    `/dev/null`;
  - `Collect host status` (`if: always()`) writes `host-status.json` from
    `deploy-staging.sh --status --json` and `Upload deploy evidence` archives it,
    so the host's own view of what it is running survives a failed run.

What is NOT recorded is the **per-plugin publish state** as a machine-readable
fact: which of build/push/bundle/install/deploy each plugin reached. The log has
it as prose and the host has its own deployment record; neither says "plugin 2
was installed but never deployed". That is the gap.

### Why the plugin step cannot simply move first

Publishing a bundle requires the new Kernel: `opsctl` registers the publisher and
installs against the Kernel's own API. Publishing before the deploy would install
against the old Kernel, and then the deploy replaces that Kernel's database - the
`plugin_deployments` rows written by the install would be gone with it, so the
work would have to be redone against the new Kernel. (The rows would not
"reference a Kernel that no longer exists": the database is replaced, not
versioned alongside it, so the rows are lost rather than dangling.)

So the order is forced. What is missing is not sequencing; it is **the ability to
say what state the publish reached, and to resume from it.**

### What a partial publish looks like today

`publish-data-plugins.sh` does, per plugin, across three separate loops over
`PLUGINS=(data-catalog data-integration)` - images, version, then publish - and
the publish one is:

```
bundle -> install -> deploy --wait
```

**It never calls `activate`.** `grep -c activate scripts/publish-data-plugins.sh`
returns 0. That is a defect in its own right and is recorded separately (B-18):
`route_candidates` requires `r.status = 'ACTIVE'` on an
`kernel.activation_revisions` row, so a plugin that is installed and deployed by
this script is never routed to, however healthy its instances are.

A failure at "sign" for the second plugin leaves:
- plugin 1: installed and deployed (a new version, live)
- plugin 2: an image pushed to the registry, no bundle, not installed
- the OCI registry holding a tag nothing references

Re-running the script is *mostly* safe, but "mostly" is the problem and the
reasons differ per step:

  - push: re-pushed to the same tag. Idempotent by construction (content hash).
  - install: skipped entirely since #149, by an existence check - so a **failed
    deploy is now retried** rather than skipped with the install. Before #149 the
    whole loop iteration was skipped, which is what hid the staging failure for
    four runs.
  - deploy: **not idempotent in the way this ADR first claimed.** `opsctl` treats
    any non-2xx as a hard error (`apps/opsctl/src/main.rs:196-197`), and the
    kernel returns `409 VERSION_ALREADY_ACTIVE` for a version that is already
    active (`apps/kernel/src/deployments.rs:345`). So re-deploying the active
    version does not "return success unchanged" - it fails the run. Documented
    real output: `Error: API 409 Conflict returned VERSION_ALREADY_ACTIVE`.

A re-run after a partial publish has never been exercised end to end.

## What is proposed

### 1. A published state machine, recorded in the journal

Per plugin, in the run's own record. (An earlier draft justified this with "the
database is one of the things being replaced" - that is wrong: `deploy-staging.sh`
replaces `kernel` and `node` only, and PostgreSQL is a dependency service, not an
application service. The real reason to keep the journal out of the database is
that the database is a thing the journal describes, and a record that lives
inside its own subject cannot report the subject being unavailable.)

```
PREPARED           inputs hashed, version computed
IMAGE_PUBLISHED    push verified, manifest read back, digest resolved
BUNDLE_VERIFIED    bundle assembled, signature verified, digest recorded
INSTALLED          kernel accepted the package
DEPLOYING          deploy issued
READY              the data endpoint answered
ACTIVATED          activation revision is ACTIVE
FAILED             with the step name and the error
ROLLED_BACK        the previous package is the ACTIVE one again
```

The journal is a JSON file in the workflow's artifact, appended per step. Decision
2 below proposes that it be a **record, not a resume cursor** - so this section
should not promise resumption. It says what state was reached; the next run
starts from the top and relies on the steps being idempotent, which
`publish-data-plugins.sh` now is for install and deploy (#149) but is not yet
proven to be for a partially-signed bundle.

### 2. The deploy job's success condition must be the plugin state

TASK-06 is explicit: *不允许 Kernel Health 通过就宣称整个平台发布完成*.

Today the job's own conclusion is that of its last step (plus any step marked
`continue-on-error`, of which this job has none for the publish). Because the
publish step runs under `set -euo pipefail` and pipes the script's output through
`tail -30`, the script's non-zero exit does fail the step - the gap is not the
exit code but what the code *means*: it cannot distinguish "no plugin needed
publishing" from "every plugin published and is READY". The proposal: the final step
reads the journal and fails unless **every** plugin is `READY` or `ACTIVATED`,
naming the plugin and the state it stopped at. Kernel health is a precondition,
not the answer.

### 3. What is NOT proposed: distributed transactions

There is no way to make "replace the Kernel" and "install plugins into it" atomic,
and pretending otherwise would be worse than the current state. The proposal is
**recorded, resumable, and honest**, not atomic.

### 4. The honest failure mode

When the publish fails after a Kernel deploy, the run must:

1. say so in the run summary in those words — not "deploy failed";
2. leave the journal artifact;
3. NOT roll the Kernel back automatically. A Kernel rollback is a second deploy
   with its own failure modes, and doing it unattended after a partial publish can
   turn a mixed state into a broken one. This needs a human, and the run should
   say that.

This is a deliberate choice against "self-healing". The brief's rollback
requirement — 回滚不能留下误导性的 ACTIVE 记录 — is why: an automatic rollback
that leaves an ACTIVE activation revision pointing at a package the old Kernel
cannot serve is worse than a red run a person reads.

## The isolated test

TASK-06 requires it, and it is the part that makes this more than a document.

```
tests/acceptance/publish_resume.sh
```

Drives `publish-data-plugins.sh` against a **local** Kernel with `docker` and
`opsctl` pointed at that instance, injecting a failure at each step in turn.

The harness does not already exist for this, which an earlier draft implied: the
`tests/acceptance/` scripts that boot a platform are `.sh` files that each own a
full bring-up and teardown (`e2e_platform.sh`, `pipeline_orphan_worker.sh`, ...),
not a reusable "boot one Kernel and hand it back" fixture. Extracting one is part
of this task's cost, not a free dependency.

The failure-injection points:

| Injected at | Expected journalled state | Re-run from there |
|---|---|---|
| after push | `IMAGE_PUBLISHED` | does not rebuild or re-push |
| after bundle | `BUNDLE_VERIFIED` | does not re-assemble |
| after install | `INSTALLED` | does not re-install |
| during deploy | `DEPLOYING`/`FAILED` | re-deploys |
| after ready | `READY` | no-ops |

Each case asserts the journal, not just the exit code — because the defect is
that the exit code was the *only* record.

**Not written yet.** Boot time for the acceptance harness is significant and this
is the largest single item in Wave A; it should not be started before the state
machine above is agreed, because the test asserts the state names.

## Decisions needed

1. **Journal location** — workflow artifact, or a file on the staging host? Artifact
   survives the runner; the host survives a workflow re-run from a different
   runner. Proposal: artifact, plus the host copies it to
   `/srv/opsweave-staging/publish-journal.json` so both exist.
2. **Resume vs. always-rebuild** — resuming is faster but adds a second code path.
   Always-rebuild is simpler and, since the version is content-addressed, mostly a
   no-op. Proposal: always-rebuild, and let the journal be a *record* rather than
   a resume cursor. This halves the implementation and removes the "resumed from a
   stale journal" failure mode.
3. **Should a failed plugin publish fail the whole deploy job?** It does today.
   Given the Kernel is already new, a red job is the correct signal — but only if
   the summary says "Kernel deployed, plugins did not". Proposal: yes, fail, with
   that wording.
4. **Does `verify_only` skip the publish?** It does (`if: inputs.verify_only != true`).
   That means a nightly verify-only run cannot detect a plugin regression. Out of
   scope here, but it belongs in TASK-09's concurrency review.

## Why this is an ADR and not a patch

The change is ~200 lines across the publish script, the workflow, and a new
acceptance test, and it can only be validated against a live Kernel. Doing it
without the state names agreed would produce a test that asserts whatever the
implementation happened to do, which is the failure mode this repository keeps
finding in its own CI.
