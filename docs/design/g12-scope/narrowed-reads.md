# 窄读与空态：谁说「没有」，谁只是「你看不到」

- 状态：**#2 已实现并实测**；**#3 已收窄并实测**（`seesAll` 已移除，见 §3）；**#4 未修（未实测）**；**/api/v1/overview 的 attention 未修（部分未验证）**
- 分支/基线：`feat/g12-ai-investigator` @ `7785ccb`（本轮改动未提交）
- 契约：`contracts/openapi/incident-v1.yaml`（`IncidentList.scope` / `IncidentScope`）
- 理由的书面记录：**本文件 §3** ＋ **ADR-G11-001 §4.6**（`docs/design/g11-incident/incident-adr.md`）。上一轮因文件预算跳过 ADR，本轮补上：契约头要求「改字段先改 ADR」，而本轮**删掉**了一个字段，比加字段更该有书面理由。
- 写给决策者的两件事：**§3.0**（字段只能说它知道的事）与 **§3.4**（D5：viewer 的 `!can_operate()` 放宽，含行号与两个面的矛盾）
- 复现：`artifacts/g12h-scratch/`（scratch DB `opsweave_g12h_scratch` + 18199 + HEAD 重建的 `apps/platform-web/dist`，见 §7）

## 1. 判据

一个列表页能说三句话，它们的前提完全不同：

| 空态 | 它断言的世界 | 只有谁知道 |
|---|---|---|
| `restricted` / `scoped` | 「有一条边界挡在中间」 | 内核（谓词 + 范围） |
| `filtered` | 「你输入的条件把它藏起来了」 | 页面（自己的筛选状态） |
| `none` | ~~「那里什么都没有」~~ → 「这次读没有按 owner 收窄，而且它一行都没返回」 | 内核（它自己施加的谓词） |

第三行是本轮改掉的：上一版把 `none` 写成「那里什么都没有」（一句关于世界的话），而载荷能支持的只是「这次读没有按 owner 收窄」。区别不在措辞，在于**前一句在谓词一变就假，而后一句永远真**。理由见 §3.0。

`items: []` 在这三件事下是同一份字节。浏览器若按角色去猜，就是把一条它看不见的谓词抄第二遍；抄写漂移的方向恰好是「告诉读者没有」，而读者据此认定谓词坏了，就会把泄漏加回来。因此本轮只做一件事：**把内核已经知道的收窄事实放进响应，页面照着说**。谓词一行未改。

## 2. #2 Activity.tsx（不选 subject 时）—— 已修

**修前实测**（operator 与 viewer 同样；1440/en；`artifacts/g12g-scratch/report-before.json`）：

```
[data-empty-state] = "none"
文本 = "No audit events / Actions performed through the Kernel will appear here."
toolbar = "0 of 0 events · newest 200 loaded"
同一时刻 admin 读到的 toolbar = "8 of 8 events · newest 200 loaded"
```

即：账本里 8 条事件，operator 与 viewer 一条都读不到（6 条 `user` + 2 条 `INCIDENT`，其中 INCIDENT 的 owner 是 admin），页面却说「没有任何审计事件」。

**根因**：该页传的是 `subjectType=null`，`auditEmptyKind` 的跨类别分支（`spansSubjectTypes`）从未被启用，于是 `rows.length === 0` 落进 `none`。helper 早就支持这个输入，只是没接上（`apps/platform-web/src/lib/audit-scope.ts:92`）。

**修法**（`apps/platform-web/src/pages/Activity.tsx`）：

1. `const spansSubjectTypes = !subjectType;` 并传给 `auditEmptyKind`（筛选为空时，这次读是「所有类别一次问」）；
2. `restricted` 空态按「问的是某一类」与「问的是所有类」分成两句：前者沿用 `audit.empty.restricted.*`（退出动作＝换类别），后者新增 `activity.empty.restricted.title/description`（`{kinds}` 由内核的 `readableSubjectTypes` 原样填入；当页内还有筛选时附上「清除筛选」）。

**修后实测**（同一脚本、同一数据、同一视口）：

```
[data-empty-state] = "restricted"   data-restricted-ask="every-kind"
文本 = "Only events you own can appear here / This page carries only the INCIDENT, job events whose subject you own;
        every other kind is administrator-only and never reaches it. An empty page is that boundary rather than a
        measurement: it does not report that nothing happened."
```

