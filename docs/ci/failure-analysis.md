# 失败分析

**采集时间 2026-11-19，基线 `ec7ff1f`。**

```bash
$ gh api "repos/baicie/ops-1/actions/runs?per_page=100" --jq '
  [.workflow_runs[]|select(.conclusion=="failure")|{wf:(.path|sub("\\.github/workflows/";""))}]
  | group_by(.wf)|map({wf:.[0].wf, n:length})|.[]|"\(.wf)  \(.n)"'
staging-preview.yml  9
ci.yml              3
data-foundation.yml 2
plugin-lifecycle.yml 2
```

最近 100 次运行中 16 次失败，**9 次是 `staging-preview`**。这份文档把每一次归到
`PRODUCT_FAILURE` / `TEST_HARNESS_FAILURE` / `INFRASTRUCTURE_FAILURE` / `TIMEOUT` / `BLOCKED`
之一，并说明证据。

---

## 1. `staging-preview` 的 9 次失败：同一个 PRODUCT_FAILURE

| run | sha | 结论 |
|---|---|---|
| 44298334228 | `edba489` | failure |
| 44328574226 | `00168f3` | failure |
| 44456814726 | `9b4e4e1` | failure |
| 44459853405 | `71f8ce0` | failure |
| 44467460840 | `0111779` | failure |
| 44474307002 | `46a667b` | failure |
| 44478182962 | `cf483fd` | failure |
| 44480971467 | `5ba30e8` | failure |
| 44505699419 | `ec7ff1f` | failure |

全部失败在 `deploy to staging host` 的 `Publish the data plugin bundles` 步骤。最近一次
（`ec7ff1f`，`46a667b` 引入诊断之后）的日志：

```
opsweave.data-catalog@0.0.17455 already installed; re-checking its deployment
  PENDING 0/0 ready (No eligible healthy node matches the placement selector
  [INSTANCE_CAPACITY_EXCEEDED] node staging-node: 4 instances already scheduled
  on this node against a per-node limit of 4; occupied by
  dev.opsweave.hello@0.0.1, opsweave.data-catalog@0.0.2,
  opsweave.data-catalog@0.0.3590, opsweave.data-integration@0.0.2)
Error: timed out waiting for deployment readiness
```

**判定：`PRODUCT_FAILURE`。** 不是环境问题、不是超时参数问题：节点上确实有四个不属于
当前版本的 deployment 在占槽位，而 `opsctl deploy` 等不到 READY 是正确行为。

根因有两层，都已定位：

1. 那四个 deployment 从未被释放——不是 `activate` 没排空（它排空，带 15 秒宽限期），
   而是 staging 的发布**从未成功到能调用 `activate`**（见 `findings-register` B-18：
   发布链是 `bundle → install → deploy`，**没有 `activate`**）。
2. 这九次里前三次（`edba489`、`4baa4fb`… 之前）报告的是 **success 但什么都没发布**：
   `publish-data-plugins.sh` 在包已存在时 `continue` 跳过整个循环，包括部署。已由 #149 修正，
   修正后的第一次运行就诚实地失败了。

**未解决**，需要一次授权的主机侧清理（B-16）。

## 2. `ci.yml` 的 3 次失败：一次 PRODUCT_FAILURE，两次 TEST_HARNESS_FAILURE

### `640172a`（run 44333389063）— PRODUCT_FAILURE，已修

ADR-027 的第一版把排空放在 `deploy_plugin`，破坏蓝绿部署。acceptance 断言：

```
FAIL  10/10 requests left v1 while v2 was not activated
```

由 #151 修正（排空属于 `activate`，且平台本来就有）。**这是产品代码的错，不是测试的错。**

### `9b4e4e1`（run 44456814714）— 合并之后的失败，不是合并时的失败

> **这一节原先的定性是错的，本轮纠正。** 我写的是「gate 正确判红，但拦不住合并」，
> 并把它当成「红色门禁可被绕过」的证据。**两个 SHA 被混为一谈。**

```bash
$ gh pr view 149 --json headRefOid,mergeCommit
head  = 621a12af...    ci-gate: success
merge = 9b4e4e14...    ci-gate: failure
```

- `621a12af` 是 PR 的 head。它的 `ci-gate` 是 **success**——合并发生时有九项必需 check
  全绿，`ci-gate` 也是绿的。
- `9b4e4e14` 是 squash 合并提交。它的 `ci-gate` 是 **failure**，那次运行由 `main` 的
  **push** 触发，发生在合并**之后**。

`ci-gate` 在 push 上看到的是 `main` 这个提交自己的检查：`staging-preview` 的
`deploy to staging host` 因为节点被四个旧 deployment 占满而失败，PART 3 如实把它算成红。

