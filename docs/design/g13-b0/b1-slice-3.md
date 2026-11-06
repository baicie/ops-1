# G13-B1 切片 3 实施记录（Event Ingest）

- 状态：已实现 Event 入库/幂等/Incident 去重；自动采集/UI 未接入
- 日期：2026-11-06
- 决策：[ADR-019](../../adr/ADR-019-event-identity-and-dedup.md)
- 迁移：`0028_event_automation_identity.sql`
- 代码：`apps/kernel/src/telemetry_events.rs`

## 1. 端点

```
POST /api/v1/telemetry/events
Authorization: Bearer <owa1 token>
Idempotency-Key: sha256:<64 hex>
```

- 只接受 `owa1`，且 principal 必须含 `EVENT_INGEST`；每次新 Event 消耗一次该操作。
- `workspaceId/sourceId` 必须与 principal 一致，否则 403 `EVENT_SOURCE_FORBIDDEN`；workspace 仍以 principal/registry 为准。
- `payloadDigest` 由 Kernel 对规范化 payload 重新计算；不一致 422 `EVENT_DIGEST_MISMATCH`。
- 响应 202（新建）/200（幂等重试），`{eventId, incidentId, deduplicated}`。

## 2. 幂等与去重

- `Idempotency-Key` 必须等于 `sha256(workspaceId|sourceId|nativeId|triggerState|occurredAt)`；不匹配 409 `EVENT_IDEMPOTENCY_CONFLICT`。
- Event 表唯一键 `(workspace_id, source_id, idempotency_key)`；冲突时返回已有 event/incident。
- 同一 `nativeId` 的 `PROBLEM`：若存在 `OPEN/INVESTIGATING/CONCLUDED` Incident，复用；否则新建 `OPEN` Incident（`source=ZABBIX`、`origin=AUTOMATION`、owner 为不可登录服务用户）。
- `RESOLVED` 只记录 Event，不创建/关闭 Incident。
- 已 `CLOSED` 的同一 `nativeId` 收到新 `PROBLEM`：新建 Incident，`recurrence_of` 指向最近一次 CLOSED；旧单不重开。
- 并发由数据库部分唯一索引裁决：`(workspace,source,native)` 仅约束 `OPEN/INVESTIGATING/CONCLUDED`（0028）。Event 插入 `ON CONFLICT DO NOTHING`，失败者读取赢家结果。
- 乱序：`late=true`，不改变 Incident 状态。

## 3. 审计

每条 Event 在**同一事务**写 `kernel.audit_events`：

```
actor_type=AUTOMATION, actor_id=principalId
subject_type=TELEMETRY_EVENT, subject_id=eventId
action=EVENT_INGEST, result=ACCEPTED
details={sourceId,nativeId,triggerState,deduplicated:false,late,incidentId}
```

## 4. 服务用户

`0028` 插入固定 UUID 的 `opsweave-automation` 用户（role viewer、密码哈希不可用），仅用于满足 `incidents.owner` 外键；不用于登录，也不写 Human Verdict。

## 5. 本切片没有做什么

- 不自动 collect、不生成 Evidence；`SEVERITY=INFO` 映射为 Incident 的 `WARNING`。
- 不提供 UI 时间线（切片 5）。
- 没有把 Event payload 当作 Evidence；Evidence 仍必须由 v2 attestation + 内容摘要产生。

## 6. 验证

- `telemetry_events::`：3/3（幂等键稳定性、摘要不匹配拒绝、重复 Event 只建 1 个 Incident 且 RESOLVED 不建单，含真实 PostgreSQL）。
- 完整 Kernel 套件 **217/217**；clippy `-D warnings` 通过。

## 7. 下一步（切片 4）

- Automation 身份进入插件 collect/attestation（当前插件仍要求 user identity）；
- PROBLEM Event → 有界 collect → v2 attestation → Evidence；
- 预算扣减与失败语义。
