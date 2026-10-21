# 风险登记表与正式未决项

## 需要在 0.0.1 S0 开始前决定
| ID | 问题 | 默认假设 | 触发 ADR |
|---|---|---|---|
| R1 | 运行 OS 范围 | Linux x86_64/arm64 Node，跨平台研发客户端 | 要求 Windows Node |
| R2 | 第一个 OCI Engine | Docker Engine 受控 Adapter，后续 containerd Provider | 要求无 Docker 主机 |
| R3 | 私网互通 | Kernel 能访问 Node mTLS 私网端点 | 跨 NAT/跨互联网 |
| R4 | 插件发行者 | 团队本地签名白名单 | 开放公网插件商店 |
| R5 | 存储 | 单 PG、每插件 Schema + role；内核不访问私有表 | 插件另需外部 DB |
| R6 | 用户规模 | 单 workspace / RBAC 3 角色；tenant_id 预留 | 需要生产多租户隔离 |
| R7 | 资产分发 | 本地/HTTP digest store；在目标 Node 校验 | S3/OCI registry 多区高可用 |
| R8 | Web Remote 工具 | 实现时验证一种可运行的运行时加载方案 | 不能满足 Shared React/卸载/版本共存 |

## 高风险专项
- H1 Node Runtime 权限过大 → 隔离专用节点、运行时管理 API 白名单、容器资源/网络防护、代码审计、独立安全测试。
- H2 双节点热升级期间新旧客户端 API 不兼容 → API additive changes、version window、activation CAS、旧 tab 测试。
- H3 数据库 Schema 无法回滚 → Expand/Migrate/Contract，迁移准入、快照与人工恢复。
- H4 Node 失联发生 split brain → Unknown 状态、路由剔除、写入端 fencing、防止双副作用。
- H5 前端动态加载恶意远程代码 → 初期只允许可信发行者，后续沙箱；不能靠签名解决业务可信。
- H6 范围失控 → 0.0.1 Golden Path + 里程碑 Gate；临时高级需求全部进入 future backlog。
- H7 自运维数据不可用 → Bootstrap 诊断作为永久 Kernel 能力；不得依赖 Ops Center 或 ClickHouse 才能救援。
- H8 成本飙升 → 对 package storage、logs stream、Node count、CPU/memory、外部 AI API 都有可配置预算/配额。

## 审批路径
上述任一默认假设被改变：写 ADR，包含 Alternative、影响模块、迁移、安全、验收与回滚、版本影响；未签署 ADR 不改变已冻结范围。

## 2026-10-22 新增风险和关闭门槛
| 风险 | 后果 | 闭合标准 |
|---|---|---|
| OCI Registry 私有化/离线分发 | Node 无法按 Digest 拉取镜像 | 可重复离线镜像同步 + 签名/摘要验证实验 |
| Rootless Engine 资源/网络限制受宿主影响 | 容器未真正受限 | cgroup v2/用户命名空间/网络 egress 真实测试，不满足 fail-closed |
| Java 慢启动与 Go/TS 快启动差异 | 错误 Liveness 重启 | 分离 Startup/Ready/Live 并三语言合约回归 |
| Web Remote 旧 Tab 与后端新版本不兼容 | 错误、用户编辑数据丢失 | 兼容窗口和更新提示 E2E |
| 套件自身签名或 ZIP 内容 hash 自引用 | 跨语言解析不一致/供应链错误 | Canonical fixtures 先冻结后签署 |
