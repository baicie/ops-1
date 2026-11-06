# ADR-019: Event identity, dedup key and legacy incident migration

- 状态：Proposed（G13-B0 contract freeze；迁移在 G13-B1 执行）
- 日期：2026-11-06
- 基线：`kernel.incidents`（0016）、`kernel.business_workspaces`（0022）、G13-A source/evidence
- 前置：[ADR-018](ADR-018-automation-principal.md)、[ADR-015](ADR-015-evidence-attestation-and-telemetry-sources.md)、[ADR-017](ADR-017-credential-endpoint-binding.md)
- 相关契约：`contracts/openapi/telemetry-event-v1.yaml`、`contracts/schema/telemetry-event.v1.schema.json`

## 1. 背景

当前 Incident 的自然键是 `(source, native_id)`，其中 `source` 只有 `MANUAL`/`API`，唯一索引是**全局**的：

```sql
CREATE UNIQUE INDEX incidents_source_native_idx
  ON kernel.incidents (source, native_id) WHERE native_id IS NOT NULL;
```

这带来两个问题：

1. 同一 Zabbix nativeId 在两个 Workspace 会互相冲突，跨 Workspace 隔离无法成立；
2. `source` 是“来源类别”，不是具体的 telemetry source；无法表达 `sourceId`，也无法把自动化 Event 归因到某个 source。

G13-B0 要求的去重键是 `workspaceId + sourceId + nativeId`。直接改唯一索引会破坏历史数据（历史行没有 `source_id`，且可能存在跨 Workspace 的同名 nativeId），因此必须采用**部分索引 + 不回填**的迁移。

## 2. Event 契约

规范化 Event（`telemetry-event.v1`，见契约文件）：

| 字段 | 语义 |
|---|---|
| `eventId` | Kernel 生成的 UUID；客户端重试提交同一 `idempotencyKey` 返回同一 `eventId` |
| `nativeId` | 上游 Trigger/Event 的稳定标识（Zabbix eventid），长度 1–200 |
| `sourceId` | Kernel 注册的 telemetry source UUID（ADR-018 §2.1） |
| `workspaceId` | **权威值来自 Kernel 注册表**，请求体中的值只用于一致性校验；不一致 403 `EVENT_WORKSPACE_MISMATCH` |
| `occurredAt` / `observedAt` | UTC ISO 8601；`occurredAt` 允许乱序与延迟，`observedAt` 是 Kernel 接收时间 |
| `severity` | `CRITICAL/MAJOR/MINOR/WARNING/INFO`，映射到 Incident 的闭集 |
| `triggerState` | `PROBLEM` / `RESOLVED` |
| `payloadDigest` | `sha256:` + 64 hex，对规范化 JSON 字节的摘要；不是 payload 本身 |
| `idempotencyKey` | `sha256(workspaceId \| sourceId \| nativeId \| triggerState \| occurredAt)`，客户端可重算 |

`payloadDigest` 只证明“收到过这些字节”，**不**把 Event payload 当作 Evidence。Evidence 仍必须由 collect → attestation v2 → Kernel 内容摘要校验产生（见 lifecycle 文档）。

### 2.1 重复、恢复、乱序、延迟、无效签名

| 情况 | 行为 |
|---|---|
| 同一 `idempotencyKey` 重试 | 200/202，返回原 `eventId` 与 `incidentId`；不新建、不追加 |
| 同 `nativeId` 的 `PROBLEM` 多次（不同 occurredAt） | 每次记 Event（不同 idempotencyKey），Incident 仍只有一个（键见 §3） |
| `RESOLVED` | 记录 Event，标记该 `(sourceId,nativeId)` 的最新状态；**不关闭 Incident**，只作为时间线事实 |
| `RESOLVED` 后新的 `PROBLEM` | 记录新 Event；若原 Incident 仍 OPEN/INVESTIGATING，追加事件；若已 CONCLUDED/CLOSED，**不重开**，新建 Incident 并把旧 Incident 链接为 `recurrenceOf` |
| 乱序（旧 occurredAt 晚到） | Event 照常落库并标记 `late=true`；不覆盖已记录的较新状态，不触发新的 collect |
| 无效签名/过期 principal | 401 `EVENT_SIGNATURE_INVALID` / `AUTOMATION_PRINCIPAL_EXPIRED`，审计 REJECTED，不落 Event/Incident |
| 未知 source / 跨 Workspace | 403 `EVENT_SOURCE_FORBIDDEN`，审计 REJECTED |

