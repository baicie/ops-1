# 12 · UI Gate 完成后的第一条真正业务纵切

## 12.1 为什么要单独设计

平台现有多个管理页并不意味着 Business Workspace 有了业务功能。最初 0.1.0 设计的核心产品是从故障到证据、假设和人工结论。双 Shell 建成后要尽快交付能操作的业务闭环，避免继续永久美化平台维护页。

## 12.2 最小 Golden Slice（以实现前实际数据为准）

```text
1. Incident 从真实授权来源或显式 Demo Fixture 创建
  → 2. 关联一条可追溯的 Host/Service
  → 3. 点击 Incident 查看时间线
  → 4. 只读 Query Gateway 取一个来源、一个时间窗 Evidence
  → 5. Evidence 保存 provenance、status 与 source-native ID
  → 6. 给出一条可证伪 Hypothesis/Verification（先确定性 Rule）
  → 7. 人工确认/拒绝、产生可审计 Verdict
  → 8. 页面可回放并追溯
```

不必先接全量 Zabbix+Nebula+Trace+Log，不必先做复杂 AI Agent。先跑通真实一条数据；缺失状态要体现，不可伪造 Trace/Log 或 AI 推理成功。

## 12.3 Business Workspace 首版 IA

- `Incidents`: 状态、严重程度、影响服务、时间、调查状态/证据覆盖。
- `Incident Detail`: 固定时间窗、时间线、Evidence List、来源状态。
- `Investigation`: 结构化假设、Tool Query Steps（真正有工具时才显示）、反证/未知；AI Run 严格受预算与权限。
- `Verdict`: 人工结果、操作者、日期、报告链接。
- `Observability`、`Resources`: 在相应真实 adapter 到位前仅作为受控功能入口，不制造空白大导航。

## 12.4 前后端权威

- 当前 Rust Kernel 与 Gateway 是既有实现；是否将 Incident Authority 置于 Kernel 或领域插件必须先 ADR，**只能有一个业务事实权威**，不能为页面原型临时在浏览器/localStorage 建主数据库。
- Evidence 至少包括 `evidenceId`, `incidentId`, `source`, `sourceNativeIdentity`, `timeRange`, `observedAt`, `status`, `provenance`, `digest`（具体 contract 由实现论证），按权限读取。
- Query Tool 有界、可授权、只读；不给模型任意 SQL/HTTP/shell。
- 人工 Verdict 与 AI Report、Incident Closed 三者独立。

## 12.5 Gate

针对一份已知 Ground Truth 的真实/标注 Demo 故障，业务人员不进入 `/admin`，在 `/app` 能完整展示起点与结果；对缺数据/权限/失败的表述准确、所有引用可追踪、有 Playwright 和 API 回放证据。未有此证据时只能说 `BUSINESS_SHELL_READY`，不能说 `INVESTIGATION_PRODUCT_READY`。
