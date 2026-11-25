# Phase 8 TASK-21: classifying a CI failure, with the evidence that put it there

> **Superseded by V2 (Phase 8A TASK-27).** This document describes the first
> classifier. It was replaced because it attributed a CAUSE by first-matching rule
> over the whole log, and because `isFailureLine` was a character class that matched
> every string. See `docs/ci/phase8a-diagnosis-trust.md` for the four counterexamples
> and the three-layer model that replaced it. The categories and the
> verdict/confidence/reason/evidence shape below are unchanged; the way a verdict is
> reached is not.

The brief names the failure mode it is guarding against:

> 禁止使用"已知外部失败"作为跳过真正回归的通用理由。
> 每个分类必须有可追溯证据。

The habit that rule forbids forms in a specific way: someone recognises a failure
shape, says "that is the Maven thing again", and moves on. That is right most of
the time, and the one time it is wrong the regression ships.

## The asymmetry, which is the design

`tests/ci/classify-failure.mjs` gives **`PRODUCT_REGRESSION` by default** for a red
assertion, and requires **positive evidence** for every other category:

| category | what must be present |
|---|---|
| `EXTERNAL_DEPENDENCY` | a named status (`status: 429`, `5xx`), an unresolvable POM, or a `transfer failed for <url>` |
| `STAGING_ENVIRONMENT` | `INSTANCE_CAPACITY_EXCEEDED`, a capacity `status_reason`, or an unreachable staging host |
| `RUNNER_INFRASTRUCTURE` | no docker daemon, no disk, a runner shutdown, lost server communication |
| `TEST_HARNESS_DEFECT` | an unparseable stage name, a missing route, `command not found` inside `tests/`, an unbound variable |
| `CHECK_ATTRIBUTION` | impostor / ambiguous / unattributed / `delegated-absent` / `required suite not wired` |
| `PRODUCT_REGRESSION` | **a failed assertion and no external signature** — the default |
| `UNKNOWN` | nothing matched; exits non-zero |

An unproven external cause is `UNKNOWN`, never folded into a category. That is the
shape the brief asks for: the excuse has to be shown, not assumed.

Every classification quotes the **line** that decided it, preferring a line that
carries a failure marker (`[FATAL]`, `[ERROR]`, `FAIL `, `##[error]`) over one where
the signature happens to appear in a passing context.

## Measured against real failures

| run | verdict | evidence |
|---|---|---|
| 45542879392 | `EXTERNAL_DEPENDENCY` | Maven Central `status: 429` |
| 45419909269 | `PRODUCT_REGRESSION` | `FAIL node-a's instance desired_action=<none>` |
| 45410012787 | `PRODUCT_REGRESSION` | same |
| 45349769192 | `PRODUCT_REGRESSION` | `FAIL deploy did not activate` |

## The limit that has to be stated

**Two of those `PRODUCT_REGRESSION` verdicts were my test being wrong, not the
product.**

- 45410012787 and 45419909269 failed because I had asserted the instance would be
  told `STOP`, when the kernel legitimately re-placed it. The assertion was wrong;
  the product was right. That is a `TEST_HARNESS_DEFECT` in the sense the brief
  means, and this classifier cannot see it.
- 45349769192 was a genuine product defect (`plugin_db_host` was
  `host.docker.internal` on a Linux daemon).

**The log does not distinguish "the assertion was wrong" from "the product was
wrong".** Both print `FAIL <something>`. Telling them apart requires reading the
assertion against the specification, which is a judgement, not a pattern.

So `PRODUCT_REGRESSION` from this tool means **"an assertion failed and nothing
external explains it"** — it does not mean "the product is broken". The output says
that, and this document says it because the difference matters: a classifier that
overclaimed here would let a wrong assertion look like a product bug and send
someone to fix working code.

## Why the rerun case is not in this tool

The brief's TASK-20 counterexamples (old attempt green, new attempt red/pending/
cancelled, same name from two producers) are about **which check run the gate reads**.
That is `check-run-ledger.mjs`, and it already has 20 unit tests covering all seven
plus `ci-gate --selftest`'s 73. `docs/ci/phase8-gate-rerun-audit.md` maps each one
to its test. This tool classifies a failure **after** the gate has decided it is one.

## Usage

```bash
node tests/ci/classify-failure.mjs --run <github-run-id>
node tests/ci/classify-failure.mjs --log path/to/job.log
gh run view <id> --log | node tests/ci/classify-failure.mjs
```

Exit code 1 on `UNKNOWN`, so a caller cannot treat "we could not tell" as success.
