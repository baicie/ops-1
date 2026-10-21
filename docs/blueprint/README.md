> **FINAL REVISION 2026-10-22 — Blueprint 1.1.0 / 0.0.1 OCI & Multi-language Freeze.** Read [Final Decisions](FINAL_DECISIONS.md) first. This full bundle supersedes the 2026-10-21 ZIP; no previous files are required. Actual runtime and deployment tests are NOT_RUN.

# OpsWeave — Distributed Plugin Platform · Architecture Baseline

> **架构基线**：2026-10-22 | **文档版本**：1.1.0 | **状态**：提议冻结（设计文档，不是可运行产品）
> **正式首版**：0.0.1 Platform Foundation；**下一版**：0.0.2 Data Foundation。

## 最终定义

OpsWeave 是**可跨节点部署、全栈热插拔、具备自运维能力的模块化应用平台**。它的首批行业能力是数据建模/数据接入/工作流，之后叠加可观测与 AI；AI RCA **不是** 0.0.1 的产品中心。平台先于业务，插件化是扩展机制而不是让每一个按钮或数据库表都变成独立微服务。

### 五项不可谈判的决策（继续有效，另见 FINAL_DECISIONS.md）
1. **不可卸载的安全内核**：身份、授权、插件签名验证、注册/生命周期、网关、部署期望状态、故障恢复入口属于 Kernel。
2. **全栈插件**：每个业务包可以组合 Web 前端、独立后端 Service、Worker、配置/数据所有权；新增业务不需要重新编译 Kernel 或 Shell。
3. **分布式从第一天验证**：0.0.1 的真实验收为 1 Kernel + 2 Linux Nodes，一个全栈测试插件两个后端副本，升级/失联/日志检查。
4. **Desired / Observed / Effective 三态分离**：PostgreSQL 是控制面期望与历史事实来源；节点状态不是配置，网关可达性不是心跳等价物。
5. **平台基础监控可在业务插件失败时自救**：Kernel 提供只读的 Bootstrap Diagnostics；Ops Center 是官方系统插件；历史遥测后续接独立采集管线。

### 阅读顺序
1. `docs/00-product-charter.md`：目标、非目标、用户旅程。
2. `docs/01-decisions-and-architecture.md`：总体结构、技术决策、部署边界。
3. `docs/02-kernel-plugin-contract.md`、`docs/03-distributed-control-plane.md`：插件和分布式执行。
4. `docs/04-security-and-isolation.md`、`docs/05-reliability-and-recovery.md`：高风险边界。
5. `docs/ui/`：核心功能界面、设计系统、交互和视觉验收。
6. `plan/`：按 0.0.1、0.0.2、0.0.3+ 拆分、按 Gate 交付。
7. `AGENTS.md` + `rules/` + `skills/`：平台无关的工程与设计规则。
8. `contracts/`、`templates/`、`scripts/`：可落地接口示例、规范模板、检查器。

### 冻结范围与明确非目标
| 版本 | 必须交付 | 明确不交付 |
|---|---|---|
| 0.0.1 | 插件签名/安装/热启停/升级/回滚；Web Extension Host；2 节点容器实例部署；节点健康/基础指标/实时运行日志；恢复 CLI；契约和验收 | AI RCA、Data Catalog、通用 DAG、历史日志检索、第三方任意代码、生产多控制面 HA、GPU 自动调度 |
| 0.0.2 | Data Catalog + Data Integration 独立插件；HTTP/JSON 接入、模型版本、发现/映射/校验/入库、执行和质量基础状态 | 通用分布式 ETL 引擎、任意 SQL 执行、可视化复杂 DAG、多源 CDC |
| 0.0.3+ | Typed Pipeline IR/Worker、编辑画布、治理、Observability、AI 能力插件，按依赖逐个发版 | 非承诺的特定日期；每版以真实 Gate 决定 |

### 与旧版的关系
此文档**取代此前以 Java/Rust 混合后端与 AI RCA 为首版中心的 OpsWeave 0.1.0 设计**。保留旧仓库只读历史、协议测试和可迁移代码资产；不把旧的 WorkflowStore / 页面结构当成新 Kernel 接口。具体在 `docs/15-legacy-and-migration.md`。

### 状态声明
- 这是设计包和示例，不包括正式可运行 Rust/React 产品。
- `contracts` 中 JSON、Schema、API 示例须以实现时的 CI 合约测试再次签署；不能将示例解析成功视为服务已上线。
- 架构内的阈值是实验验收目标或起始缺省值，非经过容量测试的生产承诺。
- `AGENTS.md` 和 `rules/` 不绑定特定编程助手产品；使用时由人或自动化读取并执行。

### 控制面最小表与节点升级
- `docs/18-control-plane-data-model.md`：控制面 Schema 所有权和事务模型；`examples/db-control-plane.sql` 是概念草案。
- `docs/19-fleet-upgrade-and-compatibility.md`：Node Runtime 自身升级、Kernel 单实例维护窗口与四轴兼容矩阵。
