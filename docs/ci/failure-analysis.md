# 重复执行与失败分析（Phase 0）

## 1. `data_foundation_ci.sh` 被两个 workflow 各跑一遍

这是本仓库最贵的一处重复，实测合计约 **2553 秒**（1051 + 1502）。

| 调用点 | 环境变量 |
|---|---|
| `.github/workflows/data-foundation.yml:50` | `RUN_BROWSER_SMOKE=1 OPSWEAVE_CI_ALLOW_SHARED_DAEMON=1` |
| `.github/workflows/typed-pipeline-runtime.yml:81` | `OPSWEAVE_CI_ALLOW_SHARED_DAEMON=1` |

脚本内**只有一处**读取这个变量：

```
tests/ci/data_foundation_ci.sh:308:  if [ "${RUN_BROWSER_SMOKE:-0}" = "1" ]; then
```

也就是说 42 个 `run_step.sh` 步骤中，**41 步在两个 workflow 里行为完全相同**，
第 42 步（浏览器块）只在前者执行。

路径过滤高度重叠：

| 路径 | data-foundation | typed-pipeline-runtime |
|---|---|---|
| `apps/kernel/**` | ✓ | ✓ |
| `apps/node/**` | ✓ | ✓ |
| `contracts/**` | ✓ | ✓ |
| `tests/ci/**` | ✓ | ✓ |

改动 `apps/kernel/src/gateway.rs` 的一行，两个 workflow 同时触发，各跑一遍完整的
42 步环境引导（PostgreSQL、Kernel、两个 Node、Docker、OCI registry、插件镜像）。

**结论：这是无意义重复，不是「名称相似但环境不同」。** 两者的 Runner、数据库、
容器、脚本路径全部相同。

## 2. `cargo` 命令重复

| 命令 | ci.yml | typed-pipeline-runtime.yml |
|---|---|---|
| `cargo fmt` | ✓ `--all -- --check` | ✓ `--all --check` |
| `cargo clippy` | ✓ `--locked --workspace --all-targets -- -D warnings` | ✓ `--workspace --all-targets -- -D warnings` |
| `cargo test` | ✓ `--locked --workspace` | ✓ `--workspace` |

**`typed-pipeline-runtime.yml` 的三条都缺 `--locked`。** 这意味着：
- 它可能在 CI 上解析出与 `Cargo.lock` 不同的依赖版本；
- 它的绿不证明锁文件可复现；
- 与 `ci.yml` 的绿不可互换。

这是 P1：不是「重复」的代价，而是**那一次的结论本身不可信**。

`ci.yml` 另有针对 `opsweave-kernel` 的 `--no-default-features` clippy 与 test，
这部分是 `typed-pipeline-runtime` 没有的，属于必要的额外覆盖，不是重复。

## 3. 其它重复项

| 命令 | 出现次数 | 说明 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 9 个 job | 每个 job 独立安装；无 pnpm store 缓存 |
| `sudo apt-get install postgresql-client` | 10 个 job | 每个 job 重新安装 |
| `npm ci --prefix plugins/*/backend` | 5 个 job | zabbix / data-catalog / data-integration 各被多次安装 |

**没有任何 workflow 使用缓存。** `grep -rn "cache" .github/workflows/` 只匹配到
`staging-preview.yml` 里与本意无关的措辞，没有 `actions/cache`、没有
`Swatinem/rust-cache`、没有 pnpm store 缓存配置。

## 4. 两个 `contracts` job 同名但不同事

| Workflow | 脚本 |
|---|---|
| `ci.yml` | `tests/contract/validate_contracts.py` |
| `typed-pipeline-contracts.yml` | `tests/contract/validate_typed_pipeline.py` |

**不是重复工作**，但它们产出**同一个 check 名称 `contracts`**。合并保护只看名称，
所以「哪一个通过了」在合并那一刻是不可知的。

## 5. 历史失败分析

采样最近 100 次运行，失败全部出现在两个重型 acceptance workflow：

| Run | Workflow | SHA | 时间 |
|---|---|---|---|
| 43680822339 | typed-pipeline-runtime | `0d766b18` | 05:22Z |
| 43680822312 | data-foundation | `0d766b18` | 05:22Z |
| 43678590589 | typed-pipeline-runtime | `301566e1` | 04:51Z |
| 43678590576 | data-foundation | `301566e1` | 04:51Z |
| 43675797785 | data-foundation | `95bc2889` | 04:13Z |

**同一个 SHA、同一分钟，两个 workflow 都红。** 这是一次故障被跑两遍、报两遍。

### 故障分类（这批已全部修复合入）

