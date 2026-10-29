# 权限矩阵（G00 审计，G05 落地）

## 1. 现状授权模型

- 角色：`viewer` / `operator` / `admin`（`apps/kernel/src/auth.rs` 解析，无法识别时降级 `Viewer`）。
- `/api/v1/auth/me` 返回 `{ user: { id, ... role ... } }`（页面已用它渲染角色药丸）。
- 服务端校验点 `require_admin` / `require_operator`：**35 个生产调用点**（G05 审计时即为 35；曾一度记作 41，因为把 6 个平台只读端点的收紧算进来——该收紧已回退，见 §10 更正段），分布于 capabilities、packages、plugins、deployments、nodes、users 等模块。文本级 grep 会数到 44，差额分解见 §6。
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

1. 导出全部校验点的**真实清单**（文件:行 + 所需角色 + 被保护资源），形成 `role-api-matrix` 实测表（当前 41 个调用点，见 §6）。
2. 新增服务端 `platform:access` 判定（可先由角色映射），并让 `/admin/*` 的**数据请求**也受其约束。
3. 负向测试：viewer 直接请求管理 API 必须 403；expired session 必须 401；未认证不得拿到任何列表。
4. 前端 `/403` 页面 + Surface 守卫（无权限时不渲染导航、不发请求）。

## 5. 已知过渡差异（必须写进 G05 报告）

- 当前没有 workspace 级资源授权模型（无 `workspaceId` 维度），因此「admin 不自动读业务域」在第一版**只能标注为过渡差异**，待 0.1.0 Incident 领域 ADR 决定权威模型。
- `operator` 的最终定位（是否进入 Platform Console）需在 G05 用实测矩阵决定，而不是凭设计偏好。

## 6. G05 实测授权清单（全部 `require_admin` / `require_operator` 调用点）

采集方式（可复现）：

```bash
# 文本出现次数
grep -rno 'require_admin\|require_operator' apps/kernel/src --include=*.rs | wc -l        # 58（含定义/注释/测试；生产调用点 41 见下表）
# 调用点（排除 3 处函数定义）
grep -rn 'require_admin()\|require_operator()\|require_operator(&' apps/kernel/src --include=*.rs | grep -v 'fn require'
```

**计数对账（重要，避免把 38 误当成 38 个端点）**：

| 分类 | 数量 | 证据 |
|---|---|---|
| 文本出现总数 | 44 | 实测（命令见上）；含 `auth.rs` 测试模块内的调用与一处定义签名 |
| 其中：`auth.rs` 测试模块内 | 8 | 含 2 个 router 级 stub handler |
| 其中：函数定义 | 1 | `auth.rs:35 fn require_operator(&self)`；`require_admin(&self)` 与 `capabilities.rs:846 fn require_operator(auth:` 的签名形状不在本 grep 的匹配里，所以这 44 行不含它们 |
| 其中：**生产调用点** | **35** | 12 个 admin-only（§6.1）+ 23 个 operator+admin（§6.2），下表逐条列出 |

因此文本计数 44 ≠ 端点数；**受保护的生产调用点实为 35 个**（12 个 admin-only + 23 个 operator+admin）。行号是 `require_*` 的调用行，实测值；`storage.rs:543` 在 `storage.rs` 的 `mod tests` 之后，但它属于生产函数 `apply_migration`，因此计入 35。

> 下表两侧的行号都是 `require_*` 的**调用行**（不是 `fn` 行）。第 36–41 行曾把 6 个平台只读端点记为收紧为「operator + admin」，**该收紧已回退**，计数回到 35，原因见 §10。

### 6.1 admin-only（12 个调用点，仅 `admin` 通过）

