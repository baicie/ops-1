# ADR-018: Automation Principal

- 状态：Proposed（G13-B0 contract freeze；G13-B1 实现前不得启用）
- 日期：2026-11-06
- 基线：G13-A.3 集成分支（#34/#35/#38/#40/#41+#39）
- 前置：[ADR-012](ADR-012-capability-fabric-and-plugin-storage.md)、[ADR-015](ADR-015-evidence-attestation-and-telemetry-sources.md)、[ADR-016](ADR-016-g13-source-persistence-scoped-identity-and-evidence-content.md)、[ADR-017](ADR-017-credential-endpoint-binding.md)
- 相关代码：`plugins/zabbix-source/backend/identity.mjs`、`apps/kernel/src/capabilities.rs`、`apps/kernel/src/auth.rs`、`apps/kernel/src/scope.rs`

## 1. 背景

G13-A 的写入路径全部建立在**人类会话**上：

- 插件用 `x-opsweave-user-context`（`owu1`）判断调用者角色与 Workspace；
- Evidence 由用户会话经 Gateway 追加，插件只对 collection 签名；
- Kernel 创建 Incident、追加 Evidence 需要 `AuthUser::require_operator`；
- Human Verdict 与 Close 必须由人完成。

无人值守的 Trigger → Incident → Collect → Evidence 流水线没有可用身份：复用人类 Session 会把自动化写成某个人的操作，复用插件 Workload 身份又会让插件获得 `telemetry.source.write` 的全部能力（包括创建/修改 Source 与 Credential Binding）。二者都违反“用户、插件或模型自报的 tenant/subject/permissions 不能代替可信身份”。

## 2. 决策：三种 Principal，三个授权类

| Principal | 传输载体 | 谁签发 | 授权来源 | 可写 |
|---|---|---|---|---|
| **User** | `owu1` user context | Kernel Gateway（用户会话） | 角色 + `business_workspace_members` | 业务写、Human Verdict、Close |
| **Workload** | `oww1` workload context | Kernel（capability grant） | capability grant + instance 身份 | 仅 capability 声明的操作 |
| **Automation** | `owa1` automation context | Kernel（仅内部端点） | Kernel 侧 source 注册表 + 触发器绑定 | 仅事件对应的 collect/evidence |

Automation **不是**一个更宽的角色，也不是 `AuthUser` 的变体。它是独立的 extractor（`AutomationPrincipal`），不实现 `require_operator`，不能进入任何接受 `AuthUser` 的 handler。

### 2.1 Token claims（`owa1`）

```
v: 1
kind: "automation"
principalId: uuid            // Kernel 侧 principal 记录，非插件生成
pluginId, instanceId, nodeId, nodeGeneration
workspaceId: uuid            // 由 Kernel 从 source 注册表解析，不接受插件自报
sourceId: uuid
allowedOps: ["SOURCE_COLLECT", "EVIDENCE_APPEND"]   // 闭集
eventId: uuid                // 本 principal 对应的 Event（若由事件触发）
incidentId?: uuid            // 仅当目标 Incident 已由该事件创建
budget: {collections, evidenceBytes, windowSeconds}
issuedAt, expiresAt          // TTL ≤ 300s；单次操作 principal 默认 120s
jti: uuid
audience: "opsweave-kernel"
```

签名密钥为 Kernel 的 automation signing key（独立于 `cursor_secret` 与 per-plugin caller key），按 `pluginId` 派生；插件只验证，不能签发。签发端点 `POST /internal/v1/automation/principals` 只接受：

1. 由 Kernel 签发的 instance workload identity，且 `instanceId/nodeId/nodeGeneration` 与当前 live instance 一致；
2. `sourceId` 在 Kernel 的 **telemetry source 注册表**中属于 `pluginId` 且 `state=READY`；
3. 请求的 `allowedOps` 是该 source 的 trigger 策略允许的子集；
4. `eventId` 存在、未过期、且签名有效。

注册表是 G13-B1 的前置迁移：G13-A 的 source 行保存在插件存储中，Kernel 只持有 credential binding 元数据（`pluginId + workspaceId + secretRef + endpoint`），没有 `sourceId`。在注册表落地前，Automation 不能启用；**不得**用插件自报的 `workspaceId` 代替注册表。

### 2.2 权限边界

