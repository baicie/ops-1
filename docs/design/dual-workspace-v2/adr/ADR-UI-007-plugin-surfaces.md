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
（`surface` / `titleKey` / `requiredCapabilities`），并新增两个 v2 kind：
`FrontendContributionKind::NavigationItemV2`（`navigation.item.v2`）与
`FrontendContributionKind::RoutePageV2`（`route.page.v2`，页面侧的 v2 契约，见 §4）。
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
| 2' | 命名空间根自身、`//`、`.`、`..`、非页面段；v1 分支只复用其中的 `.`/`..` 段级规则 | `INVALID_PATH` |
| 4 | `requiredCapabilities` ⊆ 已知能力集合 | `UNKNOWN_CAPABILITY` |
| 6 | v1 贡献携带 v2 字段 | `UNEXPECTED_FIELD` |
| — | plugin id 不能命名命名空间 | `INVALID_PLUGIN_ID` |

`ContributionRejection` 是结构化对象：`{ code, pluginId, contributionId, kind, detail }`，
`code` 为 SCREAMING_SNAKE_CASE 稳定码，`detail` 说明被拒的取值与期望前缀。
**被拒的贡献从不静默丢弃**：它在 `ExtensionView.rejections` 中返回。
Kernel 目前**只下发、不单独记日志**（早先这里声称写警告日志，代码里没有，已改为如实描述）。
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

实现位置就是上面这套逻辑的**唯一**实现：`apps/kernel/src/plugins.rs` 的 `extension_view()`
（`extensions()` 对每一行调用一次，SQL 只负责选行）；能力来自
`auth::access_for(auth.role, config.admin_surface_roles)`，`crates/contracts` 只提供纯函数。
该文件的 `mod tests` 直接调用 `extension_view()` 并断言下发的 JSON，因此"按权过滤"有测试守住。

能力词表只有一个来源：`opsweave_contracts::{CAPABILITY_PLATFORM_ACCESS, CAPABILITY_WORKSPACE_ACCESS}`，
`apps/kernel/src/auth.rs` 直接复用该常量，`KNOWN_CONTRIBUTION_CAPABILITIES` 即
`{"platform:access","workspace:access"}`。**当前不存在** `business:quality:read` 之类的业务能力；
示例 JSON 中的此类取值会被 `UNKNOWN_CAPABILITY` 拒绝，而不是被隐式授予。扩充词表必须走新的 ADR + 合同变更 + 负向测试。

### 2.4 激活与就绪（规则 7）

只有同时满足以下条件的插件贡献才可下发：

1. `activation_revisions.status = 'ACTIVE'`；
2. 发布者 `trusted_publishers.trust_state = 'TRUSTED'`（沿用原有失败关闭语义）；
3. plugin 有 frontend；
4. **（未实现）** 曾计划："有 backend 的插件，其激活版本至少有一个 READY 实例"。
   现状：`extensions()` 的查询只要求 `activation_revisions.status='ACTIVE'`、发布者为 `TRUSTED`、
   `manifest->'frontend'` 非空，**不读取 deployment 实例状态**；因此 backend 尚无就绪实例时，
   该插件的（纯前端）贡献照样下发。本分支没有实现这一条，也没有为它写测试。
   补齐它要先决定"无就绪实例"的语义（不下发 / 下发并标注"backend 未就绪"），以及
   `desired_replicas=0` 的纯前端插件如何豁免——那是一个独立任务，不是本次修复。

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
  URL 与 manifest 不变，管理员不受影响。这是规则 5+6 的直接后果，不是回归。本分支起这一点由
  **服务端**执行（`extensions()` 里的按权过滤），此前只是前端的过滤，服务端并不区分会话。
- **前端已经能渲染 v2 路径**：`apps/platform-web/src/extensions.tsx` 实现了同一套规则
  （`SURFACE_NAMESPACE` 第 42 行、`RESERVED_ROOTS` 第 48 行、`href` 第 167 行），
  旧的 `SHELL_RESERVED` 把 `/admin/…` 一律判为冲突的检查已经不在代码里。
  前端仍保留自己的 surface 过滤，但服务端过滤只会更窄，不会让浏览器看到它原本看不到的东西。
- **Schema 已经加入 v2 字段**：`contracts/schema/plugin-manifest.v1.schema.json` 定义了
  `surface`（第 139 行）、`titleKey`（第 143 行）、`requiredCapabilities`（第 148 行），
  并用 `allOf` 对三个 v1 kind 禁止携带这些字段（第 106–117 行），与 Rust 侧
  `UNEXPECTED_FIELD` 对称，两边不会各说各话。
- **页面级 v2 kind 已补齐**：kind 枚举（第 121–127 行）与 `FrontendContributionKind`
  现在都有 `route.page.v2`；它是 v2 kind，走 §2.2 的同一套校验（`surface` 必填、
  命名空间、保留前缀、能力词表），`is_v1()` 按枚举逐个列出而不再靠后缀推断。
  覆盖它的测试是 `route_page_v2_is_a_v2_kind_with_the_same_surface_rules`。
  此前 ADR 与 `tests/ui/plugin-surfaces.spec.ts` 夹具假定它存在、契约里却没有
  （夹具先行于契约的偏差）。
