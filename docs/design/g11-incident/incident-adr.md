# ADR-G11-001 · Incident → Evidence → Human Verdict 最小领域与持久化

- 状态：**Accepted（D1/D2 实现随本 ADR 落地）**
- 范围：0.1.0 第一条业务纵切（Gate G11）的后端领域与 API
- 上游依据：`docs/design/dual-workspace-v2/pack/docs/12-business-first-vertical-slice.md`（§12.2 Golden Slice、§12.4 前后端权威、§12.5 Gate）
- 契约：`contracts/openapi/incident-v1.yaml`
- 迁移：`apps/kernel/migrations/0016_g11_incidents.sql`
- 实现：`apps/kernel/src/incidents.rs`

本 ADR 只回答一件事：**这条纵切里，谁记录什么事实，谁能改，改不动的时候怎么失败。** 不做产品叙事，也不承诺 D3 之后的能力。

---

## 1. 决策：Incident 事实权威在 Kernel

§12.4 要求"是否将 Incident Authority 置于 Kernel 或领域插件必须先 ADR，只能有一个业务事实权威"。本 ADR 的决策：

**Incident / Evidence / Verdict 三张表归 Kernel（`kernel` schema），由 Kernel 独占写入，不经插件宿主。**

理由（按可验证强度排序）：

1. 现有代码里没有"插件拥有可由 Kernel 外键引用的业务表"的机制。`kernel.plugin_storage_bindings` 给的是插件自有 schema + 角色（见 `0002_data_foundation.sql`），Kernel 的 auth/audit 都不跨过去。把 Incident 放进插件 schema 就意味着 Verdict 的 `decided_by` 无法走 `kernel.users` 外键，"谁下的结论"立刻退化为自报字段——违反 AGENTS.md「让用户、插件或模型自报的 tenant/subject/permissions 代替可信身份」。
2. 权限门原语（`auth.rs` 的 `require_operator` / `require_admin`）与审计（`kernel.audit_events`）都只在 Kernel 内可用；换位置就要新造第二套身份/审计，正是本任务禁止的。
3. 审计与事务边界：`创建 incident` 与 `写 audit_events` 必须在同一进程、同一连接池语义下完成。

**边界澄清（防止和 AGENTS.md 冲突）**：AGENTS.md「将业务插件功能写入 Kernel」禁止的是**插件生态的业务功能**被固化进 Kernel；本条纵切是产品自身的核心业务记录，不是插件功能，也从未被任何插件声明过。它复用 Kernel 已有的身份、权限、审计与迁移能力，没有新增不可卸载能力。

**何时必须重审（revisit trigger）**：

- 出现第二个需要读写 Incident 的非 Kernel 组件（插件、外部采集器）时；
- 或 `kernel.incidents` 需要承载第二套业务对象（如 Change/Patch 时间线）时。

到那时改为：Kernel 只保留身份/审计/授权，Incident 迁到领域服务，并通过 `contracts/` 的 capability 接口暴露。**现在不提前做**，因为 YAGNI，且当前唯一调用方就是 `/app` 前端。

---

## 2. 最小字段集：每个字段回答什么问题

判断标准是**删掉它之后，某条验收问题就再也答不出来**。凡"删了也不影响任何问题"的，一律不进 D1。

### 2.1 Incident（`kernel.incidents`）

| 字段 | 回答的问题 | 删掉之后的后果 |
|---|---|---|
| `id` | 这条故障的唯一引用是什么？ | 证据与结论无法指向同一条故障 |
| `title` | 一句话说清发生了什么？ | 列表只能显示 UUID，人无法辨认 |
| `severity` | 有多严重，先处理哪个？ | 无法排序/过滤，值班无从下手 |
| `status` | 现在走到哪一步？ | 无法区分"没人管"与"已下结论"，闭环不可验证 |
| `source` | 这条记录从哪个通道进来的？ | 无法追溯来源，也无法去重（见 `native_id`） |
| `native_id` | 来源侧它本来叫什么？ | 同一个故障重复入库，无法与来源系统对账 |
| `related_entity` | 影响的是哪个 Host/Service？ | §12.2 第 2 步"关联一条可追溯的 Host/Service"无载体 |
| `started_at` | 故障是什么时候开始的？ | 与"我们什么时候录入"混淆，时间线失真（§12.4 固定时间窗） |
| `updated_at` | 最后一次变更是什么时候？ | 无法判断列表是否陈旧，无法做乐观并发提示 |
| `owner` | 现在谁负责？ | 操作员数据范围没有锚点（见 §4.3），责任无人承担 |
| `evidence_refs` | 这条故障挂了哪些证据？ | 见 §2.4：**派生字段，不落列** |
| `human_verdict` | 人给出的结论是什么？ | 见 §2.4：**派生字段，不落列** |

