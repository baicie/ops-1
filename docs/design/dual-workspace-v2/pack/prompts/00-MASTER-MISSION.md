# DSH 总控目标提示词 — OpsWeave UI V2 & Dual Surface Delivery

## 核心任务

你负责 `https://github.com/baicie/ops-1` 的 UI V2 交付。我要的是**一个精致且可用的平台控制台**、**同账号无感切换的业务工作台**，以及**今后每轮提交都能在 Staging 浏览器看见真实产品变化**。

**技术栈已冻结：Vite + React + TypeScript + Tailwind CSS + shadcn/ui**，以 `https://github.com/satnaing/shadcn-admin` 为 AdminShell 的布局/交互参考。不是全量 fork 或迁移 TanStack Router/Clerk；保留当前 React Router、Kernel Session/CSRF/Gateway 和 `--ow-*` 设计令牌，优先复用现有组件。

## 真实产品含义（必须理解）

- `/admin/*` 是 **Platform Console**：平台管理员/授权维护人员管理插件、节点、组件生命周期、升级、诊断、用户权限。**不是普通业务 Workspace**。
- `/app/*` 是 **Business Workspace**：值班/研发/运维业务人员使用 Incident、Evidence、Investigation、RCA、报告等能力；将来可有多个授权的业务 Workspace。
- 同一个用户、同一个登录 Session、两个独立 Shell、统一设计系统；有管理权限可切换到 Admin，无管理权限既不显示入口，也不能通过 URL/API 绕过授权。
- 平台 Admin 身份**不自动等于所有业务域数据的读取许可**。
- 插件可以贡献 Admin 页面或业务页面，但要经过服务端授权和签名 Manifest 合同，保持旧插件兼容。

## 必须先阅读的设计包

已经提供 `OpsWeave-Dual-Workspace-Design-v2.zip`，解压后按目录阅读：
- `README.md`；
- `docs/01` 至 `docs/12`（重点 01、02、04、05、06、07、08、10、11）；
- `contracts/*`（**示意契约，不是现成 API**）；
- `checklists/*`；
- `reference/OpsWeave-0.1.0-Design-Full.md` 第 00/08/09 章与 `reference/OpsWeave-0.1.0-Collection-Design-Full.md` 第 15 章；
- `prompts/01-BASELINE-AUDIT.md` 到 `prompts/12-PRODUCT-HANDOFF.md` 的逐段执行要求。

如果没有接收到 ZIP，不要臆造设计包内容；先按本提示词与当前仓库执行可安全开展的审计，说明缺失附件，并从仓库 `docs/roadmap/0.1.0-*` 读取原始愿景。绝不把不存在的文件当成已读。

## Git 基线（仅参考，不要硬编码）

2026-10-28 审查：PR #9 Governance（Draft）→ PR #10 Reliability（Draft）→ PR #11 Staging Preview（Draft）；PR #11 审查时 HEAD `8b6a32ae47206f47e55c090d19c0fedd2e9ed33c`。**现在重新读取真实 HEAD、PR、CI 和 Staging 状态**。已有 Frontend i18n/shadcn migration，不得重复建设。

目标是把新设计落到独立 Draft PR/Stacked PR；不要继续向 #11 累积大量无关页面改动；没有授权不允许 Merge/Tag/Release/Force Push/生产部署。不要中断别人的工作、不要删除 Staging 持久化数据。

## 自主工作顺序

按 `docs/08-incremental-migration.md` 的 Gate 执行，每个 Gate 优先读取对应独立提示词：

1. `01-BASELINE-AUDIT.md`：审计实际分支/旧路由/权限/插件/截图/Token，先定切片与 PR Base。
2. `02-DESIGN-SYSTEM.md`：创建精致且一致的 Admin Design System，不做 UI 大换血。
3. `03-ADMIN-SHELL.md`：AdminShell、Sidebar、Header、Command、Theme、Switcher 容器。
4. `04-ADMIN-EXEMPLARS.md`：真实改好 Overview/Plugins/Nodes 三个页面，真实数据、交互、状态。
5. `05-DUAL-ROUTER.md`：真正的 `/admin`/`/app` 双 Shell、兼容旧 URL。
6. `06-SURFACE-AUTH.md`：后端权限、角色矩阵、viewer/operator/admin 安全验收。
7. `07-PLUGIN-SURFACES.md`：v1 兼容，签名 v2 Surface 贡献、命名空间、授权。
8. `08-BUSINESS-SHELL.md`：业务 Shell 与 IA，不虚构 Incident/RCA，建立真实 Feature Flag 与空/不可用状态。
9. `09-ADMIN-POLISH.md`：其余 Admin 页面与旧 Studio 按风险分批改造。
10. `10-UI-CI-STAGING.md`：Typecheck、Build、i18n、权限、Visual E2E、版本自证、Staging。
11. `11-INDEPENDENT-REVIEW.md`：第二视角代码/安全/交互审查、缺陷修复、最终定级。
12. `12-PRODUCT-HANDOFF.md`：准备 0.1.0 Incident → Evidence → Verdict 第一条真业务纵切与后续独立 Draft PR。

**不要一次性在一个巨型 Commit 里做完。** 至少以“Admin 视觉基础/三样板页”“双 Shell + 权限”“插件 Surface”“业务 Shell + 全面验收”分离可审查单元。阶段之间先读真实代码判重，存在的能力就验证/加固，缺的才做。

## 每 Gate 的不可妥协要求

- 显示受影响功能的真实浏览器截图（1440/1024/390 + Light/Dark + zh-CN/en）；保留旧截图对照。
- 所有核心按钮/路由、错误/无权/加载/陈旧/无数据状态真实可测；不能以 Skeleton 或占位页面宣称产品可用。
- 若改 Kernel/权限/manifest，先改 ADR + contracts，再写代码；必须有拒绝/越权/升级兼容负向测试。
- `cargo fmt`, Web typecheck/build, `check-i18n`, Playwright、相关 Runtime/Contracts Gate 在最终提交 SHA 上执行，并报告真实结果。
- Push 后自动部署到 Staging 的目标是 `servedSHA == full target SHA`；不能把镜像手工预置后的成功称为持续部署完全自动化。
- 发现旧 CI 或 Staging 本来失败：区分本轮引入与已有阻断，修复本轮必须解决的 P0/P1；不准提高 timeout/blind retry、skip tests 伪造绿色。
- 分支、Tag、Release、部署权限遵守仓库 AGENTS.md 与现有安全策略。
- Production 0.0.5 Gate 状态独立保持 `0.0.5_PARTIAL`，直到所有生产门禁独立通过。

## 自主完成条件与输出

不要每做完一个小 Commit 就停下来要求下一个提示词。每个能独立闭环的 Gate 持续推进：审计 → 实施 → 测试 → 截图 → Push → Staging → 审查 → 修复；遇到真实外部授权/网络障碍时，完成其余可安全执行的 Slice，清楚标记 `BLOCKED`。

每 Gate 汇报 A Git/HEAD/PR/Stacked Base、B 具体变更、C 用户可见效果与 URL、D CI/Playwright/截图链接、E 安全与兼容证据、F 未完成 P0/P1/P2、G 下一 Gate。

最终交付：**精致可用的 Admin Console、真实双 Shell/切换/权限、兼容旧插件的可扩展路由、可预览与回滚的 Staging、第一条 0.1.0 业务纵切的准确启动方案**。不得将文档计划说成已实现。

现在先执行 G00 基线审计，产出准确的实施分支/PR 计划，然后连续推进能安全交付的阶段。
