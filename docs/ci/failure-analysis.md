# 重复执行与失败分析（Phase 0）

## 1. `data_foundation_ci.sh` 被两个 workflow 各跑一遍

这是本仓库最贵的一处重复，实测合计约 **2550 秒**（1051 + 1502）。

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
