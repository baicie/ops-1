# G13-B1 实施切片与开发顺序（冻结）

- 状态：Frozen for G13-B1
- 前置门禁：A.3 的 `CREDENTIAL_ENDPOINT_BOUNDARY`、`WORKSPACE_ATTESTATION_V2`、`SOURCE_EVIDENCE_INTEGRITY` 保持 PASS；`REAL_ZABBIX_VERIFIED` 仍 NOT_RUN 时不得宣称生产就绪
- 原则：先契约/迁移，再服务端身份，再到 Event/Incident，最后 UI；每片独立可回滚

## 切片 0 — 契约与迁移（不启用）

1. `telemetry-event.v1` schema/OpenAPI 合入（本 B0 已冻结）。
2. 迁移：`incidents.source_id`、`origin`、`recurrence_of`；`audit_events.actor_type` 增加 `AUTOMATION`；`automation_principals`、`telemetry_events` 表；部分唯一索引。
3. 迁移测试：历史行不变、并发唯一、回滚脚本 dry-run。
- 退出：迁移在含历史数据（G11/G12）的隔离库通过；旧 API 全绿。

## 切片 1 — Kernel source 注册表

1. 注册表记录 `sourceId + workspaceId + pluginId + endpointDigest + state`，来源为部署配置/受控 API，不接受插件自报。
2. 与 A.2 binding 的一致性校验：注册表的 endpoint/TLS 必须与 binding 匹配，否则拒绝 READY。
3. 测试：跨 Workspace、未注册、binding 收紧后 source 失效。
- 退出：`AUTOMATION_SOURCE_NOT_REGISTERED` 路径可审计；无注册表时 automation 端点 404/关闭。

## 切片 2 — Automation Principal 签发/验证

1. `/internal/v1/automation/principals`：实例身份 + live generation + source 注册表 + 预算。
2. extractor `AutomationPrincipal`；jti 单次、过期、撤销、节点换代。
3. 审计 actor `AUTOMATION`。
- 退出：A1–A10 全过；伪造 `workspaceId/role` 无路径。

## 切片 3 — Event ingest 与 Incident 去重

1. `POST /api/v1/telemetry/events`：签名、幂等键、摘要、乱序、RESOLVED。
2. `INSERT ... ON CONFLICT` 创建 Incident；`origin=AUTOMATION`；服务用户 owner。
3. 测试：E1–E10，含 32 并发。
- 退出：同键只 1 个 Incident；跨 Workspace 同 nativeId 互不影响；历史行不合并。

## 切片 4 — 自动采集与 Evidence

1. PROBLEM Event → 有界 collect（复用 A.2 binding、SSRF、预算）→ v2 attestation → append evidence。
2. 失败语义：超时/失联/预算耗尽不产生部分 Evidence；旧凭据不静默成功。
3. 测试：C1–C9 + 真实 Gateway/Node/OCI 栈。
- 退出：E2E 黄金路径（TEST_FIXTURE）通过；攻击矩阵保持 0 泄漏。

## 切片 5 — Investigator 与人工 Verdict

1. Automation 只能启动 investigation（假设），不能写 verdict/close。
2. UI 时间线：Event → Evidence → Hypothesis → Human Verdict；Automation 徽标。
3. 测试：U1–U3；1440/1024/390 + en/zh-CN。
- 退出：人工 CONFIRMED 与 Automation 假设在 UI/DB 分离；无自动关闭路径。

## 交付与门禁

- 每片一个 Draft PR，基于前一片；不合并 main，不 tag/release/deploy。
- CI 之外必须有真实栈证据；fixture 通过不等于真实 Zabbix。
- 生产启用前仍需：真实 Zabbix 验证（`REAL_ZABBIX_VERIFIED=PASS`）或明确的生产限制；独立 Secret Store 或等价轮换方案（`PRODUCTION_SECRET_READY` 从 PARTIAL 提升）。
- 任一切片出现 P0/P1 未关闭 → 停止后续切片。
