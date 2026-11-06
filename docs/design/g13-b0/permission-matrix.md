# G13-B0 Permission Matrix（冻结）

- 状态：Frozen for G13-B1
- 依据：[ADR-018](../../adr/ADR-018-automation-principal.md)、`apps/kernel/src/auth.rs`、`apps/kernel/src/scope.rs`、`apps/kernel/src/incidents.rs`
- 规则：`User` 的 Workspace 可见性来自 `business_workspace_members`；`Automation` 的单 Workspace 来自 Kernel source 注册表；`Workload` 只能使用 capability grant 声明的操作。

## 1. Principal × 操作

| 操作 | Viewer | Operator | Admin | Workload (`oww1`) | Automation (`owa1`) |
|---|---|---|---|---|---|
| 读 Incident/Evidence（本 Workspace） | ✅ | ✅（OwnedRows） | ✅（AllRows） | ❌ | ✅（仅关联 Incident） |
| 创建 Incident | ❌ | ✅ | ✅ | ❌ | ✅（仅 PROBLEM Event，`origin=AUTOMATION`） |
| 追加 Evidence | ❌ | ✅ | ✅ | ❌ | ✅（本 source 的 Incident，v2 attestation） |
| 写 Human Verdict | ❌ | ✅ | ✅ | ❌ | ❌ |
| Conclude（verdict 的副作用） | ❌ | ✅ | ✅ | ❌ | ❌ |
| Close Incident | ❌ | ✅（现有门禁） | ✅ | ❌ | ❌ |
| 改 owner | ❌ | ✅（现有规则） | ✅ | ❌ | ❌ |
| 启动/取消 Investigation | ❌ | ✅ | ✅ | ❌ | ✅（受预算，仅假设） |
| 创建/更新 Source | ❌ | ✅ `telemetry.source.write` | ✅ | ❌ | ❌ |
| 读取 Source | ✅ `telemetry.source.read` | ✅ | ✅ | ❌ | ❌ |
| 修改 Credential Binding / TLS | ❌ | ❌ | ✅ `credential.manage`（部署配置，非 UI） | ❌ | ❌ |
| 读 Secret 明文 | ❌ | ❌ | ❌ | ❌（只能按 ref 解析） | ❌ |
| 跨 Workspace 读写 | ❌ | ❌ | ❌ | ❌ | ❌ |
| Event ingest | ❌ | ❌ | ❌ | ❌ | ✅（`allowedOps` 含 `EVENT_INGEST`） |

说明：

- `credential.manage` 目前是**部署配置**（`OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS` + Kernel 重启/实例替换），不是 API；表中 Admin 一列表示“运维配置权限”，不是会话内可调用端点。B1 不新增在线 binding 管理 API。
- Workload 的 capability grant 是闭集；`oww1` 不能用于 incident/evidence 端点（现有 `AuthUser` extractor 不接受）。
- Automation 不能被授予 `telemetry.source.write`、`credential.manage`、`incident.verdict.write`、`incident.close`、`workspace.member.manage`。

## 2. Token 与信任根

| Principal | 前缀 | 签名键 | 签发者 | 校验点 |
|---|---|---|---|---|
| User | `owu1` | per-plugin caller key | Kernel Gateway（用户会话） | 插件 `identity.mjs` |
| Workload | `oww1` | per-plugin caller key | Kernel capability grant | 插件 / Kernel 内部端点 |
| Automation | `owa1` | Kernel automation key（按 plugin 派生） | Kernel `/internal/v1/automation/principals` | Kernel 事件/自动化 handler；插件校验 collect 请求 |

- 插件**不能**签发任何 token；没有 `owa1` 的私钥。
- `workspaceId`、`role`、`allowedOps` 均来自 Kernel 数据，不接受请求体/header 自报。
- 人类 Session 不能换取 `owa1`；Automation 也不能换取 `owu1`。

## 3. 审计 actor

| 操作 | `actor_type` | `actor_id` |
|---|---|---|
| 用户写 Verdict/Close | `USER` | `kernel.users.id` |
| 插件 capability 调用 | `WORKLOAD` | instance/plugin 标识 |
| Automation Event/Incident/Evidence | `AUTOMATION` | `kernel.automation_principals.id` |
| Kernel 定时/恢复动作 | `KERNEL` | `kernel` |

拒绝也写审计；`details` 不含 Secret、Token、payload 原文。

## 4. 失败语义

| 条件 | 状态码 / 错误码 |
|---|---|
| 无/错误 token | 401 `AUTOMATION_PRINCIPAL_INVALID` |
| 过期 | 401 `AUTOMATION_PRINCIPAL_EXPIRED` |
| source 不在注册表 / 不属于该 Workspace | 403 `EVENT_SOURCE_FORBIDDEN` |
| Workspace 不一致 | 403 `EVENT_WORKSPACE_MISMATCH` |
| 操作不在 `allowedOps` | 403 `AUTOMATION_OPERATION_FORBIDDEN` |
| 写 Verdict/Close | 403 `AUTOMATION_VERDICT_FORBIDDEN` / `AUTOMATION_CLOSE_FORBIDDEN` |
| jti 复用 | 409 `AUTOMATION_REPLAY` |
| 预算耗尽 | 429 `AUTOMATION_BUDGET_EXHAUSTED` |
| 实例/节点换代 | 401 `AUTOMATION_INSTANCE_STALE` |
