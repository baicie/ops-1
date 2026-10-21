# ADR-001：Plugin-first Kernel（接受）

- **上下文**：此前将 Data/AI/Workflow 全写入核心导致迭代难、部署耦合。需求是前后端运行时安装业务功能。
- **决策**：Kernel 仅保留 IAM/Registry/Lifecycle/Capability/Gateway/Reconciler/Bootstrap，Data、Observability、AI、UI 业务以插件交付。
- **替代**：微服务直接拆分；编译时 modules；Rust dylib。拒绝原因分别为控制面管理复杂、不能热安装、ABI 与进程隔离不足。
- **结果**：0.0.1 要先证明 Hello 全栈两节点热升级；新不可卸载 Kernel 功能需专门 ADR。
