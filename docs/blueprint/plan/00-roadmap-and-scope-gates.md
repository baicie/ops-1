# 版本路线 / 全局验收门槛

## 版本使命
| 版本 | 交付使命 | 出口 Gate |
|---|---|---|
| 0.0.1 | 可热插拔的跨节点运行基座 | 真正两节点、完整升级/失败、权限隔离、实时日志、自救 |
| 0.0.2 | 数据模型 + 数据接入 | 两个独立插件完成 HTTP/JSON→Dataset，跨插件能力授权与禁用保护 |
| 0.0.3 | Typed Pipeline + Durable Job Worker | DAG 版本/类型、不同 Node 执行、Lease/Fencing/Checkpoint |
| 0.0.4 | Pipeline Studio UI | 拖拽、调试、预览、发布、历史，真实引擎对应 |
| 0.0.5 | Data Governance & Ops | Lineage、Quality、历史节点监控与日志 |
| 0.0.6 | Observability Plugins | OTel 数据查询和实体关联（Metrics/Logs/Traces） |
| 0.0.7 | AI Plugin Foundation | 模型与工具 Capability、预算、可追溯任务 |
| 0.0.8–0.1.0 | 整合、性能、安全与可靠性 | 多版本、多节点、RCA/数据流程真实案例与迁移验收 |

## Gate 0：架构冻结（0.0.1 启动前）
- Rust/TS/OCI/PG 技术基线、CI、Git 签名、安全入口、合约 Repo 边界、可重复 3 机环境说明。
- 选择并锁定一个 Web 运行时 Remote 方案和一个 Linux OCI Engine 适配，实际 PoC 证明 SDK/API 版本共存条件。
- 所有非目标写入 Future Backlog。**不可在 S1 之后临时加入 Data Model/AI/GPU 调度**。

## Gate 1：单机内核
Plugin Package Sign/Verify、Registry、Manifest、Capability Registry、Version/Dependency、Web Shell 动态加载、本机容器运行、审计、CLI 恢复。

## Gate 2：两节点
Identity/Enrollment、Node control、私有 mTLS Gateway→Node 数据路由、Placement、Reconciler、Observed/Effective State、两副本稳定路由。

## Gate 3：完整生命周期
上传→Stage→Activate→Disable/Enable→Upgrade→Rollback/Refuse→Uninstall（keep data）；包含失败注入和未知回执处理。

## Gate 4：自运维与 UI
Node resource snapshot + Logs SSE、Ops Center 页面、Bootstrap Diagnostics、UI 六截图/a11y、类型/集成/故障注入测试，提交真实环境验收报告。

## 发布规则
如果 Gate 2 或 Gate 3 未通过，则不能进入 0.0.2；如需延后，只能减轻非核心 UX 或文档装饰，不能删安全验签/鉴权/故障状态边界。

## 2026-10-22 Gate 更新（硬性）
- Gate 0 固定：Runtime v1 + Manifest v1.1 + OCI 镜像签名/Hash 语义 + Rootless Docker Reference Adapter。Java/Go/TS 官方示例无需修改 Kernel 可接入。
- Gate 1–3：补 Java/Go/TS OCI 独立构建、真实拉取@digest、后端健康三探针、前端 Asset Index、发布升级兼容窗口。
- Gate 4：三机实测 **C01–C14**，证据见 [多语言 Gate](04-001-oci-multilang-acceptance.md) 与 [总体验收](../docs/27-implementation-and-conformance-gates.md)。