## 3. 去重键与并发

目标键：`workspaceId + sourceId + nativeId`。

迁移（B1）：

```sql
ALTER TABLE kernel.incidents ADD COLUMN IF NOT EXISTS source_id uuid;
ALTER TABLE kernel.incidents ADD COLUMN IF NOT EXISTS origin text
  CHECK (origin IS NULL OR origin IN ('USER','AUTOMATION'));
-- 旧行保持 source_id IS NULL；不回填、不合并、不改写 native_id。
CREATE UNIQUE INDEX IF NOT EXISTS incidents_workspace_source_native_idx
  ON kernel.incidents (workspace_id, source_id, native_id)
  WHERE source_id IS NOT NULL AND native_id IS NOT NULL;
```

- **历史行**：`source_id IS NULL`，继续受旧索引保护；迁移不删除旧索引，避免历史行失去唯一性。查询层把 `source_id IS NULL` 解释为 legacy。
- **新行**：必须写 `source_id`；`source` 扩展为 `MANUAL/API/ZABBIX`（B1 迁移），`native_id` 继续非空。
- **并发**：`INSERT ... ON CONFLICT (workspace_id, source_id, native_id) WHERE source_id IS NOT NULL DO NOTHING RETURNING incident_id`；无返回时按同键 SELECT 现有行。数据库唯一索引是最终裁决，不是 read-then-insert。
- **幂等重试**：Event 表对 `idempotencyKey` 建唯一索引；第二次提交返回第一次的 `eventId/incidentId`，不产生第二条 Incident。
- **历史不被静默合并**：迁移只加列/索引；如发现旧数据在同一 `(source,native_id)` 下有跨 Workspace 冲突，迁移**失败并列出冲突行**，由人工决定，不自动改写。

回滚：删除新索引与新列即可回到旧键；已写入的新行在回滚后仍是合法 Incident（`source_id` 列被删则只能按旧键解释）。回滚脚本必须在维护窗口执行，并先导出 `workspace_id/source_id/native_id` 映射。

## 4. 状态机兼容

现有状态机不变：`OPEN → INVESTIGATING → CONCLUDED → CLOSED`。

- Automation 创建 Incident 时为 `OPEN`，owner 为不可登录的 `opsweave-automation` 服务用户，`origin=AUTOMATION`；审计 actor 为 Automation Principal（ADR-018 §2.4）。
- 第一条 Evidence 仍触发 `OPEN → INVESTIGATING`；Automation 不能直接写 `INVESTIGATING`。
- Human Verdict 是进入 `CONCLUDED` 的唯一路径；Close 仍要求 `CONCLUDED` 且现有生命周期门禁。
- **不引入 `AWAITING_VERDICT`**：它与 `CONCLUDED` 表达同一事实（人工结论已写入、等待关闭），并存会产生两个“待关闭”状态、破坏现有查询与 UI 语义。若未来确需区分“等待 AI 调查”和“等待人工裁决”，应新增独立字段（如 `investigation_state`），而不是复制生命周期状态。
- AI Investigator 只产生 `investigation_hypotheses`；不写 `incidents.status`、不写 Verdict、不 Close。

详见 `docs/design/g13-b0/lifecycle-compatibility.md`。

## 5. 验收

- 同键并发 32 次只产生 1 个 Incident；重试返回同一 id。
- 两个 Workspace 使用相同 `nativeId` 各自创建成功（`source_id` 不同）。
- 历史行迁移后仍可读、可关闭，不被合并；冲突时迁移失败并列出。
- 乱序/延迟/恢复事件不改变人工生命周期，不重开 CLOSED。
- 无效签名、跨 Workspace、过期 principal 全部拒绝并留审计。
- Event payload 不进入 Evidence；Evidence 仍由 v2 attestation + 内容摘要决定。
