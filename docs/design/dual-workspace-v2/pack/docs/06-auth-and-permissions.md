# 06 · 单登录、多 Surface、权限与安全合同

## 6.1 现有事实

现有 Kernel `apps/kernel/src/auth.rs` 的 `AuthUser` 含 `user_id/role/session_id/csrf_token` 等；Role 为 `admin/operator/viewer`。`require_admin()` 只放 `admin`，`require_operator()` 放 `operator/admin`。前端 `auth.tsx` 使用 `/api/v1/auth/me` 恢复单 Session；客户端做导航可见性，但 API 访问仍由服务端决定。

**不要假设现在已经支持 `platform:access`/tenant membership。** 本文建议目标方案及兼容过渡。

## 6.2 初版上线权限映射（可实现、风险小）

| 用户 | `/app` | `/admin` | Admin API |
|---|---|---|---|
| viewer | 仅业务已授权页面 | 拒绝 | 现有对应权限保持（读权限不因新路由升级） |
| operator | 授权业务功能 | 默认拒绝；如现有 `operator` 必须执行平台维护，先单独审计并决定显式授权 | 原有操作权限不得意外收紧 |
| admin | 授权业务功能 | 允许进入 | 逐端点保留 require_admin/operator |
| anonymous | Login | Login | 401 |

如果现有 operator 具备必须使用的管理功能，不能凭设计表将其突然锁出全部页面。执行阶段必须扫描真实 API 与用户故事，必要时在后端明确 `platform_console_access` 能力定义后再切；不要只改前端硬编码。

## 6.3 长期精细化授权（独立 ADR/契约）

推荐服务端下发最小授权声明，例如：

```ts
interface AuthorizedSurfaces {
  allowedSurfaces: ('workspace' | 'admin')[];
  // capability 是服务端已核验的有效权限，并非插件自报
  capabilities: string[];
  workspaceMemberships?: Array<{ id: string; displayName: string }>;
}
```

可演进为 `platform:access`, `platform:plugins:manage`, `platform:nodes:read`, `platform:deployments:operate`, `platform:users:admin`、`business:incident:read`, `business:investigation:execute` 等。**这是新建议，不是现有接口事实。** 每个敏感 API 仍要执行服务端资源/角色/范围检查；不要把所有 Capability 放 JWT localStorage 作为权威。

## 6.4 最小服务端接口建议

优先复用 `/api/v1/auth/me` 提供可选扩展字段，旧客户端忽略新字段；如果需要新增 `/api/v1/auth/permissions`，必须记录新契约并确保登录、登出、过期、撤销可见。

**默认拒绝**：无声明或失败 => 不显示 Admin 入口，访问 `/admin` 明确 Forbidden（不要返回一个无数据的 admin 页面）。此外，后端应有至少一个明确经服务端鉴权的访问证明；单纯 AdminShell Route Guard 不是 API 防护。

## 6.5 安全用例

1. 匿名访问 `/app` / `/admin` → Login，Admin API 返回 401。
2. viewer 输入 `/admin/nodes` / `/admin/ext/...` → 403，后台敏感请求不应成功。
3. operator 如现有权限可编辑某资源，切路由后对应功能不变；若不可进入 Admin Console，需产品兼容改造或角色过渡计划。
4. admin 由 `/app` 切 `/admin`，无需重新登录；仍不能读取未授权业务数据。
5. 登出/会话撤销/跨账户切换，清除前端敏感缓存和上个用户工作空间偏好，不泄漏上个用户页面。
6. `/app` 与 `/admin` 同名资源 ID 不得串权；禁止 client-managed scope 决定后端授权。
7. 旧 `/plugins` 等 URL 不能作为绕过 `/admin` 路由限制的秘密通道；访问服务器 API 也须正常拒绝。
8. 插件通过 manifest 提交 `requiredPermissions` 不可视为实际获得这些权限；服务端核验后决定菜单/路由/API。

## 6.6 切换器 UX

- 放在用户菜单或左侧产品标题处；两种 Surface 显示不同图标与说明。
- 按键可访问；各 Surface 的上次访问路径可本地记忆，但需进入前重新鉴权。
- 无可见选项时不展示多余下拉框。
- 失去权限后立即关闭 Admin Tab、清除其查询缓存并跳转 `/403` 或有效的 `/app`，不保留敏感详情。
- `Browser Back` 不能显示未授权缓存。强制 Security Headers 与 Web Cache Policy 的合理处理遵循仓库已有规范。

## 6.7 关键安全区分

**平台 admin ≠ 业务全域 superuser。** 未来业务 Workspace 可以有独立 membership/scope；第一版尚未实现的细粒度隔离不能写成已交付。平台维护视图是高敏控制面，业务视图是使用能力的产品操作面。