viewer 同一条路径同一结果；admin 仍是 `8 of 8 events`、无空态（未受影响）。

## 3. #3 Incidents.tsx（产品主页面）—— 已收窄（三处，缺一不可）

**修前实测**（`artifacts/g12g-scratch/report-before.json`）：

```
operator  GET /api/v1/incidents?limit=20 -> 200 {"items":[],"nextCursor":null}          # 响应里没有 scope
[data-testid=incidents-empty] data-empty-state="none"
文本 = "No incident has been recorded yet / This is an empty result, not a healthy system: nothing has been entered.
        Record one here, or post one through the API."
toolbar = "0 on this page"
admin  同端点 = 2 条；viewer 同端点 = 2 条
```

即：平台里有 2 条故障记录，operator 一条都读不到，页面却说「还没有任何故障记录」。**这句话对 operator 是假的。**

### 3.0 本轮裁决：字段只能说它知道的事

上一轮加的是 `{seesAll, narrowedTo}`。其中 `seesAll: true` 被契约描述、被 ADR §4.3 的措辞、也被页面读成同一句话：**「这份列表就是平台上全部的 incident」**。那是一句关于世界的话，而它只在一种意义上为真：相对这条路由此刻恰好施加的那一个谓词。两处后果：

1. **对 admin 有角色决策背书**（admin 读全部是 ADR §4.3 写下的选择）；**对 viewer 却只由 `Caller::from_role` 的 `!can_operate()` 兜出来**（`apps/kernel/src/incidents.rs:145`，函数在 `:137`）——那是一次**偶然放宽，不是一个决定**。同一平台的审计面对同一角色说的是另一句话（§3.4）。
2. 任何**将来**加到 incident 列表上的过滤（软删除、租户、归档、范围）都会让 `seesAll: true` 变成谎话，而响应一个字节都不用改。**这句话没有能力随谓词一起变旧。**

所以本轮**删掉 `seesAll`，只留 `narrowedTo`**，并把语义钉死：

> `narrowedTo: null` ＝ **这次读没有被 owner 收窄**。
> 它**不是**「这次读拿到了全部」，也**不是**「平台上只有这些」。

三处必须同时对齐，少一处就又是一次抄写：§3.1 字段、§3.2 契约、§3.3 文案。

### 3.1 kernel（`apps/kernel/src/incidents.rs`）

`GET /api/v1/incidents` 的响应带 `scope`，本轮把它收窄成**一个字段**：

```json
{"items":[],  "nextCursor":null,"scope":{"narrowedTo":"owner"}}   // operator
{"items":[…],"nextCursor":null,"scope":{"narrowedTo":null}}      // admin / viewer
```

- `IncidentScopeView` 只剩 `narrowed_to: Option<&'static str>`（`Serialize`，camelCase）。上一轮的 `sees_all` 字段**删除**，不是改名——名字本身就在说世界（「看到全部」），换个拼写还是同一句断言；
- `Caller::scope()`（`incidents.rs:153`，推导在 `:168`）**只从 `sees_all` 推导**，不新算任何谓词：true → `None`，否则 → `Some("owner")`；
- `IncidentList.scope` 仍是必填（`incidents.rs:382`），所以「**没有范围信息**」（缺键）与「**这次读未收窄**」（`null`）仍然可区分——这是 `null` 能承载的两种不同事实，不能合并；
- `Caller.sees_all` 本身**保留**：它是绑进 SQL 的那个布尔（`incidents.rs:1040` 绑定，SQL 在 `:1030`：`WHERE ($1::boolean OR i.owner=$2)`）。删它才是改谓词；本轮只删「把它转述成一句关于世界的话」的那个字段。

与 `audit::AuditScopeView` 同思路（「把答案写在行旁边」），但**刻意不复用类型**：audit 表达的是「哪些 subject_type 能到达你」（跨类别集合），incident 表达的是「这一张表按哪个字段收窄」（单一谓词）。两者的失效方向不同，合并会逼其中一个说无关的话。

`narrowedTo` 是字段名而不是布尔：前端那句「只含你负责的事件」必须由载荷授权。将来若出现第二种收窄，值必须改，句子也得跟着改，而不是继续声称 owner。

**谓词一字未动**：`WHERE ($1::boolean OR i.owner=$2)`、`Caller::from_role`、404/403 语义全部原样。本轮唯一改的是「报告哪一个收窄」的字段形状。

测试（真库，禁 skip）：

