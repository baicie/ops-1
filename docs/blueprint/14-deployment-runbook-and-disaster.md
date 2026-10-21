# 部署基线 / 运维手册 / 灾难恢复

## 场景 A：开发机单节点
本机 PostgreSQL + Kernel + Web + 一个 Node + 可信 Hello Plugin。用于快速开发，不用于分布式验收；环境文件仅示例，签名密钥本地生成，默认不绑定公网端口。

## 场景 B：0.0.1 三机验收
```text
Machine K: TLS ingress, Kernel, Web assets, PostgreSQL, artifact store
Machine A: Node Runtime, OCI Engine, Plugin Service replica A
Machine B: Node Runtime, OCI Engine, Plugin Service replica B
```
网络前提：私网可路由、双向 mTLS 验证，Node A/B 控制面主动连出，Kernel Gateway 可到 A/B 的受控数据代理。宿主 OCI 管理 socket 仅本机 Node Runtime 有权使用。无生产 HA 宣称。

## 运维日常路径
- 安装：验签 → Diff 权限 → 检查依赖 → Stage → Placement → Ready → Activate → 审计。
- 升级：审核 API/schema/权限变更 → Staging → 展示候选和旧版实例 → Canary（可选）→ readiness → activate → drain → 保留回退窗口。
- 故障：先检查 Kernel/Node readiness、active revision、instance health、近期部署事件 → Tail log → 恢复策略；日志暴露必须遵循保密控制。
- 禁用：验证依赖 → drain → route revoke → stop/cancel → keep data；`purge` 独立操作。

## 灾难恢复
- 备份：PG 控制数据库、签名公钥信任根、Artifact Store、部署配置；密钥与 DB 备份分开管理。
- 演练：从空白 Kernel 重新装入注册数据 → 恢复 PG → 重新信任 Node 身份/必要时重注册 → 对账 OCI 进程 → 重建 Gateway effective routes → 检查审计连续性。
- 未知状态：恢复过程中所有不能证明的实例/任务标记 UNKNOWN/RECOVERING；不自动清空租户数据。
- 批准窗口：未完成完整恢复演练的版本，不声明生产可恢复能力。

## 生产默认制品与参考 Engine（2026-10-22 冻结）
- 后端发布为 OCI 镜像 `registry/repo@sha256:...`；前端通过独立版本静态 Asset Store 分发，不要求给每个 UI 插件部署独立容器。
- 0.0.1 Node 参考 Rootless Docker Engine；如果未配置 cgroup v2/非 root/用户 namespace/允许的网络与挂载，部署 fail-closed。Node Systemd 服务拥有专用管理 socket，插件容器永不挂载该 socket。
- Kernel/Web/PostgreSQL 可通过本地 Compose 部署，**Compose 单机验收与真实 3 台 Linux 主机验收必须区别记录**。
- 私网路由：A/B 主动控制通道 + K→A/B 可达 mTLS 数据通道；NAT Relay 尚未开发。企业生产部署的外部 Registry、证书、备份、CA 轮换需实际演练。
- 新增 [独立完整部署拓扑](22-oci-deployment-and-topology.md) 与 [升级/回退行为](25-rolling-release-and-rollback.md)。
