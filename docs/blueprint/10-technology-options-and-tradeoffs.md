# 关键选型与替代方案 / Trade-offs

| 决策 | 采用 | 放弃/延后与理由 |
|---|---|---|
| Kernel 语言 | Rust（Axum/Tokio/SQLx） | Go 也可行但团队希望深研 Rust；不混合多个业务核心 |
| 后端插件边界 | 独立 OCI 服务/Worker | Rust dylib：ABI/隔离/崩溃风险；Wasm：早期 host API 和系统调用限制太强 |
| Node 控制面 | 自研轻量 Node Runtime | 不是重造 Kubernetes；仅提供小规模安装/监督/心跳/日志 |
| 插件调度 | Kernel placement + Node OCI | 不自研容器运行时；K8s 后续成为一个 Provider 而非重写 Control Plane |
| Web Plugin | 可信动态 Remote（Module Federation 隔离适配） | 初期不支持第三方任意 JS；未来 iframe Sandboxed UI |
| Persistence | PostgreSQL | Node Cache/消息总线都不是控制面事实来源 |
| 消息系统 | 0.0.1 无通用 MQ；未来按流量引入 NATS/JetStream 等 | 不预装 Kafka；不能靠消息总线代替 JobDB 幂等与状态 |
| 主机监控 | Node 最小快照；OTel Collector 后续专业采集 | 不重写 Linux 全指标 Exporter |
| Plugin Marketplace | 先团队白名单 Artifact Store | 公开市场、在线安装未审插件风险与工程范围过大 |
| 数据管道 | 0.0.2 固定接入流；0.0.3 Typed DAG | 不在基座内构造通用工作流与数据引擎 |

## 注意技术边界
- Runtime JS 模块只能进行**运行时挂载/注销**，不能可靠卸载浏览器已执行的模块代码；遵守兼容窗口与刷新通知。
- OCI 提供隔离手段而非绝对安全沙箱；高风险不可信代码需要更强隔离主机、gVisor/Kata 等选型审查。
- Desired Reconciliation 是最终收敛机制，不是每一刻全局强一致；隔离期可能出现 Unknown 观察。
- PostgreSQL `SKIP LOCKED` 只适合短事务队列领取；长任务必须 lease/fencing，副作用不可能简单保证 exactly once。
- 0.0.1 双副本业务部署不等于 PostgreSQL/Kernel HA；要显式区分产品宣传和实验通过。

## 2026-10-22 运行时选择补充
- 对比 OCI 运行时：Rootless Docker Engine（0.0.1 参考实现，团队快速验证）；Podman/containerd（保留 Adapter，不在 0.0.1 同时支持）；Kubernetes（后续由成熟集群承担 Pod 调度）。**选择 Docker Engine 不意味着依赖 Dockerfile 专有协议**，产物仍是 OCI 格式。
- 跨语言：HTTP/JSON v1 在首版的互通成本和可检查性最佳；gRPC 可留给大吞吐/Streaming Provider 的后续 ADR，不要求首版双栈。
- Dev Mode 使用 native process 与 Vite HMR 不代表正式多机部署支持宿主运行 JVM/Node/Go。
