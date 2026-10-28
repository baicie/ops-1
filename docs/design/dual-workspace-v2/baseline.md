# G00 · 基线审计（真实状态）

审计时间：2026-10-28。**所有数值来自本轮实际命令输出**，不是历史报告。

## 1. Git / PR 基线

| 项 | 实测 |
|---|---|
| 审计时 HEAD | `30b0119` `docs(staging): commit the demo source the golden path reads from` |
| 当前分支 | `feat/0.0.5-staging-preview` |
| 设计包审查基线 | `8b6a32ae47206f47e55c090d19c0fedd2e9ed33c`（PR #11 当时 HEAD）——本轮已前进 4 个提交 |
| PR #9 | `feat/0.0.5-governance-foundation` → `main` · Draft |
| PR #10 | `feat/0.0.5-final-reliability-hardening` → `feat/0.0.5-governance-foundation` · Draft |
| PR #11 | `feat/0.0.5-staging-preview` → `feat/0.0.5-final-reliability-hardening` · Draft |

结论：三层 stacked Draft PR 链仍然成立；UI V2 必须另开 `feat/ui-admin-shell-v2`，**stacked on PR #11**，不继续往 #11 堆页面改动。

## 2. 前端代码事实

| 项 | 实测值 |
|---|---|
| shadcn 原语 | **12 个**：badge, button, card, dialog, dropdown-menu, input, label, select, separator, table, tabs, tooltip |
| 页面文件 | **17 个**（16 页面 + `table-kit.tsx` 共享件） |
| i18n 键 | **880**（en = zh-CN，0 缺失 0 未使用，`check-i18n` 通过） |
| 设计令牌 | `styles.css` 中 **455** 处 `--ow-*` 引用，Tailwind 已映射语义色 |
| Shell | **单 Shell**：`App.tsx` 里 `<Route element={<RequireAuth />}> → Layout`，无 `/admin`、无 `/app` |
| 导航 | `Layout.tsx` 硬编码 10 项（Overview/Plugins/Pipelines/Jobs/Nodes/Governance/Activity/Access/Settings/Ops Center），无分组、无 Surface 概念 |
| 版本角标 | 已在 Layout 中挂载（`VersionBadge` 出现 2 次） |
| 角色模型 | Kernel `viewer` / `operator` / `admin`，`auth.rs` 解析后默认 `Viewer` |
| 授权校验点 | **38 处** `require_admin` / `require_operator` 调用 |
| 插件路由 | 单前缀 `/ext/*`，`SHELL_RESERVED` 保护 7 个前缀；`navigation.item.v1` 是唯一导航贡献种类，**无 surface 字段** |
| OpenAPI 契约 | `contracts/openapi/kernel-v1.yaml` 仅 146 行 / 8 个路径，是设计稿子集，**未覆盖 nodes/deployments/auth** |

## 3. 已有与缺失（不得重复建设）

| 能力 | 状态 | 位置 |
|---|---|---|
| Tailwind + 语义令牌 | EXISTS | `tailwind.config.cjs` / `styles.css` |
| shadcn primitives（12） | EXISTS | `src/components/ui/` |
| i18n（en/zh-CN + 校验脚本） | EXISTS | `src/i18n/` / `scripts/check-i18n.mjs` |
| Status/Table 复合件 | PARTIAL | `components/status-tone.ts`、`pages/table-kit.tsx`（页面级共享，非组件库） |
| Dialog/Modal | EXISTS | `ui/dialog.tsx` + `Ui.tsx` 的 `Modal`/`ConfirmDialog` |
| Theme 切换 | EXISTS | `Layout.tsx` 的 theme 控件 + `data-theme` |
| Locale 切换 | EXISTS | `[data-testid="language-switcher"]` |
| VersionBadge | EXISTS | `components/VersionBadge.tsx` |
| Command Palette | **MISSING** | 无 cmdk/命令面板 |
| Sidebar 复合件（可折叠/分组/移动抽屉） | **MISSING** | 现为手写 `.sidebar` CSS |
| Surface 元数据与双 Shell | **MISSING** | 见路由图 |
| Surface Switcher / 最近路径记忆 | **MISSING** | 无 |
| 插件 surface 贡献（v2） | **MISSING** | `navigation.item.v1` 无 surface |
| 业务 Workspace 页面 | **MISSING** | 无 `/app/*`；**不得用 Pipeline Studio 冒充 Investigation** |

## 4. 真实路由图（迁移前）

见 `route-map.md`，共 20 条路由 + `/ext/*` + 兜底 404。

## 5. 旧 URL 与深链

