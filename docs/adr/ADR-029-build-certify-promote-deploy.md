# ADR-029: Build, Certify, Promote and Deploy are four states, not one

**Status: PROPOSED — the certification workflow and the receipt exist; nothing has
been promoted.**

Found 2026-11-20, `0d42d3f`. TASK-08/09/10.

## The problem

This repository has one pipeline and it answers several questions at once. A green
`main` push means, depending on who is reading:

- the code compiles and its tests pass (**build**)
- some image exists at some tag (**build**, again)
- `staging-preview` deployed that commit and its smoke suites passed (**deploy**)
- therefore the commit is releasable (**promotion** — which nothing ever checks)

Three of those are true independently and the fourth is not implied by any of them.
The specific failures this produced, all measured:

1. **Build success read as deploy success.** `publish-data-plugins.sh` reported
   success while publishing nothing, three times (ADR-028). The step exited 0; the
   business path did not move.
2. **Deploy success read as certified.** `staging-preview` deploys and smokes, but
   it is cancelled by the next push (`cancel-in-progress: true`, deliberately), so
   the last commit of a rapid series is the only one whose acceptance evidence
   survives. Nothing distinguishes "this SHA was deployed and verified" from "this
   SHA was superseded before its verification finished".
3. **`main` HEAD read as the shipped thing.** There is no artefact identity
   anywhere in the merge path. A tag, an image digest and a commit SHA are three
   names for three different things and nothing joins them.

## Decision

Four states, each with a different producer and none implying another:

| State | Producer | Means | Does NOT mean |
|---|---|---|---|
| **BUILT** | `ci.yml` + publish scripts | a digest was produced from this SHA | it works |
| **CERTIFIED** | a tag- or dispatch-triggered run | this exact SHA passed the full suite | it is deployed |
| **PROMOTED** | an operator action | this receipt was accepted as a release | it is live |
| **DEPLOYED** | `staging-preview` / a release job | a host serves this digest | customers use it |

The rules that follow, and each one is a thing the current pipeline gets wrong:

1. **A certification is bound to a SHA and cannot be superseded.** Its concurrency
   group contains `run_id` (the pattern `check-concurrency-supersede.mjs` already
   enforces for `workflow_dispatch` and `schedule`), so no push cancels it and no
   pending run displaces it. This is the answer to TASK-08.
2. **Build success does not certify.** Certification runs the suites itself against
   the tag's tree; it does not read `main`'s latest green run. TASK-09.
3. **Certification produces a machine-readable receipt** that another process can
   verify without trusting a file name or a run summary. §Receipt.
4. **Promotion is a separate, recorded action.** It consumes a receipt and names
   the digest it promotes. It never rebuilds: a promotion that produces a different
   digest is a bug, not a re-release. TASK-10.
5. **A deployment names the digest it deployed**, and staging failure never blocks
   a code merge (`GATE_OWNERSHIP` already says this; ADR-029 does not change it).

## Receipt

`scripts/release-receipt.mjs` writes and verifies it. Every field is either copied
from the run that produced it or read from the GitHub API — none is typed in by
hand, because a receipt someone types is a claim, not evidence.

```json
{
  "schema": "opsweave.release-receipt/v1",
  "subject": {
    "repository": "baicie/ops-1",
    "sha": "<40 hex>",
    "ref": "refs/tags/v0.0.1",
    "tag": "v0.0.1"
  },
  "trigger": { "event": "push", "runId": 123, "attempt": 1 },
  "suites": { "rust": "success", "web-unit": "success", "...": "..." },
  "artifacts": { "imageDigest": "sha256:...", "bundleDigest": "sha256:..." },
  "certifiedAt": "2026-11-20T12:00:00Z",
  "verdict": "CERTIFIED"
}
```

`subject.sha` and `subject.ref` are what a promotion verifies against. The receipt
is refused if the run it cites did not succeed, if the SHA does not match the tag
it was built from, or if a suite it claims is missing from the run's check runs.

**Why not a plain artifact name.** An artifact called
`release-<sha>-<verdict>.json` proves only that someone uploaded a file with that
name. The receipt is verified by re-reading the run, so a forged file fails.

## What is NOT decided here

- **No promotion is implemented.** `promote` is described, not built. It needs a
  destination and an authorisation story that this ADR does not have.
- **The image digest is recorded, not verified.** TASK-15 wants registry-side
  verification; this receipt records what the build reported. Until TASK-15 lands,
  `artifacts.imageDigest` is a claim by the build, marked as such in the receipt.
- **No tag is created.** The workflow triggers on a tag; creating one is a release
  action, and releasing is not in this round's authority.

## Consequences

- A full certification run costs one complete suite pass (~34 min for
  `data-foundation` alone). That is the price of "this SHA was verified"; the
  alternative is claiming `main`'s latest green run speaks for an older commit,
  which it does not — that is TASK-08's whole point.
- Certifications are not cancelled, so a burst of tags queues rather than
  supersedes. `run_id` in the group means that is the only safe behaviour.