**故意不放进 D1 的字段，及其理由**（避免"字段表看起来缺东西"被误读为遗漏）：

- `created_by`：创建者已是 `kernel.audit_events.actor_id` 的事实，再落一列就是同一事实两个权威。`owner` 回答的是"现在谁负责"，与"谁录入"不是同一个问题，且两者在 D1 恰好相等——这正是它必须分开命名的原因。
- `description` / `impact` / `labels`：§12.2 没有任何一步需要它们；加入会立刻引出富文本、模板、校验三套规则。
- `resolved_at` / `closed_at`：可以由 `status` + `updated_at` 推出，D1 没有 CLOSED 的写入端点（见 §3.3）。
- `timeline_id` / 独立时间线表：§12.2 第 3 步"查看时间线"在 D2 用 evidence 的 `collected_at` + audit 事件满足；单独的时间线表是第二套事实源。

### 2.2 Evidence（`kernel.incident_evidence`）

| 字段 | 回答的问题 |
|---|---|
| `id` | 这条证据的唯一引用（可被 verdict 的 rationale 引用、可去重） |
| `incident_id` | 它属于哪条故障（外键，`ON DELETE CASCADE`：故障没了证据无意义） |
| `kind` | 它是什么形态的证据（指标快照/日志片段/查询结果/人工记录）；决定 `content_ref` 怎么解释 |
| `source` | 谁产出的（系统名或 `operator:<email>`），是否可追溯（§12.4 `provenance`） |
| `collected_at` | 采集发生在什么时候（与入库时间分离，才能发现"迟到证据"） |
| `content_ref` | 内容在哪里（不透明定位符：内容摘要或存储键） |
| `trust` | 这条证据能承载多重的结论（`SOURCE_ATTESTED` / `OPERATOR_ASSERTED` / `UNVERIFIED`） |

两个刻意的设计约束：

1. **`content_ref` 不允许是内联正文。** §12.4 要求 Evidence 带 `digest`/`provenance`；把 payload 写进 Kernel 会让证据无界增长，且 D1 没有配额与保留策略。同时 **Kernel 永不解析/抓取 `content_ref`**：没有任何 `reqwest` 调用，所以不存在 SSRF 面（`rules/03-security.md`）。
2. **`trust` 是防造假字段。** 没有它，一条手写 `OPERATOR_NOTE` 与一条来源系统盖章的指标快照在库里完全等价，UI 无法区分，§12.5"缺失状态要体现，不可伪造"就不成立。

### 2.3 Verdict（`kernel.incident_verdicts`）

| 字段 | 回答的问题 |
|---|---|
| `incident_id` | 结论针对哪条故障（主键 ⇒ 一条故障一个结论） |
| `verdict` | 人的结论是什么（`CONFIRMED` / `REFUTED` / `INCONCLUSIVE`） |
| `rationale` | 凭什么这么判？（无理由的结论不可复核；§12.4 要求可审计） |
| `decided_by` | 谁签的字？（外键到 `kernel.users`，可信身份，不接受自报） |
| `decided_at` | 什么时候签的字？ |

**为什么 `incident_id` 是主键而不是自增 id**：§12.4 明确"人工 Verdict 与 AI Report、Incident Closed 三者独立"。D1 里"一个结论"就是终态；允许第二条 verdict 立刻引出"哪个是最终结论"的选择题，而 D1 没有任何界面能回答它。需要复核轮次时，正确做法是新增 `incident_verdicts_reviews`（D3），而不是复用同一张表覆盖历史。

### 2.4 两个派生字段：`evidence_refs` 与 `human_verdict` 为什么没有列

任务书把 `evidence_refs` 和 `human_verdict` 列为 Incident 字段。回应如下，这是本 ADR 最容易被误读的地方：

