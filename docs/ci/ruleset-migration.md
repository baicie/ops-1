# The ruleset does not require the gate

**Status: PROPOSED — not applied. Applying it changes `main`'s protection and is
outside this round's authority.**

基线本轮更新为 `7098b3f`（2026-11-19）。§10 之后是本轮新增的完整迁移方案：
前置检查、十项配置、回滚、以及执行阶段五时最容易造成不可逆损害的那一步的警告。

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


---

# 10. 完整迁移方案（2026-11-19）

## 10.1 改什么

**新增一项：`ci-gate`。九项保持不动。**

```diff
 rust
 web
 web-unit
 contracts
 spec-coverage
 platform-only
 platform-image-build
 quality-faults
 linux-runtime
+ci-gate
```

### 为什么不直接用 `ci-gate` 替换九项

任务书禁止（「不得直接从九项改成仅一项」），理由也成立：

- `ci-gate` 目前**不是**必需检查，它的绿色从未被 GitHub 强制过。它可能因为一个未预见的
  原因不产生（workflow 被禁用、`ci.yml` 语法错、job 改名）——那时十项配置里九项仍在，
  合并还能继续；只留一项的话就是全仓库停摆。
- 九项是**独立于 gate 的**第二意见。`ci-gate` 读的正是这九项的结果，但它们由 GitHub
  自己强制，不经过 gate 的判决逻辑。两份独立保证比一份强。

**九项不动还有第三个价值：它是回滚的退路。** 回滚只需去掉 `ci-gate`，不可能造成保护
真空。

## 10.2 前置检查（全部必须为绿才能执行阶段五）

### a. `ci-gate` 每个 PR 都产生

```bash
$ python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print(d[True]['pull_request'])"
None                       # 无 paths/branches 过滤
```

由 `check-impact-consistency.mjs` 的 ci-gate readiness 块守卫（#160）。给 `ci.yml` 加
`paths` 会产生 8 个 error，其中一个指名 `ci-gate`。

### b. 归属边界已修正 —— **最关键的一条**

```bash
$ grep -c "'staging-preview.yml': 'deployment'" tests/ci/ci-gate.mjs
1
```

在 #159 之前，`ci-gate` 把 staging 部署失败算成 merge 失败。把它设成必需检查会让一次
staging 容量故障冻结**全部代码合并**。

### c. gate 不因部署失败而红

```bash
$ node tests/ci/ci-gate.mjs --selftest 2>&1 | grep 'staging deploy failure'
ok   a staging deploy failure is reported as a deployment failure, not a merge blocker: PASS
```

### d. 每个 job 单独致命

```bash
$ node tests/ci/ci-gate.mjs --selftest 2>&1 | grep -c 'fails the gate and is named'
17
```

### e. 未知 workflow 不能静默绕过

```bash
$ node tests/ci/ci-gate.mjs --selftest 2>&1 | grep 'GATE_OWNERSHIP'
ok   every workflow is registered in GATE_OWNERSHIP
```

### f. 预算与超时关系成立

```bash
$ node --test tests/ci/await-delegated.test.mjs 2>&1 | grep -E '# (pass|fail)'
# pass 12  # fail 0
```

两条断言：`--budget-ms` 行不得自带 fallback；job timeout 必须大于预算 + 300 s。

### g. API 不可用不能假定成功

```bash
$ node --test tests/ci/ci-gate.api-failure.test.mjs 2>&1 | grep -E '# (pass|fail)'
# pass 3  # fail 0
```

### h. 真实 PR 证据

见 §10.5。**本地 90 个 selftest 不等于迁移安全。**

## 10.3 五个阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| 一 | 九项不变，`ci-gate` 已在跑 | 已完成 |
| 二 | 修正归属边界（#159），扩展反例（#160） | 已完成 |
| 三 | 在真实 PR 上验证 gate 正确 | **待做** |
| 四 | 提交十项方案与回滚（本文件） | 本轮完成 |
| 五 | 获得授权后执行 ruleset 变更 | **未执行** |

## 10.4 回滚

回滚 = 去掉 `ci-gate`，恢复九项。九项从未被移除，所以回滚只是去掉一个新增项，不可能
造成保护真空。

回滚**不**撤销 `ci-gate` job 本身：它继续运行并输出结论，只是不再被 GitHub 强制。这与
迁移前的状态完全一致。

## 10.5 迁移后必须验证的四件事

| 验证 | 方法 | 期望 |
|---|---|---|
| 正常 PR 可以合并 | docs-only PR | `ci-gate` 绿，合并可用 |
| 必需 CI 失败无法合并 | 让 `rust` 红 | 合并被拒，错误里出现 `10 of 10` |
| **Staging 失败不阻止合并** | 观察一次 staging 部署失败的 run | `ci-gate` 仍绿（`deploymentFailures` 非空） |
| 无永久 Expected | 任一 PR 的 check 列表 | `ci-gate` 总是出现 |

**第三条是这次迁移独有的**，也是 #159 存在的理由。

## 10.6 时间代价（实测）

`ci-gate` job 时长（10 个样本）：`min 11s  p50 606s  p95 1591s  max 1591s`。

最长一次的构成：`等待 1564 s + 其余 27 s`。

**等待是并行的**——`ci-gate.mjs` 只有一个 `awaitDelegated` 调用，
`elapsed = max(未完成 suite 的剩余时间)`，不是 `sum(...)`。

`data-foundation` p95 是 2040 s（16 个样本）。一个 PR 的最坏等待约 34 分钟，
**不是**把三个 workflow 的 p95 相加（那是 74 分钟，错在把并行当串行）。

预算 2100 s，job timeout 2700 s，余量 570 s。

## 10.7 执行阶段五的警告 —— 最容易造成不可逆损害的一步

`PUT /rulesets/{id}` **替换整个 ruleset 的 `rules` 数组**。只提交
`required_status_checks` 会**丢掉其它规则的每一项**。

正确做法：

```bash
# 1. 先取完整定义，保存
gh api repos/baicie/ops-1/rulesets/26958761 > /tmp/ruleset-before.json

# 2. 只改 required_status_checks 的 contexts，其余 JSON 原样保留
#    （用一个脚本改动，不要手写整个对象）

# 3. 提交前 diff，确认只有 contexts 变化
diff <(jq -S . /tmp/ruleset-before.json) <(jq -S . /tmp/ruleset-after.json)

# 4. 提交
# 5. 立即验证：GET 回来，确认十项，且其它规则一字未变
```

如果跳过第 1 步，回滚就没有依据——`/tmp/ruleset-before.json` 就是回滚材料。

## 10.8 未验证的剩余风险

1. **`ci-gate` 从未被 GitHub 强制过。** 迁移后第一次真实的强制会给第一个答案。
2. **`OWNERSHIP COMPLETENESS` 依赖目录遍历。** 在 `.github/workflows/` 之外注册的
   workflow（GitHub 通常不允许）不会被看到。
3. **`ci-gate` 依赖 check-run API 的可用性。** 已 fail closed，但一次长时间 API 降级会
   让所有 PR 变红——这是刻意的取舍。
4. **九项里有若干项与 gate 读的是同一批 check。** 一份结果被两份规则使用；如果 GitHub
   的 check-run API 与实际强制结果出现分歧，两份规则会同时错。
5. **阶段三尚未进行。** §10.5 的四项验证全部是待做项。