| 现象 | 分类 | 根因 | 修复 |
|---|---|---|---|
| `the workload token file never gained data.catalog.v1` | TEST_HARNESS_FAILURE | C2 的 case 12 用 `consumerPluginId: opsweave.data-integration` 创建 grant 再撤销，而那正是 data-integration 需要的；`capabilities.rs:585-596` 因此不铸 token，`runtime.rs:1657` 写入 `{}` | #103：改用 `$FIXTURE_TAG` 作为 consumer |
| Node READY 但实例未 READY | TEST_HARNESS_FAILURE | `supervisor_backoff_sigterm.sh` 只等 Node 进程/状态，未等实例 | #119 |
| `expected EXPIRED, got ACTIVE` | TEST_HARNESS_FAILURE | case 3 与续约中的 worker 竞速，并断言自己刚写的 status | #117 |
| `no READY plugin instance on node-b after 90 s` | TEST_HARNESS_FAILURE | 撤销是终态的，却排在需要 node-b 的步骤之前 | #115 |

**没有一条是 PRODUCT_FAILURE。** 这是本仓库 CI 的一个显著特征：红灯几乎总是测试基础设施。

### 仍需注意

`tests/ci/data_foundation_ci.sh` 使用固定端口、固定 `/tmp` 路径与单一 Docker
Daemon。同一 Runner 上并发运行两个 workflow 时，这两者会互相冲突——而当前
`data-foundation.yml` 与 `typed-pipeline-runtime.yml` 在重叠路径上**恰好会并发**。

未观察到由此产生的失败，但这属于「靠运气」而非隔离。消除重复执行同时会消除这个风险。


## 6. 独立审计确认的其余缺陷（本轮未修）

以下由对抗性验证确认（每条都有 `file:line` 与复现步骤），但**不在本轮修复范围**。
列在这里而不是删掉，是因为它们决定了这个 CI 体系离「可信」还有多远。

### P1 — 门禁可绕过

| # | 位置 | 问题 |
|---|---|---|
| 1 | `tests/contract/validate_contracts.py:73,95` | 唯一的 bundle 摘要校验被 `if bundle_dir.exists()` 守卫，而 `dist/plugins` 是 gitignore 的、只由 `scripts/build-plugins.sh` 生成。必需的 `contracts` job 从不构建 bundle，所以**永远走 else 分支**，打印 `(no dist/plugins yet; bundle checks skipped)` 后退出 0。打包器写错 digest 不会被这个门禁发现。 |
| 3 | `.github/workflows/staging-preview.yml:36` | push 触发里列了一个开发分支 `feat/0.0.5-staging-preview`。该分支当前不存在于 origin，但触发是**休眠而非移除**——任何人推这个分支名就得到一次完整部署。 |
| 4 | `.github/workflows/staging-preview.yml:214` | `workflow_dispatch` 的 `sha` 输入是自由文本，没有验证该提交可达 main、通过任何必需检查、或其镜像来自 CI 验证过的树。 |

### P1 — 覆盖缺口

| # | 位置 | 问题 |
|---|---|---|
| 5 | `staging-preview.yml:268` | 完整产品镜像（`--target runtime`）**只在这里构建**，而这个 workflow 没有 `pull_request` 触发。每个 PR 触发的镜像构建都是别的 target。**已修**：`ci.yml` 新增 `runtime-image-build`，PR 上构建并启动完整镜像。 |
| 6 | `staging-preview.yml:1011` | `full` 层级只能通过 `workflow_dispatch` 到达。 |

### P1 — 重复

| # | 位置 | 问题 |
|---|---|---|
| 7 | `ci.yml:766` vs `platform-linux-acceptance.yml:73` | 逐字节相同的镜像构建，只是 tag 不同（`opsweave-platform:ci` vs `:linux-bond`）。两者都是必需检查，都在每个 PR 上运行。 |
| 8 | `ci.yml` 8 处、`data-foundation.yml` 2 处、其余 4 个 workflow 各 1 处 | 本报告撰写时为 14 个 job 安装 Rust 工具链（原审计记 13 个；`contracts` job 本轮新增了一处），**没有一个缓存编译产物**。`actions/cache`、`Swatinem/rust-cache`、`sccache` 零匹配。**pnpm store 是有缓存的**（`cache: pnpm` 出现在 5 处）——审计初稿说「零缓存」不准确，这里已更正。 |
| 9 | `tests/ci/p001c13_negatives.sh:145` 与 `tests/ci/p001c13_lifecycle.sh:204` | 同一个 `plugin-lifecycle` job 里（`.github/workflows/plugin-lifecycle.yml:224` 调 negatives，negatives 与 lifecycle 各自调用一次）`scripts/build-plugins.sh` 至少被调用**两次**，每次构建并推送 7 个 OCI 镜像。审计初稿说「三次」，把 `p001c_multilang_lifecycle.sh:146` 也算进来了——那属于另一个 workflow，同一 job 内是两次。 |
| 10 | `data-foundation.yml:108` | 单个 job 内同一批二进制与 web bundle 被构建两次（一次显式，一次由 `demo_up.sh:67-68`）。 |

### 已验证但判定为「不是缺陷」

| 位置 | 结论 |
|---|---|
| `tests/ci/impact.mjs:92` | 反例提出的 P0 被否定：fail-closed 分支确实生效。 |
| `ci.yml:493` | 同上。 |
| `data-foundation.yml:15`、`g12-acceptance.yml:26` | 路径覆盖缺口被否定。 |
| `staging-preview.yml:2223` | 发布安全问题被否定。 |