- `evidence_refs` **在响应里存在、在表里不存在**。它的值由一条子查询在读取时拼装（`incidents.rs` 的 `INCIDENT_SELECT`）：`SELECT evidence_id FROM kernel.incident_evidence WHERE incident_id = i.incident_id ORDER BY collected_at DESC, evidence_id DESC LIMIT 100`。**它是有上限的投影，不是全量**：契约 `evidenceRefs.maxItems: 100` 且描述写 `always the newest 100 ids`，列表页脚注也把这句话写给读者（`incidents.table.evidenceNote`），完整证据列表由详情页调用 `GET /incidents/{id}/evidence` 取得。落列的话就是同一事实的第二个权威，会在"删证据/加证据"时产生不一致，并且必须为它写一致性修复脚本。
- `human_verdict` 同理，是 `kernel.incident_verdicts` 的读取投影（`verdict`/`rationale`/`decidedBy`/`decidedAt` 的聚合，无结论时为 `null`）。落列会让"结论存在性"出现第三种可能状态（列有值但表无行 / 表有行但列有值 / 两者不一致），而 §12.4 要求结论可审计、唯一。

**实测口径（2026-10-31）**：同一个故障下写入 101 条证据后，`GET /api/v1/incidents/{id}` 的 `evidenceRefs` 长度 = **100**，返回的是最新 100 条（边界 `sha256:cap-101` … `sha256:cap-2`）；同一时刻 `GET /api/v1/incidents/{id}/evidence` 返回 **101** 条，最早那条 `sha256:cap-1` 只出现在这里。所以"上限 100"不是文档承诺，是这条 SQL 的行为，而"完整证据集"永远只在证据端点。

这就是**自评里那个问题**的答案（见 §9），它同时也是本 ADR 里唯一一个"字段能回答的问题，已经被别的东西回答了"的例子。

---

## 3. 状态机

### 3.1 状态集合（CHECK 约束，闭集）

`OPEN` → `INVESTIGATING` → `CONCLUDED` → `CLOSED`

| 状态 | 含义 | 有意义的不变量 |
|---|---|---|
| `OPEN` | 已入库，尚无人开始取证 | 允许追加证据；允许直接下结论 |
| `INVESTIGATING` | 已有人开始取证 | 允许追加证据；允许下结论 |
| `CONCLUDED` | 已有人工 Verdict | 证据仍可补（结论之后补证据是真实审计场景），但**结论不可改** |
| `CLOSED` | 终态，记录冻结 | 拒绝一切写入 |

### 3.2 合法迁移

| # | 从 | 到 | 触发 | D2 是否可达 |
|---|---|---|---|---|
| T1 | — | `OPEN` | `POST /api/v1/incidents` | 是 |
| T2 | `OPEN` | `INVESTIGATING` | 第一条证据入库（`POST .../evidence`） | 是 |
| T3 | `OPEN` | `CONCLUDED` | 直接下结论（`POST .../verdict`） | 是 |
| T4 | `INVESTIGATING` | `CONCLUDED` | 下结论（`POST .../verdict`） | 是 |
| T5 | `CONCLUDED` | `CLOSED` | 关闭（D3：报告/复核） | **否，D2 无端点** |
| T6 | `INVESTIGATING` | `OPEN` | 释放责任人 | **否，D2 无端点** |

**明确非法、且必须解释性失败的迁移**：

- `OPEN`/`INVESTIGATING` → `CLOSED`：跳过结论直接关闭 = 静默丢弃故障。要"查无结论"，用 `INCONCLUSIVE` verdict。
- `CONCLUDED` → `OPEN`/`INVESTIGATING`：结论是签过字的审计事实，降级等于抹除签字。
- `CLOSED` → 任意：终态。
- 任意 → `CANCELLED`/`RESOLVED`/`DONE` 等未定义值：CHECK 拒绝，这保证前端不会先画出 D3 才有的状态。

### 3.3 D2 故意不实现 T5/T6 的理由

任务书的 D2 API 清单只有 create/list/get/evidence/verdict，没有 PATCH/close。少造一个端点比多造一个"暂时没人调用、但一旦被调用就改变业务事实"的端点便宜。代价是 D1 之后 `CLOSED` 不可达——这一点写在这里，而不是让读者从代码里猜。`status` 的 CHECK 已经包含 `CLOSED`，所以 D3 加关闭端点时**不需要新迁移**。

### 3.4 状态迁移在实现上如何保证

不是"先 SELECT 再 UPDATE"。每次迁移都是一条带前置状态的 CAS 语句：

