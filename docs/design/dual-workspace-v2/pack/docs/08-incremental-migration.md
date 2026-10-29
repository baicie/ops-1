# 08 · 分阶段实施计划、依赖图与 PR 策略

## 8.1 原则：每轮必须看到真实效果

每个阶段都经历：**现状代码核对 → ADR/Contract（需要时）→ 最小实现 → 自测 → 浏览器截图 → Commit/Push → Staging → 用户可感知变化 → 复盘**。禁止每个 Slice 只产生文档而无可视化结果，也禁止未经权限评审就大量搬页面。

## 8.2 建议 12 个执行切片

| Gate | 工作包 | 用户可看到的交付 | 前置 | 预计触碰范围 |
|---|---|---|---|---|
| G00 | 基线审计与快照 | 路由/权限/功能清单，旧版截图，确定堆叠 PR | 无 | Docs/Tests |
| G01 | Token 与交互规范 | 统一明暗 Token、密度、控件规格、A11y baseline | G00 | CSS/Tailwind/UI |
| G02 | AdminShell V2 | 顶栏/左导航/Command/用户菜单/Theme/版本角标 | G01 | Shell/Layout |
| G03 | 3 个示范页 | 平台 Overview、Plugins、Nodes 精修与真实状态 | G02 | 3 pages + composites |
| G04 | 双 Surface Router | `/admin/*`, `/app/*`, URL/Session/Last Path 切换 | G03 | Router/Shell |
| G05 | 授权闭环 | 管理权限与 Server Gate，viewer/operator/admin 完整矩阵 | G04 | Kernel Auth/API + Web |
| G06 | 插件双 Surface | v1 兼容 + v2 命名空间、过滤、签名、激活刷新 | G05 | Contract/Kernel/Web/Plugin |
| G07 | Business Shell | 业务 IA + 真实可用入口，不将 Admin 管理页复制过去 | G04–06 | Business Shell |
| G08 | 其余 Admin 迁移 | Access/Settings/Jobs/Studio 等按风险分批统一 | G02–06 | Admin pages |
| G09 | 浏览器与部署门禁 | Visual/Behavior/Permissions/I18n/Smoke，部署 SHA | G01–08 | UI E2E/CI |
| G10 | 独立审查与收口 | A11y、RBAC、Plugin/Legacy、性能/回滚 | G09 | Review/fixes |
| G11 | 业务纵切启动 | Incident List → Evidence → Investigation 的第一条**真实** Slice | G07,G10 | 0.1.0 后续单独 PR |

每一 Gate 的具体 DSH 提示词见 `prompts/01...12`；本包的 Prompt 文件编号 01 对应 G00，以此类推。

## 8.3 PR 规划与依赖

- **UI-A** `feat/ui-admin-shell-v2`：G00–G03，在 PR #11 的最新代码之上开新的 Draft PR。不要向 PR #11 继续塞 75+ 文件的无关大改。每轮多 Commit，控制 review 单元。
- **UI-B** `feat/ui-dual-surfaces`：G04–G05，stacked on UI-A（或其已合并基线，执行时审计）。
- **UI-C** `feat/ui-surface-extensions`：G06，stacked on UI-B；如需签名 manifest 变化，应单独可 review 的合同 PR。
- **UI-D** `feat/ui-business-shell`：G07；仅建业务入口/信息架构；不要冒充 Incident 已实现。
- **UI-E** `feat/ui-admin-polish-and-gates`：G08–G10，独立持续审查。
- **PRODUCT-0.1.0**：G11，按原始产品 Golden Path 启动，独立业务领域与权限/数据契约。

如果分支未合并，维护清楚 Stacked Base SHA；不要求在每个阶段强行重开 PR。不得 Merge/Tag/Release/Force Push。采用 PR Review Evidence Ledger `checklists/gate-checklist.md`。

## 8.4 旧 URL 兼容

旧入口：`/`, `/plugins`, `/plugins/install`, `/nodes`, `/pipelines`, `/jobs`, `/governance`, `/activity`, `/access`, `/settings`, `/ops-center`, `/ext/*`。迁移计划：

1. 路由映射表先补测试与跳转契约。
2. 一步只迁一组路由，旧链接迁到对应 Admin Namespace；如有 Business 语义，显式迁入业务视图，并保留独立授权。
3. 需要 `returnTo`、query/hash 等过滤参数时做 allowlist 迁移，绝不带来源域名跳转。
4. 用户访问旧书签时不绕过权限；禁止通过旧路径访问 Admin 页面。
5. CI 保持旧版 E2E 回归；达到指定兼容窗口后才删除旧路由。

## 8.5 避免“只是换皮”的验收问题

每完成一个页面检查：
- 用户能否看懂当前系统状态？
- 每一个主要 CTA 能否执行真实操作？
- 请求错误/无数据/权限不足是否有独立 UI？
- 可以通过 URL 直接访问、返回、刷新吗？
- 有无 i18n、响应式、暗色、键盘回归？
- 截图来自哪个 SHA 与环境？

## 8.6 资源与排期

不对无法控制的 DSH 执行时间承诺具体时长；按 Gate 而非工时汇报。若某一 Gate 涉及后端权限/签名契约难度明显增加，应把功能级交付拆为 Contract PR 和 UI PR，而非借 UI 工单要求无限重构。