- `the_reported_scope_agrees_with_the_predicate`：operator 读不到别人的行且 `narrowed_to = Some("owner")`；**owner 读得到自己的行，但仍然 `Some("owner")`**（范围描述的是这次读，不是结果）；admin `None`；并且 `narrowed_to.is_none() == caller.sees_all`——这一条把字段与 SQL 谓词焊在一起，因为 `sees_all` 已不在线上，这是唯一剩下的绑定；
- `the_scope_view_names_its_one_field_for_every_role_on_the_wire`：admin / operator / viewer **三个角色的线上形状完全相同**（对象里只有一个键 `narrowedTo`），值分别是 `null` / `"owner"` / `null`，并显式断言 `seesAll` **不存在**。这是「收窄之后，别的角色会不会又把 null 读成全部」的结构性回答：没有任何角色带着一个取值不同的布尔。viewer 那一行是**记录**而不是背书，见 §3.4。

### 3.2 契约

`contracts/openapi/incident-v1.yaml`：

- `IncidentScope.required` 从 `[seesAll, narrowedTo]` 改为 **`[narrowedTo]`**；删 `seesAll`；`additionalProperties: false` 不变，所以一个**还在发 `seesAll` 的实现现在会被结构校验拒绝**——这是有意的：它不该被当成合规；
- 描述里新增一段 **SEMANTIC BOUNDARY**：这个对象描述的是**这次读**，永远不是平台；客户端可以说「这次读没有按 owner 收窄」，不可以说「这份列表是平台上全部 incident」。同段写明这个布尔「was true only through `Caller::from_role`'s `!can_operate()` half, which no decision chose」，并指向本文件 §3 / ADR §4.6；
- `narrowedTo` 的描述改为：「这次读按哪个字段收窄；`null` 表示它没有施加 owner 收窄…… `null` 是**这个字段能命名的限制缺席**，不是现存量的计数，也不是页面完整的断言」；
- `GET /incidents` 的 description **保留**「admin and viewer see every incident」半句（它描述这条路由的谓词，且对 admin 有 ADR §4.3 背书），但补一句：viewer 走到未收窄分支靠的是 `!can_operate()`，不是任何决定；D5 见本文件 §3.4 / ADR §4.6。

按角色（新）：

| 角色 | 线上 `narrowedTo` | 这次读的含义 |
|---|---|---|
| admin | `null` | 没按 owner 收窄（有角色决策背书）|
| viewer（不可操作者）| `null` | 没按 owner 收窄——**但这是 D5 待决的偶然**，§3.4 |
| operator | `"owner"` | 按 owner 收窄到自己的行 |

### 3.3 web（`incidents.ts` + 两个 i18n 目录；`pages/Incidents.tsx` 本轮未改）

- `incidents.ts`：`IncidentScope` 只剩 `narrowedTo: 'owner' | null`，注释写明 `null` 是「这次读没有施加 owner 收窄」，**不是**「这份列表是平台上全部」；`IncidentListPayload`（`IncidentList` + `scope: IncidentScope | null`）不变。**没有 scope 不等于未收窄**，与 `readAuditList` 同一规则；
- `incidents.ts`：`incidentsEmptyKind({ scope, filtering })` → `filtered | scoped | none`，判据从 `!scope.seesAll` 改为 **`scope?.narrowedTo === 'owner'`**（`incidents.ts:153`）：页面现在读的是「有没有被 owner 收窄」，而不是「有没有看到全部」；
- 空态按 kind 渲染，`data-narrowed-to` 直接暴露载荷值；`scoped` 的动作是「录入一条」（operator 新建的记录 owner 就是它自己，这是唯一能把行放进这个列表的动作）。

**优先级与 audit 相反，是有意的**：audit 那边「拒绝」压过「筛选」（清筛选也变不出被拒绝的类别）；这里收窄并不拒绝你自己的行，所以筛选择先——否则 operator 明明是被自己的条件挡住的，却被告知「你的列表只有你负责的」，指向一个它跨不过去也无需跨的边界。

**文案（en / zh-CN 各四条，本轮改 4 条）**：