```
failed: deploy to staging host (staging-preview.yml: check named
"deploy to staging host" is failure; this check is not mapped to a suite,
but it ran on this commit)
```

**所以这一条不是 `PRODUCT_FAILURE` 传导成门禁绕过。** 它是：

| 事实 | 判定 |
|---|---|
| PR #149 合入时 `ci-gate` 绿 | 合并行为正常 |
| 合并后 main 的 push 上 `ci-gate` 红 | 合并后验证失败 |
| push workflow 不能撤销已完成的合并 | GitHub 语义，不是缺陷 |

**真正的缺陷在别处，而且是两个**：

1. **`ci-gate` 不该把部署失败算成 merge-gate 失败**（TASK-02）。`main` 上的 gate 变红是
   因为它把 `staging-preview.yml` 的部署结果当成了代码质量结论。这是归属边界错误，
   不是强制力问题。
2. **`ci-gate` 不在 ruleset 的九项里**——这个事实成立，但它需要读 ruleset 才能证明，
   不需要这组错误的对比。

### `c4d1790`（run 44333289543）— TEST_HARNESS_FAILURE，已修

与 `640172a` 同一原因（同一分支的连续提交）。

## 3. `data-foundation` 的 2 次失败：TEST_HARNESS_FAILURE，已修

`640172a` 与 `c4d1790`，与上同源：ADR-027 第一版改了 `deploy_plugin` 的语义，
`legacy-regression` 的蓝绿断言因此失败。

**这不是 flaky**：两次都在同一个 SHA、同一个断言、同样的 `10/10 requests left v1`。

## 4. `plugin-lifecycle` 的 2 次失败：同源

`640172a` 与 `c4d1790`。

## 5. 任务书点名的四个失败模式，逐项核实

### `data_token_revocation`

```bash
$ grep -oE 'tests/acceptance/[a-z0-9_]+\.sh' tests/ci/data_foundation_ci.sh | grep revocation
tests/acceptance/data_token_revocation.sh
```

它在 `data_foundation_ci.sh` 的 39 个间接脚本里，因此由 `data-foundation.yml` 执行。
在最近 100 次运行中，`data-foundation` 只有 2 次失败，都是上面的 harness 原因，
**没有一次是这个测试本身**。

「the workload token file never gained data.catalog.v1」在最近 100 次运行中**没有出现**。
这条断言是实际跑过的，范围是那 16 次失败运行的日志：

```bash
$ for id in $(gh api "repos/baicie/ops-1/actions/runs?per_page=100" \
      --jq '.workflow_runs[]|select(.conclusion=="failure")|.id'); do
    gh api "repos/baicie/ops-1/actions/runs/$id/logs" 2>/dev/null \
      | grep -c 'never gained data.catalog.v1'
  done | paste -sd+ | bc
0
```

（只查失败运行，因为一条只在绿灯里出现的错误字符串不重要。更早的运行未取，
所以只能说「近期未复现」，不能说「已修复」。）

### `supervisor_backoff_sigterm` — COVERED，我一度误判为缺口

```bash
$ grep -rl supervisor_backoff_sigterm .github/workflows/
（无输出）
```

按名称在 workflow 里搜不到，我据此写下「既不在任何 workflow 里，也不在 skip 表里，
是未登记的覆盖缺口」。**那是错的。**

`check-spec-coverage.mjs` 跟进间接调用，所以正解是这样查：

```bash
$ node tests/ci/check-spec-coverage.mjs --json | python3 -c "
import json,sys
d=json.load(sys.stdin)
print([r for r in d['shellCoverage'] if 'supervisor_backoff' in r['spec']])"
[{'spec': 'tests/acceptance/supervisor_backoff_sigterm.sh',
  'status': 'COVERED', 'workflows': ['data-foundation.yml']}]
```

它由 `data_foundation_ci.sh` 的 39 个间接脚本之一执行。

**这条留在文档里而不是删掉**，因为它是同一个错误的第 N 次复现：
`grep` 在 workflow 文件里找不到某个名字，不等于那个名字没有被执行。
本轮的 B-15 是同一个形状，只是代价大得多。

### `runtime-golden-path`

`runtime-golden-path` 这个 check 名不存在于当前 35 个 job 中；最接近的是
`data-foundation.yml` 的 `golden-path`。任务书的清单来自包含 `typed-pipeline-runtime.yml`
的旧基线，该 workflow 已被移除。

### `data_foundation_ci.sh`

见上面第 3 节：2 次失败，都是 ADR-027 第一版造成的，不是 harness 自身不稳定。

