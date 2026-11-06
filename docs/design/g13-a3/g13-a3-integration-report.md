# G13-A.3 — Integration Closure & G13-B0 Contract Freeze

- 日期：2026-11-06
- 约束：本轮不合并 main、不 force-push、不 tag/release/deploy；所有 PR 保持 Draft
- 集成候选 PR：[#42](https://github.com/baicie/ops-1/pull/42)（`integration/g13-a3` → `main`，仅用于门禁，**不合并**）
- A.3 工作分支：`feat/g13-a3-integration-closure`（基于 #41 `64b7286`）
- 交付文档：[G13-B0 pack](../g13-b0/event-contract.md)、[ADR-018](../../adr/ADR-018-automation-principal.md)、[ADR-019](../../adr/ADR-019-event-identity-and-dedup.md)

## 1. Git baseline

| PR | 分支 | HEAD | 状态 |
|---|---|---|---|
| #34 | `design/opsweave-visual-system-v1` | `c65bf39` | Open（非 Draft），未合并 |
| #35 | `design/opsweave-ds-v1-2` | `f2681d8` | Draft |
| #38 | `feat/g13-a-source-evidence` | `99fd9b2` | Draft |
| #39 | `feat/g13-a-collect-ui` | `81d1765` | Draft |
| #40 | `feat/g13-a1-workspace-attestation` | `b2d635b` | Open（非 Draft） |
| #41 | `feat/g13-a2-credential-binding` | `64b7286` | Draft，15/15 CI |
| A.3 | `feat/g13-a3-integration-closure` | `1f8ffa5`（代码 `a9d869d`） | Draft，PR #43 |
| 集成 | `integration/g13-a3` | `60edf51` | 仅门禁，不合并（PR #42） |

A.3 代码提交：`a9d869d`（Docker stderr redaction、env budget fail-closed、flake 处理）；文档 `1f8ffa5`。A.3 只新增/修改：

- `apps/node/src/docker.rs`
- `tests/ui/data-foundation-flows.spec.ts`
- `docs/adr/ADR-018-*`、`docs/adr/ADR-019-*`
- `docs/design/g13-b0/*`、本报告
- `contracts/openapi/telemetry-event-v1.yaml`、`contracts/schema/telemetry-event.v1.schema.json`

## 2. Phase 1 安全补充审查

### 2.1 Docker stderr 泄漏（P2，已修复）

**链路**：`run_with_timeout` 在命令失败时把 `output.stderr` 原样拼进 `anyhow` 错误 → `runtime` 的 `set_state(Failed, error.to_string())` → heartbeat 的 `status.error` → Kernel `plugin_instances.last_error`（`apps/kernel/src/nodes.rs`/`deployments.rs`），同时 Node 日志记录同一字符串。`redacted_command()` 只保护**错误上下文里的命令行**，不保护 stderr。

**复现**：用假 Docker CLI 让 `create` 把 `OPSWEAVE_PLUGIN_SECRETS` 的 JSON、Adapter 签名密钥和 `KEY=VALUE` 回显到 stderr，退出码 125。修复前的实现会把这些字节原样返回；新测试 `docker_create_stderr_is_redacted_before_it_reaches_logs` 断言：错误中不得出现 token/Adapters 值，但必须保留 `docker create failed`、退出码 125 与可读的 `invalid env` 诊断。

**严重级别 P2，不是 P0**：真实 Docker daemon 未被证明会回显 `--env` 值；要触发需要控制 Docker CLI/daemon 或上游代理，而这已接近主机控制权。风险在于 Secret 会进入**保留型**审计/状态面（`last_error`、Node 日志），扩大泄漏窗口。因此按 defense-in-depth 修复，不升级为 P0，也不删除 stderr。

**修复**：`sensitive_values()` 收集 `--env`/`--build-arg` 的值（含 JSON 叶子 Token），`redact_sensitive()` 在 stderr 进入错误前替换；stderr 截断到 4096 字符，保留 action/exit code/剩余诊断。单测覆盖 token、Adapter 密钥、诊断保留。`version()`/`inspect()` 的 stderr 同样限长。

### 2.2 超大环境变量（P1 静默降级，已修复）

**修复前**：`create_and_start` 对 `value.len() > 8192` 的条目仅 `tracing::warn!` 并**继续启动**。多 Workspace 的 `OPSWEAVE_PLUGIN_SECRETS` 是单个 JSON 条目，随 Workspace/ref 数量线性增长；超过 8 KiB 时实例仍可能 READY，但缺少 Secret/Binding，表现为“表面可用、实际全拒绝”。

**修复**：`validate_env_budget()` 在启动前检查：

- 单条 ≤ **32 KiB**、总环境 ≤ **256 KiB**（Linux 单参数 128 KiB / ARG_MAX 2 MiB 之下，留出多 Workspace 余量）；
- 超限 → 部署失败 `NODE_PLUGIN_ENV_TOO_LARGE`，key 非空/≤128 → `NODE_PLUGIN_ENV_INVALID_KEY`；
- 错误只含 key 与字节数，不含 value；实例状态变为 Failed，`last_error` 带稳定码。

**规模边界**：按每条 ref ≈ 140 字节估算，32 KiB 约支持 200+ refs/插件；binding 每条 ≈ 200 字节，约 160 endpoints；总计 256 KiB 是硬上限。超过即**显式失败**，需要拆插件实例或迁移到 Secret Broker。未来迁移路径（只读挂载/实例 Secret 文件/独立 Broker）与 A.2 的 `PRODUCTION_SECRET_READY=PARTIAL` 一致，本轮不实现。

### 2.3 安全回归

| 套件 | 结果 |
|---|---|
| `node --test zabbix.test.mjs server.test.mjs g13a2_endpoint_attack.test.mjs` | **59/59 PASS** |
| `cargo test -p opsweave-kernel` | **205/205 PASS** |
| `cargo test -p opsweave-node` | **18/18 PASS**（新增 5 个 Docker/env 测试） |
| `python3 tests/contract/validate_contracts.py` | PASS（16→17 schemas） |

Endpoint Swap、Cross-Workspace SecretRef、Historical Source、TLS、Basic、SSRF/DNS pinning、Attestation V2、Secret redaction 全部保持；没有为集成测试开放豁免。

## 3. Phase 2 集成

### 3.1 集成树与冲突

按 `#34 → #35 → #38 → #40 → #41/A.3 → #39` 合并：

- `tests/ui/overview-partial.spec.ts` **自动合并成功**。以 #39 的父提交 #35 为 merge base，只有 #39 的增量应用在已含 #38/#36 的树上；合并结果同时保留 #36 的本地化标题断言与 #35/#39 的视觉/工作台断言。预检阶段报告的 `#38+#39` / `#40+#39` 冲突是“分支尖端直接对比”的产物，不代表按正确顺序集成仍冲突。
- 无其他冲突；`git merge-tree` 与真实合并一致。

### 3.2 门禁矩阵（集成树 `60edf51`，PR #42）

| 门禁 | 结果 |
|---|---|
| CI 全套（rust/web/web-unit/zabbix-plugin/g13a-roundtrip/g13a1-gateway/acceptance/golden-path/runtime-golden-path/legacy/quality/contracts/spec/artifact） | **16/16 PASS**（§5） |
| 本地 Kernel/Node/Plugin/contracts | 205 / 18 / 59 / PASS |
| 真实 Gateway/Node/OCI | A.2 证据 + 集成树 CI 的 `g13a1-gateway` |
| G12 acceptance / G13 roundtrip | 集成树 CI |
| Web unit/typecheck、UI Playwright、视觉/a11y | 集成树 CI |

### 3.3 Flake 处理

1. **`stop_and_remove_reports_a_surviving_container`**：集成树首次运行时，新增的假 Docker stderr 测试在同一机制上失败，日志只显示 spawn 上下文 `run docker create ...`；这暴露了根因——测试写出可执行脚本后立刻执行，和兄弟测试的 fork/exec 竞争，Linux 在继承的写描述符关闭前返回 **ETXTBSY**，错误在 `inspect` 处变成 spawn 失败，自然不含 `"still running"`。修复：假 Docker 测试**只对 ETXTBSY** 做有界重试（20×25 ms），断言打印完整错误链；产品代码不重试 Docker。本地全套 30 次、单测 40 次通过；集成树重跑验证。2s 延迟预算改为 15s 是独立的诊断修正（fork/exec 负载下不应被误判为挂起）。
2. **`data-foundation-flows.spec.ts:79`**：根因是**整条串行业务流的 60s 测试预算耗尽**（日志在 60s 处报 `Test timeout of 60000ms exceeded`，截图只是最后一步），不是元素选择器错误。修复：该文件 `test.describe.configure({timeout: 120_000})`，并在截图前显式 `toBeVisible()`，使真实回归在可见性断言处失败而不是在超时里。未删除测试、未加无限重试。

### 3.4 Merge 策略差异

| 方式 | 影响 | 预案 |
|---|---|---|
| Merge commit | 保留每个 PR 的已评审提交与栈拓扑；main 多出合并节点 | **推荐**：按 §3.5 顺序逐 PR merge，不重写 SHA |
| Squash | 每个 PR 一条提交；父 PR squash 后子 PR 需 retarget/rebase，栈中 SHA 全变 | 若仓库要求 squash：从 #34 起逐个 squash，落地后把下一个 PR base 改为 main 并 rebase；#39 必须先把 main（含 #38）合入并重跑 UI |
| Rebase | 已评审 SHA 全部重写，review 链接与 stacked diff 失效 | 不推荐用于已评审的 #38/#40/#41/#39 |

### 3.5 Main Merge Decision

**BLOCKED**。集成树可验证，但以下生产门禁未关闭：

- `REAL_ZABBIX_VERIFIED=NOT_RUN`；
- `PRODUCTION_SECRET_READY=PARTIAL`（env 交付、旧实例窗口、静态 binding）；
- #39 必须先合入 main（含 #38）并重跑 UI/契约；
- A.3 的 Docker stderr/env 修复必须先进入 #41/A.3 并被集成树 CI 复验。

建议顺序（仍需人工批准）：#34 → main；#35 → main；#38 → main；#40 → #38/main；#41 → #40；A.3 → #41；#39 合入 main 后解决 `overview-partial.spec.ts` 并重跑。

## 4. G13-B0 Architecture Pack

| 文档 | 内容 |
|---|---|
| [ADR-018](../../adr/ADR-018-automation-principal.md) | User/Workload/Automation 三类 principal、`owa1` claims、签发/撤销/重放/预算、审计 |
| [ADR-019](../../adr/ADR-019-event-identity-and-dedup.md) | Event 身份、去重键迁移、并发、历史行不回填、状态机兼容 |
| [event-contract.md](../g13-b0/event-contract.md) | 端点、幂等、乱序/延迟/恢复、错误码、审计 |
| [lifecycle-compatibility.md](../g13-b0/lifecycle-compatibility.md) | 不引入 `AWAITING_VERDICT` 的理由、Automation 动作映射、UI 兼容 |
| [permission-matrix.md](../g13-b0/permission-matrix.md) | Principal × 操作、token 信任根、失败语义 |
| [e2e-acceptance.md](../g13-b0/e2e-acceptance.md) | A/E/C/R/U 验收矩阵 |
| [g13-b1-slices.md](../g13-b0/g13-b1-slices.md) | 切片 0–5 与开发顺序 |
| `contracts/schema/telemetry-event.v1.schema.json` | 冻结的 Event schema |
| `contracts/openapi/telemetry-event-v1.yaml` | 冻结的 ingest 契约与错误码 |

关键决策：

- Automation 不是角色，不能复用 `AuthUser`；Workspace 由 Kernel source 注册表解析，插件不能自报。
- 去重键 `workspaceId + sourceId + nativeId` 用**部分唯一索引**；历史行 `source_id IS NULL` 不回填、不合并。
- 不新增 `AWAITING_VERDICT`；`CONCLUDED` 已表示“人工结论已写入、待关闭”。
- Event payload 不是 Evidence；Evidence 仍走 A.2 binding + v2 attestation + 内容摘要。

## 5. CI / Test Matrix

最终代码树：**集成 `60edf51` 16/16 PASS**；**A.3 `1f8ffa5` 15/15 PASS**（`contracts` 多触发器重复）。两套均为首次重跑即全绿，无失败项需要再次重跑。

| 门禁 | 集成树 `60edf51` | A.3 `1f8ffa5` |
|---|---|---|
| `rust`（fmt/test/clippy） | PASS | PASS |
| `web`（typecheck/build/i18n/tokens） | PASS | PASS |
| `web-unit` | PASS | PASS |
| `zabbix-plugin`（59 + storage） | PASS | PASS |
| `g13a-roundtrip` | PASS | PASS |
| `g13a1-gateway`（真实 Gateway/Node/OCI + 攻击矩阵） | PASS | PASS |
| `acceptance`（G12） | PASS | PASS |
| `golden-path` / `legacy-regression` | PASS / PASS | PASS / PASS |
| `runtime-golden-path` | PASS | PASS |
| `quality-faults` / `contracts` / `spec-coverage` / `artifact-budget` | PASS | PASS |

- 集成树检查页：<https://github.com/baicie/ops-1/pull/42/checks>
- A.3 检查页：<https://github.com/baicie/ops-1/pull/43/checks>
- 首次集成运行 `75bf356` **失败**：`rust` 与 `runtime-golden-path` 均因 `clippy::unnecessary_sort_by` 编译失败；新增的 Docker stderr 测试同时暴露 ETXTBSY（见 §3.3）。修复为 `a9d869d` 后重跑 `60edf51` 全绿。这正好证明“集成树门禁”比逐 PR CI 更能发现栈内组合问题。

## 6. Verdicts

| Verdict | 状态 | 证据 |
|---|---|---|
| `G13_A2_SECURITY_REGRESSION` | **PASS** | 59 plugin/attack、205 Kernel、18 Node、contracts；攻击矩阵未放宽 |
| `DOCKER_ERROR_REDACTION` | **PASS** | 假 CLI stderr 含 token/Adapter 密钥；错误中 0 泄漏，保留 action/exit/诊断 |
| `SECRET_DELIVERY_LIMITS` | **PASS（边界明确）** | 32 KiB/条、256 KiB 总量；超限 `NODE_PLUGIN_ENV_TOO_LARGE`；不再静默启动 |
| `STACK_INTEGRATION` | **PASS** | 集成树 `60edf51` 16/16；overview-partial 自动合并保留双方断言 |
| `CI_RELIABILITY` | **PASS（残余窗口已记录）** | 两个 flake 均已定位并修复；集成树与 A.3 两套全量 CI 首次重跑全绿 |
| `AUTOMATION_IDENTITY_CONTRACT` | **PASS（契约冻结）** | ADR-018 + 权限矩阵；未实现，不声称运行时验证 |
| `EVENT_DEDUP_CONTRACT` | **PASS（契约冻结）** | ADR-019 + schema/OpenAPI；迁移未执行 |
| `INCIDENT_LIFECYCLE_COMPATIBILITY` | **PASS（契约冻结）** | 不引入 AWAITING_VERDICT；现有门禁不变 |
| `G13_B1_READY` | **PASS（可开工）** | 切片 0–5 有退出条件；生产依赖另列 |
| `PRODUCTION_READY` | **BLOCKED** | REAL_ZABBIX NOT_RUN、Secret 交付 PARTIAL、主分支未合并 |

## 7. 残余风险

1. Docker stderr 红队测试使用假 CLI；真实 Docker daemon 回显 Secret 未被证实，修复是防御性。
2. 8 KiB→32 KiB 只是把静默降级改为显式失败；多 Workspace 规模仍受 env 交付限制，Secret Broker 未实现。
3. Flake 1 的 ETXTBSY 窗口只能靠测试侧重试缩小，不能从 Linux 语义上消除；若再发，断言会输出完整错误链。
4. 集成树 `60edf51` 是最终**代码** SHA；A.3 之后的报告修订只改文档，不再改变门禁结论。
5. `REAL_ZABBIX_VERIFIED=NOT_RUN`、`PRODUCTION_SECRET_READY=PARTIAL` 继续有效；CI 绿色不是安全证明。
