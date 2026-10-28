# G08 / P1 — 剩余平台维护页迁移与组件一致性收口

读取 `docs/04-design-system-and-shadcn-admin.md`、`docs/08-incremental-migration.md`、`docs/09-interaction-state-matrix.md` 和已完成 G03 的对照成果；检查最新 `src/pages/` 是否已有 shadcn/ui 迁移，禁止重复替换。这个阶段只在 G02–G07 稳定后进行。

## 分批顺序（可按实际依赖调整）

A. Access / Settings / Diagnostics / Activity：表格、权限面板、审计历史、状态提示。  
B. Jobs / Pipelines / Governance：保持任务/数据治理原有语义，严防 UI 换皮把业务和平台概念混淆。  
C. Studio / GraphCanvas / Install Wizard / PluginDetail / InstanceLogs：专业高密度界面用专用控件，不强行挤进通用 `Card`。

## 要求

- 每批至少一个真实操作从入口到后端响应完整可见（如安装验证、Node 详情、Job 状态、审计筛选）。
- 复用 `PageHeader`, `DataTable`, `StatusIndicator`, `DetailSheet`, `ConfirmAction`；抽象时维护明确消费方，不扩大无谓 Props API。
- 对危险操作与权限统一行为：确认、Pending、重复提交保护、Cancel/Retry、回滚/不可逆警告。
- 旧 `Pipeline Studio` 的 XYFlow/画布交互由独立视觉/交互测试保护，勿改变 Graph/Run 领域契约。
- 每批截图 1440/1024/390 × Light/Dark × en/zh；保留真实筛选、表格空状态与响应式。
- 注意 0.0.5 reliability/migration 仍未完，不因 UI 改好就宣布释放。

## 完成

所有 Admin 页面使用一致的 App Shell、Token、交互和组件；经过真实浏览器 E2E 的主要操作不退化，未知/陈旧/无数据有准确的语义，文档记录页面迁移表与未修问题。继续 G09。
