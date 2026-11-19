# The ruleset does not require the gate

**Status: PROPOSED — not applied. Applying it changes `main`'s protection and is
outside this round's authority.**

Measured 2026-11-17, main `c3edae4`:

```
gh api repos/baicie/ops-1/rulesets/26958761 \
  --jq '.rules[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context'

rust
web
web-unit
contracts
spec-coverage
platform-only
platform-image-build
quality-faults
linux-runtime
```

Nine checks. **`ci-gate` is not one of them.** Neither is `golden-path`,
`legacy-regression`, `acceptance`, `conformance`, `full TypeScript lifecycle`, or
any `staging-preview.yml` job.

## What that means

`ci-gate` is the only component that reads across workflows. It decides whether
the suites the impact analyzer requires actually ran, and it now waits for them
instead of reading whatever existed at its start. But a *red* `ci-gate` blocks
nothing: the merge endpoint checks the nine names above and nothing else.

So today, for a change that requires `data-foundation`:

| Situation | `ci-gate` verdict | Blocks the merge? |
|---|---|---|
| `golden-path` red | FAIL | **No** — not a required context |
| `golden-path` never ran (filter typo) | FAIL | **No** |
| `golden-path` still running after 30 min | FAIL | **No** |
| `ci-gate` itself red for any reason | — | **No** |

The two delegated suites that *are* covered — `linux-runtime` and
`quality-faults` — are covered by name, independently of the gate. Everything
else in `DELEGATED_CHECK_OWNERS` is enforced by nothing.

This is the honest statement of the remaining hole. It is not fixable in code;
it is a ruleset change, and the brief forbids making one without approval.

## Proposed change

Add one context to ruleset `26958761`:

```
ci-gate
```

That is the whole change. It requires no workflow edit and no new job: the check
already exists on every pull request and already reads everything above.

One caveat on "exists on every pull request": it is a job in `ci.yml`, which has
an unfiltered `pull_request:` trigger, so it starts for every PR *today*. Nothing
enforces that - if `ci.yml` ever gained a `pull_request.paths` filter, the gate
would stop being created for the excluded PRs and the merge would hang at
"Expected". `tests/ci/check-impact-consistency.mjs` now asserts the nine required
contexts run unconditionally, and `ci-gate` should be added to that list when this
migration is applied.

### Why one context and not the ten individual check names

Both work. `ci-gate` is preferred because:

1. **It is one rule instead of nine.** Nine names is nine things to keep in sync
   with the workflow files — the exact drift `check-impact-consistency.mjs`
   exists to catch, except in a place no test can read.
2. **It decides per-change.** `golden-path` is not required for a docs change and
   *is* required for a `tests/ui/**` change. A static required-check list cannot
   express that; a job whose verdict depends on the analyzer can.
3. **A required check that never runs blocks forever.** Making `golden-path`
   required would mean any change whose path filter does not start
   `data-foundation.yml` sits `_expected` and never merges. That is the
   "no permanently-Pending required check" requirement violated by construction
   (stated in the task brief as TASK-08; there is no TASK-08 document in this
   repository, so the reference is to the brief, not to a tracked file).

### The cost, stated plainly

Requiring `ci-gate` makes **every** pull request wait for the slowest suite it
requires, because the gate now waits rather than judging a snapshot. Measured
p95 on this repository:

```
workflow                        n    p50     p95     max
data-foundation.yml            16   1476s   2040s   2040s   (34 min)
plugin-lifecycle.yml            6   1083s   1258s   1258s   (21 min)
g12-acceptance.yml             10    965s   1124s   1124s   (19 min)
platform-linux-acceptance.yml  19    526s    623s    623s   (10 min)
reliability.yml                14    135s    258s    258s    (4 min)
```

measured 2026-11-19 from `actions/runs` (100 most recent), by `updated_at -
run_started_at`, **excluding queue time**.

**An earlier version of this table said `p95 1530 s` for data-foundation. That
was one run's duration, not a p95** - 1530 s is `max` for a *different* sample,
and the real p95 over 16 runs is 2040 s. The distinction matters immediately:

