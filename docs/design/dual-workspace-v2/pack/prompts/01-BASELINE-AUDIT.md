# G00 / P0 — 审查当前真实基线并建立 UI V2 迁移计划

你现在执行 OpsWeave UI V2 的第一阶段。读取设计包 `README.md`、`docs/01`、`02`、`03`、`08`、`11` 和 `checklists/*`。仓库 `https://github.com/baicie/ops-1`。不许凭旧报告猜测现状；重新检查远端 branches/PR #9/#10/#11 HEAD、changed files、CI、Draft 状态、Staging 版本。

## 必做

1. 读取 `AGENTS.md`、`rules/06-ui-ux.md`、`apps/platform-web/src/{App.tsx,auth.tsx,extensions.tsx,components/Layout.tsx,styles.css,tailwind.config.cjs}`、`package.json`、现有 E2E 和 `contracts/`。
2. 提交一份**真实路由图**：现有路由、实际页面、API、角色、插件贡献、旧 URL/深链、迁移目标、是否已有测试。
3. 提交“已有与缺失”组件表：shadcn primitives、Tailwind、i18n、Design Tokens、Status、Table、Dialog、Command、Sidebar、Theme、VersionBadge。不要让后续 DSH 重写已完成内容。
4. 对照最初 0.1.0 Incident 设计辨别平台管理页与业务页；不能将 Pipeline Studio 误认成 AI Investigation UI。
5. 记录当前 `/api/v1/auth/me` 角色实际字段，审计全部 require_admin/require_operator 的敏感 API 与 operator 兼容行为。
6. 评估 PR #11 是否已包含后续 G01/G02 的一部分；提出合理 Stacked PR 方案，创建**独立 Draft PR**（允许 commit/push，但禁止 merge）。
7. 对当前 Staging 可达页面进行**真实**截图，保存当前 UI 对照基线；附 precise SHA。无 Staging 权限则用本地真实运行，不拿现成图片冒充现场。
8. 写简洁 ADR：为什么 Vite/React Router 保留、shadcn-admin 只参考、双 Shell 首先单 Web App、授权后端权威、原始 Java 提案不在 UI 期改造。

## 输出

`docs/design/dual-workspace-v2/{baseline,route-map,permission-matrix,design-token-audit,implementation-plan}.md`（路径可依据仓库规范调整）、对照截图/版本、Git/PR 与 Gate 状态。将缺失分为 P0/P1/P2，并标注依赖与风险。**不要在 G00 顺手进行无界页面重写。**

## 完成判定

能说明“当前每个 UI 功能在哪里、归属哪个 Surface、什么角色可以操作、哪些必须保留兼容”。可开始 G01；否则标 PARTIAL，修复基线信息缺失。
