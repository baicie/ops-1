# G05 服务端授权声明契约（/api/v1/auth/me 的 access 字段）

状态：**服务端已实现（本轮）**；前端消费为 G05 前端任务，本文只定义服务端权威契约。
实现位置：`apps/kernel/src/auth.rs`（`access_for` / `me_payload`）、`apps/kernel/src/config.rs`（`parse_admin_surface_roles`）。

## 1. 契约（追加式，不删不改既有字段）

`GET /api/v1/auth/me` 在**保留全部既有字段**的前提下追加 `access`：

```json
{
  "user": { "id": "…", "email": "…", "displayName": "…", "role": "admin" },
  "session": { "csrfToken": "…", "viaCookie": false },
  "csrfToken": "…",
  "access": {
    "allowedSurfaces": ["workspace", "admin"],
    "capabilities": ["platform:access", "workspace:access"]
  }
}
```

非 admin-surface 角色（默认配置下 `operator` / `viewer`）：

```json
{
  "user": { "id": "…", "email": "…", "displayName": "…", "role": "operator" },
  "session": { "csrfToken": "…", "viaCookie": false },
  "csrfToken": "…",
  "access": { "allowedSurfaces": ["workspace"], "capabilities": ["workspace:access"] }
}
```

字段说明：

| 字段 | 类型 | 语义 |
|---|---|---|
| `access.allowedSurfaces` | `("workspace" \| "admin")[]` | 本会话允许进入的**渲染面**。`workspace` 恒存在；`admin` 仅当角色在 admin-surface 集合内 |
| `access.capabilities` | `string[]` | 由同一判定派生的能力名。`workspace:access` 恒存在；`platform:access` 与 `admin` surface 同源 |
| `session.csrfToken` | string | 与顶层 `csrfToken` 同值（见 §4 兼容说明） |
| `session.viaCookie` | bool | 本次请求是否用 cookie 认证（决定前端是否必须带 `X-CSRF-Token`） |
| `csrfToken`（顶层） | string | **既有字段，保持不变**；旧客户端继续读它 |

响应**不含** session token 本身、不含密码哈希、不含任何插件/节点凭据。

## 2. 派生规则（服务端唯一权威）

| 角色 | `allowedSurfaces` | `capabilities` | 本轮是否进 Admin 控制台 |
|---|---|---|---|
| `admin` | `["workspace","admin"]` | `["platform:access","workspace:access"]` | 是 |
| `operator` | `["workspace"]` | `["workspace:access"]` | **否**（可经 env 放开，见 §3） |
| `viewer` | `["workspace"]` | `["workspace:access"]` | 否 |

规则要点：

1. 任意**已认证**会话都持有 `workspace` surface 与 `workspace:access`；这**不**等于可读全部业务域数据（见 `permission-matrix.md` §5 过渡差异）。
2. Admin surface 只由「角色 ∈ admin-surface 集合」决定，与请求头、插件自报的 capability、前端存储无关。
3. 前端**不得**由 `user.role` 自行推导 surface；只能消费 `access`。
4. 无法识别的角色字符串在鉴权中间件中降级为 `viewer`（既有行为，未改），因此只会得到 workspace-only 的声明。

## 3. 环境变量 `OPSWEAVE_ADMIN_SURFACE_ROLES`

- 默认值：`admin`（`config.rs` 的 `DEFAULT_ADMIN_SURFACE_ROLES`）。
- 语法：逗号分隔角色名，大小写不敏感，空白忽略，重复项去重。
- **fail-closed**：出现任何无法识别的 token（例如 `operator,root`）、或解析结果为空（`""`、`",,"`）时，整体回退到默认 `[admin]`，并记 `tracing::warn!`；**不做部分采纳**，避免一个拼写错误悄悄放开或收紧权限。
- `admin` 永远在集合内：该变量只能**放宽**，不能用配置把平台管理员锁在 Admin 控制台之外（`OPSWEAVE_ADMIN_SURFACE_ROLES=viewer` ⇒ `[viewer, admin]`）。
- 生效时记 `tracing::info!`，便于审计看到「本部署放开过谁」。
- 变更只影响新进程启动后的 `access` 计算，不追溯修改既有 API 鉴权。