```sql
UPDATE kernel.incidents
   SET status='INVESTIGATING', updated_at=now()
 WHERE incident_id=$1 AND status='OPEN'
```

零行受影响 ⇒ 说明状态已被别人改过，返回 `409 INCIDENT_STATE_CONFLICT`（而不是假装成功，也不是 500）。

---

## 4. 权限

### 4.1 只用既有原语

全部权限判断只调用 `apps/kernel/src/auth.rs` 里的两个**已存在**方法，不新增任何方法：

- `AuthUser::require_operator()` → `role.can_operate()`（`admin` | `operator`），否则 `403 FORBIDDEN`
- `AuthUser::require_admin()` → `role.is_admin()`

本 ADR **不新建身份系统、不新增角色、不新增 capability 名称**。D1 不需要 `require_admin`：没有任何"只有管理员能做"的故障动作。

### 4.2 端点矩阵

| 端点 | 权限门 | admin | operator | viewer |
|---|---|---|---|---|
| `POST /api/v1/incidents` | `require_operator()` | ✅ | ✅ | 403 |
| `GET /api/v1/incidents` | 仅需登录 + 数据范围 | ✅ 全部 | ✅ 自己 owner 的 | ✅ 全部 |
| `GET /api/v1/incidents/{id}` | 仅需登录 + 数据范围 | ✅ | ✅ 限自己 | ✅ |
| `POST /api/v1/incidents/{id}/evidence` | `require_operator()` + 数据范围 | ✅ | ✅ 限自己 | 403 |
| `GET /api/v1/incidents/{id}/evidence` | 数据范围 | ✅ | ✅ 限自己 | ✅ |
| `POST /api/v1/incidents/{id}/verdict` | `require_operator()` + 数据范围 | ✅ | ✅ 限自己 | 403 |
| `GET /api/v1/incidents/{id}/verdict` | 数据范围 | ✅ | ✅ 限自己 | ✅ |

**为什么创建/加证据/下结论都不给 viewer**：viewer 的定义就是"只读"。verdict 尤其不能给——§12.4 要求人工结论可审计，而不可写是只读角色唯一的强约束。**为什么 verdict 不要求 admin**：下结论是值班操作员的本职动作；把它抬到 admin 会让 operator 角色在业务上不存在，等于逼着现场用 admin 账号，反而扩大权限面。

### 4.3 数据范围：逐字对齐 jobs（`jobs.rs:1883`）

现有 jobs 的可见性谓词是：

```rust
// jobs.rs:1883
.bind(auth.role.is_admin() || !auth.role.can_operate())   // 是否"看全部"
.bind(auth.user_id)                                        // 否则只看 submitted_by = 自己
```

即：**admin 看全部；viewer（不可操作者）看全部但只读；operator 只看到自己的**。Incident 用同一条谓词，只是把 `submitted_by` 换成 `owner`：

```sql
WHERE ($1::boolean OR owner = $2)
```

单对象访问同理，与 `require_job_access`（`jobs.rs:1958`）的语义逐条一致：

| 角色 | 单对象访问 | 越权时返回 |
|---|---|---|
| admin | 任意 incident | — |
| operator | 仅 `owner = self` | `404 INCIDENT_NOT_FOUND` |
| viewer | 任意 incident（只读） | — |

**越权读为什么返回 404 而不是 403**：这是 `require_job_access` 已有的选择（`jobs.rs:1972`），保持一次会话内两种资源不泄露"另有一条你无权看的 ID 存在"。**越权写返回 403**：写端点先过 `require_operator()`，viewer 在这里就被拦下，不会走到范围判断；operator 写别人的 incident 则与读一样返回 404（不暴露存在性）。**唯一的例外是 `POST /incidents` 的自然键冲突**：那里返回 `409 INCIDENT_NATIVE_ID_TAKEN` 而**不是** 404——读的入参是 id，create 的入参是调用者自己提交的自然键，回答"已被占用"不泄露它没提供的信息，而 404 会在同一句话里同时说"没有这条"和"不给你建这条"（详见 §5.1）。

### 4.4 审计：与业务写同事务，失败即整体回滚

每一次写（create / evidence / verdict）都在**同一个数据库事务**里写一条 `kernel.audit_events`：`actor_type='USER'`、`actor_id=<user_id>`、`subject_type='INCIDENT'`、`subject_id=<incident_id>`、`result='ACCEPTED'`。审计行与业务行一起提交，也一起回滚。

