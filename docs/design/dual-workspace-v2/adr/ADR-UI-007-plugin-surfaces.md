# ADR-UI-007 · 插件 Surface 贡献（navigation.item.v2）与服务端按权下发

状态：Accepted（G06 服务端范围）。取代 ADR-UI-004 中"待定"的实施细节，不改写其结论。
影响面：`crates/contracts`、`apps/kernel`（扩展相关模块）、`GET /api/v1/extensions`。
不在范围：前端 Shell 过滤、插件 web 代码、已签名 bundle、脚本与 CI。

## 1. 背景

ADR-UI-001 引入 `/admin/*` 与 `/app/*` 两个 Surface，ADR-UI-003 规定授权权威在 Kernel，
ADR-UI-004 规定**不在已签名 manifest 中原地加字段**。但当前唯一可用的贡献种类
`navigation.item.v1` 没有 `surface` 字段，语义隐式等于"管理台导航"，路径是
`/ext/<publisher>/<name>`。要在不重签旧包的前提下区分 Surface，只能新增**版本化 contribution kind**。

同时，线上事实是：`GET /api/v1/extensions` 对任何已认证会话返回全部 ACTIVE 扩展的全部贡献，
可见性完全交给浏览器。按 ADR-UI-003 的风险 R1（仅 CSS 隐藏可绕过），这不可接受。

## 2. 决策

### 2.1 新增 `navigation.item.v2`，不改 v1

```json
{ "kind": "navigation.item.v2", "id": "catalog-manage", "surface": "admin",
  "path": "/admin/ext/opsweave.data-catalog/manage",
  "titleKey": "catalog.nav.manage",
  "requiredCapabilities": ["platform:access"] }
```

`crates/contracts` 的 `FrontendContribution` 增加三个**可选**字段
（`surface` / `titleKey` / `requiredCapabilities`），并新增 `FrontendContributionKind::NavigationItemV2`。
v1 三种 kind（`route.page.v1`、`navigation.item.v1`、`settings.section.v1`）的报文形状、
语义与 canonical 序列化结果保持不变。

原因：只在 `kind` 上版本化，已签名 bundle 的 `manifest.json` 字节不变，无需重签；
若改 `FrontendContribution` 的既有字段（例如把 `path` 换成 `routeRef`），就必须重签全部历史包，
与 ADR-UI-004 冲突，也会让已安装插件在升级后失效。

`surface` 在反序列化阶段保持原始字符串（不是 enum），这样非法取值
（例如 `root`）产生的是**逐贡献的结构化拒绝**，而不是整个 manifest 解析失败。

### 2.2 服务端强制规则

规则实现在 `crates/contracts`：

```rust
pub fn FrontendContribution::validate_for_plugin(&self, plugin_id: &str)
    -> Result<ContributionSurface, ContributionRejection>;
pub fn deliverable_contributions(plugin_id: &str, contributions: &[FrontendContribution],
    granted_capabilities: &[&str]) -> ContributionDelivery; // { delivered, rejections }
```

| # | 规则 | 拒绝码 |
|---|------|--------|
| 1 | `surface` 必填且仅 `admin`/`workspace` | `MISSING_SURFACE` / `INVALID_SURFACE` |
| 2 | 命名空间 `/admin/ext/<pluginId>/`、`/app/ext/<pluginId>/` | `NAMESPACE_ESCAPE` |
| 3 | 保留前缀 `/admin`、`/app`、`/login`、`/api`、`/internal`、`/assets`、`/ext` 及更浅路径 | `RESERVED_PREFIX` |
| 2' | 命名空间根自身、`//`、`.`、`..`、非页面段 | `INVALID_PATH` |
| 4 | `requiredCapabilities` ⊆ 已知能力集合 | `UNKNOWN_CAPABILITY` |
| 6 | v1 贡献携带 v2 字段 | `UNEXPECTED_FIELD` |
| — | plugin id 不能命名命名空间 | `INVALID_PLUGIN_ID` |

`ContributionRejection` 是结构化对象：`{ code, pluginId, contributionId, kind, detail }`，
`code` 为 SCREAMING_SNAKE_CASE 稳定码，`detail` 说明被拒的取值与期望前缀。
**被拒的贡献从不静默丢弃**：它在 `ExtensionView.rejections` 中返回，并写入 Kernel 警告日志。
`rejections` 是 manifest 诊断信息（插件 id 本就对已认证会话可见），**不是**授权状态；
因能力不足被过滤的贡献绝不进入 `rejections`，否则等于披露该会话无权进入的 surface。

同一函数被 `ManifestV11::validate()` 调用，因此 Bundle 校验/激活前的 manifest 校验也会拒绝非法 v2 贡献
（失败关闭），与下发期的逐贡献过滤互为纵深。

### 2.3 按权下发（规则 5）

`GET /api/v1/extensions` 从 `AuthUser.role` + `OPSWEAVE_ADMIN_SURFACE_ROLES` 推导
`auth::access_for(...).capabilities`，再交给 `deliverable_contributions`：

- admin surface 贡献要求 `platform:access`；
- workspace surface 贡献要求 `workspace:access`；
- 外加 `requiredCapabilities` 全部命中；
- 不满足的贡献**既不出现在 `contributions`，也不出现在 `rejections`**（否则等于披露该会话无权进入的 surface）；
- 一个扩展若过滤后既无交付也无拒绝，整条扩展不下发（避免为一个空列表加载远端 UMD）。