| key | 修前（关于世界） | 修后（关于这次读） |
|---|---|---|
| `incidents.empty.none.title` | No incident has been recorded yet / 还没有任何故障记录 | **No incident in this read / 本次读取没有故障记录** |
| `incidents.empty.none.description` | …not a healthy system: **nothing has been entered** / …**目前没有任何记录** | **The kernel returned no row, and this read applied no owner narrowing. That is a statement about this read, not a measurement of the platform** / **内核这次没有返回任何一行，这次读取也没有按 owner 收窄。这两句说的是这次读取，不是对整个平台的测量** |
| `incidents.empty.filtered.description` | Clear them to see **everything your role can read** / 清除筛选即可看到**当前角色可读的全部记录** | Clear them to see **what this list returns** / 清除筛选即可看到**这个列表返回的内容** |
| `incidents.empty.scoped.description` | **An administrator's view is where those are counted** / **需要看全量时由管理员查看** | **An administrator's list is not narrowed this way** / **管理员的列表不按这种方式收窄** |

最后一行的 scoped 文案是同一类毛病的另一半：「需要看全量时由管理员查看」把**另一个角色的视野**也写成了一句关于世界的断言。改后只说「管理员那条读不按这种方式收窄」——那是这个页面真的知道的事。

**修后实测**：见 §7（本轮用 scratch 库 + 18199 + HEAD 重建的 dist 实跑；operator `data-empty-state="scoped"`、`data-narrowed-to="owner"`；admin/viewer 仍是 2 行、无空态、`data-empty-state` 不出现）。

### 3.4 D5 · viewer 的 `!can_operate()` 放宽：现象（不定性）

**这一节是写给决策者的：本条不由本轮在代码里定性。** 本轮只保证一件事——不管 D5 怎么选，响应里已经不存在任何一句话在替 viewer 断言「这是平台上全部的 incident」。

#### 现象（含行号，均为 HEAD `7785ccb`）

1. `apps/kernel/src/incidents.rs:145` — `sees_all: role.is_admin() || !role.can_operate()`。`can_operate()` 是 `Admin | Operator`（`crates/contracts/src/lib.rs:752`），所以 **viewer 落进 `!can_operate()` 那一半**，`sees_all` 为 true。
2. 于是 `GET /api/v1/incidents` 对 viewer 绑定 `$1 = true`（`incidents.rs:1040`），SQL 是 `WHERE ($1::boolean OR i.owner=$2)`（`:1030`）——**viewer 读全表**。本轮唯一的改动是把这件事报告成 `narrowedTo: null`，而不是把它说成「这就是平台的全部」。
3. 同一平台的审计面给出的答案更窄，而且是**故意**的：`apps/kernel/src/audit.rs:131` — `sees_all: auth.role.is_admin()`；`audit.rs:115-122` 的注释直接点名 `incidents::Caller::sees_all`「also answers yes for a viewer」，并声明审计故意不复用它。
4. `audit.rs:179` 把 `INCIDENT` 判为 `Visibility::Owned`，`VISIBILITY`（`audit.rs:249` 起）的语义是：`INCIDENT` 事件只在 `i.owner = caller` 时可见。
5. **而 viewer 在构造上不可能成为 owner**：`create_incident` 第一行就是 `auth.require_operator()`（`incidents.rs:603`）；owner 交接把 viewer 目标直接拒掉——`INCIDENT_OWNER_ROLE_INELIGIBLE`（`incidents.rs:1665`，覆盖它的测试在 `incidents.rs:4032`）。

#### 两个面对 viewer 的矛盾表述（原文对照）

| 面 | 对 viewer 说的话 | 出处 |
|---|---|---|
| 故障列表 | 「这次读**没有**按 owner 收窄」（实际读全表） | `incidents.rs:145` → `GET /api/v1/incidents` |
| 审计账本 | 「本页只包含**主体归你所有**时的 INCIDENT、job 事件；其他类别仅管理员可读」 | `audit.rs:131,179,249`；文案 `activity.empty.restricted.description` |

**结论（只陈述事实，不做取舍）**：同一个 viewer，一个面被告知「未收窄，你拿到的是全表」，另一个面被告知「只含你拥有主体的 INCIDENT 事件」——而 viewer 不可能拥有任何 incident，所以那一半**恒为空**。两个面不是「一个宽一个窄」，而是**一个全开、一个恒空**。

**顺带更正上一轮本文件 §6 的一句话**：上一版写「viewer 不能创建、只能被交接后成为 owner（`incidents.rs:5114` 的测试就是「交接给 viewer」）」。**这句在当前 HEAD 上是错的**：交接明确拒绝 viewer（`INCIDENT_OWNER_ROLE_INELIGIBLE`，`incidents.rs:1665`），`incidents.rs` 里没有任何一条路径让 viewer 成为 owner。矛盾因此比上一轮写下的更强，不是更弱。