审计后放开 operator 的示例（需重启进程）：

```bash
OPSWEAVE_ADMIN_SURFACE_ROLES=admin,operator ./opsweave-kernel
```

## 4. 兼容策略

| 场景 | 行为 |
|---|---|
| 旧客户端（只认 `user` / `csrfToken`） | 两个字段名称、类型、取值均未变；新增键被忽略 |
| 前端收到**缺失** `access`（旧版 Kernel / 代理裁剪） | 必须按 `allowedSurfaces=["workspace"], capabilities=["workspace:access"]` 处理，即**默认拒绝 Admin**，不得用 `role==="admin"` 兜底 |
| 前端收到 `access.allowedSurfaces` 不含 `admin` | 不渲染 Admin 导航、不加载 admin 路由、不发 admin 数据请求 |
| `session` 对象 | 本轮**新增**的镜像：G05 前的 `/api/v1/auth/me` 只有顶层 `csrfToken`，没有 `session` 对象。为满足前后端钉死的 `user`/`session`/`access` 形状，服务端把会话相关事实同时放进 `session`，并**保留**顶层 `csrfToken`。两处同值，前端任取其一；迁移完成前不得删除顶层字段 |
| 新增端点 | 本轮**不新增** `/api/v1/auth/permissions`；避免第二套权限读取入口 |

## 5. 为什么不改 `contracts/openapi/kernel-v1.yaml`

实测（`grep -n 'auth/me' contracts/openapi/kernel-v1.yaml` 无输出）：该文件只描述了 `/api/v1/health`、`/api/v1/nodes`、实例日志 SSE 等少数路径，**未描述 `/api/v1/auth/me`**，是设计稿子集而非完整契约。按任务约束，本轮不改这个文件（否则等于大改契约范围），改由本文档定义字段与兼容策略。若要把它并入 OpenAPI，需要单独立项，并把 `Error`/`401`/`403` 一并补齐。

## 6. 明确不做（边界）

1. **不改任何既有鉴权**：35 处 `require_admin`/`require_operator` 调用点语义完全未动，`access` 只是「能不能进 Admin 控制台」的声明，不参与任何 handler 的放行判定。**唯一例外**是本轮追加的 §9（6 个平台维护类只读端点由「无守卫」收紧到 `require_operator`），它只收紧、不放宽，且与 `access` 无关。
2. **不引入第二个身份系统**：仍然只有 `kernel.users.role` + `kernel.sessions`；`access` 是同一身份的派生视图。
3. **不做 workspace 级资源授权**：`access` 里没有 `workspaceId` 维度，业务域隔离仍是 `permission-matrix.md` §5 记录的过渡差异。
4. **不改前端**：`apps/platform-web/**` 本轮未触碰。

## 7. 验证记录（本轮实际执行）

| 命令 | 结果 |
|---|---|
| `cargo fmt --check` | 通过（无输出） |
| `cargo clippy -p opsweave-kernel --all-targets -- -D warnings` | 通过（`Finished dev profile`） |
| `cargo test -p opsweave-kernel` | `59 passed; 0 failed` |

新增测试（`apps/kernel/src/auth.rs`、`apps/kernel/src/config.rs`）：

