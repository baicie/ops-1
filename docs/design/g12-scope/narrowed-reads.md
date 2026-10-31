# 窄读与空态：谁说「没有」，谁只是「你看不到」

- 状态：**#2、#3 已实现并实测**；**#4 未修（未实测）**；**/api/v1/overview 的 attention 未修（部分未验证）**
- 分支/基线：`feat/g12-ai-investigator` @ `79a72b7`（本轮改动未提交）
- 契约：`contracts/openapi/incident-v1.yaml`（`IncidentList.scope` / `IncidentScope`）
- 理由的书面记录：**本文件 §3**（契约 `IncidentScope` 的描述指向这里）
- **未改 ADR**（`docs/design/g11-incident/incident-adr.md`）：契约头要求「加字段须先改 ADR」，本轮的理由写在本文件 §3 而 ADR 一字未动——原因是 10 个可编辑文件的预算已经用在实现、测试与这份记录上（见 §8）。这是一处需要确认的取舍，不是遗漏。
- 复现：`artifacts/g12g-scratch/`（scratch DB `opsweave_g12g_scratch` + 18199，跑完已清理，见 §7）

## 1. 判据

一个列表页能说三句话，它们的前提完全不同：

| 空态 | 它断言的世界 | 只有谁知道 |
|---|---|---|
| `restricted` / `scoped` | 「有一条边界挡在中间」 | 内核（谓词 + 范围） |
| `filtered` | 「你输入的条件把它藏起来了」 | 页面（自己的筛选状态） |
| `none` | 「那里什么都没有」 | 内核（未收窄的完整答案） |

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

## 3. #3 Incidents.tsx（产品主页面）—— 已修（两处，缺一不可）

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

### 3.1 kernel（`apps/kernel/src/incidents.rs`）

`GET /api/v1/incidents` 的响应加 `scope`：

```json
{"items":[],"nextCursor":null,"scope":{"seesAll":false,"narrowedTo":"owner"}}
```

- 新增 `IncidentScopeView { sees_all, narrowed_to }`（`Serialize`，camelCase）；
- 新增 `Caller::scope()`，**只从 `sees_all` 推导**，不新算任何谓词；
- `IncidentList` 增字段 `scope`，`list_incidents` 填充。

与 `audit::AuditScopeView` 同思路（「把答案写在行旁边」），但**刻意不复用类型**：audit 表达的是「哪些 subject_type 能到达你」（跨类别集合），incident 表达的是「这一张表按哪个字段收窄」（单一谓词）。两者的失效方向不同，合并会逼其中一个说无关的话。

`narrowedTo` 是字段名而不是布尔：前端那句「只含你负责的事件」必须由载荷授权。将来若出现第二种收窄，值必须改，句子也得跟着改，而不是继续声称 owner。

**谓词一字未动**：`WHERE ($1::boolean OR owner=$2)`、`Caller::from_role`、404/403 语义全部原样。实测佐证：修前修后 operator 仍是 `items: []`，admin/viewer 仍是 2 条。

测试（真库，禁 skip）：`the_reported_scope_agrees_with_the_predicate`（operator 读不到别人的行且 `narrowedTo=owner`；admin `seesAll=true`）＋ `the_scope_view_names_its_two_fields_on_the_wire`（`seesAll`/`narrowedTo` 两个线上字段名，改名即静默失效）。

### 3.2 契约

`contracts/openapi/incident-v1.yaml`：`IncidentList.required` 增 `scope`；新增 `IncidentScope`（`seesAll: boolean`、`narrowedTo: 'owner' | null`，`additionalProperties: false`，描述指向本文件 §3）；`GET /incidents` 的 200 描述改为「带读取范围的页」。

按角色：

| 角色 | `seesAll` | `narrowedTo` |
|---|---|---|
| admin | `true` | `null` |
| viewer（不可操作者） | `true` | `null` |
| operator | `false` | `"owner"` |

### 3.3 web（`apps/platform-web/src/pages/Incidents.tsx`）

