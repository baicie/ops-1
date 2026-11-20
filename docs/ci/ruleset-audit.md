# Ruleset 现状审计与恢复方案（TASK-01）

**采集 2026-11-20，main `104e058`。只读。本轮没有修改任何 ruleset。**

---

## 1. 当前适用的保护

### 1.1 Ruleset（唯一一个）

```
$ gh api repos/baicie/ops-1/rulesets
id=26958761  name=main-protection  target=branch  enforcement=active
```

完整规则：

| 规则 | 参数 |
|---|---|
| `deletion` | — （禁止删除 main） |
| `non_fast_forward` | — （禁止强推） |
| `required_linear_history` | — （要求线性历史） |
| `pull_request` | `required_approving_review_count: 0`、`dismiss_stale_reviews_on_push: true`、`required_review_thread_resolution: true`、`allowed_merge_methods: ["squash"]` |
| ~~`required_status_checks`~~ | **已移除** |

`bypass_actors: []`、`current_user_can_bypass: "never"`。

### 1.2 Classic branch protection

```
$ gh api repos/baicie/ops-1/branches/main/protection
{"message":"Branch not protected","status":"404"}
```

**没有。** 这个仓库只用 rulesets。

## 2. 现在实际强制什么

| 保护 | 是否强制 |
|---|---|
| 必须走 PR | **是** |
| 禁止强推 main | **是** |
| 禁止删除 main | **是** |
| 线性历史 | **是** |
| 只允许 squash 合并 | **是** |
| 必须解决 review 线程 | **是** |
| review 审批数 | 0（不要求） |
| **状态检查通过** | **否** |

**结论：PR 流程本身仍被强制，CI 结果不再是合并的前提。**
PR #168 已实测：`mergeStateStatus: UNSTABLE`（CI 在跑）时合并成功。

## 3. 仓库里保存的两份恢复快照

| 文件 | 内容 |
|---|---|
| `ruleset-26958761-original-strict.json` | 九项 context + `strict: true`（变更前原样） |
| `ruleset-26958761-with-required-checks.json` | 九项 context + `strict: false`（中间态） |

两份都是**完整的五规则对象**——这是必须的，见 §5。

## 4. 两套方案

### 方案 A：恢复九项（回到变更前）

```bash
node tests/ci/check-ruleset-payload.mjs   # 先验证载荷
gh api -X PUT repos/baicie/ops-1/rulesets/26958761 \
  --input docs/ci/ruleset-26958761-original-strict.json
```

- 强制：九项检查 + `strict`（分支必须基于最新 main）
- 代价：每个 PR 要等 `data-foundation`（p95 34 分钟），且分支落后就要重跑
- 回滚：`--input docs/ci/ruleset-26958761-with-required-checks.json`（去掉 strict）

### 方案 B：恢复九项 + `ci-gate`（十项）

**没有现成快照。** 需要先生成：

```bash
python3 - <<'PY'
import json
d = json.load(open('docs/ci/ruleset-26958761-original-strict.json'))
for r in d['rules']:
    if r['type'] == 'required_status_checks':
        ctx = [c['context'] for c in r['parameters']['required_status_checks']]
        if 'ci-gate' not in ctx:
            r['parameters']['required_status_checks'].append({'context': 'ci-gate'})
json.dump(d, open('docs/ci/ruleset-26958761-with-gate.json', 'w'), indent=2)
PY
node tests/ci/check-ruleset-payload.mjs   # 会先报错：ci-gate 不在 NINE_CONTEXTS 里
```

**最后一步会失败，这是刻意的。** 检查器目前只认九项；加 `ci-gate` 之前必须先扩展
`NINE_CONTEXTS`，那本身是一次需要论证的变更（#171 的 owner 表要求每个 workflow 登记）。

方案 B 的前置条件（来自 `docs/ci/ruleset-migration.md`）：

| # | 条件 | 状态 |
|---|---|---|
| 1 | `ci-gate` 每个 PR 都产生 | **已验证**（`check-impact-consistency.mjs` 守卫） |
| 2 | 归属边界正确（staging 失败不阻塞合并） | **已验证**（`GATE_OWNERSHIP`） |
| 3 | gate 会等待 delegated suite | **已验证**（#161 实测等待 773 s） |
| 4 | 取消/缺失不能 PASS | **已验证**（`rust cancelled` → FAIL） |
| 5 | 预算与超时关系 | **已验证**（`check-concurrency-supersede` + 常量断言） |