| 测试 | 证明什么 |
|---|---|
| `auth::tests::access_matrix_under_the_default_admin_only_configuration` | 三角色 → 期望 `allowedSurfaces`/`capabilities` |
| `auth::tests::access_declaration_serializes_to_the_contract_field_names` | 序列化后字段名是 camelCase `allowedSurfaces`，不会漏出 snake_case |
| `auth::tests::me_payload_is_additive_and_carries_the_declared_access` | 整个 `/auth/me` payload 逐字节相等断言；`user`/`csrfToken` 不随角色漂移 |
| `auth::tests::operator_enters_the_admin_surface_only_through_the_env_override` | env 覆盖生效，且不影响其他角色 |
| `auth::tests::invalid_admin_surface_env_never_widens_the_surface` | 非法 env fail-closed |
| `config::tests::admin_surface_roles_*` | 解析、去重、大小写、fail-closed、admin 不可被移除 |
| `auth::tests::viewer_is_forbidden_by_every_existing_role_gate` | viewer 过 `require_admin`/`require_operator` 均为 403 `FORBIDDEN` |
| `auth::tests::viewer_receives_403_from_admin_and_operator_gated_routes` | **router 级**：viewer 打 admin/operator handler 都是 403；operator 打 admin handler 403、打 operator handler 200 |

E2E（未执行，本轮禁止服务器操作）——部署后可用如下命令补证据：

```bash
# admin
curl -sS -c /tmp/jar -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"***"}' http://127.0.0.1:8081/api/v1/auth/login >/dev/null
curl -sS -b /tmp/jar http://127.0.0.1:8081/api/v1/auth/me | jq .access
# 期望：{"allowedSurfaces":["workspace","admin"],"capabilities":["platform:access","workspace:access"]}

# viewer（同一命令，期望只拿到 workspace；随后打 admin-only API 必须 403）
curl -sS -b /tmp/jar -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/api/v1/users
# 期望：403
```

## 8. 风险与后续

1. **operator 的最终定位未定**：本轮 operator 只有一个 workspace surface，但它在 23 个管理端点上本来就有权限（见 `permission-matrix.md` §6.2/§8）。放开与否是先审计后配置的决策，已用 env 变量留出开关。
2. **`session` 镜像的收敛**：G05 前不存在该对象；待前端全部改读 `access` 后，应评估是否废弃顶层 `csrfToken`，避免两处漂移（当前由同一次序列化保证同值）。
3. **`access` 不是授权本身**：任何后端 handler 都不得以 `access` 作为放行依据；放行仍只由 `require_admin`/`require_operator` 决定。

## 9. 平台维护类只读接口收紧（G05 验收补强，本轮）

§1 的 `access` 只声明「能否进 Admin 控制台」，不参与放行。因此 G05 之前，平台的**维护类只读**端点对任何已认证角色都开放：这些 handler 只取 `AuthUser`、没有 `require_*`。用真实 viewer 会话在 Staging 实测后暴露了缺口，本节记录收紧决策。

### 9.1 实测证据（Staging，真实 viewer 会话，本轮改造前）

| 请求 | 改造前实测 | 期望 |
|---|---|---|
| `POST /api/v1/plugins/packages` | 403 ✅ | 403 |
| `POST /api/v1/users` | 403 ✅ | 403 |
| `POST /api/v1/nodes/enrollment-tokens` | 403 ✅ | 403 |
| `GET /api/v1/nodes` | **200** ❌ | 后台敏感请求不应成功 |
| `GET /api/v1/plugins` | **200** ❌ | 同上 |
| `GET /api/v1/audit` | **200** ⚠️ | 本轮不动，见 §9.5 |

设计包 G05 验收原文：「viewer 输入 `/admin/nodes` → 403，**后台敏感请求不应成功**」。节点清单含主机名、节点身份、CPU/内存、心跳时间，属平台维护数据；插件清单/详情暴露平台安装与部署拓扑。两者都不属于「已认证即可读」的业务数据，所以前端路由守卫被绕过时（直连 API）也不该成功。

### 9.2 决策

把**平台维护类只读接口**收紧到 `operator` + `admin`（handler 内 `auth.require_operator()?`，与既有 23 个 operator+admin 调用点同一把锁）。**operator 现有能力不变**——它本就有这 6 个只读端点的访问权，本轮只是把它从「隐式人人可读」变成「显式 operator+admin」。