#### 需要决策的问题（D5）

**viewer 这个角色到底应该读到什么？**

| 选项 | 内容 | 代价 |
|---|---|---|
| A 保持现状 | viewer 读全部 incident（只读）；把审计面的 INCIDENT 谓词也对齐成「viewer 读全部」 | 审计面会比它自己 `audit.rs:115-122` 写下的理由更宽，那段注释要一起作废 |
| B 收窄成 admin-only | `sees_all = role.is_admin()`；viewer 只读到「它拥有的」，也就是**永远空** | 列表页空态会变成 `narrowedTo: "owner"`，§3.3 的 scoped 文案自动接上；但 viewer 这个人基本失去读故障的能力 |
| C 给 viewer 一个可见单位 | 例如「被指派可见的 scope」 | 新的授权模型 + 迁移，在本切片之外 |

三个选项改的都是**产品语义**，不是文案。本轮不动谓词、不在代码里选，只把它连同行号摆在这里。

#### 遗留的第二份抄本（记录，不修）

`apps/platform-web/src/incidents.ts:291` 仍按角色推 `seesAll`（`role === 'admin' || role === 'viewer'`）来决定详情页的 `outOfScope` 文案。它不影响本轮的字段语义（服务端仍以 404 为准，页面只是选理由），但它是 §1 判据里所说的「把谓词抄第二遍」。D5 定案时它要一起改。本轮不动：它不在本项验收里，且改动会牵到详情页既有测试。
## 4. #4 Jobs.tsx —— **只记录，不修（未实测）**

结论一句话：**疑似受影响，未实测，未验证**。

- 按谓词判定确实同形：`GET /api/v1/jobs` 的 `AND ($5::boolean OR submitted_by=$6)` 绑定 `role.is_admin() || !role.can_operate()`（`apps/kernel/src/jobs.rs:1874,1883`），而 `JobListResponse` 只有 `{items, nextCursor}`（`jobs.rs:1813`），没有 scope；`Jobs.tsx:97` 也只有 `filtered | none` 两态。形状与 #3 修前完全一致。
- **本轮拿不出可复现证据**：造一条 job 需要 pipeline definition + 已发布 revision（提交端点还要可用的运行观察），本机没有 Docker（`docker ps` → `dial unix … no such file`），无法稳定复现「job 存在但 operator 看不到」。
- 实测所需的 fixture（两选一，优先前者）：
  1. **真实链路**：`POST /api/v1/pipelines/preview` → 发布 revision → 用 admin 会话提交一条 job → 用 operator 会话 `GET /api/v1/jobs?limit=20` 断言 `{items: [], nextCursor: null}` 且**无 scope**，再断言 `/admin/jobs` 的 `data-empty-state` 与文案。需要能接受 job 的节点/运行时（这就是 Docker 的用处）。
  2. **仅前端分支**：`page.route('**/api/v1/jobs?*', fulfill({items: [], nextCursor: null}))` 只能证明「无 scope 时页面说 none」，**不能**证明内核是否收窄——不能当作受影响的证据，只能当作回归测试。
- 修法与 #3 相同（响应加 scope + 页面按 scope 分支），但**必须先拿到 fixture 证据**再动谓词周边，否则又是一次「把猜测写进文案」。

## 5. 顺带记录：`/api/v1/overview` 仍在广播平台级 attention —— **本轮不动，需单独决策**

已核实的形状（读代码，非实测）：

- `plugins::overview` 对**任何已认证调用者**构造 `attention`：节点名与心跳细节（`plugins.rs:582-606`）、`plugin_deployments` 的 `plugin_id` 与 `status_reason`（`plugins.rs:608` 起）以及平台计数，构造过程**没有任何角色分支**；
- 而 `audit.rs::SUBJECT_TYPES` 把 `node` / `plugin` / `deployment` 判为 `AdminOnly`（非 admin 连这些类别的**事件**都读不到）。

这就是同一件事的另一扇门：账本这边刚说「这类事件你读不到」，首页那边仍在把这类主体的具名关注项和部署失败原因发给非 admin。

**未验证的部分（不得当成结论）**：