## 6. 基础设施类失败

最近 100 次运行中**没有**出现 `apt` DNS / Docker daemon 不可用 / Runner lost communication
的证据。不声称「已解决」，只能说「本次采样的 100 次里未出现」。

### 但 2026-11-19 采到了一次，而且是干净的样本

PR #157（只改 `tests/ci/ci-gate.mjs` 与本文档）的 `golden-path` 与 `legacy-regression`
双双失败，原因完全相同：

```
E: Failed to fetch https://security.ubuntu.com/ubuntu/pool/main/p/postgresql-common/postgresql-client_16%2b257build1.1_all.deb
   503  Service Unavailable [IP: 52.15.158.54 80]
##[error]Process completed with exit code 100.
```

`security.ubuntu.com` 返回 503，`apt-get install` 因此失败。`ci-gate` 随后因这两项而红。

**判定：`INFRASTRUCTURE_FAILURE`。** 依据有两条，都不是推测：

1. 该 PR 没有触碰任何被这两个 job 执行的代码——只有测试与 Markdown。
2. 错误是 `503 Service Unavailable` 来自 `security.ubuntu.com`，不是编译或断言失败。

**这是任务书 §10 要求的区分的一个真实实例**：它与 `PRODUCT_FAILURE` 在 check 列表上
长得一模一样（都是一个红叉），但处置完全不同——产品失败要修代码，镜像源 503 要重跑。

处置：`gh api -X POST .../actions/runs/<id>/rerun-failed-jobs`。**只重跑失败的 job**，
不是整个 workflow——后者会重新消耗 `default` 上已经通过的 19 项。

**这不能写成「CI 不稳定」。** 一次 503 是一次外部服务故障，与「测试 flaky」是两件事：
flaky 是同一输入不同结果，503 是同一输入根本没跑到断言。

## 7. 结论

| 类别 | 次数 | 状态 |
|---|---|---|
| PRODUCT_FAILURE（staging 容量 + 从未 activate） | 9 | **未解决**（B-16 / B-18） |
| PRODUCT_FAILURE（ADR-027 第一版破坏蓝绿） | 3（跨三个 workflow） | 已修（#151） |
| gate 判红但无强制力 | 1 | **未解决**（B-10） |
| 未登记的覆盖缺口 | 0 | 一度误判为 1（`supervisor_backoff_sigterm`），实为 COVERED |
| 基础设施 / flaky | 0 | 本次采样内为 0 |

---

## 8. §18 的十二项反例：逐项状态

| 项 | 要求 | 状态 | 证据 |
|---|---|---|---|
| A | Rust 失败 → gate FAIL | **COVERED** | `ci-gate.mjs --selftest`：`rust failed`，加上本轮新增的 17 个 per-job 反例 |
| B | Web 失败 → gate FAIL | **COVERED** | 同上——本轮之前**只有 `rust` 有反例**，`web` 从未被证明过 |
| C | Contract 不兼容 → FAIL | **COVERED** | `contracts skipped` 反例；真实校验在 `contracts` job |
| D | 缺数据库 → BLOCKED | **COVERED** | `OPSWEAVE_REQUIRE_TEST_DATABASE=1` 让 skip 变 panic |
| E | 缺 Docker → BLOCKED | **COVERED** | 实测：`OPSWEAVE_REQUIRE_TEST_DOCKER=1` + 无 docker → `BLOCKED` 且 **rc=1** |
| F | 高风险变更强制调度 | **COVERED** | `impact.mjs`；`apps/node/**` → `linux-runtime` |
| G | 低风险跳过重型 | **COVERED** | `impact.mjs`；`docs/**` → 零 suite |
| H | 未引用测试 → FAIL | **COVERED** | `check-spec-coverage.mjs`，0 unreferenced |
| I | 依赖被取消 → gate 不能 PASS | **COVERED** | `rust cancelled` → FAIL |
| J | 不可信部署输入 → 拒绝 | **COVERED** | `ok = status == 200 and bool(expected) and served == expected`，`EXPECTED_SHA` 空即失败 |
| K | 发布竞态 | **COVERED** | `concurrency` + `deploy.lock` |
| L | 回滚失败 → 明确报告 | **IMPLEMENTED_NOT_TESTED** | `deploy-staging.sh:1449` `die 1 "... rollback to $rollback_target also failed"` |

**L 必须写清楚它不是 PASS。** `rollback_to_release` 的失败路径实现正确——它
`die 1` 并明确说「两个都失败了」——但 `scripts/deploy-staging.sh` 在
`tests/` 下**没有任何测试**。`p001c_rollback_*` 测的是 Kernel 层的
`opsctl rollback`，不是主机部署脚本。