Worst case: a PR whose change set requires all three suites waits the sum of
their p95s, ~74 minutes at the gate even when everything passes. (Not "a PR
touching `plugins/**`": `plugins/**` requires `runtime-conformance`,
`plugin-lifecycle` and `data-foundation` - not `g12-acceptance`. Verified against
`tests/ci/impact.mjs`.) That is the price of not
merging on "probably fine".

### 预算的实测复核（2026-11-19）

这一节原先写的是「预算 30 分钟，低于 p95 34 分钟」，并称预算「不可配置」。
两半都需要更正，而且**第一版还有第三个错误：把并行 workflow 的 p95 相加**。

#### 等待从哪里开始

`awaitDelegated` 的 `started = now()` 在**函数内部**，即等待开始于 gate 的 `Decide`
步骤已经读出检查列表之后。**不包含 runner 排队时间**——排队发生在 job 启动之前，
而 `updated_at - run_started_at` 也不含它。

#### 是并行的，不是串行的

`ci-gate.mjs` 里只有一个 `awaitDelegated(...)` 调用，`whatToAwait` 一次返回所有未完成的
suite，循环里同时对每个 suite 轮询。所以：

```
等待时长 = max(所有未完成 suite 的剩余时间)，不是 sum(...)
```

**上一版把 `data-foundation` 34 min + `plugin-lifecycle` 21 min + `g12-acceptance`
19 min 相加写成「最坏 74 分钟」，那是错的。** 并行执行下它们同时进行。

#### 实测

`ci-gate` job 本身（`started_at` → `completed_at`，10 个样本）：

```
min 11s   p50 606s   p95 1591s   max 1591s
```

最长那次（run 44513474911）的分解：

```
等待阶段   1564 s   （日志：「all delegated suites settled after 28 read(s), 1564s」）
其余步骤     27 s   （checkout + 两次 ledger 读 + 判决）
合计       1591 s
```

#### 三层的实际数值与关系

| 项 | 值 | 来源 |
|---|---|---|
| `GATE_BUDGET_MS`（step env） | 2100 s（35 min） | `ci.yml` step `env:` |
| run 块里的 fallback | ~~1800 s~~ → **已删除** | 见下 |
| `ci-gate` job timeout | ~~2400 s~~ → **2700 s**（45 min） | `ci.yml` job |

**两个真实缺陷，本轮修掉：**

1. **fallback 与 env 不一致。** env 设 `2100000`，而 run 块写
   `${GATE_BUDGET_MS:-1800000}`。env 一旦丢失（改 job、复制步骤、拼写错误），预算
   静默降到 30 分钟——低于 p95 2040 s。改成 `${GATE_BUDGET_MS:?...}`：env 缺失是硬错误，
   不是静默降级。
2. **timeout 余量只有 240 s。** 2100 + 27 = 2127 s，job timeout 2400 s，余量 273 s
   （约 11%）。一次慢 checkout 或 API 重试就会让 job 被自己的 timeout 杀掉，而
   `cancelled` 比「超时并说明原因」更糟。提到 2700 s。

必须成立的关系：

```
job timeout  >  GATE_BUDGET_MS + (checkout + ledger 读) + 余量
2700 s       >  2100 s         +  ~30 s                 + 570 s
```

这条关系有测试断言（`await-delegated.test.mjs`），把 timeout 降回 30 分钟会让它变红。
3. **`--no-wait`** exists for local use and for a deliberate re-read. It is never
   used in `ci.yml`: reading without waiting is what let a failing suite merge.

### Second change, same ruleset: the delegate list

If requiring `ci-gate` is too much of a single point of failure, the fallback is
to require the three delegated contexts that gate consequences — `golden-path`,
`acceptance`, `full TypeScript lifecycle` — **plus** keeping the per-change
decision in `ci-gate`. That is nine → thirteen contexts, with the permanent-
pending problem above for changes their filters do not match.

**Recommendation: require `ci-gate` only.** The permanent-pending failure mode is
worse than a single point of failure, because it is unrecoverable without editing
the ruleset again.

## Rollback

Removing `ci-gate` from the required list restores today's behaviour exactly.
Nothing in the workflows depends on being required; the gate runs either way and
its summary is written either way.

## What is NOT proposed here

- No change to how the nine existing contexts are produced.
- No new workflow.
- No branch-protection (classic) change — this repository uses rulesets, and the
  classic API returns `404 Branch not protected` (measured).
