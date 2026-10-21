# 控制面数据模型 / 事务边界 / 所有权

> 这是 0.0.1 初始 Schema **设计草案**，不是经过生产压测的 SQL 迁移。示例 DDL 在 `examples/db-control-plane.sql`，落地前必须补齐 migration checksum、PG 版本与真实集成测试。

## 核心事实表

| 表或概念 | 主数据 | 事务/约束 |
|---|---|---|
| `trusted_publishers` | publisher id、public key fingerprint、trust state | 发布者停用后拒绝新安装、保留审计历史 |
| `plugin_packages` | package id、version、packageDigest、payloadDigest、signature state | 同一 id+version 只有一个 digest，禁止覆写 |
| `plugin_installations` | 一个 workspace 下安装的 plugin id | 与 package 物理制品分离，禁用不删除数据 |
| `activation_revisions` | 插件活跃版本、激活代次、policy digest | CAS 原子切换；Gateway effective routes 读取有效代次 |
| `plugin_deployments` | desired version/replicas/placement/generation | 用户声明事实；更新需 expected generation |
| `plugin_instances` | node、version、instance、observedAt、readiness | 只记录由 Node 认证报告的观察事实，支持 UNKNOWN |
| `nodes` | 身份、公钥指纹、OS/arch/labels、lastSeen、status | Node identity 通过 trust 层校验，不由请求体自证 |
| `capability_registrations` | provides/requires、契约 major/digest、scope | 可从已安装 Manifest 重建，需 activation 过滤 |
| `operation_receipts` | requestId、command digest、accepted/final status | 重复请求同摘要回原 receipt；不同摘要冲突 |
| `audit_events` | actor、action、subject、requestId、eventTime、result | Append-only 风格，受保留/隐私策略约束 |
| `plugin_migrations` | plugin id、version、migration id、checksum、status | 独立 Schema owner；升级前兼容性和恢复门槛 |

## 四个明确的事务边界

1. `Stage Package`：摘要、trust state、Manifest 校验与 installation candidate 在一个 DB 事务中提交。实际文件上传在事务外分阶段落到不可变存储，DB 中引用只能指向完成校验的对象。
2. `Change Desired Deployment`：expected generation CAS + command receipt + audit event 原子提交；对 Node 网络调用在事务外进行。
3. `Activate Version`：只有实例 Ready 见证、许可/依赖/兼容性及数据库迁移前置条件均满足，才将 activation revision 和审计原子提交。数据代理随后根据新 revision 重新构建有效路由；不能把路由缓存更新失败伪装成激活全部成功。
4. `Record Observation`：凭 Node 身份校验 node_id 和 generation，拒绝过时回报覆盖较新代次；记录 observedAt 和实例状态，心跳过期保留上次见证并将有效性标为不可用。

## Read Model / 写入所有权
- Kernel 控制面 PostgreSQL 模型由 Kernel 独占。业务插件只访问自己的 Schema 或明确授权的独立存储；Gateway Capability 才能读写跨插件数据。
- 插件私有存储的迁移不在 Kernel 核心业务事务中跨服务提交；必要时用 Saga/补偿或显式半完成状态。不宣称跨 Postgres/OCI/HTTP exactly-once。
- 可重建视图：EffectiveRoute、菜单扩展快照、当前可用 Capability 列表，可根据 active revision + readiness + policy 重建；不能作为唯一事实。
- UI 使用 opaque ID 和服务端分页，不能读取插件 Schema 内部表来拼装管理页。

## 数据保留和删除
卸载默认停用并保留用户数据与结构；`PurgeData` 是高权限独立命令，需要列出影响范围、持久 receipt、检查备份和恢复策略。审计事件与法律/安全保留期独立，不受卸载影响。
