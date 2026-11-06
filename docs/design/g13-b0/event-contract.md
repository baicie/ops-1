# G13-B0 Event Contract（冻结）

- 状态：Frozen for G13-B1（2026-11-06）
- 契约：`contracts/openapi/telemetry-event-v1.yaml`、`contracts/schema/telemetry-event.v1.schema.json`
- 决策：[ADR-018](../../adr/ADR-018-automation-principal.md)、[ADR-019](../../adr/ADR-019-event-identity-and-dedup.md)

## 1. 端点

```
POST /api/v1/telemetry/events
Authorization: OpsWeave-Automation owa1.<payload>.<sig>
Content-Type: application/json
Idempotency-Key: <idempotencyKey>     # 必须与 body 一致
```

响应：

| 状态 | 语义 |
|---|---|
| 202 | 新 Event 已记录；body `{eventId, incidentId, deduplicated:false}` |
| 200 | 幂等重试；body `{eventId, incidentId, deduplicated:true}` |
| 401 | `EVENT_SIGNATURE_INVALID` / `AUTOMATION_PRINCIPAL_EXPIRED` |
| 403 | `EVENT_SOURCE_FORBIDDEN` / `EVENT_WORKSPACE_MISMATCH` |
| 409 | `AUTOMATION_REPLAY`（jti 已用）/ `EVENT_IDEMPOTENCY_CONFLICT`（同 key 不同摘要） |
| 422 | `EVENT_PAYLOAD_INVALID`（字段/枚举/长度/时间） |
| 429 | `AUTOMATION_BUDGET_EXHAUSTED` |
| 503 | `EVENT_STORE_UNAVAILABLE`（不落半条记录） |

Event ingest 不解析凭据、不出站；不调用 collect。它只做身份、幂等、去重和审计。

## 2. 请求体

```json
{
  "nativeId": "123456",
  "sourceId": "2f1c...",
  "workspaceId": "6a0e...",
  "occurredAt": "2026-11-06T08:00:00Z",
  "observedAt": "2026-11-06T08:00:03Z",
  "severity": "MAJOR",
  "triggerState": "PROBLEM",
  "payloadDigest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "payload": { "host": "web-1", "trigger": "CPU high" }
}
```

- `workspaceId` 必填但只用于一致性校验；权威值来自 Kernel source 注册表。不匹配返回 403，不写任何行。
- `payloadDigest` 由插件对规范化 `payload` 计算：UTF-8、键按字典序、无空白、数字用 JSON 规范形式、时间已字符串化。Kernel 重新计算并比较；不一致 422 `EVENT_DIGEST_MISMATCH`。
- `payload` 仅用于摘要与受限展示，不写 Evidence，不进入 Investigator 的 evidence set。大小上限 64 KiB；超过 413 `EVENT_PAYLOAD_TOO_LARGE`。

## 3. 幂等与去重

- `idempotencyKey = sha256(workspaceId | sourceId | nativeId | triggerState | occurredAt)`；请求头必须与 body 重算结果一致，否则 409。
- Event 表唯一键 `(workspace_id, source_id, idempotency_key)`；重复提交返回第一次的 `eventId/incidentId`。
- Incident 去重键见 ADR-019 §3；Event 去重与 Incident 去重是两层：同一 Trigger 的多次不同 `occurredAt` Event 可以存在，但 Incident 仍只有一个。
- 并发：`INSERT ... ON CONFLICT DO NOTHING RETURNING`；无返回时按同键查询；禁止 read-then-insert。

## 4. 状态与时间

- `PROBLEM` → 若 `(workspace,source,native)` 无 Incident，创建 `OPEN`；已有则追加 Event 到时间线。
- `RESOLVED` → 只记录事件与最新状态；不关闭 Incident、不写 Verdict。
- 乱序：`occurred_at < latest.occurred_at` 时 `late=true`，不改变 latest 状态、不触发 collect；仍可被时间线读取。
- `RESOLVED` 之后的新 `PROBLEM`：若原 Incident 未关闭，追加；若已 CONCLUDED/CLOSED，新建 Incident 并写 `recurrence_of`，不重开旧单。
- 时间偏差：`occurredAt` 早于 90 天或晚于 `observedAt + 5min` → 422 `EVENT_TIME_INVALID`。

## 5. 身份

- 仅接受 `owa1` Automation Principal（ADR-018）；`owu1`/`oww1` 一律 401 `EVENT_PRINCIPAL_KIND_UNSUPPORTED`。
- principal 的 `sourceId`、`workspaceId`、`pluginId` 必须与 body/注册表一致；`allowedOps` 必须含 `EVENT_INGEST`。
- 每次 ingest 消耗预算 `collections=0, events=1`；`jti` 单次使用。

## 6. 审计

每次 ingest 写一条 `kernel.audit_events`：

```
actor_type=AUTOMATION, actor_id=principalId
subject_type=TELEMETRY_EVENT, subject_id=eventId
action=EVENT_INGEST, result=ACCEPTED|REJECTED
details={sourceId,nativeId,triggerState,deduplicated,incidentId,late}
```

被拒绝的请求也写审计（`result=REJECTED`），但不写 Event/Incident。

## 7. 兼容与回滚

- 旧客户端没有 automation token，端点默认关闭（Kernel 配置 `automation_enabled=false`）；不影响现有用户路径。
- 回滚只关闭端点；已落库的 Event/Incident 保留，UI 以只读时间线展示。
- 不改变 v1 Attestation 写入策略；Event 永远不能直接生成 `SOURCE_ATTESTED` Evidence。