**先写业务、后写审计是错的（D3 评审指出）**：原实现把 `audit::record` 放在 `tx.commit()` 之后，于是审计失败返回 5xx 而结论已经落库；客户端重试拿到 `409 INCIDENT_ALREADY_CONCLUDED`——**报没写成，其实写成了**。"审计失败不静默"于是字面成立、方向反了：调用者被告知失败，系统却已经接受。同一形状在 create 与 evidence 的 created 分支上也存在。

**为什么选同事务，而不是另外两条路**：

| 方案 | 结论 | 理由 |
|---|---|---|
| 审计与业务同事务（本实现） | **采用** | 只有一个提交点，不存在"一边成一边败"的中间态 |
| 审计先写、业务后写 | 否决 | 仍是两个提交点，只是把残留换到另一边：业务写失败会留下一条"已接受"的审计 |
| 写失败后标记需补偿 | 否决 | 需要补偿表 + 补偿任务 + 第三份"补到哪一步"的状态；D3 没有任何调度器能消费它，而同事务已经直接给出一致性 |

同事务的代价写在明处：`audit_events` 写不进去的那一刻，这三个写端点**完全不可用**。这是可接受的方向——审计表是 Kernel 自己的表、同一个库同一个连接池，没有跨服务失败模式；它不可写时，业务写也没有可信的落地位置。

**错误语义**（此前是裸 500 `INTERNAL`）：审计行写失败返回 `500 AUDIT_WRITE_FAILED`，消息直接说明"审计记录无法写入，因此本次写已回滚、未生效"，并带 `retryable: true`。这个 `retryable` 是诚实的：库里没有留下半条记录，重试是有意义的重试，而不是重复一次已经成功的写。

**实测**（2026-10-31，scratch 库 + 本机 18199，真实 HTTP；自动化版本是同名单测）：

1. 给 `kernel.audit_events` 加一条只针对某个 actor 的 `CHECK` 约束，让审计 INSERT 真的失败（不是 mock）；
2. `POST /api/v1/incidents` → `HTTP 500` + `AUDIT_WRITE_FAILED`；`SELECT count(*) FROM kernel.incidents WHERE owner=<actor>` = **0**，该 actor 的 `audit_events` = **0**；
3. `POST /api/v1/incidents/{id}/verdict`（同手法）→ `HTTP 500` + `AUDIT_WRITE_FAILED`；`incident_verdicts` = **0**，状态仍是 `INVESTIGATING`（`CONCLUDED` 的 CAS 与该事务一起回滚），`INCIDENT_VERDICT_RECORDED` 审计 = **0**；
4. 删掉约束后重放同一请求 → `201`，业务行与审计行各 **1** 条。

单测：`a_failed_audit_rolls_the_verdict_back`、`a_failed_audit_rolls_the_incident_back_and_frees_the_natural_key`、`a_failed_audit_rolls_the_evidence_and_the_state_change_back`。第二条还证明了一个副作用：回滚把自然键也还回来了——否则调用者会被 200 告知"这个键已经存在"，而那一次它明明失败了。

### 4.5 viewer 看得见写入口：这是一条产品规则，不是遗漏

D3 评审的第三条：列表的"录入故障"按钮与详情页的证据/结论表单对 viewer 照常渲染，提交后 403。二选一的决定是 **(b) 保留入口，让 viewer 点一次、拿到服务端的高质量 403 文案**；(a) "对 viewer 禁用并说明原因"被否决。

理由：

1. 权限是服务端事实，不是前端事实。AGENTS.md 明令不许"依赖 Prompt/CSS 隐藏来实现权限控制"；把按钮藏掉会让"我这个角色为什么看不到"重新变成只有代码能回答的问题，而 403 把答案直接写在页面上。
2. 禁用态会同时销毁证据：一个禁用按钮无法区分"服务端会拒绝"和"前端以为服务端会拒绝"。一旦前后端角色判定漂移，界面会静默少一个入口且没有任何断言会红；403 路径则一定会红。
3. 成本可控且被实测：一次点击 = 一次 403，文案来自码表 `incidents.error.FORBIDDEN`（en/zh-CN 各一条），不渲染 Kernel 的英文句子。

文案（`i18n/catalogs/en.json:1327`、`zh-CN.json:1327`）：

- en: `Your role can read incidents but not write them. Creating, adding evidence and recording a verdict are refused by the server.`
- zh-CN: `当前角色可以读取故障，但不能写入：创建、追加证据和写入结论都会被服务端拒绝。`