| # | 文件:行 | handler | 端点 | 允许角色 |
|---|---|---|---|---|
| 1 | `users.rs:31` | `list_users` | `GET /api/v1/users` | admin |
| 2 | `users.rs:54` | `create_user` | `POST /api/v1/users` | admin |
| 3 | `users.rs:124` | `update_user` | `PATCH /api/v1/users/{user_id}` | admin |
| 4 | `nodes.rs:146` | `create_enrollment_token` | `POST /api/v1/nodes/enrollment-tokens` | admin |
| 5 | `nodes.rs:374` | `revoke_node` | `DELETE /api/v1/nodes/{node_id}` | admin |
| 6 | `publishers.rs:48` | `add_publisher` | `POST /api/v1/publishers` | admin |
| 7 | `publishers.rs:102` | `revoke_publisher` | `DELETE /api/v1/publishers/{publisher_id}` | admin |
| 8 | `storage.rs:72` | `ensure_binding` | `POST /api/v1/plugin-storage/{plugin_id}` | admin |
| 9 | `storage.rs:543` | `apply_migration` | `POST /api/v1/plugin-storage/{plugin_id}/migrations` | admin |
| 10 | `deployments.rs:865` | `uninstall` | `POST /api/v1/plugins/{plugin_id}/uninstall` | admin |
| 11 | `diagnostics.rs:39` | `diagnostics` | `GET /api/v1/diagnostics` | admin |
| 12 | `diagnostics.rs:138` | `settings_policies` | `GET /api/v1/settings/runtime-policies` | admin |

### 6.2 operator + admin（23 个调用点，`operator` 可用）

| # | 文件:行 | handler | 端点 | 允许角色 | 备注 |
|---|---|---|---|---|---|
| 13 | `packages.rs:82` | `upload` | `POST /api/v1/plugins/packages` | operator, admin | |
| 14 | `deployments.rs:201` | `create_deployment` | `POST /api/v1/plugins/{plugin_id}/deployments` | operator, admin | |
| 15 | `deployments.rs:389` | `activate` | `POST /api/v1/plugins/{plugin_id}/activations` | operator, admin | |
| 16 | `deployments.rs:662` | `disable` | `POST /api/v1/plugins/{plugin_id}/disable` | operator, admin | |
| 17 | `deployments.rs:793` | `enable` | `POST /api/v1/plugins/{plugin_id}/enable` | operator, admin | |
| 18 | `deployments.rs:904` | `rollback` | `POST /api/v1/plugins/{plugin_id}/rollback` | operator, admin | |
| 19 | `logs.rs:65` | `get_instance` | `GET /api/v1/instances/{instance_id}` | operator, admin | |
| 20 | `logs.rs:99` | `live_logs` | `GET /api/v1/instances/{instance_id}/logs/live`（SSE） | operator, admin | |
| 21 | `capabilities.rs:129` | `list_grants` | `GET /api/v1/capability-grants` | operator, admin | 走模块内私有 `require_operator`（`capabilities.rs:846`） |
| 22 | `capabilities.rs:143` | `create_grant` | `POST /api/v1/capability-grants` | operator, admin | 同上 |
| 23 | `capabilities.rs:209` | `revoke_grant` | `DELETE /api/v1/capability-grants/{grant_id}` | operator, admin | 同上 |
| 24 | `diagnostics.rs:153` | `bootstrap_page` | `GET /bootstrap` | operator, admin | |
| 25 | `jobs.rs:63` | `validate_pipeline_definition` | `POST /api/v1/pipelines/validate` | operator, admin | |
| 26 | `jobs.rs:194` | `create_draft` | `POST /api/v1/pipelines/{pipeline_id}/drafts` | operator, admin | 草稿归属当前用户 |
| 27 | `jobs.rs:257` | `list_drafts` | `GET /api/v1/pipelines/{pipeline_id}/drafts` | operator, admin | 行级：仅自己的草稿（admin 全见） |
| 28 | `jobs.rs:274` | `get_draft` | `GET /api/v1/pipelines/{pipeline_id}/drafts/{draft_id}` | operator, admin | 行级：`created_by=$3 OR is_admin`（`jobs.rs:282`） |
| 29 | `jobs.rs:296` | `update_draft` | `PUT /api/v1/pipelines/{pipeline_id}/drafts/{draft_id}` | operator, admin | 行级：同上（`jobs.rs:320/330`） |
| 30 | `jobs.rs:1045` | `create_pipeline` | `POST /api/v1/pipelines` | operator, admin | |
| 31 | `jobs.rs:1121` | `publish_revision` | `POST /api/v1/pipelines/{pipeline_id}/revisions` | operator, admin | |
| 32 | `jobs.rs:1208` | `publish_draft` | `POST /api/v1/pipelines/{pipeline_id}/drafts/{draft_id}/publish` | operator, admin | 行级：仅自己的草稿（`jobs.rs:1235`） |
| 33 | `jobs.rs:1475` | `preview_pipeline` | `POST /api/v1/pipelines/preview` | operator, admin | |
| 34 | `jobs.rs:1699` | `submit_job` | `POST /api/v1/jobs` | operator, admin | |
| 35 | `jobs.rs:3371` | `cancel_job` | `POST /api/v1/jobs/{job_id}/cancel` | operator, admin | 之后再过 `require_job_access`（`jobs.rs:3372`，sensitive=true） |

