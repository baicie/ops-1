# 能力覆盖矩阵（Phase 0）

判定标准见本文件末尾。本表只记录**代码与 CI 配置能证明的**事实，不记录期望。

## 测试规模（按层）

| 层 | 数量 | 命令 |
|---|---|---|
| Rust 单元/集成（`#[test]` / `#[tokio::test]`） | 405 | `cargo test --locked --workspace` |
| vitest | 34 个文件 | `pnpm --filter <pkg> test` |
| `node --test`（`tests/ci/*.test.mjs`） | 9 | 各 job 内 |
| Playwright spec | 65 | 见 `check-spec-coverage.mjs` |
| acceptance 脚本（`tests/acceptance/*.sh`） | 62 | `tests/ci/data_foundation_ci.sh` 等 |

## Rust 组件

| 组件 | IMPLEMENTED | TESTED_CI | 必需门禁 | 真实依赖 |
|---|---|---|---|---|
| `apps/kernel` | 是 | 是（`cargo test --locked --workspace`，带 postgres service 且 `OPSWEAVE_REQUIRE_TEST_DATABASE=1`） | **是**（`rust`） | PostgreSQL 17（真实容器） |
| `apps/node` | 是 | 是（同上 + `linux-runtime` 的 `container_ownership` / `migration_*`） | **是** | Docker daemon（真实） |
| `apps/pipeline-worker` | 是 | 是（`data_foundation_ci.sh` 内多步） | 否 | Kernel + PostgreSQL + Docker |
| `apps/opsctl` | 是 | 是（`plugin-lifecycle` 用其安装/激活） | 否 | Kernel |
| `crates/*` | 是 | 是（workspace test） | **是** | 纯 Rust |
| `opsweave-contracts` | 是 | 是（`validate_contracts.py` + `validate_typed_pipeline.py`） | **是**（`contracts`，同名冲突） | 无 |
| `opsweave-bundle` | 是 | 是（签名/校验在 `plugin-lifecycle`） | 否 | 真实 OCI registry |

## Web 组件

| 组件 | IMPLEMENTED | TESTED_CI | 必需门禁 |
|---|---|---|---|
| `apps/platform-console` | 是 | typecheck + build + vitest | **是**（`web` / `web-unit`） |
| `apps/ops-web` | 是 | typecheck + build + vitest | **是** |
| `packages/ui` | 是 | typecheck + vitest | **是** |
| `packages/platform-client` | 是 | typecheck + vitest | **是** |
| 插件 web remote | 是 | 通过 `plugin-lifecycle` 与 `data-foundation` 的浏览器块 | 否 |
| i18n 目录 | 是 | 缺键检查在 `web` job 内 | **是**（间接） |
| Playwright（65 spec） | 是 | 仅部分：`data-foundation.spec.ts`、`studio.spec.ts`、`visual-layout.spec.ts`、`data-foundation-flows.spec.ts` 在 `data-foundation.yml`；多数其余仅 `staging-preview.yml` | 否 |

## 数据与执行环境

| 能力 | IMPLEMENTED | TESTED_CI | 真实依赖 | 备注 |
|---|---|---|---|---|
| PostgreSQL 17 | 是 | 是 | 真实 service container | `ci.yml` 与 `data-foundation.yml` 各自启动 |
| SQLx migrations | 是 | 是 | 真实 | `ci.yml:56-60` 断言 `_sqlx_migrations` 有行且 `kernel.pipeline_jobs` 存在 |
| OCI Registry | 是 | 是 | `registry:2` 容器 | `data-foundation.yml`、`plugin-lifecycle.yml`、`runtime-conformance.yml` 各起一个 |
| Docker runtime | 是 | 是 | 宿主 daemon | 非 rootless |
| Kernel Gateway | 是 | 是 | 真实 Kernel 进程 | `g13a1-gateway`、`data-foundation` |
| Capability Grants | 是 | 是 | 真实 | `p001c2_security_negatives.sh`（C2） |
| Runtime Conformance | 是 | 是 | 真实容器 | `runtime-conformance.yml`，非必需门禁 |

## 插件体系

| 语言 | IMPLEMENTED | TESTED_CI | 必需门禁 | 位置 |
|---|---|---|---|---|
| TypeScript | 是 | 是 | 否 | `plugin-lifecycle.yml` |
| Go | 是 | 是 | 否 | `runtime-conformance.yml` + `plugin-lifecycle.yml` |
| Java | 是 | 是 | 否 | 同上 |
| data-catalog / data-integration | 是 | 是 | 否 | `data-foundation.yml` |
| zabbix-source | 是 | 是 | 否 | `ci.yml` 的 `zabbix-plugin` job |

## 分布式与安全能力

