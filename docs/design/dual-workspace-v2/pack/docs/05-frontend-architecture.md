# 05 · 前端架构、目录与技术决策

## 5.1 已选技术（冻结首轮范围）

Vite + React + TypeScript + Tailwind CSS + shadcn/ui（copy-in）+ React Router（现有），共享当前自建 i18n、`--ow-*` Tokens、Kernel Session、Gateway API。参考 shadcn-admin 的视觉/信息密度，不接受为了模板统一而全量迁移 TanStack Router、Clerk 或重新实现 Auth。

可按需引入：TanStack Query（异步数据与缓存）、TanStack Table（复杂可重用表格）、React Hook Form + Zod（复杂表单）；**必须为具体 Feature 提供成本/收益与增量方案**，不能一次引入一大批依赖。Zustand 仅跨页客户端 UI 状态确有需求时使用，别用来缓存服务端权威数据。

## 5.2 建议目录（渐进式，不要求一轮整体移动）

```text
apps/platform-web/src/
  app/
    AppRouter.tsx           # 登录 / Surface Layout / Legacy redirect
    auth/                   # 复用现有 auth.tsx，逐步移动
    api/                    # 复用现有 api.ts Gateway + CSRF
    i18n/                   # 复用 catalogs, hooks
  shells/
    admin/
      AdminShell.tsx
      AdminSidebar.tsx
      AdminHeader.tsx
      AdminNavigation.ts
    workspace/
      WorkspaceShell.tsx
      WorkspaceSidebar.tsx
      WorkspaceHeader.tsx
  features/
    platform/
      overview/
      plugins/
      nodes/
      deployments/
      activity/
      access/
    business/
      incidents/            # 未来真实领域/API 到位后再编码
      investigations/
      observability/
      resources/
  extensions/
    registry.ts             # Surface route / nav registry
    loader.ts               # 保留原 Remote 机制、安全校验
    bridge.ts               # 限权的 host API
  components/
    ui/                     # 既有 shadcn primitives
    app/                    # OpsWeave composite UI
  styles/
    tokens.css              # 以 --ow-* 为单一权威
    density.css
```

迁移期间原 `pages/*` 继续作为容器内子路由导入，不强制大范围移动文件，切换完成再移动。保留原 `ExtensionsProvider` 为共同 Provider，按 Surface 提供 UI 过滤（服务端必须同步限制）。

## 5.3 路由方案

```tsx
<BrowserRouter>
  <AuthProvider>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/app/*" element={<WorkspaceShell />} />
        <Route path="/admin/*" element={<RequirePlatformAccess><AdminShell /></RequirePlatformAccess>} />
        <Route path="/" element={<AuthorizedHomeRedirect />} />
        <Route path="/legacy/*" element={<LegacyRouteBridge />} />
      </Route>
    </Routes>
  </AuthProvider>
</BrowserRouter>
```

**伪代码，非精确现成代码。** 当前 `App.tsx` 用 React Router 嵌套 `Outlet`，实现时路由层级须和实际 Router 行为对应，不能出现双 Router 或 Shell 中把 Session 重置。

- 遵循 React Router 相对路由规则，不能用 `window.location.href` 做普通内部切换。
- 登录后 Redirect 需要验证 `returnTo` 仅为同源允许路径；禁止 open redirect。
- 切换后保持独立导航上次路径（localStorage 存偏好只用于 UX，不用于授权）。
- 404 与 403 分离。`/admin` 未授权不能被 SPA fallback 假装成无权限功能页，也不能访问 API。
- `api/v1/auth/me` Session Refresh 在授权变更/登录/退出时同步菜单状态；Logout 清空敏感缓存。

## 5.4 UI 状态与服务器数据

- API Gateway 是授权和请求语义的唯一入口；业务 UI 不直连 Node、插件端口、数据库。
- 可以逐步采用 TanStack Query，但 Query Keys 包含用户身份/业务 Scope/Surface/资源 ID，切换用户或 Scope 时清理敏感缓存。
- Query 失败 = 可诊断错误；`NO_DATA` ≠ `0`；`STALE` ≠ `READY`。
- 复杂 Studio（React Flow）保留现状直到独立验收，不作为双 Shell 的启动门槛。
- 命令面板仅展现有权访问的导航动作；Cmd+K 热键、Esc、键盘无鼠标操作。

## 5.5 复合组件契约

共享：`PageHeader`, `DataTable`, `StatusPill`, `EmptyState`, `PermissionGate`, `DetailSheet`, `ConfirmDialog`, `LogViewer`, `TimeRangePicker`，但不要一次全部实现；按真实页面增量抽象。

禁止：把插件 UI 的全局 CSS 注入 Host、让远端扩展修改根 Router、共享原始 Session Secret 给远端代码、在全局 Context 替插件建立权限。

## 5.6 前端服务能力分界

Platform Console 与 Workspace UI 可以在**同一 Vite build** 内通过嵌套路由、code splitting 和按需 lazy import 实现。当前 Kernel 已托管 Web Shell，避免新增 Web Nginx/服务。只有确实需要不同构建发布节奏/安全域时再 ADR 讨论 `apps/workspace-web`；目前不做。
