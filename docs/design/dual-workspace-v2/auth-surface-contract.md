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

1. **不改任何既有鉴权**：35 处 `require_admin`/`require_operator` 调用点语义完全未动，`access` 只是「能不能进 Admin 控制台」的声明，不参与任何 handler 的放行判定。
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
