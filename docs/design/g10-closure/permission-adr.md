# ADR · Phase C1 权限一致性 + C2 登录与切换

- 状态：**审计完成 / 未改动任何权限判定代码**；4 个决策点待产品/架构裁定（D1–D7）
- 日期：2026-10-31
- 分支 / 基线：feat/ui-visual-excellence-v3 @ 64d194e
- 适用范围：apps/kernel/src/{auth,config}.rs、apps/platform-web/src/{surface.tsx,App.tsx}、
  docs/design/dual-workspace-v2/permission-matrix.md、tests/acceptance/data_authz.sh
- 铁律（brief 原文）：**必须先审计并形成 ADR，不得静默收紧或放宽既有 API 策略**；
  **若事实不足以决定新的安全政策，不猜：保留兼容行为、补测试、写清待决策项**。

## 0. 一句话结论

现状是「两层授权」而不是「一套权限」：**Surface 是导航/投递声明，API 是角色门**。二者互不推导，
也没有任何一处服务端代码用 surface 判定核心平台 API（唯一例外是插件 UI 贡献投递，见 §3.2）。
本轮审计**没有发现必须立即修复的越权缺陷**，因此零代码改动；发现 3 处文档与文档/实现不一致、
1 处死代码、1 处结构性缺口、7 个决策点，全部按 brief 登记而不自行裁定。

## 1. 方法与证据基线

做了什么（可复现）：

```bash
# 1) 角色门调用点（生产代码）
grep -rn 'require_admin()\|require_operator(&\|require_operator()' apps/kernel/src --include=*.rs \
  | grep -v 'fn require' | grep -v 'auth.rs'
# -> 35 行：12 admin-only + 23 operator（含 capabilities.rs 私有 helper 的 3 处）

# 2) 路由全表逐条对照 handler 是否带门
apps/kernel/src/routes.rs            # 101-255 全部 protected 路由

# 3) 实机黑盒：现状策略的可执行化
tests/acceptance/permission_matrix.sh        # 24 passed / 0 failed / 2 skipped（角色列见 §9）

# 4) 实机浏览器：会话、切换、URL 绕过、撤销、权限变更
cd tests/ui && ./node_modules/.bin/playwright test permission-consistency.spec.ts   # 8 passed / 2 skipped

# 5) 既有单测基线（未改动，确认无回归）
cargo test -p opsweave-kernel --bin opsweave-kernel auth     # 11 passed
cd apps/platform-web && ./node_modules/.bin/vitest run src/surface.test.ts           # 20 passed
```

**未验证的部分（不伪造）**：operator / viewer 的实机列。本机只有 `admin@opsweave.local` 一个账号，
两个新测试资产都按「凭据缺失即 SKIP」处理，没有创建用户（brief 禁止服务器操作）。
所以 §2 中 operator/viewer 的 API 结论来自**代码 + 文档 + 既有验收脚本**，不是本轮实测。

## 2. C1-Q1 · operator 默认进不了 Admin Console，却保留部分平台管理 API —— 是现状吗？设计还是漏洞？

### 2.1 现状（三条独立证据）

1. **声明层**：`/api/v1/auth/me` 的 `access` 由 `access_for()` 生成（apps/kernel/src/auth.rs:79-91）：
   角色 ∈ `OPSWEAVE_ADMIN_SURFACE_ROLES` 才拿到 `["workspace","admin"]` + `platform:access`，
   否则只有 `["workspace"]` + `workspace:access`。默认集合只有 `admin`（apps/kernel/src/config.rs:171-177，
   环境变量读取在同文件 66-69）；非法值整体回退到 `admin` 并打 warn（config.rs:203-210），
   `admin` 永远被保留（config.rs:213-215）。
   代码注释明确写了它**只**是导航/路由声明（auth.rs:73-78：*"...neither widens nor narrows any
   existing require_admin/require_operator API gate"*）。
2. **能力层**：operator 通过 `require_operator` 的调用点共 **23 处**（§1 的 grep）：
   packages.rs:82；deployments.rs:201/389/662/793/904；jobs.rs:63/194/257/274/296/1045/1121/1208/1475/1699/3409；
   logs.rs:65/99；capabilities.rs:129/143/209；diagnostics.rs:153。这 23 处是**真实管理能力**
   （插件上传/部署/激活/禁用/启停/回滚、实例详情与 SSE 日志、能力授予、流水线全流程、作业提交/取消）。
   同时 operator 被 **12 处** `require_admin` 挡在门外（users×3、publishers×2、nodes×2、storage×2、
   deployments::uninstall、diagnostics×2）。
