# G05 / P0 — 双 Surface 真正权限闭环（不能只靠前端菜单）

从 G04 实际代码开始，读取 `docs/06-auth-and-permissions.md`、`docs/11-architecture-decisions-and-risks.md`、`checklists/role-route-api-matrix.csv`，结合 `apps/kernel/src/auth.rs`, `routes.rs`, `apps/platform-web/src/auth.tsx`, `types.ts`、Gateway、`/api/v1/auth/me` 与所有敏感管理操作，建立真实 Role/API 表。

## 实施

1. 逐端点枚举 admin/operator/viewer 已有权限，查清 operator 使用的维护功能，不允许 UI 迁移导致现有操作被非预期封禁。
2. 给出阶段性权限 ADR：最小过渡可先让 `role=admin` 访问 AdminShell，但要为 operator 维持现有能力，或先交付真实服务端可验证 `platform:access` 授权再切换。**禁止凭前端 role hardcode 宣称 API 安全。**
3. 若新增 `effective access`/`allowedSurfaces`：先改 OpenAPI、Rust DTO、auth/me 或受控 permissions endpoint，提供兼容旧客户端策略；不让插件提交的 capability 变成 user permission。
4. `RequirePlatformAccess` 仅渲染授权导航；后台各敏感 API 保持 `require_admin`/`require_operator` 或更细服务端资源授权，不因路由调整放宽。
5. Session 过期、禁用账号、权限撤销、切用户时，关闭 Admin 页面并清理敏感查询缓存，Back/Forward 不能恢复未授权详情。
6. `/admin/ext/*` 和旧 `/ext/*` 同样遵循授权，不能借 Legacy 路由访问管理功能。
7. 产出权限矩阵与可审计执行结果：匿名、viewer、operator、admin、禁用/撤销用户、旧 URL 及插件路由的 200/401/403。
8. 交互上给“无权访问”有文案与恢复路径；不能泄露资源的标题/ID/Secret。

## 安全测试

- API 调用用真实会话，不通过模拟前端隐藏来代替拒绝测试。
- 模拟/构造非 admin 访问管理 API 返回 403；匿名 401；管理员不能越过业务资源 scope。
- 如果新的企业级 Scope 尚不存在，清楚标记 NOT_IMPLEMENTED，不凭 UI 说多租户安全完成。
- 检查 CSRF/session cookies 与原认证链路保持不变；前端扩展不拿原始秘密。

## 验收

后端权限矩阵真实通过，双 Shell 与服务端行为一致，operator 兼容策略明确。必须有 Rust/Contract/Web/E2E 的真实输出与最终 SHA。因缺少权限契约无法安全实现时标 PARTIAL/BLOCKED，绝不放行。完成后 G06。