Automation **可以**：

- 对绑定 source 发起有界 collect；
- 为本次 Event 对应的 Incident 追加 Evidence（必须带 v2 attestation 与内容摘要）；
- 在 Event 首次落地时创建 Incident（`source=AUTOMATION`，见 ADR-019）。

Automation **不可以**：

- 写 Human Verdict、Conclude、Close、改 owner；
- 创建/更新/删除 Source、修改 Credential Binding 或 TLS 策略；
- 读取或写入其他 Workspace、其他 source；
- 读取 Secret 明文、调用 credential.manage；
- 复用人类 Session、伪造 `sub` 为用户、写入人类审计 actor。

### 2.3 预算、撤销、重放

| 项 | 规则 |
|---|---|
| 预算 | token 内嵌 `collections`/`evidenceBytes`/`windowSeconds`；Kernel 在每次调用扣减，插件在本地再次校验；耗尽返回 429 `AUTOMATION_BUDGET_EXHAUSTED`，不产生部分 Evidence |
| 过期 | `expiresAt` 后一律 401 `AUTOMATION_PRINCIPAL_EXPIRED`；时钟偏移容忍 ±60s |
| 重放 | 状态变更调用要求 `jti` 单次使用；Kernel 以唯一索引拒绝第二次，返回 409 `AUTOMATION_REPLAY` |
| 撤销 | `kernel.automation_principals.revoked_at`；实例撤销、节点隔离、source 禁用、binding 收紧任一发生即撤销 |
| 节点故障 | token 绑定 `nodeGeneration`；节点失联/换代后旧 token 在 Kernel 侧失效，不依赖 Node 重启 |
| 实例替换 | 旧 `instanceId` 在替换后失效；容器收养不延长 principal 生命周期 |

### 2.4 审计归因

`kernel.audit_events` 增加 `AUTOMATION` 到 `actor_type`（迁移在 B1）。Automation 的审计行：

```
actor_type = AUTOMATION
actor_id   = principalId
details    = {eventId, sourceId, pluginId, instanceId, nodeId, operation, budgetRemaining}
```

`actor_id` **绝不**写用户 UUID；`on_behalf_of` 不存在。UI 时间线以“Automation”标签展示，人工仍可随后写 Verdict。

## 3. 与现有身份的关系

- User 与 Workload 的 token 格式不变；Automation 使用独立前缀，旧插件无法解析，旧 Kernel 也无法验证。
- `oww1` 的 capability grant 不会自动产生 `owa1`；必须显式签发。
- 插件现有的 role→scope 表（`identity.mjs`）不增加 automation 条目：插件没有“automation 用户”，只有 Kernel 签发的 principal。
- 人类 Verdict 的 `decided_by` 仍为 `kernel.users.id`；Automation 没有可写的 verdict 路径。

## 4. 迁移与回滚

- B0 仅冻结契约，**不启用**任何 automation 端点；现有行为不变。
- B1 按切片落地：注册表 → 签发/验证 → Event ingest → collect/evidence → UI。每一步都可独立回滚到“关闭 automation”，不影响用户会话路径。
- 回滚不得删除已由 Automation 创建的 Incident/Evidence；改为标记 `origin=AUTOMATION` 并保留审计。
- 不重新打开 v1 Adapter 写入；Automation 的 Evidence 必须走 v2 attestation。

## 5. 风险与残留

| 风险 | 处理 |
|---|---|
| Kernel 注册表与插件 source 行不一致 | 注册表为权威；不一致时拒绝签发，返回 `AUTOMATION_SOURCE_NOT_REGISTERED`，不猜测 |
| 长时采集超出 token 预算 | 有界 collect + 429；不允许续期后静默重试 |
| 多 Workspace 共用一个插件实例 | principal 绑定单 workspace/source；进程隔离仍是 PARTIAL（见 A.2） |
| Secret 交付仍为 env | 不因 Automation 改变；`PRODUCTION_SECRET_READY=PARTIAL` 继续有效 |

## 6. 验收（B1 前必须通过）

见 `docs/design/g13-b0/e2e-acceptance.md`：签发拒绝插件自报 Workspace、跨 Workspace 拒绝、过期/重放/撤销、预算耗尽、审计 actor 类型、Human Verdict 不可写、节点换代失效。