3. **契约层**：`Role::can_operate()` = Admin｜Operator；`is_admin()` = Admin（crates/contracts/src/lib.rs:751-759）。
   角色解析失败降级 `Viewer`（auth.rs:156），是失败闭合而非放开。

### 2.2 判定：**设计（现状正确）**，不是漏洞

判据不是"看起来合理"，而是三个可核对的事实：

- **时间顺序**：`require_operator` 在 deployments/jobs 里来自 0.0.1 地基提交 `7ae93aa`；
  surface 概念（`admin_surface_roles` / `access_for`）来自 `51e8eb7`（G00–G10）。
  即"operator 有 API 权限"**先于**"surface 存在"，不是 surface 引入的回归，也没有被 surface 改动过。
- **书面理由**：permission-matrix.md:143-148 明确写了本轮把 operator 的 `allowedSurfaces` 定为
  `["workspace"]` 的原因——控制台会出现 12 个"点了就 403"的菜单，属**用导航制造错误授权暗示**；
  放开路径是环境变量而非代码。
- **双层不可互推**：前端从 `user.role` 推导 surface 被明令禁止（surface.tsx:4-13 模块注释 +
  App.tsx:69-80 守卫只读 `access`）；服务端 35 个门也从不读 `access`。两者之间只有一条
  单向数据流（role → 声明），不存在"声明反过来放宽 API"的路径。

**它不是缺陷的原因**：operator 拿到的是**服务端角色门**授权的真实能力，不需要控制台也能被审计
（审计记录在 kernel.audit，不依赖页面）。真正的风险是**运营性**的：有能力无入口 ⇒ operator 会走
curl/脚本，页面上的动作痕迹消失。

### 2.3 遗留（登记，不改）

