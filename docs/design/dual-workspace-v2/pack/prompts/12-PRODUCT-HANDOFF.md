# G11 / P0（0.1.0 新里程碑）— Business Workspace 第一条 Incident → Evidence → Verdict 真正业务纵切

这一步只有在 AdminShell + Dual Surface + 基础权限/插件路线具有可复核证据后启动，或以独立 Draft PR 开始设计但不影响 UI 门禁。读取 `reference/OpsWeave-0.1.0-Design-Full.md` 第 00/03/04/05/08/09 章、`reference/OpsWeave-0.1.0-Collection-Design-Full.md`、`docs/12-business-first-vertical-slice.md` 与仓库 `docs/roadmap/0.1.0-*`。

## 产品目标

让一个被授权的值班工程师**不进入 `/admin`**，从真实或清楚标注的独立 Demo Incident 出发，获得来源可追溯的 Evidence，查看一条可证伪的 Hypothesis，最后写下人工 Verdict。不得把固定静态卡片当真正调查功能，更不能把 LLM 正常输出误报为 RCA 正确。

## 第一步（架构 Gate）

先审查当前 Rust Kernel、Data Catalog、Gateway 能否承载 Incident 状态，确定**一个** Incident/Evidence 事实权威（不要把旧 Java Platform API 草案和 Rust Kernel 并行实现两个控制面）。给出数据模型、Auth 资源范围、期限/预算、只读 Query Tool、事件/证据 provenance、API 版本化合同与迁移路径。

## 第二步（可运行 Slice）

- Incident List 和详情：一个真实告警或显式 DEMO Fixture 的证据，状态/来源/严重度/时间窗清楚。
- Evidence Panel：一个授权数据来源，状态可区分 AVAILABLE/NO_DATA/PARTIAL/STALE/UNAVAILABLE/FORBIDDEN；时间与 source-native ID 可追溯。
- Deterministic Hypothesis：有支持和反证引用、未知项；先规则后 AI，多步 Agent 后续独立里程碑。
- Human Verdict：保存操作者、时间、确认/否定、证据引用和审计。
- Golden Replay：最小可复现故障用例，能够证明数据和证据不是编造。

## 第三步（前端验收）

从 Business Workspace 登录、筛选故障、点击 Incident、打开 Evidence、保存 Verdict；1440/1024/390、Light/Dark、zh/en、Loading/Partial/Forbidden、资源跳转、键盘导航，给真实 Playwright Trace 与截图。

## 不做

不先造多租户 SaaS、全量通用 DAG、第二个插件框架、第二套数据库、任意 SQL/shell 工具、自动生产修复、无预算的 AI Agent 或假人工审核。

## 交付

独立 `feat/0.1.0-incident-first-slice` Draft PR（或根据真实 Git Base 调整），领域 ADR/Contract/代码、真实 Demo 数据说明、Git SHA、CI、Staging、E2E、未完项。只有真正完成一条端到端用户路径才可 `INCIDENT_FIRST_SLICE_READY_FOR_REVIEW`；否则 PARTIAL/BLOCKED。