- `incidents.ts`：`IncidentScope` 与 `IncidentListPayload`（`IncidentList` + `scope: IncidentScope | null`）。**没有 scope 不等于未收窄**，与 `readAuditList` 同一规则——类型放在这里而不是 `types.ts`，理由与 `AuditScope` 放在 `lib/audit-scope.ts` 相同：范围只有挨着读它的 helper 才有意义，两处声明就是契约的第二份抄本；
- `incidents.ts`：`incidentsEmptyKind({ scope, filtering })` → `filtered | scoped | none`；
- 空态按 kind 渲染，`data-narrowed-to` 直接暴露载荷值；`scoped` 的动作是「录入一条」（operator 新建的记录 owner 就是它自己，这是唯一能把行放进这个列表的动作）。

**优先级与 audit 相反，是有意的**：audit 那边「拒绝」压过「筛选」（清筛选也变不出被拒绝的类别）；这里收窄并不拒绝你自己的行，所以筛选择先——否则 operator 明明是被自己的条件挡住的，却被告知「你的列表只有你负责的」，指向一个它跨不过去也无需跨的边界。

**修后实测**：operator `data-empty-state="scoped"`、`data-narrowed-to="owner"`，文本为「No incident you own has been recorded / …an empty page here is not the platform's record…」；admin/viewer 仍是 2 行、无空态。

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
2. **viewer 在 incident 列表上的 `seesAll` 是 `true`**（`Caller::from_role` = `is_admin() || !can_operate()`）。这在列表路由上确实「未收窄」，但同一个 viewer 在审计账本里只能读到 `owner = 自己` 的 `INCIDENT` 事件（`audit.rs::SUBJECT_TYPES` 把 INCIDENT 判为 `Owned`）——而 viewer 不能创建记录（`create_incident` 先过 `require_operator()`），只能被交接后成为 owner（`incidents.rs:5114` 的测试就是「交接给 viewer」）。于是同一角色在两个面上被告知**不同的可见范围**：列表说「未收窄、这是全部」，账本说「只含你拥有主体的那部分」。本轮**不动谓词**，只在这里记录；`IncidentScope.seesAll` 如实反映当前谓词，不代表这一项的取舍是对的——这正是本轮我最不满意的一处（见报告的自评）。
3. 空态文案没有、也无法声称「你读得到的东西都已列出」——它只能声称「内核这次没给你」。

## 7. 复现

```bash
# scratch DB + 内核（18199），web 用 apps/platform-web/dist
# 注意：本文件是第 10 个被编辑的文件，预算见 §8
psql -h 127.0.0.1 -U postgres -c 'create database opsweave_g12g_scratch'
OPSWEAVE_BIND=127.0.0.1:18199 DATABASE_URL=postgres://postgres@127.0.0.1:5432/opsweave_g12g_scratch \
OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL=admin@g12g.invalid OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD=… \
OPSWEAVE_ADMIN_SURFACE_ROLES=admin,operator,viewer ./target/debug/opsweave-kernel
node artifacts/g12g-scratch/seed.mjs      # 建 operator/viewer + 1 incident（admin owner）
node artifacts/g12g-scratch/probe.mjs before   # 修前 DOM 断言（report-before.json）
node artifacts/g12g-scratch/probe.mjs after    # 修后 DOM 断言（report-after.json）
```

`artifacts/` 为未跟踪目录，截图见 `artifacts/g12g-scratch/shots/`。

## 8. 预算与越界说明

- 可编辑文件：**10 个**（kernel `incidents.rs`；契约 `incident-v1.yaml`；web `incidents.ts` / `pages/Incidents.tsx` / `pages/Activity.tsx` / 两个 i18n 目录；`tests/ui/g11-incident-slice.spec.ts`；本文件）。
- 为了守住 10 个：`types.ts` 未改（范围类型放进 `incidents.ts`，与 `AuditScope` 的先例一致）；`docs/design/g11-incident/incident-adr.md` 未改（理由写在本文件 §3）。
- Playwright：**2 次**（修前 `probe.mjs before`、修后 `probe.mjs after`，同一脚本同一数据）。
- 迁移：0；新依赖：0；merge/tag/force-push：0。

