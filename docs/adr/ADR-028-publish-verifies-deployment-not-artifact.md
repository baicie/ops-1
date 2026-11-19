# ADR-028: The publish script must verify the deployment, not the artifact

**Status: PROPOSED — one half implemented (the retry), one half not (the state
machine).**

Found 2026-11-19, on the fourth consecutive "green" staging deploy that published
nothing.

## What happened

`deploy to staging host` succeeded on `edba489` and again on `4baa4fb`. Its log
says:

```
opsweave.data-catalog@0.0.17455     already installed; leaving it
opsweave.data-integration@0.0.17455 already installed; leaving it
data plugin bundles installed at 0.0.17455
```

`publish-data-plugins.sh` short-circuits on the package's *existence*:

```bash
installed="$(... SELECT count(*) FROM kernel.plugin_packages
                  WHERE plugin_id='$plugin' AND version='$version')"
if [ "$installed" != "0" ]; then
  say "$plugin@$version already installed; leaving it"
  continue          # <- deploy never called
fi
```

So a version that was **installed but never successfully deployed** is skipped
forever. Staging has been in exactly that state: a publish installed
`0.0.17455`, the deploy failed with `INSTANCE_CAPACITY_EXCEEDED`, and every
publish since has said "already installed" and moved on.

This is the mechanism behind the four-instance wall, and it is independent of
ADR-027. ADR-027 explains why the *first* deploy ran out of slots; this explains
why it was never retried afterwards.

## What was fixed

The `continue` now skips only the INSTALL. "Already installed" is a true statement
about the artifact — the version is a content hash — and says nothing about
whether it is running. The script now calls `opsctl deploy --wait` on that path
too, which is idempotent: an active version returns `VERSION_ALREADY_ACTIVE`, a
healthy deployment returns 202 unchanged, a failed one is retried.

Under `set -euo pipefail`, a failed deploy fails the run. That is the point: the
previous behaviour turned "deployment failed" into "everything is fine" three runs
in a row.

## What is not fixed, and is the larger half

The script still treats a successful exit of `opsctl deploy --wait` as "the
plugin works". TASK-06 asks for a state machine — PREPARED / IMAGE_PUBLISHED /
BUNDLE_VERIFIED / INSTALLED / DEPLOYING / READY / ACTIVATED / FAILED / ROLLED_BACK
— and for the run's success condition to be **the plugin actually READY**, not
"the Kernel is healthy". ADR-026 specifies it; this ADR records the second,
smaller defect found on the same path.

The two are related and should land together:

- ADR-026 makes the outcome *legible* (a journal, a per-plugin state).
- ADR-028 (this one) makes the outcome *checked* (a deploy is attempted even when
  the artifact already exists).

Neither alone would have caught the state staging was in. A journal with the old
`continue` would have recorded "SKIPPED" accurately and still published nothing.

## Why this half is an ADR and the other is a patch

The retry is a bug fix: the script claimed to be idempotent and was not, because
idempotence was checked at the wrong layer. The state machine is a design change:
it needs the state names agreed (ADR-026's four open questions) and an isolated
acceptance test that injects a failure at each step. That test cannot be written
against states that have not been decided.

## Verification

**Not verified on staging.** The fix is exercised only when a plugin's content
changes — the version is a content hash — and this round has produced no content
change. What can be said:

- the script parses (`bash -n`) and the change is confined to one branch;
- `pipefail` is set, so a failing `opsctl deploy` fails the run rather than being
  swallowed by `| tail -2`;
- the path it unblocks is the one ADR-027's tests measured (4/4 slots on
  `staging-node`).

Claiming it fixes staging needs a real content change and a real deploy. That is
the first thing to do next round.

## Decisions needed

1. **Is `already installed; re-checking its deployment` the right behaviour, or
   should the script fail when the package exists but is not deployed?** The
   proposal retries, because a retry is what an operator would do.
2. **Should a failed deploy leave the bundle installed?** Currently yes. ADR-026
   would record the state; neither ADR changes it.