- 这些条目是否已经能从别的端点读到（`GET /api/v1/nodes`、`GET /api/v1/plugins` 都是 `_auth: AuthUser`，节点名/插件 id 本身就不是秘密；`status_reason` 是否随另一个读端点下发，本轮**没有核**）；
- 因此「这是泄漏」还是「只是两个面说的不一致」**尚未定论**，需要一次带 fixture 的实测 + 一次产品决策（收窄到 admin，或明确「平台级关注项对所有已认证人员可见」并写进权限矩阵）。
- 本轮**不改**：它会改变非 admin 首屏的信息量，属于产品决策，不是文案修复。

## 6. 假设与保留意见

1. **Activity 的 `restricted` 仍然压在 `filtered` 之上**（helper 既有优先级，本轮沿用）。结果是：operator 在有搜索词时清空结果，看到的是「边界」而不是「筛选」。为此新文案**只说边界、不说数量**（「它并不说明什么都没有发生」），并且当 `narrowed` 为真时同时给出「清除筛选」。要彻底分开这两种空态，需要内核另发一个「未收窄计数」，本轮不做。
2. **viewer 的可见范围是 D5，已上抬为独立决策项**：全量现象、行号、两个面的原文对照与三个候选选项写在 **§3.4**，本文件不再重复判断。此处只保留一条自我更正：上一版这条写的「viewer 只能被交接后成为 owner」**在当前 HEAD 上是错的**（交接拒绝 viewer，`incidents.rs:1665`），所以两个面不是「一宽一窄」而是「一个全开、一个恒空」。字段层面已经不存在 `seesAll`，因此这句话也不再经由任何字段传播。
3. 空态文案没有、也无法声称「你读得到的东西都已列出」——它只能声称「内核这次没给你」。本轮之后它可以更准确地只说「这次读没有按 owner 收窄，而且它没返回行」。
4. **viewer 的写入口存在三方分歧，本轮只记录不动**：ADR-G11-001 §4.5 说保留写入口、让 viewer 拿到 403；`pages/IncidentDetail.tsx:497,575` 说不给表单、只给角色说明句；两条 spec（`g11-incident-slice.spec.ts:211`、`g11-viewer-write-entries.spec.ts:154`）按 ADR 写。实测第 2 条 spec 因此失败，原文与行号见 §7.3。改任何一边都超出本轮授权：改产品＝改 §4.5 的产品规则，改 spec＝放宽测试。

## 7. 复现

```bash
# scratch DB + 内核（18199）+ HEAD 重建的 dist
psql -h 127.0.0.1 -U postgres -c 'create database opsweave_g12h_scratch'
cargo build -p opsweave-kernel
OPSWEAVE_BIND=127.0.0.1:18199 \
  DATABASE_URL=postgres://postgres@127.0.0.1:5432/opsweave_g12h_scratch \
  OPSWEAVE_DATA_DIR=artifacts/g12h-scratch/data \
  OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL=admin@opsweave.local \
  OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD=… OPSWEAVE_ADMIN_SURFACE_ROLES=admin,operator,viewer \
  ./target/debug/opsweave-kernel

pnpm --filter @opsweave/platform-web build      # dist 由 HEAD + 本轮改动重建
cd tests/ui && OPSWEAVE_URL=http://127.0.0.1:18199 \
  OPSWEAVE_ADMIN_EMAIL=admin@opsweave.local OPSWEAVE_ADMIN_PASSWORD=… \
  npx playwright test g11-incident-slice.spec.ts
```

### 7.1 线上实测：三个角色，同一条请求

`GET /api/v1/incidents?limit=20`（同一个 scratch 库、同一次内核进程）：

```
admin    -> 6 items   "scope":{"narrowedTo":null}
operator -> 1 item    "scope":{"narrowedTo":"owner"}     # 只有自己名下的那一条
viewer   -> 6 items   "scope":{"narrowedTo":null}        # 与 admin 完全相同的 6 条 —— D5，§3.4
```

三处响应里都**没有 `seesAll`**，`additionalProperties: false` 的契约因此会对旧实现报错。operator 的 1 条与 admin 的 6 条也再次证明**谓词没动**：收窄的只是「怎么报告这次读」。

### 7.2 Playwright 逐条结果（`g11-incident-slice.spec.ts`，18199 + 真实构建产物）