- **v1 路径不再允许 `..`**：v1 分支在历史报文正则之后复用与 v2 同一个段级规则
  （`crates/contracts/src/lib.rs` 的 `traverses()`），`/ext/<publisher>/../<别处>`
  现在是 `INVALID_PATH`。已签名 v1 manifest 的 `/ext/trusted-team/hello` 形状不受影响：
  `v1_manifest_canonicalises_to_the_same_bytes`（字节不变）与
  `v1_path_refuses_traversal_but_keeps_signed_paths_valid`（路径仍合法）分别覆盖。
- **为什么补契约而不是改夹具**：前端 `apps/platform-web/src/extensions.tsx` 第 132 行
  早已把 `route.page.v2` 当 v2 页面贡献解析，改夹具只会让浏览器与契约一起停在
  “没有页面级 v2”的状态，并把 `ADR-UI-decisions` 里“版本化合同（`navigation.item.v2` 等）”
  中那个“等”永久留空。补 kind 是加性变更，v1 字节兼容测试未改一行且仍通过。
- `ExtensionView` 的 `rejections` 字段**已实现并下发**（`apps/kernel/src/plugins.rs`，
  类型为 `Vec<ContributionRejection>`）；前端 `types.ts` 的 `Extension.rejections?`
  就是它的形状，`extensions.tsx` 读它做诊断。属加性变更。
- **未实现、本 ADR 不承诺**：规则 7 第 4 条的就绪门（见 §2.4）、§3 的插件运行时隔离。

## 5. 验收证据（G06 服务端部分）

本节只列**真实跑过**的命令与输出。没有对应测试的条目就是缺失的验收，不是"以后再补"。

补齐 `route.page.v2` 与 v1 段级校验这一轮，真实跑过的命令与输出：

- `cargo test -p opsweave-contracts`（**改动前**先跑，作为 v1 字节兼容基线）：`running 14 tests`，
  `test result: ok. 14 passed; 0 failed; 0 ignored`，其中包含
  `v1_manifest_canonicalises_to_the_same_bytes` 与
  `v1_contribution_keeps_its_legacy_wire_shape_and_admin_surface`。
- `cargo test -p opsweave-contracts`（改动后）：`running 16 tests`，
  `test result: ok. 16 passed; 0 failed; 0 ignored`。新增两条
  `route_page_v2_is_a_v2_kind_with_the_same_surface_rules`、
  `v1_path_refuses_traversal_but_keeps_signed_paths_valid`；上面那两条 v1 字节/形状测试
  **一行未改**且仍然通过。
- `cargo test --workspace`：`opsweave-bundle 4 passed`、`opsweave-contracts 16 passed`、
  `opsweave-kernel 76 passed`、`opsweave-node 13 passed`、
  `opsweave-pipeline-transform 2 passed`、`opsweave-pipeline-worker 18 passed`，全部 `0 failed`。
  （kernel 的用例数比本节早先写的 64 多，是本分支后来新增的；这一轮对 kernel 只改了一行注释。）
- `cargo fmt --all -- --check`：通过（无输出）；
  `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `python3 tests/contract/validate_contracts.py`：`contract validation passed`，
  `schemas: 15`、`examples validated: 6`、4 个 bundle 均 `ok`。
- schema 行为抽查（`jsonschema` 直接对 `contributions.items` 求值）：`route.page.v2` 带
  `surface` 通过；缺 `surface` 被拒；路径含 `..` 被拒；`route.page.v1` 的
  `/ext/trusted-team/hello` 通过；`route.page.v1` 含 `..` 被拒；`route.page.v1` 携带
  `surface` 仍被拒（与 Rust 侧 `UNEXPECTED_FIELD` 对称）。
- 与按权下发直接相关的 5 条测试仍在 `apps/kernel/src/plugins.rs` 的 `mod tests` 里，
  调用的都是 `extensions()` 每一行都会调用的 `extension_view()`（不是 `crates/contracts`
  里没人调用的私有函数）：`workspace_only_session_receives_no_admin_contribution`、
  `platform_session_receives_every_contribution`、
  `admin_surface_roles_decide_the_grant_instead_of_the_role_name`、
  `extension_with_nothing_to_deliver_is_omitted`、
  `invalid_v2_contribution_is_reported_instead_of_dropped`。
- **不存在**的测试（先前版本在这里列过，属于伪证据）：`platform_session_receives_legacy_v1_contribution_unchanged`、
  `backend_without_a_ready_instance_withholds_its_contributions`。前者被 `crates/contracts` 的
  `v1_contribution_keeps_its_legacy_wire_shape_and_admin_surface` 覆盖（名字不同），
  后者对应的功能根本没有实现（§2.4），所以也不会有测试。
- **本轮没有验的部分**：`tests/ui/plugin-surfaces.spec.ts` 与 `tests/ui/admin-shell.spec.ts`
  需要运行中的 Kernel（`http://127.0.0.1:18181`），而本轮任务边界禁止启动服务器，
  因此浏览器验收**未运行**；`route.page.v2` 的端到端渲染只经过 `tsc --noEmit`、
  `vitest`、`vite build` 与代码审查，抽屉的模态语义同样未经真实浏览器确认。
- **仍存在的夹具偏差（本轮未修）**：`tests/ui/plugin-surfaces.spec.ts` 的 FLAGGED 用例把
  “`route.page.v2` 带 `titleKey`”标成服务端 `UNEXPECTED_FIELD` 拒绝。补上 v2 页面 kind 之后
  这个 payload 已不对应真实服务端语义（`titleKey` 对 v2 kind 合法）；该用例检验的是
  “服务端说不行就是不行”的客户端优先级，断言本身仍然有效，但夹具不再是契约样本。
