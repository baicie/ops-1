# G13-B0 Incident Lifecycle Compatibility（冻结）

- 状态：Frozen for G13-B1
- 基线：`kernel.incidents`（0016/0019/0022/0024/0025）、`apps/kernel/src/incidents.rs`、G12 lifecycle ADR
- 决策：[ADR-019](../../adr/ADR-019-event-identity-and-dedup.md) §4

## 1. 现有状态机（不得替换）

```
OPEN --(first evidence)--> INVESTIGATING --(Human Verdict)--> CONCLUDED --(Close)--> CLOSED
```

不可变规则（来自现有实现与迁移，B0 全部保留）：

- `CLOSED` 只能从 `CONCLUDED` 进入；`CONCLUDED` 只能由写入 Human Verdict 产生。
- Verdict 写入一次，后写拒绝；进入 `CONCLUDED` 时冻结其考虑过的 Evidence 集合。
- Close 需要 `CONCLUDED` + verdict + 现有生命周期门禁；没有从 `OPEN` 直接关闭的路径。
- 已 `CLOSED` 的 Incident 不接受新 Evidence、不重开。

## 2. 为什么不引入 `AWAITING_VERDICT`

`CONCLUDED` 已经表示“人工结论已写入、等待关闭”。再加 `AWAITING_VERDICT` 会造成：

1. 两个“等待人工/等待关闭”状态，查询、筛选、KPI 与 UI 必须同时处理，容易出现一处认 CONCLUDED、另一处认 AWAITING_VERDICT；
2. 现有 `incident_verdicts` 写入即转 CONCLUDED，新增状态需要把“verdict 已写”和“状态已改”拆成两步，破坏 write-once 事务；
3. Close 的门禁从 `status='CONCLUDED'` 变成两个合法前置，扩大绕过面。

若未来需要表达“AI 调查中/等待人工”，使用独立字段 `investigation_state`（由 investigation run 维护），**不**复制生命周期状态。B1 不实现该字段；显示上沿用现有 `INVESTIGATING` + investigation run 状态。

## 3. Automation 的动作映射

| 动作 | 允许的主体 | 结果状态 | 备注 |
|---|---|---|---|
| Event ingest | Automation | 无（仅事件） | 不创建 Incident，直到 `PROBLEM` |
| 创建 Incident | Automation（由 PROBLEM Event） | `OPEN` | `origin=AUTOMATION`，owner 为不可登录服务用户 |
| 追加 Evidence | Automation（本 source 的 Incident） | `OPEN → INVESTIGATING`（首条） | 必须带 v2 attestation + content；payload 不算 Evidence |
| 启动 Investigation | User 或 Automation（受预算） | 不变 | 只写 hypotheses；不能写 verdict |
| Human Verdict | **仅 User** | `CONCLUDED` | Automation 403 `AUTOMATION_VERDICT_FORBIDDEN` |
| Close | **仅 User** | `CLOSED` | Automation 403 `AUTOMATION_CLOSE_FORBIDDEN` |
| 重开 | 任何人 | 不允许 | 新 Incident + `recurrence_of` |
| 改 owner | User（现有规则） | 不变 | Automation 不可改 |

## 4. 事件与生命周期的交互

- `RESOLVED` 不改变 Incident 状态；它是时间线事实，等待人工 Verdict/Close。
- 乱序/延迟 Event 不触发状态迁移；`late=true` 只影响展示与排序。
- 已 `CONCLUDED/CLOSED` 的 Incident 收到新 `PROBLEM`：不重开，新建 Incident 并写 `recurrence_of`；旧单保留冻结的 Evidence 集。
- Automation 的 Evidence 追加遵循同一规则：CLOSED 拒绝（`INCIDENT_CLOSED`），CONCLUDED 也拒绝新增 Evidence（现有冻结语义在 B1 复核并保持）。

## 5. UI 兼容

- Incident 列表/详情继续使用 `OPEN/INVESTIGATING/CONCLUDED/CLOSED`；不新增标签。
- Automation 创建的 Incident 显示 `origin=AUTOMATION`（“Automation”徽标），与 “AI hypothesis” 徽标分开；人工 Verdict 仍显示 `decided_by` 用户。
- Event 时间线是只读事实列表；`late`/`deduplicated` 用中性文案，不改变状态色。
- 390/1024/1440 与 en/zh-CN 的文案走现有 i18n；错误按稳定码映射。

## 6. 迁移兼容

- 新列（`source_id`、`origin`、`recurrence_of`）可空，历史行不受影响。
- 旧 API 创建 Incident（`source=MANUAL/API`，`source_id=NULL`）保持可用；它们继续受旧 `(source,native_id)` 唯一索引约束。
- 新 Automation 路径必须写 `source_id`；没有 `source_id` 的请求返回 422 `INCIDENT_SOURCE_ID_REQUIRED`（仅新路径）。
- 回滚：关闭 Automation 端点即可；状态机与历史行不变。
