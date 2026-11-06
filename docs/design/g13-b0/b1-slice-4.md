# G13-B1 切片 4–5 实施记录（自动采集 → Evidence → 现有 UI）

- 状态：PROBLEM Event 自动 collect → attestation → Evidence 已实现；UI 复用现有 Incident 时间线/Evidence/Investigator/Verdict
- 日期：2026-11-06
- 决策：[ADR-018](../../adr/ADR-018-automation-principal.md)、[ADR-019](../../adr/ADR-019-event-identity-and-dedup.md)
- 代码：`apps/kernel/src/automation_flow.rs`、`telemetry_events.rs`、`incidents.rs`、`plugins/zabbix-source/backend/{identity,server}.mjs`

## 1. 插件接受 Automation 身份

- `owa1` 与 `oww1`/`owu1` 使用同一把 per-plugin key（`OPSWEAVE_CALLER_CONTEXT_KEY`），因此不新增 Secret 交付；Kernel 仍是唯一签发者。
- identity 解析 `x-opsweave-automation-context`：校验签名、`pluginId`、`kind=automation`、过期时间；返回 `{kind:'automation', principalId, workspaceId, sourceId, ops}`。
- collect 与 attestation 的 actor 从“必须是 user”改为 `requireSourceActor`：
  - user：原有 workspace 校验；
  - automation：`workspaceId/sourceId` 必须与 source/collection 行一致，且 `ops` 含 `SOURCE_COLLECT` / `EVIDENCE_APPEND`；
  - workload 仍拒绝（没有可归因 principal）。
- 其他写操作（创建/更新/probe/hosts/items）仍只接受 user。

## 2. Kernel 编排

PROBLEM Event 落库并提交后：

1. 扣减 principal 的 `collections` 预算（0 → 429 `AUTOMATION_BUDGET_EXHAUSTED`）；
2. 找到 principal 的 live instance，经 Node data proxy 调用插件 `sources/{id}/collect`（body `{}`，由插件自己的 A.2 binding/SSRF/预算约束）；
3. outcome 是 `UNAVAILABLE/UNKNOWN/TIMEOUT` 时拒绝（`AUTOMATION_COLLECTION_NOT_ATTESTABLE`）；
4. 调用 `collections/{id}/attestation`，拿回插件签名好的 evidence body；
5. 校验 evidence 字节不超过 principal 的 `evidenceBytes` 预算；
6. 交给 `incidents::append_automation_evidence`：同一份内容摘要/attestation 校验、同一份写库逻辑，审计 actor 为 `AUTOMATION`；只允许 `OPEN/INVESTIGATING`。

失败不产生半条 Evidence：Event 已接受，失败写入 `telemetry.automation.collection_failed` 审计，并在响应 `automation` 字段返回稳定错误码；不返回上游 body。

## 3. 响应与 UI

Event 响应新增可选：

```json
{"automation": {"status": "COLLECTED", "collectionId": "...", "evidenceId": "...", "code": null}}
```

或 `{"status":"FAILED","code":"..."}`。契约已更新。

UI 不新增专用页面：Automation Event 在同一事务写入 Incident 的 audit timeline（`INCIDENT_AUTOMATION_EVENT`），Evidence 以现有 `SOURCE_ATTESTED` 行显示；现有 Incident 详情/Investigator/Human Verdict 流程原样适用。未新增 “Automation” 徽标或 390 专用截图；这是与 `g13-b1-slices.md` 描述的差异，记录为残留。

## 4. 失败语义

| 条件 | 结果 |
|---|---|
| 预算耗尽 | 429，无 Evidence |
| 插件/Node 不可用 | Event 已接受，`automation.status=FAILED`，审计 REJECTED |
| A.2 binding 不匹配 | 插件 422，Kernel 映射 `ZBX_CREDENTIAL_ENDPOINT_MISMATCH`，无 Evidence |
| 采集结果非测量 | 409，无 Evidence |
| incident 已 CONCLUDED/CLOSED | 409，无 Evidence |
| 证据超过字节预算 | 413，无 Evidence |

## 5. 验证

- 插件 socket **60/60**（新增 automation collect/attest 成功、错误 source 403、缺少 EVIDENCE_APPEND 403）。
- Kernel **217/217**（真实 PostgreSQL），clippy `-D warnings` 通过。
- 契约校验 17 schemas 通过。
- 未新增 Rust 侧“真实插件 HTTP 上游”的 orchestration 测试；该路径由 `g13a1-gateway` CI 的插件/Node/Kernel 组合环境覆盖（fixture，不是真实 Zabbix）。

## 6. 残留

- 真实 Zabbix 仍 `NOT_RUN`；fixture 不代表真实响应形状。
- Event 重试不会重新触发采集（返回已有 event/incident），失败后需要运营者手动触发或新的 Event。
- Node/插件必须在 10s 请求预算内完成 collect+attest；大窗口采集可能超时并记录 FAILED。
- 没有 Automation 专用 UI 徽标/截图。
