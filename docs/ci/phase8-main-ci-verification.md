# Phase 8 TASK-01: main CI at `a039cf6c`, per workflow

Read 2026-11-23 from GitHub. Every row is a `main` PUSH run, not a pull-request
run — the two are separate executions of separate commits, and a green PR says
nothing about whether `main` itself is verified.

## Result

| workflow | run | conclusion | note |
|---|---|---|---|
| `ci.yml` | 45172963339 | **success** | `runtime-image-build` skipped by the scope job; every other job success, `ci-gate` included |
| `data-foundation.yml` | 45172963356 | **success** | `golden-path` and `legacy-regression` both success |
| `plugin-lifecycle.yml` | 45172963410 | **success** | includes the four Phase 7 suites added in #209/#210 |
| `staging-preview.yml` | 45172963360 | **failure** | `deploy to staging host`; the other four jobs (smoke, seeded-data ×3) were skipped because it failed |

All four ran at the same SHA, `a039cf6c79856985985f8a22fc28eaf6704af64c`,
attempt 1, event `push`.

## `legacy-regression`: NORMAL_BUILD_VERIFIED, not 429 recovery

The question TASK-01 asks is not "did it pass" but "did it pass THROUGH a Maven
429". It did not.

Measured on job 137686889917:

| check | result |
|---|---|
| `status code: 429`, `status: 429`, `Too Many Requests` | **0 occurrences** |
| the 13 lines containing "429" | all timestamps (`...42986c68b...`, `...4296Z`) and one `libcommons-parent-java` package line |
| `BUILD SUCCESS` for the Java plugin | 1, 27 seconds after `== Java OCI image` |
| outer retry messages (`registry fault on attempt`) | 0 |

So this run is **`NORMAL_BUILD_VERIFIED`**. It is NOT
`REAL_429_RECOVERY_VERIFIED`, and calling it that would repeat the exact
substitution this phase exists to remove.

## The 429 recovery question is answered elsewhere, and the answer is not obvious

`tests/scripts/maven-429-recovery.test.sh` runs REAL Maven against a REAL local
HTTP server that answers 429. Two findings:

1. **A persistent 429 makes the outer policy retry twice** and still fails with the
   command's own exit code. That half is verified.
2. **A single transient 429 never reaches the outer policy at all.** Maven's own
   `retryHandler` absorbs it and the build succeeds:

       ok   the build recovered (rc=0)
       ok   Maven's OWN retryHandler absorbed the 429 - the outer policy never fired

Finding (2) is why the distinction in this document matters. A green
`legacy-regression` cannot distinguish "the outer retry worked" from "Maven never
needed it" — and the second is what happens for any single transient fault.

## Staging, classified separately

`deploy to staging host` failed. That is a statement about the staging host, not
about the commit: the four occupants holding the per-node limit are ACTIVE
revisions, so the deploy is refused with `INSTANCE_CAPACITY_EXCEEDED`. Per
`docs/ci/ruleset-migration.md`, `staging-preview.yml` is a DEPLOYMENT gate; `ci-gate`
reports its failure without treating it as a merge blocker, and this document does
the same — one environment failure does not cast doubt on the other three.

`smoke the preview` was SKIPPED as a consequence, not as a separate judgement.
