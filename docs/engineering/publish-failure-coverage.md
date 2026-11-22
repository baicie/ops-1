# TASK-19: publish failure-recovery acceptance — what is covered, what is not

Written 2026-11-23 against main `a6115753`. Every row states the test that proves
it, or that nothing does. Nothing here was inferred from "the code looks right".

## The eleven conditions

| # | Condition | State | Evidence |
|---|---|---|---|
| 1 | Build fails | **ALREADY_COVERED** | `scripts/build-plugins-retry.test.sh` — 12 cases, including a compilation error failing on the FIRST attempt (no retry) and a test failure doing the same |
| 2 | Push fails | **ALREADY_COVERED** | `scripts/verify-registry-digest.test.mjs` — a 404 tag and a 500 registry answer are each refused, and a 500 is reported as an ERROR rather than "no such tag" |
| 3 | Registry unreachable | **ALREADY_COVERED** | same file — `the registry could not be asked: fetch failed`, verdict REFUSED. Measured end to end against a real `registry:2` on a stopped port |
| 4 | Digest mismatch | **ALREADY_COVERED** | same file — the measured staging defect (`sha256:d9e853e8` vs `sha256:45e09956`) is a case, and `local` vs `remote` disagreement is a SEPARATE case with its own message |
| 5 | Bundle signature fails | **ALREADY_COVERED** | `crates/bundle` — `rejects_tampered_payload` and `manifest_image_reference_is_covered_by_signature` |
| 6 | Install succeeds, deploy fails | **NOT_COVERED** | `publish-phases.mjs` reports what a failure at `DEPLOYING` leaves behind, but nothing EXECUTES a deploy that fails |
| 7 | READY but activate fails | **NOT_COVERED** | same: `explain('ACTIVATING')` describes it, no run produces it |
| 8 | Activate succeeds but the read-back differs | **NOT_COVERED** | same |
| 9 | One plugin succeeds, another fails | **PARTIALLY_COVERED** | the loop still stops at the first failure (deliberate), but `tests/scripts/publish-untried-report.test.sh` proves the EXIT trap now NAMES the plugins it never reached. The failure path is reported; it is still not an end-to-end run |
| 10 | Re-run after a failure | **NOT_COVERED** | the script has an "already installed" path; nothing tests it |
| 11 | Cancelled during rollback | **NOT_COVERED** | nothing tests it |

## Why 6–11 are not covered, and what covering them would take

They are not small omissions. Each needs a KERNEL to install, deploy and activate
against — the publish script drives a real kernel container over `opsctl`. Unlike
the registry checks (5 rows, doable with Docker alone and done), these need the
kernel, PostgreSQL, a node and a plugin image, all wired.

Row 9 moved from NOT_COVERED to PARTIALLY_COVERED during this session, and the
distinction is stated rather than glossed: what is tested is that a failure names
the plugins it never reached. What is still not tested is a real mixed-outcome run
against a kernel.

That is the same environment TASK-15/16/17 are blocked on. Building it is a
session of its own, not a test to add to this one.

**What is honest to say about the staging failure that motivated this task:** the
four occupants holding the slots are ACTIVE revisions, so a deploy fails with
`INSTANCE_CAPACITY_EXCEEDED` — condition 6's neighbourhood — and that failure has
been OBSERVED in production logs (`docs/ci/failure-analysis.md:41`). It has never
been REPRODUCED in isolation. Observed once is not a tested condition.

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