**实测**（scratch 库 + 18199 + Chromium，页面来自真实构建产物 `apps/platform-web/dist`）：viewer 登录 → 列表按钮 `Record an incident` 可见且 `enabled=true` → 填标题提交 → `[data-testid=incident-create-error]` 的 `data-error-code="FORBIDDEN"`，正文是上面那条 en 文案 + `Request ID`；详情页证据表单 `visible=true`、提交按钮 `enabled=true` → 提交 → `[data-testid=incident-evidence-write-error]` 同样 `FORBIDDEN`。

**代价写在明处**：viewer 会看到两个永远失败的入口，每点一次重读一遍 403。若 D4 要做"角色化界面"，正确做法是**同时保留服务端拒绝**、把入口改成"申请操作权限"的只读说明——那是新交互，不是隐藏。

---

## 5. 并发与幂等

### 5.1 重复请求（重试/双击/客户端超时重放）

| 请求 | 幂等键（数据库强制） | 重复时的响应 |
|---|---|---|
| `POST /incidents` | `UNIQUE (source, native_id) WHERE native_id IS NOT NULL` | `200` + **已存在**的那条 incident（不是 201，不新建第二条） |
| `POST /incidents`（自然键已被别人占用） | 同一 `UNIQUE` 索引 | `409 INCIDENT_NATIVE_ID_TAKEN`（**不是 404**） |
| `POST /incidents`（`native_id` 为空） | 无自然键 | 每次都 `201` 新建；手工录入两次就是两条，**这是正确行为**，system 无从判断是否重复 |
| `POST .../evidence` | `UNIQUE (incident_id, kind, source, content_ref)` | `200` + 已存在的证据 |
| `POST .../verdict` | `incident_id` 主键 | `409 INCIDENT_ALREADY_CONCLUDED` |

**"键被占用"为什么必须是 409**：D3 评审实测过——operator B 拿 A 的 `(source, nativeId)` 重放 create，拿到 `404 INCIDENT_NOT_FOUND`，而契约当时只声明 200/201/400/401/403，也就是客户端收到了一个契约里根本不存在的结果；更糟的是这个 404 在同一次回答里说"没有这条"和"不给你建这条"。自然键是调用者自己提交的，回答"已被占用"不泄露它没提供的信息（范围外的**读取**仍返回 404，见 §4.3）。读范围覆盖该行时（admin）重放仍是 `200` + 已存在的那条：同一组状态码下，"能读到"与"能创建"被分开表达。

实现方式统一：`INSERT ... ON CONFLICT DO NOTHING`（或 `DO UPDATE ... RETURNING`）后看返回行，**不做"先查再插"**——先查再插在并发下必然漏，而且会把唯一索引冲突变成 500。

### 5.2 并发更新

- 状态迁移用 `WHERE status=<期望前置状态>` 的 CAS（§3.4），冲突 `409 INCIDENT_STATE_CONFLICT`。
- `updated_at` 由同一条 UPDATE 里的 `now()` 推进，不做应用层时钟，避免多实例时钟漂移。
- 不引入分布式锁、不引入乐观版本列：D1 的写路径都是"单行 + 前置状态"的 CAS，行锁足够（READ COMMITTED 下 UPDATE 会持锁到提交）。

### 5.3 结论与证据的竞态

"下结论时必须有证据"与"一条故障只有一个结论"这两条规则如果写成裸的"先 SELECT 再 INSERT"，在并发下会被绕过。实现为**单事务 + 先锁行**：

```sql
BEGIN;
SELECT status FROM kernel.incidents
 WHERE incident_id=$1 AND ($2::boolean OR owner=$3) FOR UPDATE;  -- 串行化并发结论
SELECT 1 FROM kernel.incident_verdicts WHERE incident_id=$1;      -- 已存在 ⇒ 409 ALREADY_CONCLUDED
SELECT EXISTS (SELECT 1 FROM kernel.incident_evidence WHERE incident_id=$1); -- 假 ⇒ 409 EVIDENCE_REQUIRED
INSERT INTO kernel.incident_verdicts (...) VALUES (...);
UPDATE kernel.incidents SET status='CONCLUDED', updated_at=now()
 WHERE incident_id=$1 AND status IN ('OPEN','INVESTIGATING');     -- 0 行 ⇒ 409 STATE_CONFLICT 并回滚
COMMIT;
```

