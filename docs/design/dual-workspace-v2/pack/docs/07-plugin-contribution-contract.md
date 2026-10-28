# 07 · 插件 Surface 贡献与签名兼容设计

## 7.1 现状与限制

当前 `apps/platform-web/src/extensions.tsx` 将 `/api/v1/extensions` 返回的远端扩展加载到 `window.__OPSWEAVE_REMOTES__`；插件通过 `navigation.item.v1`、`route.page.v1` 声明链接/页面，挂在单 `Layout` 与 `/ext/*`。`SHELL_RESERVED` 防旧核心路由冲突。

扩展读取受 Gateway 代理、SDK 包裹，但远端 UMD JS **仍是在宿主页面 JavaScript 上下文运行的受信代码**。这不是浏览器级沙箱。不要宣称因有 RBAC/manifest 已经隔离恶意 JS；未受信代码将来需独立 origin/iframe 安全方案（非本轮）。

## 7.2 目标抽象：一个插件，两类可选贡献

示例语义（草案，后端签名 manifest 版本化优先）：

```json
{
  "kind": "navigation.item.v2",
  "id": "catalog-quality-nav",
  "surface": "workspace",
  "routeRef": "quality-overview",
  "requiredCapabilities": ["business:quality:read"]
}
```

- `surface` 只接收 `admin|workspace`，插件不能随意设为 `root`, `login`, `system`。
- `routeRef` 最终映射到 Namespace 下的规范路径，例如 `/app/ext/opsweave.data-catalog/quality`；路径只能在插件所属命名空间。
- 客户端校验冲突/类型/长度；**后端再次校验** signed manifest、身份、激活版本与授权结果。
- 贡献读取时由后端以当前身份过滤可见模块；前端二次过滤仅作 UX。`requiredCapabilities` 是要求用户有权限，不是插件申请的用户权限。
- 业务页面使用 Gateway 的 plugin-scoped API Host；禁止直连 Node 或数据库、禁止泄露 raw CSRF/session token。

## 7.3 兼容策略（必须完成旧包回归）

1. 先盘点 `contracts/`、`plugins/*/manifest.template.json`、当前 JSON schema 与 `extensions.tsx` 的 v1 贡献。
2. 如果在已有 manifest 内添加字段：明确 optional/default 的规则。**签名 manifest 绝不可直接原地修改**；要按既有验证、构建、签名、Bundle 流程重建。
3. 老 `navigation.item.v1` / `route.page.v1` 默认归属现有 legacy-admin Surface **仅为兼容建议**，要按每个插件真实用途核定；不能自动把所有旧 Extension 变成业务产品。
4. 保留 `/ext/*` 旧书签，安全地引导到新 `/admin/ext/:pluginId/*` 或 `/app/ext/:pluginId/*`；无权查看时拒绝而不是暴露存在性细节。
5. 检查路径前缀、大小写、编码、尾斜杠、Unicode、重复 ID 与多插件路径冲突；拒绝伪装 `/admin`, `/app`, `/login`, `/api` 等核心路径。
6. 只有已激活、READY/authorised 的插件才出现在导航；停用/升级时及时刷新，防止 stale UI 与错误版本资产混用。

## 7.4 拟议插件 Host API

```ts
interface PluginSurfaceHost {
  pluginId: string;
  version: string;
  activationRevision: number;
  surface: 'admin' | 'workspace';
  api: {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body: unknown, idempotencyKey?: string): Promise<T>;
  };
  // 不传 cookie/session/private key，也不传能绕过 Gateway 的任意 fetch 客户端
}
```

该接口**不是现有已支持的 API**；必须通过 ADR、contracts、验证器、扩展加载器和黑盒测试协同实施。不要为了演示而在前端悄悄附加字段且不升级 manifest 合同。

## 7.5 验收

- 已签 v1 插件在新架构下仍正常显示在约定的兼容 Surface，真实路由可用。
- v2 管理插件只出现在 Admin，viewer 无权加载敏感页面或调用管理接口。
- v2 业务插件只在 Workspace 出现，未经授权的用户看不到菜单/页面；API 403。
- 恶意/冲突的 manifest Path/Surface 被明确拒绝，有结构化错误，而不是加载到保留路径。
- Plugin disable/upgrade/rollback 更新导航、API、资源版本，不出现 stale asset 被错误路由。
- 信任边界如实写入 ADR，不声称 Sandbox 安全。
