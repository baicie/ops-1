# G10 / P0 — UI V2 + Dual Surface 独立复验与最终收口

对实际落地的 UI-A/B/C/D/E Draft PR 执行**独立于实现者思路的复查**，以源码和运行结果为依据；最小覆盖 `docs/11-architecture-decisions-and-risks.md` 的 R1–R10、`checklists/*`，不接受只看总结报告。

## 审查任务

1. Route Guard 与 API Auth：viewer/operator/admin、直接 URL/旧路径、Session 过期/权限撤销、跨业务 Domain。列出可利用的越权路径；必须以真实请求验证是否返回 401/403。
2. 插件：v1 带签名 Manifest 是否仍可运行；v2 Surface 检查/重复路径/核心保留路径/签名/升级/禁用/资源缓存；恶意远端 UI 的同源信任风险写明，不虚构 sandbox。
3. UI 交互：Tabs/Dialogs/Dropdown/Tooltip/Command/Sheet 的键盘/焦点恢复、盲读语义、移动端、光暗主题、中英文、卡片与表格密度。
4. 产品边界：维护项只在 Admin；业务项只在 Workspace；数据接入配置属于何种 Surface 有清晰权限和职责；Business Shell 不能是假 Incident 数据。
5. 部署：固定 SHA、版本自证、回滚与数据库兼容、Staging Secret，避免旧版本被错误记为最新成功。
6. 性能与可维护性：新增 bundle/路由/Design Tokens/重复组件数量、API 请求/缓存隔离、响应式渲染是否回归。
7. 每个 P0/P1 有重现步骤、路径/代码证据、最小修复、回归测试；修复后**第二轮**独立复验，不能自行关闭未验证项。

## 结论

- 所有本阶段阻断 P0/P1 修复且二次验收实际通过才可以 `UI_V2_READY_FOR_REVIEW`；
- 仍有安全/越权/业务错位则 `BLOCKED/PARTIAL`，严禁按设计文档完成度宣布可用；
- 最终报告包括 Git HEAD、PR、所有关键 CI Run ID、Staging Served SHA、E2E 截图、剩余风险/技术债、对下阶段的建议。

不 Merge、不 Tag、不 Release、不生产部署；单独保留 `0.0.5_PARTIAL`。完成后 G11 产品交接。
