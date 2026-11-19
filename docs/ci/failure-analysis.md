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

### `9b4e4e1`（run 44456814714）— gate 正确判红，但拦不住合并

`ci-gate` 的 `Decide` 步骤 FAIL，原因是：

```
failed: deploy to staging host (staging-preview.yml: check named
"deploy to staging host" is failure; this check is not mapped to a suite,
but it ran on this commit)
```

**这是 PART 3 按设计工作**——#146 加的规则是「任何红色 check 都不能只作 note」。
但 `ci-gate` 不在 ruleset 的九项必需 check 里，所以**它判红不阻止合并**。该提交仍然合入了。

**判定：`PRODUCT_FAILURE`（staging 部署失败）传导成 gate 红，但 gate 无强制力。**
这是一个自我强化的问题：staging 越坏，gate 越红；gate 越红而越不挡合并，就越没人看它。

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

### 本轮修掉的一个测量错误

E 项第一次测出 `rc=0`，我据此认为 `trap teardown EXIT` 覆盖了 `BLOCKED` 的退出码。
实际是 `bash script | head -2` 返回了 `head` 的退出码。去掉管道后 `rc=1`。

同一形状的错误本轮出现两次（另一处是文档里的「0 次命中」写在跑之前）。`$?` 与管道是
一个反复的陷阱：`cmd | head` 的 `$?` 是 `head` 的。