- 旧入口：`/`、`/plugins`、`/plugins/install`、`/plugins/:id`、`/pipelines`、`/pipelines/:pipelineId`、`/pipelines/:pipelineId/editor`、`/pipelines/:pipelineId/run`、`/jobs`、`/jobs/:jobId`、`/nodes`、`/nodes/:id`、`/governance`、`/instances/:id/logs`、`/activity`、`/access`、`/settings`、`/settings/diagnostics`、`/ops-center`、`/ext/*`
- **无 `returnTo` 机制**：`App.tsx` 与 `auth.tsx` 中未发现登录后回跳逻辑，迁移时需补且必须 allowlist 校验。
- 外部书签兼容需要在 `/admin/*` 落地后保留一段重定向窗口（`docs/08 §8.4`）。

## 6. 测试覆盖（现状）

| Spec | 覆盖路由 |
|---|---|
| `staging-smoke` | `/login`, `/` |
| `i18n-locale` | `/login`（+ 导航断言） |
| `dialog-a11y` | `/login`, `/nodes` |
| `visual` | `/login`, `/plugins/dev.opsweave.hello`, `/plugins/install`, `/ext/trusted-team/hello` |
| `visual-layout` | `/login`, `/jobs` |
| `studio` | `/login`, `/pipelines`, `/jobs` |
| `data-foundation` / `-flows` | `/login`, `/ext/trusted-team/{data-catalog,data-integration}`, `/nodes`, `/governance` |

**未覆盖**：`/access`、`/settings`、`/settings/diagnostics`、`/ops-center`、`/activity`、`/plugins/:id` 生命周期操作、`/nodes/:id` 详情。这些在 G09 补齐。

## 7. 阻断与风险（P0/P1/P2）

| ID | 级别 | 项 | 依赖 |
|---|---|---|---|
| B1 | P0 | 镜像自动投递仍 BLOCKED（GitHub→主机 7.4 KB/s，Docker Hub 不可达） | 需国内 OCI 仓库凭据 |
| B2 | P0 | Staging 无 HTTPS、管理员口令在公网 HTTP 上公开 | 需域名 + 443 |
| B3 | P1 | 上一目标的业务闭环停在 Data Integration 入库记录被 catalog 拒绝（`rejected=1`，无失败原因） | catalog 侧校验语义 + 错误透出 |
| B4 | P1 | 没有能力授权 UI（只能通过 `POST /api/v1/capability-grants`） | G06 一起设计 |
| R1 | P0 | 前端隐藏 Admin 菜单 ≠ 授权；必须后端 403 | G05 |
| R2 | P0 | 插件 surface 路由冲突/越权 | G06 |
| R4 | P1 | 既有 `operator` 的平台维护能力不能因双 Surface 被误伤 | G05 角色-API 矩阵 |
| R9 | P2 | 令牌命名错导致新旧样式并存 | G01 |

## 8. 结论

前端**已具备**扎实基础（12 原语、880 i18n 键、455 令牌、部分页面已迁 shadcn），**缺的**是 Shell 架构层：双 Surface 路由、Command Palette、Sidebar 复合件、Surface Switcher、插件 surface 合同、业务 Workspace。

因此 G01 起的工作是**架构与体验层**，不是重写组件。

## 9. 旧版视觉基线（真实截图，非现成图片）

Staging 当前 served SHA：`bd21a9ef044136924e9c31efa40e75efc7b8485a`（`/api/v1/version` 实测，本轮隧道抓取）。

| 截图 | 说明 |
|---|---|
| `artifacts/ui-baseline/v1-overview-1440-light.png` | 平台概览（当前单 Shell，无 Surface 概念） |
| `artifacts/ui-baseline/v1-overview-1440-dark.png` | 暗色 |
| `artifacts/ui-baseline/v1-overview-390-light.png` | 390 宽（侧栏收起为抽屉） |
| `artifacts/ui-baseline/v1-plugins-{1440,390}-light.png` | 插件列表（shadcn Table 已迁） |
| `artifacts/ui-baseline/v1-nodes-{1440,390}-light.png` | 节点列表 |
| `artifacts/ui-baseline/v1-governance-{1440,390}-light.png` | 治理 |

基线观察（G01/G02 的改进依据）：
1. 侧栏是**扁平 10 项**，没有分组、没有折叠、没有 Surface 概念；扩展插件项直接混在业务导航里。
2. 顶栏只有「健康胶囊 + 语言 + 用户」，**没有 Command Palette、没有面包屑、没有 Surface 切换器**。
3. 页面标题区做法不统一（有的用 `PageHeader`，有的自绘），KPI 卡片与事件列表间距不一致。
4. 事件流里 `ACCEPTED` 等状态仍是原始码药丸，视觉上比中文状态弱。
5. 版本角标固定在最底部，信息密度与可读性都偏弱。