五项都 VERIFIED，但**没有做过一次真实的「十项一起强制」运行**——那只能在变更之后测。

## 5. `PUT` 会替换整个 `rules` 数组

这是本案最大的风险，也是 `check-ruleset-payload.mjs` 存在的原因。

```bash
# 错误做法：只提交检查规则
gh api -X PUT repos/baicie/ops-1/rulesets/26958761 \
  -d '{"rules":[{"type":"required_status_checks",...}]}'
# 结果：deletion / non_fast_forward / required_linear_history / pull_request
#       全部被删除，main 可以在没有 PR 的情况下被强推
```

检查器拒绝这类载荷：

```
FAIL ruleset-...json checks=yes
ERROR ...: missing rule "deletion". PUT replaces the whole rules array, so sending
       this payload would REMOVE that protection from main
```

反事实已验证：把快照改成只剩 check 规则 → `exit 1`。

## 6. 回滚

| 从 | 到 | 命令 |
|---|---|---|
| 方案 A | 当前（无检查） | `--input ruleset-26958761-with-required-checks.json` 然后手工删掉该规则 |
| 方案 A | 原始 | 已在其上 |
| 方案 B | 方案 A | `--input ruleset-26958761-original-strict.json` |

当前状态（无 `required_status_checks`）没有对应快照文件——因为它是「删掉一条规则」，
而 `PUT` 只能提交完整对象。**这是回滚材料的一个缺口**，本轮记录但不新建文件，
以免有人误以为那是一份可以直接 `PUT` 的配置。

## 7. 未执行

- 没有修改 ruleset
- 没有生成 `ruleset-26958761-with-gate.json`（会触发检查器失败，见 §4）
- 没有做任何真实的合并行为验证

## 8. 结论

两条路都准备好了，**都不该由我执行**。

推荐：**方案 A 优先**。理由不是它更完整，而是它的代价已经被测量过（p95 34 分钟），
而方案 B 的 `ci-gate` 从未被 GitHub 强制过——第一次强制会给第一个答案，而那应该是
一次有意的观察，不是一次顺手的配置变更。

---

# 附录：TASK-02 的可执行检查器

`tests/ci/check-gate-enforcement.mjs`。它读**实时 ruleset**，不是读 YAML——
因为 YAML 完美而 ruleset 不要求，正是本仓库当前的状态。

```
$ node tests/ci/check-gate-enforcement.mjs
required: (none)
produced: 27 context(s)
note: NO required status checks: CI is advisory. A red gate blocks nothing.
note: ci-gate is produced but not required. The gate computes a verdict on every PR
      and no merge consults it.
produced but not required (27): acceptance, artifact-budget, ..., ci-gate, ...
gate enforcement: ADVISORY
```

## 四种判决

| 判决 | 含义 | 退出码 |
|---|---|---|
| `ENFORCED` | `ci-gate` 在必需列表里 | 0 |
| `PARTIAL` | 有必需检查，但 `ci-gate` 不在其中 | 0 |
| `ADVISORY` | **没有任何必需检查**（当前状态） | 0 |
| `BROKEN` | 必需了一个没人产生的 context | **1** |

只有 `BROKEN` 非零退出。另外三种是**关于仓库的事实**，不是代码缺陷——由迁移决策，
不该让 CI 替人决定。

## 为什么 `BROKEN` 单独处理

`required but never produced` 会让每个 PR 永久卡在 `Expected`——不是失败，是缺席。
那是最糟的一种状态：没有任何红色，也没有任何合并。它需要被当成错误拦住。

## selftest 自己的 bug

第一版五条全 FAIL。原因：`cases` 数组里存的是**已求值的布尔**，循环却当函数调用
（`fn()`），每次都抛 `TypeError`，`catch` 把它变成 `false`。

**一个永远不能通过的 selftest 和一个永远不能失败的 selftest 一样没用。** 已修正，
5/5。

## 与 §4 方案 B 的关系

检查器现在会说 `ci-gate` 是 "not produced by this repository"——那是
`check-ruleset-payload.mjs` 的九项白名单在说话。加 `ci-gate` 之前必须先扩展那个白名单，
而那是一次需要论证的变更，不是恢复步骤的一部分。
