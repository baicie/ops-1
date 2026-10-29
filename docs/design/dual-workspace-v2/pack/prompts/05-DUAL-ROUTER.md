# G04 / P0 — 单一登录下的 Admin / Business 双 Shell 与路由迁移

审查 G03 HEAD、`src/App.tsx`, `src/components/Layout.tsx`, `src/auth.tsx`, `src/extensions.tsx`, `src/i18n`；读取 `docs/02-product-model-and-boundaries.md`、`docs/03-information-architecture.md`、`docs/05-frontend-architecture.md`。本阶段必须**亲自执行**路由/浏览器测试，不接受单纯改 UI 文案。

## 任务

1. 明确两个概念：`Surface` 是 admin/workspace；`Business Workspace` 是业务域上下文，Admin Console 不属于用户可创建的 Workspace。实现 Shared Provider 下两个 Shell，而不是两套独立 Auth。
2. 新增 `/admin/*` 与 `/app/*` 的路由嵌套，平台维护的旧页面落 `/admin`；Business Shell 初期可以做真实入口与不可用说明，但不能制造虚假 Incident 数据。
3. `SurfaceSwitcher`：有授权的人通过菜单从 Admin/Business 双向切换，无需重新登录。无管理权限的用户不出现 Admin 入口。G05 未完成前只允许依现有服务端 `role=admin` 进行明确过渡，严禁只凭 localStorage 权限。
4. 登录恢复/刷新/浏览器 Back/Forward/深链/命令面板均与当前 Surface 一致。记住两个 Surface 的最后合法路径；退出或换账号清理偏好，不用偏好作为权限依据。
5. 路由根 `/` 选择真实可用默认页：优先 Business 的已授权 Home，业务尚无可用页面时不得让管理员误入空壳；定义阶段性默认与后续变更 Gate。
6. 为旧 URL `/plugins`, `/nodes`, `/pipelines`, `/jobs`, `/activity`, `/access`, `/settings`, `/governance`, `/ops-center`, `/ext/*` 做**安全**兼容映射；保留查询参数的 allowlist，禁止 open redirect 或越权桥接。
7. `/admin` / `/app` 各自 Breadcrumb、Nav、404、403、Navigation focus。不能在未授权时先渲染敏感页面再瞬间跳转。
8. 复用现有 Theme/i18n/VersionBadge，不增加第二个全局 Router；用 `Link/NavLink` 内部导航，不随意强刷页面。

## E2E 矩阵

- admin 登录 → `/admin/overview` → `/app` → 返回 Admin，无重新登录。
- viewer 不显示 Admin 导航；手工输入 `/admin/nodes` 获拒绝；服务端 API 403 留到 G05 专门加固。
- operator 的现有平台操作能力逐项对照迁移策略，不要因隐藏了 Admin 导航造成实际功能孤岛。
- 旧 `/plugins/:id` 深链能转换、拒绝非授权用户；失效路由 404。
- 390 宽能打开/关闭 Switcher；Language/Theme 状态保留。

## 限制

G04 主要是 Router/Shell 重构；若发现需要服务端新授权字段，先记到 G05 的 ADR，不悄悄拓宽 Kernel 权限。CI/截图/Preview 绑定最终 SHA；独立 Draft PR。完成后执行 G05。