| 端点 | handler | 改造后角色 |
|---|---|---|
| `GET /api/v1/nodes` | `nodes.rs:321` `list_nodes` | operator, admin |
| `GET /api/v1/nodes/{node_id}` | `nodes.rs:355` `get_node` | operator, admin |
| `GET /api/v1/nodes/{node_id}/resource-history` | `nodes.rs:705` `resource_history` | operator, admin |
| `GET /api/v1/nodes/{node_id}/instances` | `nodes.rs:790` `node_instances` | operator, admin |
| `GET /api/v1/plugins` | `plugins.rs:106` `list_plugins` | operator, admin |
| `GET /api/v1/plugins/{plugin_id}` | `plugins.rs:243` `get_plugin` | operator, admin |

拒绝语义沿用既有实现：`403` + 稳定错误码 `FORBIDDEN`（`AppError::forbidden`，见 `auth.rs` 的 `AuthUser::require_operator`）。未认证仍是 `401`（鉴权中间件先拒绝，行为未变）。

**契约一致性（关键旁证）**：`contracts/openapi/kernel-v1.yaml` 早就为 `GET /plugins`（`:51`）与 `GET /nodes`（`:99`）声明了 `'403': Forbidden`，只是实现漏了守卫——所以本次是**让实现追平既有契约**，不需要改 `contracts/`。同一文件里 `GET /nodes/{nodeId}`（`:100`）尚无 403 声明，属契约侧遗留，需另行补齐（不在本轮允许改动的文件范围内）。

### 9.3 影响面

1. **operator 不变**：管理端点从 23 个增加到 29 个（新增的 6 个正是它改造前就能读的只读端点）。没有任何既有授权被提高或降低。
2. **viewer 失去上述 6 个只读端点**：现在返回 403 `FORBIDDEN`。这是本轮唯一的权限收窄。
3. **写操作端点零改动**：`POST /api/v1/plugins/packages`、`POST /api/v1/users`、`POST /api/v1/nodes/enrollment-tokens`、`DELETE /api/v1/nodes/{node_id}` 等保持原判定。
4. **不影响 workspace 面**：前端引用这 6 个端点的页面都在 Admin 控制台（`Nodes.tsx`、`OpsCenter.tsx`、`Governance.tsx`、`Plugins.tsx`、`PluginDetail.tsx`、`InstallWizard.tsx`），viewer/operator 默认拿不到 `admin` surface，本轮不改前端即自洽（页面守卫 403 + API 403 双层）。
5. **未来业务侧资源视图需另立授权**：若以后要在 workspace 面展示「我的节点/资源摘要」「可用插件」这类视图，**不得**放宽本节的 6 个端点，也不得让前端直连 Kernel 维护接口；必须新立一个带资源范围的业务侧端点与权限模型（见 `permission-matrix.md` §5 的过渡差异）。
6. `access.allowedSurfaces` / `capabilities` 不变：这轮收紧不改 `/api/v1/auth/me` 的任何一个字节。

### 9.4 本轮**没有**收紧的端点（明确保持现状）

| 端点 | 现状 | 原因 |
|---|---|---|
| `GET /api/v1/audit` | 三角色均 200（`diagnostics.rs:120` 是**空守卫**：`if auth.role == Role::Viewer { /* 注释 */ }`，不产生拒绝） | 另一决策，本轮不动，见 §9.5 |
| `GET /api/v1/plugins/{plugin_id}/packages`、`/deployments`、`/activations` | 已认证即可 | 属插件详情子资源，不在本轮决策范围；与 §9.3-5 同属待评审项 |
| `GET /api/v1/deployments`、`GET /api/v1/deployments/{id}`、`GET /api/v1/publishers` | 已认证即可 | 部署拓扑与信任根清单也属平台维护数据；本轮按「不扩大范围」保留 |
| `GET /api/v1/plugin-storage/{plugin_id}`、`/migrations` | 已认证即可 | 同上 |
| `GET /api/v1/health`、`/api/v1/overview`、`/api/v1/extensions`、`/api/v1/capabilities` | 已认证即可 | 概况/文案/能力声明，不含节点身份与心跳等维护数据 |