| 能力 | IMPLEMENTED | 判定 | 依据 |
|---|---|---|---|
| Node Enrollment | 是 | TESTED_CI | `data_foundation_ci.sh` 启动两个 Node |
| Node Revocation | 是 | TESTED_CI | `data_token_revocation.sh`（撤销是终态的） |
| Credential Binding | 是 | TESTED_CI | `capability_multi_provider.sh` |
| Workspace Isolation | 是 | TESTED_CI | C2 的跨 workspace 负例 |
| Plugin Signature | 是 | TESTED_CI | `plugin-lifecycle.yml`（含篡改 manifest 被拒） |
| Publisher Trust | 是 | TESTED_CI | 同上 |
| OCI Digest | 是 | TESTED_CI | `plugin-lifecycle.yml` |
| Job Claim / Lease | 是 | TESTED_CI | `claim_concurrency.py`、`pipeline_jobs.sh` |
| Fencing | 是 | TESTED_CI | `catalog_fenced_sink.sh`、`pipeline_heartbeat_ttl_takeover.sh` |
| Recovery | 是 | TESTED_CI | `pipeline_orphan_worker.sh`、`kernel_restart_takeover.sh` |
| Upgrade / Rollback | 是 | TESTED_CI | `plugin-lifecycle.yml` 的 0.0.1 → 0.0.2 → rollback |
| Container Ownership | 是 | TESTED_CI | `linux-runtime` 的 `container_ownership` 测试 |

## NOT_RUN / 缺口

| 项 | 状态 | 说明 |
|---|---|---|
| 真实多机物理部署 | **NOT_RUN** | 所有「双 Node」都是同一 host 上的两个进程，共享一个 Docker daemon 和一个 PostgreSQL 实例。不能表述为真实三机验收。 |
| Rootless Docker | **NOT_RUN** | `p001c_up.sh` 使用 `/var/run/docker.sock`，是 rootful。 |
| 三个 seeded_* staging job | **失败被 `continue-on-error` 吞掉** | 见下方「已确认的掩盖」。 |
| D4 浏览器验收 | **NOT_RUN** | spec 已交付，`KNOWN_UNRUN` 登记，不在 CI 运行。 |
| 断电持久性 | **NOT_RUN** | 无法在 CI 模拟。 |
| 生产环境 | **NOT_RUN** | 本仓库没有生产部署路径。 |

## 已确认的掩盖（P1）

`staging-preview.yml` 的三个 `[known-flaky]` job，其 Playwright 步骤都带
`continue-on-error: true`：

| Job | 带 `continue-on-error` 的步骤 |
|---|---|
| `seeded_studio` | `Playwright seeded-data suite - studio (host-metrics-pipeline)` |
| `seeded_visual_layout` | `Playwright seeded-data suite - visual layout` |
| `seeded_visual` | `Seed the demo hello plugin`、`Playwright seeded-data suite - visual` |

**这些测试失败时，job 仍然是绿的。** 名称里的 `[known-flaky]` 因此是标签，不是判决——
读者从 check 列表看不出这些浏览器验收是否真的通过过。

这与任务书「`continue-on-error` 不能让产品回归被掩盖为完整发布验收通过」的要求冲突。

本轮**未修改**：改它需要先知道这三个套件的真实失败率，否则会把 staging 部署变成
常态红。正确顺序是：先让它们以「失败但不阻塞」的方式**报告**（例如把结果写进 job
summary 与一个非必需的 check），积累数据后再决定是修测试还是恢复为阻塞。

## 未验证

- Playwright 的完整视觉矩阵（390/1024/1440 × light/dark × en/zh-CN）在哪个 workflow
  执行、覆盖了几个页面组合。
- Playwright 的 390/1024/1440 × light/dark × en/zh-CN 组合矩阵：`visual-layout.spec.ts`
  覆盖了部分，但未确认完整矩阵在哪个 workflow 执行。
- 62 个 acceptance 脚本中，哪些被 `data_foundation_ci.sh` 调用、哪些从不执行。需要
  逐个比对才能给出确切数字。

## 判定标准

| 值 | 含义 |
|---|---|
| IMPLEMENTED | 代码存在且可达 |
| TESTED_LOCAL | 有测试，但不在 CI 执行 |
| TESTED_CI | 在某个 workflow 里真实执行 |
| TESTED_STAGING | 在 staging 主机上执行 |
| TESTED_REAL_INFRA | 多机、独立 daemon、真实网络 |
| NOT_RUN | 有测试但从不执行，或无测试 |
| NOT_IMPLEMENTED | 代码不存在 |

本轮没有任何一项达到 `TESTED_STAGING` 或 `TESTED_REAL_INFRA` 的证据门槛。
