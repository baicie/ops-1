# 权限矩阵（G00 审计，G05 落地）

## 1. 现状授权模型

- 角色：`viewer` / `operator` / `admin`（`apps/kernel/src/auth.rs` 解析，无法识别时降级 `Viewer`）。
- `/api/v1/auth/me` 返回 `{ user: { id, ... role ... } }`（页面已用它渲染角色药丸）。
- 服务端校验点 **38 处** `require_admin` / `require_operator`，分布于 capabilities、packages、plugins、deployments、nodes、users 等模块。
- **没有** `surface` 概念：一个 `admin` 角色可以访问全部已实现 API。

## 2. 目标（G05）

```
surface=admin     -> 需要 platform:access（当前映射：role ∈ {admin, operator?}）
surface=workspace -> 需要 workspace:access（当前映射：任何已认证用户）
```

**关键约束**（ADR-UI-003 + docs/02 §2.2）：
1. 平台 admin **不自动**获得所有业务域敏感数据读取权限。第一版若现有 RBAC 无法表达，必须在矩阵中标注「过渡差异」，不得伪造隔离。
2. `operator` 现有能力必须审计后保留，不能因为引入 Surface 而误伤（风险 R4）。
3. 前端隐藏入口不构成授权；`/admin/*` 必须 403（页面）+ API 403（数据）。

## 3. 拒绝矩阵（取自设计包 `checklists/role-route-api-matrix.csv`）

| 角色 | Surface | 路由 | 期望 | 示例 API | 期望 | 备注 |
|---|---|---|---|---|---|---|
| anonymous | admin | `/admin/nodes` | `/login` | `/api/v1/nodes` | 401 | 未认证用户绝不获得敏感数据 |
| viewer | admin | `/admin/nodes` | forbidden | `/api/v1/plugins/packages` | 403 | 路由守卫 + 既有 API 授权双层 |
| operator | admin | `/admin/nodes` | **existing_behavior** | `/api/v1/nodes` | 保留 | 改造前必须审计并写测试 |
| admin | admin | `/admin/nodes` | allowed | `/api/v1/nodes` | existing | 仍需具体权限 |
| viewer | workspace | `/app/home` | allowed_if_authorized | `/api/v1/auth/me` | 200 | 不得假设可读全部业务数据 |
| admin | workspace | `/app/incidents` | authorized_scope_only | `/api/v1/incident` | conditional | 平台 admin ≠ 全业务域 |
| viewer | admin | `/admin/ext/example` | forbidden | `/api/v1/capabilities/example/1/manage` | 403 | 无插件路由/API 绕过 |
| viewer | workspace | `/app/ext/example` | conditional | `/api/v1/capabilities/example/1/list` | scope_filtered | 需激活插件 + 真实能力 |
| expired | admin | `/admin/overview` | `/login` | `/api/v1/auth/me` | 401 | 撤销会话并清缓存 |

## 4. G05 必做前置

1. 导出 38 处校验点的**真实清单**（文件:行 + 所需角色 + 被保护资源），形成 `role-api-matrix` 实测表。
2. 新增服务端 `platform:access` 判定（可先由角色映射），并让 `/admin/*` 的**数据请求**也受其约束。
3. 负向测试：viewer 直接请求管理 API 必须 403；expired session 必须 401；未认证不得拿到任何列表。
4. 前端 `/403` 页面 + Surface 守卫（无权限时不渲染导航、不发请求）。

## 5. 已知过渡差异（必须写进 G05 报告）

- 当前没有 workspace 级资源授权模型（无 `workspaceId` 维度），因此「admin 不自动读业务域」在第一版**只能标注为过渡差异**，待 0.1.0 Incident 领域 ADR 决定权威模型。
- `operator` 的最终定位（是否进入 Platform Console）需在 G05 用实测矩阵决定，而不是凭设计偏好。
