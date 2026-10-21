# A-01 架构边界规则

- MUST：Kernel 仅含 IAM/Registry/Lifecycle/Capability/Gateway/Node Reconciliation/Bootstrap 诊断等信任根，不依赖任何业务插件源码或私有表。
- MUST：新增功能先决定是 Kernel 内部不变职责还是插件 Extension；凡业务 Data/AI/Observability 默认插件。
- MUST：后端插件经跨进程版本化 API，禁止 Rust dylib 直接注入 Kernel。
- MUST：插件发布和 ABI/SDK/API 相互兼容；Breaking 变更走 SemVer 主版本与变更审查。
- MUST：Contract 是单一真相，生成客户端不可手改；模块不能直接共享另一插件内部 DTO。
- SHOULD：保持模块化单体 Kernel + 独立业务 Workloads，不引入无证据的额外微服务/消息平台。
- Gate：新增 Kernel 模块或不可卸载能力必须 ADR，包含更轻的插件替代方案为何不可行。