能力词表只有一个来源：`opsweave_contracts::{CAPABILITY_PLATFORM_ACCESS, CAPABILITY_WORKSPACE_ACCESS}`，
`apps/kernel/src/auth.rs` 直接复用该常量，`KNOWN_CONTRIBUTION_CAPABILITIES` 即
`{"platform:access","workspace:access"}`。**当前不存在** `business:quality:read` 之类的业务能力；
示例 JSON 中的此类取值会被 `UNKNOWN_CAPABILITY` 拒绝，而不是被隐式授予。扩充词表必须走新的 ADR + 合同变更 + 负向测试。

### 2.4 激活与就绪（规则 7）

只有同时满足以下条件的插件贡献才可下发：

1. `activation_revisions.status = 'ACTIVE'`；
2. 发布者 `trusted_publishers.trust_state = 'TRUSTED'`（沿用原有失败关闭语义）；
3. plugin 有 frontend；
4. **有 backend 的插件**：该激活版本的 deployment 至少有一个 `desired_action='START' AND state='READY'` 实例；
   **纯前端插件**（`manifest.backend` 为空）没有实例可等，以 ACTIVE 为准。

第 4 条是对"ACTIVE 且实例 READY"的落地：把 `desired_replicas=0` 的纯前端插件也要求 READY 会让现存
前端扩展整批消失，那不是本 ADR 想要的兼容结果。就绪判定在 Rust 中完成（`extension_views`），
SQL 只提供 READY 实例计数，便于离线单测。

### 2.5 签名 / 重签策略

- **不重签任何已发布 bundle。** v1 contribution 的三个新字段使用
  `#[serde(default, skip_serializing_if = ...)]`，v1 manifest 反序列化后再序列化（即
  `crates/bundle` 计算 `manifestDigest` 的过程）与原 JSON 的 canonical 字节完全一致；
  `v1_manifest_canonicalises_to_the_same_bytes` 直接比对 `canonical_json` 结果作为回归证据。
- v2 贡献只能出现在**新构建、新签名**的 bundle 里。若要给存量插件补 v2 贡献，必须重建 bundle
  并重新签名（新版本号），不得改动已签文件。
- 旧 Kernel（不识别 `navigation.item.v2`）遇到 v2 bundle 会在解析期失败：这是预期的前向不兼容，
  升级顺序为"先升级 Kernel，再分发含 v2 贡献的 bundle"。

### 2.6 保留前缀

`/admin`、`/app`、`/login`、`/api`、`/internal`、`/assets`、`/ext` 归宿主所有：
任何 v2 贡献路径必须**严格深于**自己 Surface 的扩展命名空间（至少一个页面段），
否则 `RESERVED_PREFIX`/`INVALID_PATH`。插件无法通过 v2 贡献占用核心路由、也无法用
`/admin/ext/<其他插件>/…` 逃出自己的命名空间。

**v1 不做命名空间强制**：真实已签名 bundle 使用的是 `/ext/<publisher>/<name>`
（例如 `/ext/trusted-team/data-catalog`，publisher ≠ pluginId），对其追加命名空间规则会直接拒绝现存包，
违反"已签名 bundle 一个字节都不改"的约束。v1 只保留原有的语法路径校验，语义等同 admin surface。

## 3. 信任边界：远端 UMD **不等于** sandbox（必须如实声明）

远端 `remoteEntry.js` 是在宿主页面**同一 JavaScript 上下文**里执行的受信代码。
Signed Manifest、RBAC、`requiredCapabilities` 过滤只能决定"是否加载、向谁展示"，
**不能**把恶意插件 JS 限制在沙箱内：它可以读 `window`、改 DOM、调用宿主已认证的 API 客户端。
因此：

- 本 ADR 不声称插件已隔离，也不把 Surface 分离当作安全边界；
- 真正的隔离（独立 origin / iframe + 受控 postMessage）需要单独 ADR 与单独 Gate，不在本轮；
- 插件可信度由发布者签名与 trusted publisher 列表管理，这是**供应链**控制，不是运行时沙箱。

## 4. 已知后果与跨任务依赖

- v1 贡献按规则 6 归入 admin surface，因此**只有 `platform:access` 会话能看到旧 `/ext/*` 导航项**；
  URL 与 manifest 不变，管理员不受影响。这是规则 5+6 的直接后果，不是回归。
- 前端 `apps/platform-web/src/extensions.tsx` 现有的 `SHELL_RESERVED` 检查会把 `/admin/…`、`/app/…`
  判为冲突，从而拒绝加载该扩展的远端模块。**v2 路径真正展示依赖 G06 前端任务同步更新该检查**；
  本 ADR 只承诺服务端契约与下发，不承诺当前前端已能渲染 v2 路径。
- `contracts/schema/plugin-manifest.v1.schema.json` 与 `contracts/examples/` 属本任务边界之外，
  尚未加入 v2 字段；在补齐前，Schema 校验器会拒绝 v2 contribution（失败关闭，不会放行未校验字段）。
- `ExtensionView` 新增 `rejections` 字段属加性变更；前端 `Extension` 类型忽略未知字段，无需改动即可继续工作。

## 5. 验收证据（G06 服务端部分）

- `cargo test -p opsweave-contracts`：v2 规则逐条负向用例、v1 字节级回归、能力过滤。
- `cargo test -p opsweave-kernel`：`workspace_only_session_receives_no_admin_contribution`、
  `platform_session_receives_legacy_v1_contribution_unchanged`、
  `backend_without_a_ready_instance_withholds_its_contributions`、
  `invalid_v2_contribution_is_reported_instead_of_dropped`、`extension_with_nothing_to_deliver_is_omitted`。
- `cargo fmt --check`、`cargo clippy --workspace --all-targets -- -D warnings`。
