# ADR-002：Linux Node + OCI Adapter（接受）

- **决策**：后端插件部署为独立 OCI 进程/容器；Node Runtime 负责 Enrollment/监督/资源/日志/私网代理；Kernel 调度期望部署。
- **替代**：远程执行 shell、直接进程二进制、K8s 首版强依赖。拒绝理由为危险执行边界/不同语言环境难管理/范围过大。
- **约束**：Node 管理 OCI Socket 具高权限，必须专用受控节点、最小系统权限、防提权；0.0.1 Linux 私网可路由，不声称 NAT 穿透。
- **后续**：Containerd/Kubernetes Provider / NAT Relay 需要新 ADR 和真实 E2E。
