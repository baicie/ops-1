# 01 · 设计基线与原始愿景对齐

## 1.1 原始设计的真实内容

最初文档（2026-10-15）定位 OpsWeave 为 **Incident-centric AI Investigation**，Golden Path：真实 Zabbix 告警/APM Trace/日志 → Host/Service 身份关联 → Incident 时间窗 → 有界只读查询 → Evidence → Hypothesis/Verification → RCA 报告 → Human Verdict → Golden Replay。

第 08 章的 Web Console V2 已经提出以 Incident 为默认用户入口，导航：概览、故障调查、可观测、资源与拓扑、数据接入、设置；明确不把 Workflow、Job 等底层原语堆进业务用户一级导航。

2026-10-16 采集设计补充了 Zabbix、OTLP/APM、Logs、Entity mapping 的数据平面与业务控制面边界。两份原文存于 `reference/`；它们是历史提案，不等于今天的代码。

## 1.2 设计演进：不是简单旧页面美化

本包新增区分：

| 维度 | 原始 0.1.0 设计 | 现行方案 v2 |
|---|---|---|
| 用户工作区 | Web Console V2 聚焦 Incident | **Business Workspace** 独立 Shell、完整 Incident 体验 |
| 维护入口 | 管理员管理接入/映射等 | **Platform Console** 独立 Shell，管理平台与插件生命周期 |
| 身份 | 平台权威会话/RBAC | **单一登录与会话；后台授权按 Surface + Operation 校验** |
| 技术 | 当时假设 Java Platform API + Rust Agent | 以**当前已实现 Rust Kernel/Gateway** 为现有事实；后续 0.1.0 领域权威通过 ADR 明确，不提前造第二套 |
| 插件 UI | 旧版导航贡献 | 面向 `admin` / `workspace` 双 Surface 版本化贡献；保留原签名兼容 |
| UI | 新应用 `web-next` 是候选 | 优先在现有 `apps/platform-web` 分出双 Shell；大规模独立发布需求出现后再考虑双应用 |

## 1.3 代码基线（GitHub 已查，截至 2026-10-28）

- 当前 `main` 已到 0.0.4；PR #9 `feat/0.0.5-governance-foundation`（Draft），PR #10 `feat/0.0.5-final-reliability-hardening`（Draft），PR #11 `feat/0.0.5-staging-preview`（Draft、stacked on #10）。
- 审查时 PR #11 HEAD `8b6a32ae47206f47e55c090d19c0fedd2e9ed33c`；此值只是**启动点**，不能固定为执行事实。
- `apps/platform-web/src/App.tsx`：单 `RequireAuth → Layout`，尚未实现 `/app/*` 与 `/admin/*` 的独立 Shell。
- `apps/platform-web/src/components/Layout.tsx`：统一导航（Overview/Plugins/Pipelines/Jobs/Nodes/Governance/Activity/Access/Settings/Ops Center）。
- `apps/platform-web/src/extensions.tsx`：单路由 `/ext/*` 和全局导航贡献，未区分 Surface；存在 `SHELL_RESERVED` 保护，但需要扩展以防新保留路径冲突。
- `apps/platform-web/src/i18n`：已支持 `en` / `zh-CN`；当前默认中文，真实执行前再次核对。
- `apps/platform-web/src/components/ui/`：已有 shadcn/Radix copy-in，多个页面已经迁移；不得重复开发现成 Button/Card/Dialog 等。
- `apps/kernel/src/auth.rs` 当前是 admin/operator/viewer Role，Session、CSRF、RequireAuth 等沿用；**没有现成的多业务 Workspace 授权模型**。
- `.github/workflows/staging-preview.yml` 与 `scripts/deploy-staging.sh` 已有 SHA-pinned Staging 发布方案，但需要根据当前代码/CI 事实验收，不能当作全部产品链路通过。

## 1.4 优先审查表（不是让代理重新实现）

执行时逐项标记 `EXISTS / PARTIAL / MISSING / BLOCKED`：

| 项 | 路径/证据 | 预期处理 |
|---|---|---|
| 基础 shadcn 组件 | `components/ui/*` | 复用；只修确切缺陷 |
| i18n | `src/i18n/*`、`check-i18n.mjs` | 复用与扩展 |
| Theme | `--ow-*`、`styles.css`、`tailwind.config.cjs` | 统一 token，禁止第二套 |
| 现有 Shell | `src/components/Layout.tsx` | 按阶段拆为 `AdminShell` |
| 路由 | `src/App.tsx` | 加两条受控路由树，保留旧路径过渡 |
| 身份会话 | `src/auth.tsx`、Kernel auth | 单会话、Server authorization |
| 插件 UI | `src/extensions.tsx`、manifest/contracts | 版本化 Surface 契约与权限过滤 |
| 原用户业务主线 | `docs/roadmap/0.1.0-*` | Incident 优先，不能把 Pipeline Studio 当 RCA |

## 1.5 变更纪律

1. PR #11 本身范围较大；新工作从当前分支开**独立 Draft PR**，优先 stacked on #11。拆分成多个 slice，避免几十个大杂烩提交。
2. 在任何权限/契约变更前，先定义兼容性与升级；前端隐藏不等于后端授权。
3. 不退回到旧版 Java-only 设计，不为了 UI 工作迁移后端语言。
4. 不把 Staging Smoke 与 Production Release Gate 混淆。
5. 任何“已实现”判断须有**代码路径 + 测试 + 可访问运行版本**证据。