## 7. 不在 `require_*` 里的授权/可见性判定（同样不得放宽）

| 位置 | 机制 | 语义（实测） |
|---|---|---|
| `jobs.rs:1883` | SQL 过滤 `is_admin() \|\| !can_operate()` | `GET /api/v1/jobs`：admin 全见；operator **只见自己提交的**；viewer 不受该过滤影响（`!can_operate()` 为真） |
| `jobs.rs:1958` `require_job_access` | admin=任意；operator=仅本人提交；viewer=仅摘要，sensitive 请求 403 | 调用点：`get_job_result`(1923, sensitive)、`get_job`(1994, 摘要)、`get_job_diagnostics`(3257, sensitive)、`cancel_job`(3372, sensitive) |
| `jobs.rs:282 / 320 / 330 / 1235` | SQL `created_by=$3 OR is_admin` | 草稿的读/改/发布：operator 只能操作自己的草稿，否则 404 `DRAFT_NOT_FOUND` |
| `capabilities.rs:846` | 模块内私有 `fn require_operator` | 与 `AuthUser::require_operator` 等价（Admin\|Operator），3 个调用点见 6.2 |
| `gateway.rs:38` | 角色白名单 `Admin\|Operator\|Viewer` | `/api/v1/gateway/{plugin_id}/{*path}`：三种角色都放行，角色以 `x-opsweave-user-role` 头转发给插件（插件侧权限另计） |
| `diagnostics.rs:120` | `if auth.role == Role::Viewer { /* 注释 */ }` | **空守卫**：不产生任何拒绝，`GET /api/v1/audit` 对三种角色都开放（详情在写入时已脱敏）。不要把它当成 admin-only。**本轮按决策不动**，遗留项登记在 `auth-surface-contract.md` §9.5 |
| 无守卫的其余平台维护类 GET | 只校验 `AuthUser` | `/api/v1/plugins/{id}/packages`、`/deployments`、`/activations`，以及 `/api/v1/deployments(/{id})`、`/api/v1/publishers`、`/api/v1/plugin-storage/{id}(/migrations)` 仍对任何已认证角色开放；本轮**刻意不扩大范围**，清单与原因见 `auth-surface-contract.md` §9.4 |

## 8. 结论：operator 当前能用哪些管理 API？（表格证据）

**operator 可用（29 个端点 = §6.2 的 23 个 + 6 个任何已认证会话可读的只读端点，凭 §6.2 与 §7 证据）**——即「不改代码就已被授权的管理操作」：

