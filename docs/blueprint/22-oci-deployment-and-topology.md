# OCI 部署设计与拓扑（0.0.1 冻结）

## 运行时落点
- `platform-kernel`: Rust API/Policy/Registry/Gateway/Reconciler，0.0.1 一份；本机 OCI 容器交付。
- `platform-web`: React Shell 构建后由 TLS ingress 的静态服务分发；也可放入独立 Web OCI 镜像供 Compose 运维，但**业务 UI Remote 是独立静态制品**，不随 Shell 重建。
- `opsweave-node`: Linux 主机上的**系统守护进程**（建议二进制/systemd），持有专用 Rootless Docker Unix socket 访问权。不能把宿主 Docker Socket 挂给业务插件。Node 自身也可包装为受控容器，但需要独立审查宿主控制权限，首版推荐守护进程。
- `business-backend`: 每插件版本按 digest 引用 OCI 镜像，Node Runtime 通过容器引擎受控执行。
- `postgres`: 独立数据库服务；Artifact/OCI Registry 可先用开发服务但必须有备份与恢复策略。

## 单机开发与正式验收
```
Dev Laptop:
  Kernel + PG + Web + Dev Node + Registry fixture
  Plugin Web dev server → Shell development loader (HMR)
  Plugin Java/Go/Node locally (DEV ONLY) or container

Three-host acceptance:
  K: TLS ingress, Kernel, React Shell assets, PostgreSQL, artifact store
  A: opsweave-node (rootless Engine), plugin replica A
  B: opsweave-node (rootless Engine), plugin replica B
```
A/B → K 主动建立控制通道；K → A/B 使用**可路由私网 mTLS 数据通道**。不支持 NAT 穿透的环境必须先部署 VPN/Overlay 或更改网络方案，不能仅依赖“Node 主动注册”就假设数据通道可用。

## 从构建到上线的对象
```
source code (Java/Go/TS/Rust/Python)
  → CI build / contract test → OCI Image@Digest → OCI Registry
React plugin source → remoteEntry/chunks@SHA-256 → Artifact Store
plugin Manifest + signed package → Package Registry
  → desired deployment (replicas, placement, resources)
  → Node reconciler pulls digest / starts container
  → startup/readiness/info verification
  → Gateway routes + Web Extension Registry atomic revision
```

## Node 容器控制硬边界
- Host 前置：Linux cgroup v2、rootless Engine 可用、专属运行用户、专属 Docker Unix socket、必要的 CPU/Memory/PID 限额可生效；不可用就拒绝合规部署，而不是省略限制。
- 禁止 privileged、host network、host PID/IPC、宿主 Docker Socket、任意 bind mount、附加 Linux capabilities、可写宿主根目录。
- 只读 rootfs、`no-new-privileges`、cap-drop、seccomp 与明确 writable tmpfs 应作为启动默认政策；对确实需要存储的插件使用事先授权的卷和独立数据生命周期。
- 默认不允许任意出站联网；如 0.0.1 引擎不能提供可靠网络 egress 限制，必须在可信隔离节点/网络策略实现，不得声称已具备此安全保证。
- Node 必须保存 container ID、image digest、deployment generation 和 instance ID 的安全映射；只允许操作由本 Node 管理的容器。
- 滚动升级先确保新实例 Ready + `info` 与 Manifest 匹配，再 CAS 切 Effective Routes；失败保留旧路由。

## 真实部署前的配置矩阵
| 项 | 开发环境 | 0.0.1 多机实验 | 正式生产前额外要求 |
|---|---|---|---|
| 节点 | 1 | 2 | 异构/容量/故障域评估 |
| 内核 | 1 | 1 | HA / failover 才能宣称高可用 |
| 引擎 | Rootless Docker 参考 | 每 Node 一份 | 受控版本与权限审计 |
| 数据库 | 单 PG | 单 PG | 备份恢复和可能的 HA |
| 网关网络 | loopback | 私网 mTLS 双向 | 防火墙、证书轮换、审计 |
| 制品来源 | 测试信任根 | 可信签名和固定 Digest | 发布者、密钥、SBOM 和扫描门禁 |

## 回滚差异
- 容器路由可以回切旧 Digest，**但已经执行的不兼容 Schema 迁移不能自动倒退**。
- 旧 Web Remote 被浏览器加载后可能继续活动，后端需保证兼容窗口；当请求协议不兼容时 UI 展示升级要求。
- 失败或节点失联不能直接证明旧实例已停止；Fencing、Effective Routes 冻结和有界离线许可必须生效。