锁行 + 事务隔离为什么足够（而不是"看起来足够"）：

- 两个并发结论被 `FOR UPDATE` 串行化，后到者提交前会看到前者的 verdict 行 ⇒ `409 INCIDENT_ALREADY_CONCLUDED`，历史不会被覆盖。
- 证据只增不改、且没有删除端点（`ON DELETE CASCADE` 只在故障被删时触发，而 D2 无删除端点），所以"证据存在"这个判断在一个已提交事务内不会由真变假。锁内看到的 `EXISTS` 结果因此是稳定的。
- 状态 CAS 失败会让整个事务回滚，verdict 不会留在一个状态不一致的故障上。

`INCONCLUSIVE` 允许零证据，因为"证据不足以下结论"本身是一个合法且必须能被记录的结果；若连它也要证据，现场就只能伪造一条。

---

## 6. 迁移与回滚

- 文件：`apps/kernel/migrations/0016_g11_incidents.sql`，纯新增（3 表 + 索引），不改任何既有表/列/端点。
- 命名与风格沿用 `0001_init.sql` / `0002_data_foundation.sql`：`CREATE TABLE IF NOT EXISTS kernel.*`、`text + CHECK` 闭集、`timestamptz NOT NULL DEFAULT now()`、显式索引名。
- **可回滚性：不可自动回滚。** sqlx 迁移是前向的，D1 不提供 `down` 脚本；ADR 与迁移注释里给出显式逆向 DDL（§6.1），由人执行并承担数据丢失。
- 兼容性：`0016` 对旧版本 Kernel 是"多出三张没人读的表"，滚动升级/回滚到上一版本 Kernel 不会有任何失败。

### 6.1 逆向 DDL（人工执行，非自动）

```sql
DROP TABLE IF EXISTS kernel.incident_verdicts;
DROP TABLE IF EXISTS kernel.incident_evidence;
DROP TABLE IF EXISTS kernel.incidents;
DELETE FROM _sqlx_migrations WHERE version = 16;
```

顺序不能反（外键依赖）。**这会删除真实业务记录**：`incident_verdicts` 用 `ON DELETE RESTRICT` 保护结论不被级联删除，所以即便有人误执行 `DELETE FROM kernel.incidents`，有结论的故障会拒绝删除而不是静默消失。

### 6.2 回滚 DDL 已实测（2026-10-31，scratch 库 `opsweave_g11_incident`）

不是"看起来能回滚"，而是执行过：

1. `0016` 正向应用（Kernel 启动时 `sqlx::migrate!`）→ `kernel.incidents` / `kernel.incident_evidence` / `kernel.incident_verdicts` 存在。
2. 逐条执行 §6.1 的逆向 DDL → 三条 `DROP TABLE` 与 `DELETE 1` 全部成功；
   `SELECT count(*) FROM information_schema.tables WHERE table_schema='kernel' AND table_name LIKE 'incident%'` = `0`，
   `SELECT count(*) FROM _sqlx_migrations WHERE version=16` = `0`。
3. 再次启动 Kernel → 迁移重新应用，三张表全部重建，`GET /api/v1/incidents` 返回 `{"items":[],"nextCursor":null} [200]`。

含义：这一条迁移是"可执行、可撤销、可重放"的；它的代价（删掉业务数据）是明确的，所以只做人工执行，不进任何自动流程。

---

## 7. 明确不做（D1/D2 的非目标）

| 不做 | 理由 |
|---|---|
| **不接 Zabbix / Nebula** | 没有真实可验证的连接器就没有可验证的 provenance；`source` 的取值集合因此被收窄到今天 Kernel 能自证的 `MANUAL`/`API`。接入方需自带迁移 + ADR 扩大 CHECK，而不是让客户端谎报来源 |
| **不做 AI RCA / 假设生成** | §12.2 第 6 步是"先确定性 Rule"；AI Run 需要预算、权限和失败语义三件套，D1 一件都没有。库里也没有任何 "ai_*" 字段来占位，避免出现"看起来支持"的假象 |
| **不建第二套工作流平台** | 没有状态机 DSL、没有审批流、没有 SLA 引擎、没有通知扇出。三个闭集 CHECK 就是全部"工作流" |
| **不做 Incident→Pipeline 触发** | 会立刻需要幂等触发、回环检测、预算；不属于本纵切验收 |
| **不做删除/合并/重开 incident** | 删除业务记录需要保留策略；合并需要"主故障"语义；重开需要一个复核模型 |
| **不向前端暴露任何聚合计算** | 列表只有 `items` + `nextCursor`，没有总数、没有 SLA、没有 MTTR 聚合 |

