# G02 / P0 — AdminShell V2：漂亮而完整的维护控制台外壳

先读 `docs/03-information-architecture.md`、`docs/04-design-system-and-shadcn-admin.md`、`docs/05-frontend-architecture.md` 和 G00/G01 结论，核对 `src/components/Layout.tsx` 与所有现有路由。

## 任务

1. 把现有 `Layout` 逐步重构为可独立使用的 `AdminShell`，先不强制迁路由（双路由放 G04）；保留旧版 URL 和动态 Extension 行为。
2. 实现专业侧栏：Logo/Surface Label、分组、选中态、折叠、移动 Sheet、滚动高亮、长标题 Tooltip、当前环境提示。
3. 实现顶栏：可理解的 Breadcrumb、标题区域、全局搜索/Command（只包含有权菜单，允许首批只搜索导航）、平台健康、Theme、Language、用户菜单。
4. 统一页面 Container/Toolbar/Content 结构；修复当前布局中 Topbar、Table、Drawer、Badge、Version 等视觉密度差异。
5. 预留 Surface Switcher API/Slot，但在 G04/G05 完成授权前**不展示可用的未经授权 `/admin` 切换**。
6. 保留 Nav/Extension slots；不让插件自己决定全局 Header/Sidebar CSS。
7. 确保现有登录/退出、i18n、深浅色/导航刷新、1536/1440/1024/390、键盘导航/Focus/Radix Overlay 正常。
8. 建立真实浏览器 E2E：Sidebar/Collapse/Sheet/Keyboard/Cmd+K/Language/Theme/Logout。对旧路由运行 Regression。

## 禁止

不为了参考 shadcn-admin 而引入第二套 Router、Auth、状态管理。不要把业务 Workspace 和平台维护菜单混在一起，不要改动未授权的 Kernel 业务 API。

## 完成

交付一个可以在 Staging 打开并使用的 AdminShell（导航、搜索、主题、退出、权限不退化），报告 before/after 截图、完整 SHA、相关测试和 Preview URL；继续 G03。