这一项的诚实状态是：**读代码确认正确，从未被执行验证过**。为它写测试需要模拟整个主机
部署（`docker compose` + health check + 记录文件），成本与 `staging-preview` 本身相当，
而且只能在真实主机上跑。记为缺口，不记为覆盖。

### A–P 逐项：位置与反例

任务书 TASK-03 要求 16 项，每项都要验证**实际 `gate()` 的最终 verdict**，不只是 helper 的返回值。

| 项 | 要求 | 反例位置 | 断言的是 |
|---|---|---|---|
| A | rust FAILURE → FAIL | `ci-gate.mjs` selftest `a red rust fails the gate and is named` | verdict + 失败 job 被指名 |
| B | web FAILURE → FAIL | 同上，per-job 循环生成 | 同上 |
| C | lint FAILURE → FAIL | 同上 | 同上 |
| D | g13b17-principal FAILURE → FAIL | 同上（per-job 循环覆盖全部 17 个 job） | 同上 |
| E | 必需 Data Foundation FAILURE → FAIL | `DELEGATED_SELFTEST` `a red check is a failure` | `delegatedVerdict` 的 failed 桶 |
| F | 必需 Plugin Lifecycle 缺失 → FAIL | `a suite with no check on this commit is ABSENT, not green` | absent 桶 → FAIL |
| G | 必需 Suite CANCELLED → FAIL | `a cancelled check is a failure` | failed 桶 |
| H | 必需 Suite TIMEOUT → FAIL | `AWAIT_SELFTEST` `a suite still running after the budget is pending, and pending fails` | pending 桶 **且** 镜像 `main()` 的规则得出 FAIL |
| I | 外部 Staging Deploy FAILURE → **不**使 merge gate 失败 | `a staging deploy failure is reported as a deployment failure, not a merge blocker` | verdict PASS + `deploymentFailures` 非空 |
| J | 外部 Staging Deploy SUCCESS 不能代替必需 suite | `a green deployment check does not stand in for a required suite` | 不进入 delegated |
| K | 同名 Check 来自错误 Workflow 不能冒充 | `a green check from the WRONG workflow does not verify`（`impostor` 桶） | impostor 桶 → 不 verified |
| L | PR Head SHA ≠ merge SHA，不得混淆 | `ci-gate.api-failure.test.mjs` `ci.yml reads check runs for the PR head, not the merge commit` | `CHECKS_SHA` 必须优先 `HEAD_SHA`，且它来自 `pull_request.head.sha` |
| M | Rerun Attempt 只看最新有效执行 | `AWAIT_SELFTEST` 三条：fail→pass、pass→fail、in-flight | 两条方向相反的 rerun + 一条进行中 |
| N | API 不可用不能假定成功 | `ci-gate.api-failure.test.mjs` 前两条 | **进程退出码 = 1** 与 `delegated-api-error`，并断言**不**报 `delegated-absent` |
| O | 未知新增 CI Job 未登记 → 接线检查失败 | `every workflow is registered in GATE_OWNERSHIP` | 放一个未登记 workflow → FAIL 并指名 |
| P | docs 改动不触发 L2，但 ci-gate 稳定产生 | `impact.mjs --files docs/*` 返回 `run: (none)`；`ci-gate` 是 `ci.yml` 的 job，`pull_request:` 无过滤 | 见下 |

**P 的两半是分开验证的**，因为它们由不同的机制保证：

```
$ node tests/ci/impact.mjs --files docs/ci/baseline.md
run:  (none)                       <- 零 suite，L2 合法跳过

$ python3 -c "import yaml; d=yaml.safe_load(open('.github/workflows/ci.yml')); print(d[True]['pull_request'])"
None                               <- ci.yml 无 paths 过滤，ci-gate 每个 PR 都产生
```

「docs 改动时 gate 仍然出现」不是靠 gate 自己保证的，是靠 `ci.yml` 的触发条件。
所以 `check-impact-consistency.mjs` 里那条「九个必需 context 不得条件化」的断言，在
迁移时**必须把 `ci-gate` 也加进去**——否则一次 `paths` 改动就能让它消失。

### 本轮修掉的一个测量错误

E 项第一次测出 `rc=0`，我据此认为 `trap teardown EXIT` 覆盖了 `BLOCKED` 的退出码。
实际是 `bash script | head -2` 返回了 `head` 的退出码。去掉管道后 `rc=1`。

同一形状的错误本轮出现两次（另一处是文档里的「0 次命中」写在跑之前）。`$?` 与管道是
一个反复的陷阱：`cmd | head` 的 `$?` 是 `head` 的。