| # | 测试 | 结果 |
|---|---|---|
| 1 | the admin creates an incident, it survives a reload, evidence is verifiable, the list queries it, and a verdict sticks | ✅ 通过（7.0s / 7.9s）|
| 2 | a viewer reads incidents it does not own and is refused every write, with the refusal explained | ❌ 失败，见 7.3 |
| 3 | an operator cannot see a record owned by someone else, and can still close its own loop | ✅ **通过（3.1s）——「上一轮改了没跑」的那一条** |
| 4 | the loading state is a real pending read, and a real transport failure is reported as stale | ✅ 通过（2.0s）|
| 5 | the list and the detail survive 1440/1024/390 in both themes, and the header action is reachable | ❌ 失败：390/light 详情页横向溢出 8px，见 7.4 |

第 3 条的两个断言原文（本轮跑过，不是推断）：

```ts
await expect(page.getByTestId('incidents-empty')).toHaveAttribute('data-empty-state', 'scoped');
await expect(page.getByTestId('incidents-empty')).toHaveAttribute('data-narrowed-to', 'owner');
await expect(page.getByTestId('incidents-empty')).toContainText('incidents you own');
await expect(page.getByTestId('incidents-empty')).not.toContainText('no owner narrowing');
```

最后一条是本轮**改过目标**的负向断言：上一轮它否认的是 `nothing has been entered`，而本轮的文案改写删掉了这句话，留着它会对一个不存在的句子成立——那是**放宽**，不是保持。改为否认 `none` 态现在的专属句子，并在它前面补一条正向断言。这是加强，不是放宽（§8 记录）。

### 7.3 第 2 条的失败原文与根因（**与本轮改动无关，属既有分歧**）

```
  2) [chromium] › g11-incident-slice.spec.ts:185:1 › a viewer reads incidents it does not own and is refused every write
     Test timeout of 60000ms exceeded.
     Error: locator.fill: Test timeout of 60000ms exceeded.
     Call log: - waiting for getByTestId('incident-verdict-rationale')
      211 |   await page.getByTestId('incident-verdict-rationale').fill(...)
           |                                                     ^
```

前一步 `expect(getByTestId('incident-verdict')).toHaveAttribute('data-verdict-state', 'open')` **通过了**，所以页面是加载成功的；缺的是**表单本身**。失败现场的无障碍快照里有 viewer 的说明句（`incident-readonly-reason`），`Human verdict` 面板里没有 `Verifying` 表单。

根因：`apps/platform-web/src/pages/IncidentDetail.tsx:575` 先判 `capabilities.readOnlyReason`（viewer 恒真），于是渲染 `incident-verdict-readonly` 说明句而**不渲染** `VerdictForm`；证据表单同理（`:497`）。这是**故意的**，就地注释写着「Why the form is absent…: a viewer is told about the role」。

但 ADR-G11-001 §4.5 写的是相反的选项 (b)：「保留写入口，让 viewer 点一次、拿到服务端的高质量 403」，而且**另有一条专门的 spec 在守它**——`tests/ui/g11-viewer-write-entries.spec.ts:154` 同样对 viewer 填 `incident-verdict-rationale`。也就是说 HEAD `7785ccb` 上存在**三方分歧**：ADR §4.5 说要表单；`IncidentDetail.tsx` 说不给表单；两条 spec 按 ADR 写。

**本轮不改**：改 `IncidentDetail.tsx` 等于改 viewer 的写入口行为（第 10 个文件，且是产品规则），改 spec 等于放宽测试。两者都被本任务的硬约束挡住。**这条必须由决策者裁定：要么恢复 §4.5 的表单，要么正式废止 §4.5 并同步两条 spec。**（§6 已登记）

### 7.4 第 5 条的失败：390 宽度详情页横向溢出 8px —— 已在 HEAD 基线复现

失败行原文：`expect(overflow, path + ' at ' + width + '/' + theme).toBeLessThanOrEqual(1)` → `/app/incidents/<id> at 390/light`，`Received: 8`。

**基线对照**（把前端四个文件 `git stash` 回 HEAD、重建 dist、跑同一测试）：同一条断言、同一个路由、`Received: 8`。所以这 8px 不是本轮改动带来的；而它落在详情页布局上，本轮改的两个面（列表空态、viewer 说明句）在 admin 会话的 390 详情页里一个都不渲染。

**本轮不修**：属既有的窄屏布局缺陷，与本项的语义收窄无关，且改它要动 `styles.css` / 详情页，超出文件预算与验收范围。**记录在案，建议单独一轮处理。**

