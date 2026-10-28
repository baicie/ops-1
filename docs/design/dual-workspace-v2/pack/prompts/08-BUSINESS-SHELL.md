# G07 / P0 — Business Workspace V1 的真正外壳（不要拿平台管理页充数）

读取 `docs/02-product-model-and-boundaries.md`、`docs/03-information-architecture.md`、`docs/12-business-first-vertical-slice.md`，原设计 `reference/OpsWeave-0.1.0-Design-Full.md` 第 00/08 章。先审计 G04–G06 是否已经实现独立 Router、权限与插件 Surface。

## 本阶段交付

1. `WorkspaceShell` 必须拥有和 Admin 不同的导航/布局：我的工作台、故障、调查、可观测、资源、报告。只显示有**真正入口或明确 feature unavailable** 的项目；不展示 Node/Publisher/OCI/Plugin 安装等控制面细节。
2. 继续共用 Theme/Locale/Auth/Error Boundary/shadcn 原语，不能各自维护一套颜色/登录/会话。
3. 给业务首页设计 **真正的业务任务空间**：待处理、最近调查、关联服务、Evidence 状态占位规则。如果 Incident API 尚不存在，展示诚实的 `尚未启用 / COMING_SOON` feature 信息或引导到真正可用的业务插件，不可以伪造 incident 数量或 AI 结论。
4. 给未来 Incident Investigation 预留桌面优先的多面板布局槽位：时间线/Evidence、Hypothesis/Tools、Detail；不把普通 shadcn-admin 卡片模板直接堆满调查页。
5. SurfaceSwitcher：有管理权限者在 `/app` 与 `/admin` 双向切换；没有权限者只能进业务；角色变更/会话失效处理正确。
6. 可访问业务插件的导航与详情必须经 Gateway Scope/Server Auth；缺失/过期/拒绝状态明确，首页不显示无权资源总数。
7. i18n、键盘、深浅主题、1440/1024/390、404/403/Empty/Partial/Stale/Unavailable 交互实测。

## 验收界限

`BUSINESS_SHELL_READY` 仅表示业务界面/导航/权限可用；**不等于 Incident/RCA 产品已经实现**。至少一次 admin→workspace 与普通用户受限访问真实 Playwright；截图标注访问 URL 和 served SHA。完成后 G08。
