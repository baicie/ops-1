# OpsWeave UI/UX & Dual-Workspace Design Pack v2

**版本：** 2026-10-28 · DRAFT / IMPLEMENTATION PLAN · 不代表仓库已经实现。  
**目标：** Vite + React + TypeScript + Tailwind CSS + shadcn/ui；以 `satnaing/shadcn-admin` 为 Admin Console 的布局/交互**参考**，发展 OpsWeave 自有 Design System；将平台维护控制台与业务工作台分开。  
**项目：** https://github.com/baicie/ops-1  
**基线（审查时刻）：** PR #9 → #10 → #11（均 Draft），PR #11 `feat/0.0.5-staging-preview` HEAD `8b6a32ae47206f47e55c090d19c0fedd2e9ed33c`。**执行前以远端实时状态为准**。  
**状态：** 本包全部为设计与待执行提示词，不是实现验收或自动部署成功的证明。

## 一句话的产品定义

OpsWeave 是一个可扩展的智能运维平台：
- **Platform Console `/admin/*`**：授权的维护人员用于部署/升级平台组件、维护插件/节点/权限/诊断；这是**平台的管理视图**，不是用户业务 Workspace。
- **Business Workspace `/app/*`**：值班、运维、研发等使用者完成 Incident → Evidence → Investigation → RCA → Verdict 的工作；未来可以按业务域切换多个授权 Workspace。
- **Shared Platform**：同一个账号/Session、Rust Kernel、Gateway、RBAC、Plugin Runtime、设计令牌；**导航、流程、权限与操作边界独立**。

## 阅读顺序

1. `docs/01-baseline-and-original-design.md`：哪些来自 2026-10-15 原始方案、哪些需要适配现有 Rust Kernel。
2. `docs/02-product-model-and-boundaries.md`：双工作台含义、角色、默认登录、业务与维护分层。
3. `docs/03-information-architecture.md`：导航、路由、跳转、工作流。
4. `docs/04-design-system-and-shadcn-admin.md`：视觉、组件、响应式、交互与无障碍细则。
5. `docs/05-frontend-architecture.md`：目录结构、共享基础设施、路由与接入。
6. `docs/06-auth-and-permissions.md`：Session / RBAC / 授权边界与迁移策略。
7. `docs/07-plugin-contribution-contract.md`：双 Surface 插件扩展，兼容已签名 manifest。
8. `docs/08-incremental-migration.md`：按什么顺序做、拆哪些 PR、如何保留现有功能。
9. `docs/09-interaction-state-matrix.md`：页面和状态的验收矩阵。
10. `docs/10-release-and-preview-gates.md`：测试、CI、截图、部署和回滚。
11. `docs/11-architecture-decisions-and-risks.md`：明确选择/禁止事项。
12. `docs/12-business-first-vertical-slice.md`：双 Shell 完成后如何开始 Incident 第一条产品链路。

## 可直接让 DSH 执行的提示词

- **总控目标提示词**：`prompts/00-MASTER-MISSION.md`（先交这一份，要求按 Gate 自主连续执行）。
- **分阶段提示词**：`prompts/01-BASELINE-AUDIT.md` 至 `prompts/12-PRODUCT-HANDOFF.md`。每一份包括目标、受影响代码、强制行为、命令、证据、验收/停止条件。
- 执行代理应把 `docs/` 放入仓库暂存为 `docs/design/dual-workspace-v2/`（或由项目 ADR 确定的路径）；`prompts/` 可以放仓库任务文档目录，但不要自动把本包里的历史原文整份纳入产品仓库。

## 文件说明

```text
OpsWeave-Dual-Workspace-Design-v2/
├── README.md
├── docs/01..12-*.md
├── contracts/                      # 建议契约草案；不是仓库已存在的 API
├── checklists/                    # Gate 与截图/路由矩阵
├── prompts/00..12-*.md           # 每一步可单独复制执行的 DSH 任务
└── reference/                    # 两份原始设计全文；保留出处与时间
```

## 优先级与停止线

**先让 Admin Console 精致可靠、再做双 Shell + 权限闭环，最后接第一条业务旅程。** 不因美化工作而编造 Incident/RCA 的真实能力，也不把 FT-03..FT-16 等未完成的 0.0.5 生产门禁宣称为完成。

禁止：迁移成另一套框架、重写 Rust Kernel、立即落 Kubernetes、做全新的通用插件系统、擅自合并 PR、将 Demo 伪装生产真实数据、生产部署或任何破坏数据的操作。

## 参考来源

- 原始设计 `reference/OpsWeave-0.1.0-Design-Full.md`（2026-10-15）与 `reference/OpsWeave-0.1.0-Collection-Design-Full.md`（2026-10-16）。
- 当前仓库 `https://github.com/baicie/ops-1`；PR #11 `https://github.com/baicie/ops-1/pull/11`。
- 上游布局参考 `https://github.com/satnaing/shadcn-admin`（MIT）。**仅参考布局/交互；要复制其原创代码须保留 MIT 许可证与版权声明，并单独审查具体实现/版本。** shadcn-admin README 特别说明它不是开箱即用的产品脚手架。

## 使用方法

1. 将 ZIP 解压并作为附件/本地文件交给 DSH。
2. 首先发送 `prompts/00-MASTER-MISSION.md`；它会强制代理阅读所有设计与分阶段提示词。
3. 可在每阶段单独发送对应的 `prompts/NN-*.md`，同时要求 DSH 用**真实远端 HEAD** 和实际 Staging 状态更新任务进展。
4. 一阶段一个可独立审查的 Draft PR / Slice，输出 Commit SHA、CI URL、Staging 版本、功能截图、失败原因；绝不从“页面可渲染”推断“业务可用”。