## 6b. 本轮已修的三项（原在上一节）

| # | 位置 | 修复 |
|---|---|---|
| 2 | `tests/ci/check-spec-coverage.mjs:121` | `*.test.mjs` 纳入清单；立刻发现 `b2_workspace_isolation.test.mjs` 从不运行，已接入 `b2-plugin-identity` |
| — | `check-spec-coverage.mjs` env 守卫 | 见下节；`spec-coverage` 现在能发现唯一带 `RUN_BROWSER_SMOKE` 的调用被删除 |
| — | `.github/workflows/typed-pipeline-runtime.yml` | 整个删除（42 步 harness 的第二次执行） |

## 7. 本轮修了什么

| 发现 | 状态 |
|---|---|
| `data_foundation_ci.sh` 跑两遍 | **已修**（删除 `typed-pipeline-runtime.yml`） |
| 重复那份缺 `--locked` | **已修**（随文件删除） |
| `spec-coverage` 看不见浏览器块消失 | **已修**（env 守卫识别，变异测试验证） |
| `ci-gate` 读 `needs` 的形状错误 | **已修**（首次真实运行抓到） |

## 8. 第二轮：对这份清单本身做对抗性复核

第一轮之后，PR #120 上又做了一轮。**下列缺陷全部是本分支自己引入的**——这一点值得单独
写下来，因为它说明「审查自己刚写的东西」和「审查别人的东西」需要用同样的力度。

| 位置 | 缺陷 | 怎么发现的 |
|---|---|---|
| `ci-gate` 的 `JOB_TO_SUITE` | 只映射了 15 个 job 里的 7 个（Ruleset 要求的那 7 个）。另外 8 个每个 PR 都跑，结果被读进来又丢掉——红的 `g13b17-principal` 不影响 gate 判决 | 把 `needs` 的实际 job 集和映射表做差集 |
| `ci-gate` 的 `delegated` | 七个 suite 一律标 `delegated` 后放行。分析器要求了、workflow 因 path filter 没启动的 suite，**没有任何红 check 可看** | 把 `impact.mjs` 的规则和每个 workflow 的 `paths:` 逐条比对，22 处分歧 |
| `staging-preview.yml` 的 sha 检查 | 要求 tag `sha-<SHA>` 且查 ghcr REST API，且写在 build job 里、构建**之前**。实测 136 个已发布 tag 全是裸 40-hex，0 个带前缀 → **任何 `workflow_dispatch` 都会死在这一步** | 匿名列出 ghcr 的 tag |
| 同上 | `merge-base --is-ancestor` 在 depth-1 克隆上对不在克隆里的 commit 返回 128，被 `if !` 报成「不在 origin/main 上」——诊断错误 | 在 depth-1 克隆上实测：分支尖端 rc=0，较旧的 main commit `fatal: Not a valid commit name` |
| `ci-gate.mjs` 注释 | 引用 `tests/ci/check-workflow-hygiene.mjs`——该文件从未存在 | `ls` |
| 同上 | 写「七个 workflow」，实际九个 | 同上 |
| `ci-gate` 的 pending | 把 `in_progress` 一律算成 `failed`，在三个兄弟 check 还在跑时变红——gate 第一红在它自己的读时序上 | 真实运行 43716720306 的日志 |
| `contracts` 的 bundle fixture | 读 `plugins/hello-ops/web/dist`——gitignore 的构建产物。本地过、CI 挂 | CI 报 `missing required file: frontend/remoteEntry.js` |
| `validate_contracts.py` | `ok bundle` 无条件打印，包括刚往 FAILURES 里追加了摘要不匹配的那一个 | 手工篡改 bundle 后 grep 日志 |

最后一条是我自己读错日志造成的：第一次看时以为篡改**没有被发现**，实际是
`CONTRACT VALIDATION FAILED` 打在 `ok bundle` 之后，grep 截断让我看到的顺序反了。据此
改的「`ok` 行会误报」是真缺陷，但我当时给的理由是错的。

### 仍然未修（明确记录）

| # | 位置 | 为什么没修 |
|---|---|---|
| 5 | `staging-preview.yml` 的 `--target runtime` 完整镜像只在无 `pull_request` 触发的 workflow 里构建 | 需要 staging 链重构，且要真实主机验证；brief 禁止本轮触碰 |
| 6 | `full` 层级只能 `workflow_dispatch` 到达 | 已加每日 certification 产生数据，但不提升为 PR 阻塞——没有基线就阻塞是错误顺序 |
| 7 | `ci.yml` 与 `platform-linux-acceptance.yml` 各构建一次相同镜像 | 实测：artifact 传递（60–90 MB `docker save`）与重建同量级（345s vs 469s），不划算 |
| 9 | 同一 job 内 `build-plugins.sh` 被调用两次 | 两次针对不同 registry，是刻意的隔离；Docker layer cache 已让第二次变便宜 |