---

## 8. 已知缺口（D1/D2 结束时仍然存在）

1. `CLOSED` 无写入端点（§3.3）→ 需要 D3 的关闭/报告端点。
2. `owner` 创建后不可转移（无 PATCH）→ 换班交接依赖 D3。
3. 列表分页用 `(started_at, incident_id)` keyset 游标；没有总数、没有跨页稳定性承诺之外的能力。
4. Evidence `content_ref` 在 D1 **不被校验存在性**（没有对象存储适配器）→ 可能出现指向不存在的键。这是"不伪造"的代价：宁可让引用悬空且显式标注，也不做假的内容校验。
5. Timeline 视图（§12.2 第 3 步）由 evidence `collected_at` + audit 事件拼装，D1 没有专门的 timeline 端点。
6. `audit::record` 只接受 `&PgPool`，因此**本切片之外的写端点**（`users::create_user` 等）仍然只能在业务写之后写审计——与 §4.4 修掉的是同一个形状。本切片在 `incidents.rs` 里用 `audit_in_tx` 局部实现了"同事务"；正确做法是让 audit 模块接受任意 `Executor`/事务，一处改、全站受益，届时删除 `audit_in_tx`。
7. 审计写失败会让这三个写端点直接 500（§4.4）。当前 `audit_events` 与业务表同库，这不是远程失败模式；一旦审计被拆到独立存储，这个选择必须重新评审（要么接受写端点随审计一起不可用，要么改成异步审计 + 显式的"未审计"状态）。

---

## 9. 自评：字段最小集里哪一个是弱项

**`evidence_refs`。** 它是唯一一个"它回答的问题，已经被另一个结构回答了"的字段：证据集合的权威是 `kernel.incident_evidence`，任何落列的数组都是该权威的缓存。

处理方式不是删掉它（前端列表确实需要"有没有证据"），而是**把它降级为读取投影**：只在响应里派生，不入库、不可写、不可被客户端提交。同理 `human_verdict` 也是投影。若哪一天真的需要冗余列（例如为列表页性能做物化），必须同时给出"重建该列"的脚本，否则它就是第二个权威。

**它有上限，这一点必须写进结论**：`evidence_refs` 是"最新 100 条"的投影，不是完整证据集（SQL 见 §2.4，契约 `maxItems: 100`，列表页脚注同样写"最新 100"）。所以它回答的是"有没有证据 / 最近的证据是什么"，不是"证据一共几条"；任何需要完整集合的读取都必须走 `GET /incidents/{id}/evidence`。把上限当成全量是这类派生字段最常见的误用，也是本 ADR 上一版的记错之处（曾写成"全投影"，而实现与契约一直是 100）。

另外补一句任务书的口径差异：任务书说"这**七**个字段"，但 Incident 实际列了 **12** 个、Evidence 7 个、Verdict 5 个。本 ADR 按实际字段数逐个论证，不按"七个"凑数。

---

## 10. 验收证据索引

| 验收项 | 证据位置 |
|---|---|
| 字段最小集理由 | 本文件 §2 |
| `evidence_refs` 上限 100 的实测 | 本文件 §2.4（101 条证据的边界测量） |
| 状态机 | §3 |
| 权限 | §4 |
| 并发与幂等 | §5 |
| 迁移文件名与回滚 | §6 + `0016_g11_incidents.sql` 头注释 |
| API 契约 | `contracts/openapi/incident-v1.yaml` |
| 真实 curl 成功/失败输出 | `tests/acceptance/incident_slice_api.sh` 及执行日志 |
| 单测 | `apps/kernel/src/incidents.rs` 的 `#[cfg(test)] mod tests` |
| 审计与业务同事务（回滚实测） | §4.4 + `incidents::tests::a_failed_audit_rolls_*`（3 条） |
| create 自然键被占 → 409 | §5.1 + 契约 `POST /incidents` 的 409 + `a_native_key_owned_by_another_operator_answers_409_not_404` |
| viewer 写入口的产品规则与实测 | §4.5 + `docs/design/g11-incident/g11-d3-ui.md` §10 |