### 9.5 遗留项：`/api/v1/audit` 仍对 viewer 开放

`diagnostics.rs:120` 的 viewer 分支只有注释、没有 `return Err`，所以审计事件列表对三种角色都返回 200（详情字段在写入时已脱敏）。它看起来像 admin-only，实际是**空守卫**，不能当作已保护。本轮按决策**保持现状**，并把该遗留显式登记在此：

- 风险：viewer 可读审计事件元数据（`permission-matrix.md` §7 已记录同一事实）。
- 不做的原因：审计可见性涉及合规口径（谁能看谁的审计），需与 Incident 领域授权模型一起定，不并入本次「平台维护类只读」收紧。
- 若下一轮收紧，判定点只有一个：给 `audit_events` 加 `auth.require_operator()?`（或按合规口径收更紧），并同步更新本节与 `permission-matrix.md` §7。

### 9.6 验收与回滚

- 正向：admin 与 operator 打上述 6 个端点仍 200（operator 能力不变）。
- 反向：viewer 打上述 6 个端点 403 `FORBIDDEN`；写操作端点维持原有 403。
- 回滚：撤掉 6 处 `auth.require_operator()?` 即回到「已认证即可读」，无数据迁移、无契约字段变化。

### 9.7 验证记录（本轮实际执行）

| 命令 | 结果 |
|---|---|
| `cargo fmt --check` | 通过（无输出，exit 0） |
| `cargo clippy -p opsweave-kernel --all-targets -- -D warnings` | 通过（`Finished dev profile`，无 warning） |
| `cargo test -p opsweave-kernel` | `63 passed; 0 failed`（G05 轮 59，本轮 +4） |

新增测试（截至本轮）：

| 测试 | 证明什么 |
|---|---|
| `nodes::tests::viewer_is_forbidden_from_every_platform_node_read` | 直接调用 4 个真实 handler（`list_nodes`/`get_node`/`node_instances`/`resource_history`），viewer 一律 `403` + `FORBIDDEN`，且在第一条 SQL 前就被拒 |
| `nodes::tests::platform_node_reads_answer_403_for_viewer_and_200_for_operator_and_admin` | 4 条真实路由路径 × 3 角色：viewer 403、operator 200、admin 200（router 级，写法与 `auth::tests::viewer_receives_403_from_admin_and_operator_gated_routes` 一致） |
| `plugins::tests::viewer_is_forbidden_from_every_platform_plugin_read` | `list_plugins`/`get_plugin` 对 viewer 同样 `403` + `FORBIDDEN` |
| `plugins::tests::platform_plugin_reads_answer_403_for_viewer_and_200_for_operator_and_admin` | 2 条真实路由路径 × 3 角色：viewer 403、operator 200、admin 200 |

测试的数据库边界（必须如实记录）：Kernel 没有数据库测试夹具（全仓无 `sqlx::test` / 连接池 fixture），因此

- 「viewer → 403」是**真实 handler 调用**，用 `connect_lazy` 的不拨号连接池构造 `AppState`；守卫在第一条 SQL 之前返回，所以断言的是生产代码路径本身；
- 「operator → 200 / admin → 200」是 router 级断言（与既有 G05 写法一致），证明这两角色过同一把 `require_operator` 锁后不再被拒；**未**证明这两个端点在真实数据库上的完整响应体。补齐方式：部署后按 §9.1 同样的 curl 复测（本轮禁止服务器操作，未执行）。

部署后复测命令（viewer 与 operator 各跑一次）：

```bash
for role in viewer operator; do
  # 各自登录后
  for p in /api/v1/nodes /api/v1/plugins; do
    printf '%s %s -> ' "$role" "$p"
    curl -sS -b /tmp/$role.jar -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8081$p"
  done
done
# 期望：viewer 403 / 403，operator 200 / 200
```