`artifacts/` 为未跟踪目录；截图与日志见 `artifacts/g12h-scratch/`（`playwright-run1.log`、`playwright-run2.log`、`cargo-test.log`、`clippy.log`、`gates.txt`、`shots/`）。

## 8. 预算与越界说明

**本轮（收窄 `seesAll`）的预算**：

- 可编辑文件：**9 个 / 上限 10** —— `apps/kernel/src/incidents.rs`；`contracts/openapi/incident-v1.yaml`；`apps/platform-web/src/incidents.ts`、`incidents.test.ts`、两个 i18n 目录；`tests/ui/g11-incident-slice.spec.ts`；`docs/design/g11-incident/incident-adr.md`（新增 §4.6，补上上一轮跳过的 ADR）；本文件。
- **没有改**：`pages/Incidents.tsx`（`data-narrowed-to` 与分支结构都不需要动，文案在目录里）、`pages/Activity.tsx`、`pages/IncidentDetail.tsx`（见 §7.3：改它＝改产品行为）、`types.ts`、任何迁移、任何依赖。
- 门禁（全部实跑）：`cargo test --workspace`（真库，`OPSWEAVE_REQUIRE_TEST_DATABASE=1`，**217 个测试 / 0 skip / 0 fail**）、`cargo fmt --check`、`cargo clippy --workspace --all-targets -- -D warnings`、`vitest`（280 passed）、`tsc --noEmit`、`check-i18n`（1620 keys / 0 unused）、`validate_contracts.py`、`check-tracked-png-budget`（379 files / 68.03 MB，在上限内）。**`check-ui-tokens` 仍 FAIL（6 条超预算）**：全部落在 `styles.css` 与 `format.ts`，这两个文件本轮未改（`git status` 可核），属既有欠账，未纳入本轮。
- Playwright：**3 次 / 上限 6**（全量跑、`--grep-invert` 补跑、HEAD 基线对照）。
- 迁移：0；新依赖：0；merge / tag / force-push：0。

**上一轮（首次加 `scope`）的记录，保留**：可编辑文件 10 个；Playwright 2 次（`probe.mjs before` / `after`）。

## 9. 自评：收窄之后，`narrowedTo: null` 还有可能被读成「全部」吗？

**会。有三种，性质不同。** 收窄字段只取消了「响应自己说出这句话」的许可，没有取消这个读法。

1. **人可以继续推断，只是不再由载荷授权。** `null` 仍然是「没有命名收窄」，读者仍可推出「那我拿到了全部」。没有字段能阻止推断；现在挡住它的是文案纪律（§3.3）与「三个角色形状相同、只有一个键」那条线上测试。这是**弱保护**，靠的是每个写文案的人读这份文件。
2. **结构性缺口：`narrowedTo` 只枚举了一个谓词。** 将来任何一层行级过滤（软删除、租户、归档、scope_id）加到这个列表上，`null` 立刻又能被读成「全部」——而且这次响应**没有撒谎**，因为它从来没说过那句话。契约的 `additionalProperties: false` 只锁形状、不锁枚举值，**没有任何机制强制新的 WHERE 子句同时扩充这个枚举**。这是我认为下一轮最该补的一处：谓词与枚举必须绑定，否则同样的读法会在新谓词上重演一次，而这次的辩护是「字段本来就没承诺」。
3. **有一个角色上，`null` 今天字面上就是「全部」：viewer。** §7.1 实测 viewer 与 admin 拿到同样的 6 条。字段不再**断言**它，但 UI 那句「这次读没有按 owner 收窄」是真的，而它背后的事实仍是 D5 的偶然放宽。也就是说：**收窄让句子变真了，但没有让这个角色变窄**。D5 定案前，viewer 的 `null` 是「null 被读成全部」的最强反例，只不过这次错在谓词，不在字段。
4. **浏览器里还留着第二份抄本**：`apps/platform-web/src/incidents.ts:291` 仍按角色推 `seesAll`（详情页的 `outOfScope` 文案）。那是唯一一处仍然由**角色**而不是**载荷**决定「你看到全部」的地方；D5 一改，它会静默漂移。已记录（§3.4 末），本轮未改。

一句话结论：**字段本身已经不会再声称「全部」，但「null ⇒ 全部」这个读法还需要一条机器可执行的绑定（第 2 条）和一个 D5 的决定（第 3 条）才能真正关掉。**


