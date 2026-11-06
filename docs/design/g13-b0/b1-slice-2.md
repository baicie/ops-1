# G13-B1 切片 2 实施记录（Automation Principal）

- 状态：已实现签发/验证；**Event ingest、collect、evidence 尚未接入**
- 日期：2026-11-06
- 决策：[ADR-018](../../adr/ADR-018-automation-principal.md)、[ADR-019](../../adr/ADR-019-event-identity-and-dedup.md)
- 迁移：`0027_automation_principal_uses.sql`
- 代码：`apps/kernel/src/automation.rs`、`apps/kernel/src/routes.rs`

## 1. 签发

```
POST /internal/v1/nodes/{node_id}/automation-principals
Authorization: Bearer <node control token>
```

请求：

```json
{
  "instanceId": "<uuid>",
  "sourceId": "<uuid>",
  "allowedOps": ["EVENT_INGEST"],
  "eventId": null,
  "incidentId": null
}
```

- 调用者只能是持有 Node control token 的 Node；插件没有签发入口。
- `workspaceId` **不在请求里**：Kernel 从 `kernel.telemetry_sources` 解析。
- 校验：instance 属于该 Node 且 `desired_action=START`；source 已注册且 `state=READY`；source.plugin_id 与 instance 的 plugin 一致；`eventId/incidentId`（若给出）必须属于该 workspace/source。
- `allowedOps` 闭集：`EVENT_INGEST`、`SOURCE_COLLECT`、`EVIDENCE_APPEND`；重复/未知/verdict/close/binding 操作一律 422/403 `AUTOMATION_SCOPE_INVALID`。
- 预算由服务端固定（events 8、collections 8、evidenceBytes 1 MiB、window 300s），调用者不能抬高。
- TTL 固定 300 秒；返回 `owa1.<payload>.<sig>`、`principalId`、`expiresAt`、`workspaceId`、`sourceId`。

Token claims（`owa1`）：`v, kind, principalId, pluginId, instanceId, nodeId, nodeGeneration, workspaceId, sourceId, allowedOps, eventId, incidentId, budget, issuedAt, expiresAt, jti, audience`。签名键从 Kernel cursor secret 按 plugin 派生，Node/插件不持有。

## 2. 验证

`automation::authenticate` 在每次调用时同时检查：

1. `owa1` 前缀、版本、audience、HMAC 签名、`expiresAt`、`issuedAt` 时钟偏移；
2. DB principal 行的 `jti/plugin/instance/node/workspace/source/allowed_ops` 与 token 完全一致；
3. `revoked_at` 为空；
4. 节点当前 generation 与 token 一致（`AUTOMATION_INSTANCE_STALE`）；
5. instance 仍在该 Node 上 live 且 plugin 一致；
6. source 仍为 `READY` 且 workspace/plugin 未变（`AUTOMATION_SOURCE_NOT_READY`）。

`consume_once(operation)` 向 `automation_principal_uses` 插入 `(principal_id, operation)`；主键冲突返回 409 `AUTOMATION_REPLAY`。同一 principal 的每个操作只能执行一次。

`revoke(principal_id)` 置 `revoked_at`；admin 通过 `POST /api/v1/automation-principals/{id}/revoke` 调用（幂等，204）。Node 换代、实例替换、source 禁用都会让旧 token 在验证时失效，无需等待 token 过期。

## 3. 本切片没有做什么

- 没有 Event ingest 端点、没有 collect/evidence 自动化、没有 UI。
- 没有把 `owa1` 注入插件环境；切片 4 才决定 Node→插件交付方式。
- 预算字段已随 principal 存储，但扣减在切片 3/4 的 handler 内实现。

因此，`OPSWEAVE_AUTOMATION_SOURCES` 的 READY 行目前只能通过内部接口签发 token，不能触发任何业务写入。

## 4. 验证

```bash
OPSWEAVE_TEST_DATABASE_URL=... OPSWEAVE_REQUIRE_TEST_DATABASE=1 \
  cargo test -p opsweave-kernel automation::
```

3/3：token 绑定/操作权限/replay/revoke；非法操作签发拒绝；节点换代与 source 禁用使 token 失效。完整 Kernel 套件 214/214；clippy `-D warnings` 通过。

## 5. 错误码

| 条件 | 码 |
|---|---|
| 缺失/坏签名/过期/不匹配 | `AUTOMATION_PRINCIPAL_INVALID` / `AUTOMATION_PRINCIPAL_EXPIRED` |
| 已撤销 | `AUTOMATION_PRINCIPAL_REVOKED` |
| 节点换代/实例不在 | `AUTOMATION_INSTANCE_STALE` |
| source 未注册 | `AUTOMATION_SOURCE_NOT_REGISTERED` |
| source 非 READY | `AUTOMATION_SOURCE_NOT_READY` |
| 操作越权 | `AUTOMATION_OPERATION_FORBIDDEN` / `AUTOMATION_SCOPE_INVALID` |
| 操作重放 | `AUTOMATION_REPLAY` |

## 6. 下一步（切片 3）

- `POST /api/v1/telemetry/events`：`AutomationPrincipal` + `EVENT_INGEST` + `consume_once`；
- idempotency key、payloadDigest、乱序/RESOLVED、Incident 去重；
- 审计 actor `AUTOMATION`；仍不写 Verdict/Close。