- D1：是否 `OPSWEAVE_ADMIN_SURFACE_ROLES=admin,operator`。
- 放开之前必须先做前端"按能力渲染菜单"，否则 12 个 403 页会成为噪声（当前无此实现）。
- permission-matrix.md §6.2 第 35 行行号已过期：文档写 `jobs.rs:3371`，实测 `jobs.rs:3409`（本轮 grep）。
  该文件不在本轮可改范围（仅 docs/design/g10-closure/** 可写），故在此记录，未改原文件。

## 3. C1-Q2 · viewer 可访问哪些平台只读接口？依据是什么？

### 3.1 清单（路由 → handler → 门）

依据：`routes.rs:101-255` 里每条 protected 路由只挂了 `auth_middleware`（auth.rs:120-172，只证明
"已认证"）；handler 只解构 `AuthUser` 而未调用 `require_*`。逐条：

| # | 端点 | 路由 routes.rs | handler | 门 |
|---|---|---|---|---|
| 1 | GET `/api/v1/overview`、`/api/v1/health` | 104-105 | plugins.rs:551 | 无 |
| 2 | GET `/api/v1/plugins` | 106 | plugins.rs:105 | 无 |
| 3 | GET `/api/v1/plugins/{id}` | 111 | plugins.rs:240 | 无 |
| 4 | GET `/api/v1/plugins/{id}/packages` | 112-115 | plugins.rs:372 | 无 |
| 5 | GET `/api/v1/plugins/{id}/deployments` | 116-119 | deployments.rs:167 | 无 |
| 6 | GET `/api/v1/deployments/{id}` | 140-143 | deployments.rs:185 | 无 |
| 7 | GET `/api/v1/nodes` | 149 | nodes.rs:317 | 无 |
| 8 | GET `/api/v1/nodes/{id}` | 154 | nodes.rs:349 | 无 |
| 9 | GET `/api/v1/nodes/{id}/instances` | 155-158 | nodes.rs:782 | 无 |
| 10 | GET `/api/v1/nodes/{id}/resource-history` | 159-162 | nodes.rs:697 | 无 |
| 11 | GET `/api/v1/audit` | 164 | diagnostics.rs:115 | **空守卫**（diagnostics.rs:120-124：if viewer 分支里只有注释） |
| 12 | GET `/api/v1/publishers` | 177 | publishers.rs:23 | 无 |
| 13 | GET `/api/v1/extensions` | 183 | plugins.rs:453 | 无（内部按 role 过滤贡献，§3.2） |
| 14 | GET `/api/v1/capabilities` | 184 | plugins.rs:496 | 无 |
| 15 | GET `/api/v1/capabilities/{name}/{major}/resolve` | 185-188 | capabilities.rs:237 | 无 |
| 16 | GET `/api/v1/plugin-storage/{id}` | 197-200 | storage.rs:52 | 无 |
| 17 | GET `/api/v1/plugin-storage/{id}/migrations` | 201-204 | storage.rs:503 | 无 |
| 18 | GET `/api/v1/pipelines`、`/{id}`、`/{id}/revisions`、`/{id}/revisions/{r}`、`/{id}/revisions/{r}/plan` | 205-238 | jobs.rs:849/903/964/1017/1371 | 无 |
| 19 | GET `/api/v1/jobs`（列表，行级过滤见 Q4） | 239 | jobs.rs:1840 | 无 |
| 20 | GET `/api/v1/jobs/{id}`（摘要） | 240 | jobs.rs:1989 → require_job_access(sensitive=false) jobs.rs:1958-1986 | 行级 |
| 21 | ANY `/api/v1/gateway/{plugin}/{*path}` | 247 | gateway.rs:28 | 三角色白名单（gateway.rs:38-45），插件侧再判 |
| 22 | POST `/api/v1/pipelines/validate` | 209-212 | jobs.rs:58-63 | operator（viewer 403） |

对照 permission-matrix.md §7：它只列了 #2/#4/#5/#13/#14 一类"插件清单/部署/包"，
**missing：#11 audit、#18 pipelines×5、#19/#20 jobs、#17 migrations、#15 resolve、#1 overview**。
这是文档不完备，不是代码缺陷。

### 3.2 依据（三个来源）

1. **代码事实**：上述 handler 无门（见上表行号）。
2. **契约事实**：插件贡献投递是唯一"真用 capability 做拒绝"的地方——
   `ContributionSurface::required_capability()`（contracts/src/lib.rs:169-176）把
   admin→`platform:access`；`deliverable_contributions(plugin, contributions, &granted)`（lib.rs:434）
   按会话能力过滤，kernel 在 plugins.rs:422-432 用它生成 `/api/v1/extensions` 与 `/admin/ext|/app/ext` 路由。
   契约测试 lib.rs:1305-1311 明确："an admin contribution must not reach a session without platform:access"。
3. **产品验收事实**：`tests/acceptance/data_authz.sh:54-55/69-70/92-93/98-99` 把 viewer 的读写成
   **200**（且 CI 会跑），permission-matrix.md:157-173 §10 记录了上一次"为了收紧而改断言"被回退的先例。

### 3.3 判定：**设计（保留）+ 文档缺陷 + 待决策**

- 设计：viewer 是"只读观测者"，平台清单本身不含密钥；敏感读（结果、诊断、运行时策略、日志）
  仍被门/行级规则挡住（jobs.rs:1973-1985、diagnostics.rs:39/138、logs.rs:65/99）。
- 文档缺陷：§7 清单不完整（上表 missing 项）。原文件不在可改范围，记录于此。
- **待决策 D3**：viewer 是否应继续读"全平台清单 + 全部作业摘要"。
  若收紧：必须先改 data_authz.sh 的 4 条 200 断言 + 本 ADR，否则就是 brief 禁止的静默收紧。

## 4. C1-Q3 · Surface 权限与资源权限的区别；有没有一处把两者混用？

### 4.1 代码怎么表达

| 层 | 载体 | 判定者 | 作用面 |
|---|---|---|---|
| Surface 权限 | `AccessView{allowedSurfaces,capabilities}`（auth.rs:63-69/79-91） | 只在 `GET /auth/me` 下发（auth.rs:384-411） | 浏览器导航：`canEnterSurface`（surface.tsx:93-97，admin 需 surface+capability 双一致）；插件贡献投递（§3.2） |
| 资源权限 | 35 个 `require_*` + 行级 SQL/函数（jobs.rs:1883、1958-1986、282/320/330/1235） | 每个 handler | 每一个 API 响应 |

关键事实：**核心平台 API 从不读 surface**。全仓搜 `CAPABILITY_PLATFORM_ACCESS` 只有
contracts:113（定义）/171（surface→能力映射）/434+1305-1311（投递与契约测试）+ auth.rs:60/83（声明），**零个 handler**。
因此"页面 403"与"数据 403"是两个独立结论——这不是失误，而是"服务端不信任前端"的必然结果。

### 4.2 三处值得点名的"混用/重复"

**(a) 结构性缺口（最重要，实测）**：同一会话可以"页面 403 / API 200"。
`tests/ui/permission-consistency.spec.ts` 的
`"a refused surface keeps its API readable"` 就是这么断言的：把 `access` 改成 workspace-only 后
`/admin/nodes` → `/403`，而同一 cookie 下 `GET /api/v1/nodes`=200、`GET /api/v1/settings/runtime-policies`=200。
判定：**设计**（导航不是授权；服务端不读前端声明）。但它使 permission-matrix.md §3 的
"路由期望 / API 期望"并列表格容易被误读成"路由 403 ⇒ 数据 403"，§3 实际要求的是**两层都要卡**。
本轮把这个事实写成可执行测试，谁将来加服务端 surface 门，这个测试会**先失败**，从而强制回到本 ADR。

**(b) 唯一把"默认值"写成"授权"的地方**：surface.tsx:78-81，`normalizeAccess` 在
`allowedSurfaces` 是空数组时回填 `DENY_ACCESS`（= `['workspace']` + `['workspace:access']`）；
而 `canEnterSurface` 对 workspace **只看 surface 列表、不看 capability**（surface.tsx:96）。
即"声明为空白"会被升级成"可进 workspace"。现状无影响（服务端对所有角色都下发 workspace），
但一旦 workspace:access 变成可撤销，这里就会把"撤销"读成"允许"。
判定：**待决策 D4**（改法二选一：声明即否认 / 保持"已认证即 workspace"），本轮不动代码；
surface.test.ts:20 已经把当前行为钉住，改不改都会先红一次。

**(c) 同一判定两份实现**：`capabilities.rs:846-852` 的模块私有 `require_operator(&auth)`
（`role == Admin || role == Operator`）与 `AuthUser::require_operator`（auth.rs:34-43）语义重复，
由 3 个调用点（capabilities.rs:129/143/209）使用。今天等价，角色扩展时会漂移。
判定：**技术债**（资源层内部，不是 surface 混用），登记不改。

## 5. C1-Q4 · 管理员与业务数据授权的隔离：管理员能读到业务数据吗？

### 5.1 能读到，三条路径

1. **作业与草稿（kernel 内业务数据）**：`list_jobs` 的 SQL 绑定
   `is_admin() || !can_operate()`（jobs.rs:1883）→ admin 全见、operator 只见自己、**viewer 全见摘要**；
   `require_job_access`（jobs.rs:1958-1986）里 admin 首行直接 `Ok(())`（1965），
   operator 仅本人（1968-1979），viewer 只允许非 sensitive（1981-1985）；
   草稿读写发布一律 `created_by=$3 OR is_admin`（jobs.rs:282/320/330/1235）。
2. **插件业务数据（data plugins）**：授权**完全下沉到插件**。gateway.rs:114 把
   `x-opsweave-user-role` 注入上游；插件把角色映射成 scope：
   data-catalog/backend/server.mjs:70-74（admin|operator → `dataset:read+write`；viewer → `read`）、
   data-integration/backend/server.mjs:93-97（同构，`source:*`）。
   ⇒ **admin 与 operator 对业务数据的权限完全相同**，没有人/租户/行级维度。
   这与 data_authz.sh:104-120 一致（operator 创建 dataset/source/spec/run 全部 201/202）。
3. **无 workspace 维度**：`grep -rn 'workspace_id\|workspaceId\|tenant_id\|tenantId' apps/kernel/src
   crates/contracts/src` → **0 命中**。隔离在数据模型上尚不存在。

### 5.2 判定：**待决策（已知过渡差异），不是缺陷**

- 产品约束 ADR-UI-003 + docs/02 §2.2 要求"平台 admin 不自动获得业务域敏感数据"，
  但现有 RBAC 只有 3 个全局角色、没有资源维度，**物理上无法表达**；
  permission-matrix.md:43-46 §5 已把它标成过渡差异，并指向 0.1.0 Incident 领域 ADR。
  按 brief，本轮**不伪造隔离**。
- 好的部分（不要回退）：gateway 会**丢弃入站 `x-opsweave-*` 头**（gateway.rs:118-135，130-134 的
  `starts_with("x-opsweave-")` 分支），身份头只能由 kernel 注入；capability 调用另用 workload token
  （capabilities.rs:590-613 先验签、再验绑定/授权），业务插件绕过 kernel 直接调的能力路径不成立。

### 5.3 风险登记（不修，必须让 owner 知道）

**R1 · 插件信任未签名的角色头**。`identity(req)` 先验 `x-opsweave-caller-context`（HMAC，workload 用），
再**直接读取** `x-opsweave-user-role`（data-catalog:70-74 / data-integration:93-97）。今天安全的前提是
"插件数据端口不可被任意客户端直连"（gateway 剥离入站头 + 节点网络策略 + valid_node_data_endpoint）。
若某部署把节点数据端口暴露到可被浏览器/终端直连的网段，任何人自带一个
`x-opsweave-user-role: admin` 头即可获得全部业务读写。
建议（0.1.0 收口，不在本轮）：用户身份也走 HMAC caller-context，或插件只接受 kernel 的 workload 身份。

## 6. 判定汇总

| 问 | 结论 | 依据强度 |
|---|---|---|
| Q1 operator 有 API 无控制台 | **设计**（先有 API 后有 surface；书面理由在 §8） | 强（代码+提交顺序+文档） |
| Q2 viewer 可读平台只读接口 | **设计（保留）+ 文档不完备 + D3** | 中（代码与验收脚本；平台端点缺书面策略） |
| Q3 surface vs 资源 | **两层不同机制，无越权；1 处结构性缺口（设计）、1 处待决策、1 处技术债** | 强（含实测） |
| Q4 admin 与业务数据 | **待决策/过渡差异；R1 真实风险** | 强（代码）+ 中（意图） |

**没有需要立即修的权限缺陷** ⇒ 本轮**零权限代码改动**（brief 允许的唯一前提未触发）。

## 7. C2 · 登录与切换（逐条）

### C2.1 有平台权限的用户可无感切换 Admin/Workspace —— 通过
- 机制：切换器只在服务端允许时渲染（SurfaceChrome.tsx:161-186，`canEnterSurface(access, other)`），
  目标地址是同 surface 的历史位置或首页（surface.tsx:164-166），触发的是 `<Link>` 客户端路由，
  `AuthProvider`/`BrowserRouter` 均不卸载（App.tsx:125-190）。
- 实测：`permission-consistency.spec.ts`「one cookie session reaches the console without a login form」、
  「switching surfaces reuses the same session and the same document」——往返后
  `framenavigated` 记录里 **0 次 `/login`**，登录按钮 count=0。结果：passed。

### C2.2 没有授权不能通过 URL 绕过 —— 通过（并说明它的边界）
三层一起看，缺一不可：
1. **传输层**：`/admin/*` 不是 API，SPA fallback（routes.rs:265-267，static_site）对**所有人**返回
   200 index.html。所以"URL 返回 200"不能当授权证据——任何人可以拿到空壳。
2. **渲染层**：守卫在 `<Outlet/>` **之前**决定（App.tsx:69-80），拒绝时子树根本不创建
   → 不挂 shell、不发数据请求。实测「a workspace-only grant is refused before the console shell
   renders or fetches」：`/admin/nodes` → `/403`，`.admin-sidebar`=0、`table`=0，
   且 **零** `/api/v1/nodes` 请求（用请求记录断言，不是"看起来没渲染"）。
3. **数据层**：真正的拒绝由 35 个角色门承担；匿名访问全部 401（permission_matrix.sh 9 条）。
- 边界（必须写清）：第 3 层与第 2 层**不联动**（§4.2(a)）。viewer 手工请求 API 能拿到清单，
  这是当前策略（§3），不是 URL 绕过；URL 绕过的定义是"绕过界面拿到界面拒绝的数据"，
  在 core API 上两者的边界恰好重合，在 extensions 上才由 capability 真正切断（§3.2）。

### C2.3 一个账号只拥有自己的历史位置记录 —— 通过（机制有代价，见 D6）
- 机制：按 surface 存两份路径偏好 + 一份 owner（surface.tsx:109-112），
  `adoptSurfaceOwner` 发现 owner 变了就 `clearSurfaceMemory`（surface.tsx:177-181，auth.tsx:44），
  登出时也清（auth.tsx:116-123）；写入点只有 `useRememberSurface`（surface.tsx:187-193，
  **挂在守卫之内**，所以被拒绝的路径不可能被记住）。
- 实测「surface memory is discarded when the browser is handed to another account」：
  同账号 → 访问 `/` 后回到 `/admin/nodes`；把 owner 改成别的 uuid → 访问 `/` 落到 `/admin/overview`，
  旧路径不复活，owner 被改回当前用户 id。
- 代价（设计选择，不是缺陷）：键不按 userId 做命名空间，隔离靠"owner 变了就整体清空"
  ⇒ A→B→A 切回后 **A 自己的历史位置也丢了**。若要保留，需要按 userId 命名空间化
  （改动会碰 surface.tsx，不在本轮范围）→ 记 D6。

### C2.4 Session 失效与权限变更 —— 失效：通过；权限变更：部分（见 D6）
- **失效**：中间件对过期/停用/查不到的会话统一 401（auth.rs:148-155）；
  前端任何 401 → `opsweave:unauthorized`（api.ts:55-56）→ 代际比对（auth-generation.ts:39-45,56-60）
  → `clearSession` + `advance`（auth.tsx:80-91）。
  实测「a revoked session presented through a stale cookie is sent to `/login`」：
  真实登出（服务端删会话）后把**旧 cookie 塞回浏览器**，再访问 `/admin/nodes` → `/login`。
  这比"清 cookie"更强：证明的是服务端撤销被遵守，而不是浏览器本地清状态。
- **权限变更（提升）**：`/403` 页的 retry 会重取 `/auth/me`（SurfaceChrome.tsx:280-290），
  取回后可自动进入控制台（277-278）。实测「a grant acquired while the tab is open is picked up by
  the retry on /403」→ 通过。
- **权限变更（撤销/其他标签页）**：没有轮询、没有 SSE、没有 `focus` 重取，只有"重新挂载/点 retry/
  下次 401"三条路径 ⇒ **部分覆盖**，登记 D6（若要加，属产品决定，不改）。

### C2.5 默认入口是否应优先业务工作台 —— **产品决定，只写不改**
- 现状（实测 + 代码）：`SurfaceEntry`（App.tsx:100-111）顺序是
  ① 记住的是 workspace 且可进 → workspace；
  ② 可进 admin → admin 历史位置；
  ③ 可进 workspace → workspace；
  ④ 否则 `/403`。
  实测「the default entry for an admin with no remembered state is the console」：admin 首次登陆
  访问 `/` 落到 `/admin/overview`，并写入 `opsweave-surface=admin`。
- **决策点 D2**（两条路径的代价，供产品裁定）：
  - A 保持现状（admin 先进控制台）：合理性=平台运维是主场景；代价=业务用户每次要手动切。
  - B 改为业务工作台优先（②③互换）：合理性=设计包把 workspace 定位为主界面；
    代价=运维人员多一次切换，且与现有 dual-surface.spec.ts 的入口断言冲突（该文件不在本轮可改范围，
    需要一并更新）。
  - 注意：无论选哪条，**都不影响授权**（两条分支都先过 `canEnterSurface`）。

### C2.6 没有重复登录或页面闪烁 —— 通过
- 单一登录：整个 spec 只登录 1 次（worker 级 fixture 复用同一个 cookie），其余用导航记录断言
  没有 `/login`；已登录再访问 `/login` 会被 `<Navigate to="/">` 顶回（Login.tsx:10-17）。
- 闪烁：`RequireAuth`/`SurfaceGuard`/`SurfaceEntry` 在 `loading` 时渲染同一个 `<Splash>`（App.tsx:37-46/55/71），
  会话确立后 `loading` 不会回退为 true（auth.tsx:62-74，注释说明了它是单向latch），
  因此不会出现"Splash → 内容 → Splash"。
- 已知历史缺陷（已修，留作回归依据）：冷启动 `/auth/me` 的 401 曾覆盖刚建立的会话；
  修法是"代际"而非"延迟"（auth-generation.ts:1-15；dual-surface.spec.ts:58-64 记录了 staging 失败
  run 40809470709）。本轮新增的同目录 spec 沿用同一纪律（先等 bootstrap 探测再填表）。

## 8. 决策点清单（全部"只写不改"）

| ID | 决策点 | 现状 | 若改，前置条件 |
|---|---|---|---|
| D1 | operator 是否进控制台 | 不进（默认 admin-only） | 前端按能力渲染菜单；env 开关可回滚 |
| D2 | 默认入口是否 workspace 优先 | admin 优先 | 同步更新 dual-surface.spec.ts 入口断言 |
| D3 | viewer 是否继续读全平台清单/全部作业摘要 | 是 | 先改 data_authz.sh 四条 200 断言 + 本 ADR |
| D4 | 声明的空 allowedSurfaces 是否仍回填 workspace | 回填（surface.tsx:78-81） | surface.test.ts:20 会先红；需给出"已认证≠授权"的取舍 |
| D5 | 业务数据授权模型（tenant/workspace 维度） | 无维度，admin=operator | 0.1.0 Incident 领域 ADR |
| D6 | 权限变更传播（撤销/多标签页）与历史位置命名空间 | 无轮询；A→B→A 丢历史 | 产品决定 + 改 surface.tsx/auth.tsx |
| D7 | `diagnostics::audit_events` 的空 viewer 守卫（diagnostics.rs:120-124） | 死代码，三种角色都能读审计 | 二选一：删死代码，或落实 viewer 限制（后者=收紧，需 D3 同款前置） |

## 9. 本轮改动（可核对）

- 新增 `tests/acceptance/permission_matrix.sh`：把**现状**策略写成可执行断言（24 passed / 0 failed /
  2 skipped）。它是"防静默变更"的护栏：任何悄悄收紧或放宽都会在这里红。
- 新增 `tests/ui/permission-consistency.spec.ts`：真实内核 + 真实会话（8 passed / 2 skipped）。
- 新增本 ADR。
- **未接入 CI**：新的 acceptance 脚本需要在 tests/ci/** 里挂一步，该目录不在本轮可改范围，故在此登记（建议与 data_foundation_ci.sh 同一阶段执行）。
- **权限代码改动：无**。`apps/kernel/src/**` 与 `apps/platform-web/src/**` 一字未改；
  唯一被改的既有文件是**新增**（三个新文件），无既有行为变更。

未跑通的验证（诚实记录）：operator/viewer 列需要 fixture 账号，本机不存在，两个资产都按 SKIP 处理：

```bash
OPSWEAVE_OPERATOR_EMAIL=... OPSWEAVE_OPERATOR_PASSWORD=... \
OPSWEAVE_VIEWER_EMAIL=...   OPSWEAVE_VIEWER_PASSWORD=... \
  tests/acceptance/permission_matrix.sh
cd tests/ui && ./node_modules/.bin/playwright test permission-consistency.spec.ts
```

## 10. 自评：哪一问事实不足却给了确定结论

**Q2 最弱**，且弱点可以定位到具体一句话：*"viewer 读平台只读端点（/api/v1/nodes 等）是设计"*。
- 我手上只有：代码（handler 无门）、路由表（只有认证中间件）、以及 permission-matrix.md §7
  的一行描述（"仍对任何已认证角色开放；本轮刻意不扩大范围"）。
- 我**没有**的：任何一条书面策略说"平台清单对 viewer 开放是产品决定"。
  唯一的书面 200 断言来自 `data_authz.sh:54-99`，而那四条是**data 插件端点**（datasets/
  quality-rules/node-history/governance-summary），**不是** `/api/v1/nodes` 这类平台端点——
  我把前者的证据强度**外推**到了后者。
- 同一处还有第二个弱环：Q1 的"设计而非漏洞"依赖"作者当时是刻意保留"的**意图判断**，
  我能证明的只是"提交顺序 + 文档这么写"，不是作者陈述。

因此本 ADR 的 Q2/§3.3 结论应按"**代码现状 + 文档默认**"读，而不是"产品已批准"。
若需要一条硬结论，必须由 owner 在 D3 上签字；在那之前，permission_matrix.sh 只能锁住"别静默改"。