- 平台维护类**只读**：节点清单/详情/实例列表/资源历史、插件清单/详情（任何已认证会话可读，见 §7；曾记为「收紧为 operator+admin」，该收紧已回退，operator 的可用性从未变过——见 §10）。
- 插件生命周期：上传包、创建部署、激活、禁用、启用、回滚（**但不能 `uninstall`**，见 §6.1 #10）。
- 运行时观测：实例详情、实例日志 SSE。
- 能力治理：列出/创建/撤销 capability grant。
- 流水线：校验定义、创建/列出/读取/更新草稿（**仅自己的草稿**）、创建流水线、发布修订、发布草稿（仅自己的）、预览。
- 作业：提交、取消（取消实际只对本人作业有效）。
- `GET /bootstrap` 引导页。

**operator 不可用（12 个端点，`403 FORBIDDEN`）**：用户增删改查整套（`/api/v1/users*`）、节点入网令牌与节点撤销、发布者添加/撤销、插件存储绑定与 schema 迁移、插件卸载、`GET /api/v1/diagnostics`、`GET /api/v1/settings/runtime-policies`。

**结论（回答设计问题「operator 能否进 Admin 控制台」）**：

1. operator 有**实质管理能力**（29 个管理端点），但缺少 12 个「平台治理/身份与信任根」端点（用户、节点入站、发布者信任根、存储迁移、诊断与运行时策略）。
2. 因此本轮把 operator 的 `access.allowedSurfaces` 定为 `["workspace"]`（见 `auth-surface-contract.md` §2）：现在放它进 Admin，控制台会出现它点了就 403 的菜单（尤其「用户」「诊断」「运行时策略」这些 admin-only 页面），属于**用导航**制造**错误授权暗示**。
3. 放开路径已留好且不写死代码：`OPSWEAVE_ADMIN_SURFACE_ROLES=admin,operator`；放开的判断依据就是本节表格——若后续把这些 admin-only 页面按角色隐藏、或把「用户/诊断」拆成独立 surface，才应放开。
4. 无论是否放开，**API 鉴权不变**：`/admin/*` 的数据请求仍由 35 个调用点判定，`access` 只是导航声明。

## 9. G05 交付边界（与本节矩阵的关系）

- `/api/v1/auth/me` 新增 `access` 字段：**纯追加**，不改 §6/§7 任何一条判定。
- 负向测试：`apps/kernel/src/auth.rs` 的 `viewer_receives_403_from_admin_and_operator_gated_routes`（router 级：viewer→admin/operator handler 均 403；operator→admin handler 403、→operator handler 200），以及 `viewer_is_forbidden_by_every_existing_role_gate`（错误码 `FORBIDDEN` / 403）。
- §6.2 第 36–41 行的收紧已回退（§10），因此**不存在**与之配套的 4 个测试：`nodes.rs` 没有测试模块，`plugins.rs` 里只有扩展按权下发的测试（`plugins::tests::*`，与角色门无关）。当前真实存在的角色负向测试只有 `auth.rs` 的 `viewer_is_forbidden_by_every_existing_role_gate` 与 `viewer_receives_403_from_admin_and_operator_gated_routes`。


## 10. 更正（2026-10-28，回退 §6.2 第 36–41 行）

本文档 §6.2 曾把 6 个平台只读端点（nodes 列表/详情/资源历史/实例、plugins 列表/详情）记为
`operator + admin`。**该收紧已回退**，这些端点恢复为「任何已认证会话可读」。

原因：`tests/acceptance/data_authz.sh` 是产品自己的授权验收脚本，逐条规定 viewer 的读策略为 200
（第 55/70/93/99 行），而 `tests/ci/data_foundation_ci.sh` 会在 CI 中执行它。为让实现通过而修改
该断言，等于静默变更授权策略。

准确的现有策略分两层：

| 层 | 判定依据 | 现状 |
|---|---|---|
| 能否进入 Admin 控制台 | `access.capabilities` 含 `platform:access` | admin-only（可经 `OPSWEAVE_ADMIN_SURFACE_ROLES` 放宽），有浏览器 403 与 API 证据 |
| 能否读数据 | 已认证即可读；写操作按角色 | 由 `data_authz.sh` 验收，测试覆盖 |

细节与后续若要收紧的前置条件见 `auth-surface-contract.md §9`。
