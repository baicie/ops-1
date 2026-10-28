# Dual Workspace v2 · 设计包与实施记录

本目录同时存放**设计包原文**（权威规格）与**本仓库的实施记录**（实测事实）。两者不可混淆：
设计包描述目标，实施记录描述当前代码与验证结果。

## 设计包原文（未修改）

- `pack/README.md`、`pack/VERSION.md`、`pack/MANIFEST.json`
- `pack/docs/01…12` — 基线、产品模型、IA、设计系统、前端架构、权限、插件合同、迁移计划、状态矩阵、发布门禁、ADR 与风险、业务纵切
- `pack/checklists/` — Gate 验收清单、角色-路由-API 矩阵、视觉评审规则
- `pack/contracts/` — 导航与授权类型草案、surface 贡献 v2 示例
- `pack/prompts/` — G00…G11 的可执行阶段提示词

设计包中的 `reference/`（2026-10-15/16 历史全文）**未纳入仓库**：按包内 README 要求，历史原文不整份进入产品仓库。

## 本仓库实施记录（实测，随 Gate 更新）

| 文件 | 内容 |
|---|---|
| `baseline.md` | 真实 HEAD/PR/CI、代码事实、已有与缺失、阻断项 P0/P1/P2 |
| `route-map.md` | 20 条现状路由 → Surface 归属 → 迁移目标 → 旧 URL 兼容策略 |
| `permission-matrix.md` | 角色/路由/API 拒绝矩阵、38 处校验点、过渡差异 |
| `design-token-audit.md` | 455 令牌、12 原语、G01/G02 缺口、状态矩阵与 a11y 现状 |
| `implementation-plan.md` | Gate → 分支 → PR 计划、切片划分、风险与完成判定 |
| `adr/ADR-UI-decisions.md` | ADR-UI-001…006 |

## 当前状态

- **G00 完成**（审计与计划）；G01 起进入实现。
- 分支：`feat/ui-admin-shell-v2`，stacked on PR #11。
- `0.0.5_PARTIAL` 保持不变；Production Release Gate 独立。
