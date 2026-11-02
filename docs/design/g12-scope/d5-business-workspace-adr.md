# ADR-D5-001 · 最小业务权限模型（方案 C）：Business Workspace 作为数据可见单位

- 状态：已实现（G12 R2 Phase 1）
- 分支：`feat/g12-ai-investigator`，基线 `2968fc6`
- 取代：ADR-G11-001 §4.3 / §4.6 的 D5「decision required」条目，以及 `docs/design/g12-scope/narrowed-reads.md` §3.4 的三选一
- 契约：`contracts/openapi/incident-v1.yaml`
- 迁移：`apps/kernel/migrations/0022_d5_business_workspace_scope.sql`
- 验证脚本：`tests/acceptance/d5_workspace_scope.sh`（真库 + 真 HTTP，49 条断言）

---

## 1. 问题：一个表达式回答了两个问题

D5 记录的事实（HEAD `7785ccb`，行号可核）：

```rust
// apps/kernel/src/incidents.rs:145（改动前）
sees_all: role.is_admin() || !role.can_operate(),
```

这一行同时被读作两件事：

1. **哪些行这个调用方可以读**（行级收窄）；
2. **哪些工作区这个调用方可以读**（范围授权）。

第 2 件从来没有被判断过。`!can_operate()` 对 viewer 为真，于是 viewer 读全表；而审计面
（`audit.rs:131`）问的是同一个角色的另一个问题，回答是「INCIDENT 事件仅在你拥有主体时可见」——
viewer 在构造上不可能成为 owner（创建要 `require_operator()`，交接拒绝 viewer，
`incidents.rs:1665`），所以那一半**恒为空**。同一个角色，两个面，两个答案。

D5 的三个选项（保持现状 / 收窄成 admin-only / 给一个真正的可见单位）里，A 让审计面作废自己的理由，
B 让 viewer 永久读空。本 ADR 实现 **C**：Business Workspace 成为数据可见单位。

---

## 2. 模型

三张表、两条独立的判断，互不替代：

| 判断 | 依据 | 位置 | 谁决定 |
|---|---|---|---|
| 哪些**动词**可用（写/判定/交接） | 角色门 `require_operator()` / `require_admin()` | `apps/kernel/src/auth.rs`（未改） | 角色 |
| 哪些**工作区**可读 | `kernel.business_workspace_members` | `apps/kernel/src/scope.rs` | 管理员**授予的数据** |
| 工作区内哪些**行**可见 | `RowRule`（按角色穷举 match） | `apps/kernel/src/scope.rs` | 角色，但只在已授权工作区内生效 |

```sql
kernel.business_workspaces        (workspace_id, key, name, created_at, created_by)
kernel.business_workspace_members (workspace_id, user_id, granted_at, granted_by)
kernel.incidents.workspace_id     uuid NOT NULL REFERENCES business_workspaces ON DELETE RESTRICT
```

**谓词单一来源**：`scope::predicate(alias, workspace_param, all_rows_param, user_param)` 是唯一拼写，
返回的两半**总是同时出现**——不存在「只用户主那一半」的变体。审计账本复用同一个函数
（`audit::visibility_sql` 里的 INCIDENT 分支就是它），所以「账本与主体路由各写一遍」这件事在结构上
不再可能。没有无 scope 变体：所有数据读都要求一个 `DataScope`。

---

## 3. 必须回答的 8 条

### 3.1 成员、角色与资源归属

- **成员**：`kernel.business_workspace_members`，由 `POST /api/v1/business-workspaces/{id}/members`
  授予（admin 门 + 与业务写同事务的审计行 `BUSINESS_WORKSPACE_MEMBER_GRANTED`），由 `DELETE ...` 撤销
  （`..._REVOKED`）。撤销对**正在运行的 run 的下一次工具调用**立即生效（见 3.6）。
- **角色**：不变（admin / operator / viewer）。角色的含义被收窄为「动词 + 工作区内的行规则」，
  不再是「范围的来源」。`RowRule::for_role` 是对 `Role` 的**穷举 match**：契约里加第四个角色会编译失败，
  而不是静默继承某个表达式的答案。
- **资源归属**：每条 incident 归属**恰好一个** Business Workspace（`workspace_id` NOT NULL，无 DEFAULT——
  漏写即数据库报错，不会静默落进 legacy）。`owner` 仍是问责字段，并在工作区内收窄 operator 的行。

### 3.2 Viewer 的可见集合

`{ 工作区 W 中的所有 incident | 该 viewer 是 W 的成员 }`，只读。

- viewer 的 `RowRule` 是 `AllRows`，但这是**行规则**，不是授权：没有成员关系时它为真也读不到任何行
  （`workspace_id = ANY('{}') -> false`）。`scope.rs` 的文档注释与测试都在守这条区分。
- 成员关系为空时，`workspaceCount = 0`，页面据此说「没有被授予任何工作区」（新的空态），
  而不是「你没有负责的记录」——后者会把 viewer 送去一个它跨越不了也无需跨越的边界。

### 3.3 Operator 的查询与写入条件

- **查询**：`workspace ∈ 成员集合` **且** `Owner = 自己`。这是纯收窄：改造前 operator 看
  `Owner = 自己` 的全部行；现在还要落在它被授权的工作区内。
- **写入**：`require_operator()`（角色）**且** 该行/该目标工作区在成员集合内（数据）。
  「能写」与「能看」分别判断，这就是方案 C 的核心命题。写入范围判定与读取共用同一个谓词。
- **创建**：body 可带 `workspaceId`；省略时仅当调用方**恰好属于一个**工作区才自动取用它
  （0 个 -> `403 INCIDENT_WORKSPACE_FORBIDDEN`，多个 -> `400 INCIDENT_WORKSPACE_REQUIRED`）。
  命名不是自己声明范围：命名一个非成员工作区 -> `404 BUSINESS_WORKSPACE_NOT_FOUND`，且**不建行**。
- **交接**：目标账号必须是该 incident 所在工作区的成员，否则 `409 INCIDENT_OWNER_NOT_IN_WORKSPACE`——
  否则交接会把记录交给一个永远读不到它的人。

### 3.4 现有历史 Incident 的默认归属与兼容迁移

- `workspace_id` 先用 `ADD COLUMNTB（可空）引入，`UPDATE ... WHERE workspace_id IS NULL` 把**全部历史行**
  填成固定的 legacy 工作区 `00000000-0000-4000-8000-000000000001`（key `legacy`），然后 `SET NOT NULL` +
  外键 + 索引。
- **一次性授权**：迁移把所有**迁移时刻已存在**的账号写成 legacy 的成员
  （`INSERT ... SELECT u.id FROM kernel.users`）。这不是角色规则，是数据快照：迁移之后新建的账号
  **不自动获得任何工作区**，必须由管理员授予——这正是 D5 要求的收窄。
- **对历史数据，谁都没有被扩大或收窄**：admin / viewer 保持原来能读的每一行（行规则不变、工作区覆盖
  全部历史行），operator 仍只看自己拥有的行。改造后**新建**的工作区对所有人（含 admin）默认不可见。
- 未修改任何历史账号、未删除任何数据、未改动任何既有列的类型。
- **全新部署的一个后果，写在明处**：迁移先于 bootstrap 管理员创建，所以全新库上的 bootstrap admin
  属于 0 个工作区——它能创建工作区、能授予，但读不到任何业务行，直到它显式给自己授予一次
  （那是一次被审计的平台动作，不是自动获得）。这是 ruling 的字面结果，不是缺陷；但它意味着
  「装好就能看」不再成立，安装文档与演示脚本要跟着改。

### 3.5 禁止用户自行声明更大范围

四条机械保证：

1. `workspaceId` 只被**校验**，不被信任：`may_enter()` 不通过即 404（`insert_incident` 第一段）。
2. 工作区成员关系的写入只有 `require_admin()` 一条路，且写入审计。
3. 所有读都不接受调用方给出的工作区集合——它来自数据库。
4. `Owner` 查询参数只做**追加**过滤（`AND ($8::uuid IS NULL OR i.owner=$8)`），永远不能替代工作区谓词。

### 3.6 权限撤销对运行中的 AI 工具调用的影响

`investigations::scope_caller` 在**每次工具调用**时重新解析（角色 + 成员关系都重读）：

```rust
DataScope::resolve_for(db, scope_user_id, role) // 每次 execute_tool 调用一次
```

run 的 `scope_user_id` 只说明**谁在行动**，不说明它现在能读什么。撤销成员关系后，下一次工具调用
立即 `INCIDENT_NOT_FOUND`（与 HTTP 路由同一个 404），run 不需要被重启、取消或刷新。
证据：`a_membership_revocation_mid_run_takes_the_next_read_away`、
`a_tool_call_from_an_account_in_no_workspace_reads_nothing`（两条都在真库上跑）。

### 3.7 跨资源隐私与「不存在」语义

越权读 -> **404**（`INCIDENT_NOT_FOUND` / `BUSINESS_WORKSPACE_NOT_FOUND`），不是 403：
「不归你」和「不存在」必须是同一个回答，否则 id 可以被当作探针。逐面一致：

| 面 | 越权时的回答 |
|---|---|
| `GET /incidents/{id}` | 404 |
| `GET /incidents` | 空 items（+ `workspaceCount` 解释） |
| `GET /incidents/{id}/evidence` | 404（经 `incident_status` 的统一门） |
| `GET /incidents/{id}/timeline` | 404 |
| `GET /api/v1/audit?subjectId=...` | 空 events（审计行不可见，闭包理由随行一起不可见） |
| `POST /incidents/{id}/investigations` | 404（工具与路由同一谓词） |
| 越权**写** | 403（角色门先拒绝 viewer）+ 404（operator 写别人的行） |

唯一的例外仍是 create 的自然键冲突 `409 INCIDENT_NATIVE_ID_TAKEN`：入参是调用方自己提供的键。

### 3.8 不自动扩大既有角色权限

无任何角色获得新的行或新的动词：

- viewer：平台全表 -> 其成员工作区（**收窄**）；写仍然全拒。
- operator：`Owner=自己` -> `Owner=自己 ∧ 成员工作区`（**收窄**）。
- admin：平台全表 -> 其成员工作区（**收窄**；其平台管理能力不在本 ADR 的「业务数据」范围内）。
- 唯一的**扩大**发生在审计面：viewer 原先读不到任何 INCIDENT 事件（恒空），现在能读到它**已获授权
  阅读的记录的**事件。这是 §3.7 一致性要求的结果，不是新的授权：它读得到的行没有增加一行。

---

## 4. 为什么这是「最小可用」

| 没做的事 | 理由 |
|---|---|
| 多租户 / tenant 表 / 租户路由 | 方案 C 只需要「一个数据可见单位」，不需要命名空间隔离、配额、跨租户运维 |
| 角色内再分权（每工作区 operator/admin） | 动词门已经由全局角色决定；工作区内再分层没有本阶段的需求，且会引入第二份权限语义 |
| 工作区级「只读成员」 | viewer 已经是只读；工作区内再区分读写会让「只读」有两个来源 |
| 删除/归档工作区 | 没有删除就没有级联损坏；`ON DELETE RESTRICT` 已经保证有行的工作区删不掉 |
| 迁移 jobs / pipelines 的数据范围 | 它们是平台管线数据，不是业务域数据；见 §9 的遗留项 |
| 前端工作区选择器 | 需要选择器的只有「属于多个工作区」的账号；单工作区（迁移后的默认形态）行为不变。已登记为 Phase 2 |

---

## 5. 迁移与非破坏论证

**文件**：`apps/kernel/migrations/0022_d5_business_workspace_scope.sql`（`0021` 及更早的文件一个字节都没改）。
sqlx 把每个迁移包在一个事务里，所以这个文件整体原子。

**非破坏**（逐条对 DDL）：

| 语句 | 破坏性 |
|---|---|
| `CREATE TABLE business_workspaces / _members` | 否（新增） |
| `ALTER TABLE incidents ADD COLUMN workspace_id uuid`（可空，无 DEFAULT） | 否（新增列） |
| `UPDATE incidents SET workspace_id=... WHERE workspace_id IS NULL` | 只填新列，不覆盖任何既有值 |
| `ALTER COLUMN workspace_id SET NOT NULL` + `ADD CONSTRAINT ... FK` + `CREATE INDEX` | 否（回填后成立） |
| `INSERT INTO business_workspaces ... ON CONFLICT DO NOTHING` | 否（幂等） |
| `INSERT INTO business_workspace_members ... SELECT ... ON CONFLICT DO NOTHING` | 否（新增行；用户表不动） |

**回滚 DDL（人工执行，非自动；已实测）**：

```sql
BEGIN;
DROP INDEX IF EXISTS kernel.incidents_workspace_time_idx;
ALTER TABLE kernel.incidents DROP CONSTRAINT IF EXISTS incidents_workspace_fk;
ALTER TABLE kernel.incidents DROP COLUMN IF EXISTS workspace_id;
DROP TABLE IF EXISTS kernel.business_workspace_members;
DROP TABLE IF EXISTS kernel.business_workspaces;
COMMIT;
```

**实测（`opsweave_d5_rollback`，2026-10-31）**：`0001`-`0022` 依次 `psql -f` 全部成功，写入 1 个用户
+ 1 条 incident 后：

```
--- before rollback ---
1|1|0|1        # incidents=1, workspaces=1, members=0, incidents.workspace_id 存在
--- after rollback ---
1|t|t|t        # incidents 仍为 1（业务行未丢），两张新表消失，新列消失
```

再把 `0022` 前向重放一次（证明回滚后可以再前进）：

```
1|1            # 存活的 incident 被回填进 legacy，存活的用户被授予 legacy 成员关系
```

**回滚的代价写在明处**：`DROP COLUMN workspace_id` 丢掉「这一行属于哪个工作区」这个决定本身。
业务内容（标题、证据、结论）不丢，但重新前进时全部历史行都会落回 legacy——所以回滚**不是**一次无损撤销，
它是一次「放弃本阶段范围信息」的操作。

---

## 6. 验收矩阵（9 条，真库 + 真 HTTP）

```
$ dropdb --if-exists opsweave_d5_http && createdb opsweave_d5_http
$ DATABASE_URL=postgres://…/opsweave_d5_http OPSWEAVE_BIND=127.0.0.1:18199 \
  OPSWEAVE_DATA_DIR=/tmp/d5-http/data OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL=admin@d5.local \
  OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD=*** ./target/debug/opsweave-kernel
$ OPSWEAVE_URL=http://127.0.0.1:18199 OPSWEAVE_ADMIN_EMAIL=admin@d5.local \
  OPSWEAVE_ADMIN_PASSWORD=*** tests/acceptance/d5_workspace_scope.sh
== summary: 49 passed, 0 failed
```

逐条断言原文（原样摘自脚本输出）：

| # | 断言 | 结果 |
|---|---|---|
| 0 | `the scope says zero workspaces -> 0` / `a freshly created account is a member of nothing -> 0` | PASS |
| 1 | `ITEM 1: viewer A reads the incident of its workspace -> 200` | PASS |
| 2 | `ITEM 2: viewer A gets 404 for the other workspace -> 404` + `ITEM 2: and it is nonexistence, not forbidden -> INCIDENT_NOT_FOUND` + `ITEM 2: the list agrees with the single read -> 1` | PASS |
| 3 | `ITEM 3: viewer POST evidence -> 403` / `ITEM 3: with the stable code -> FORBIDDEN` / `ITEM 3: viewer POST verdict -> 403` | PASS |
| 4 | `ITEM 4: operator A appends evidence -> 201` / `ITEM 4: operator A records a verdict -> 201` | PASS |
| 5 | `ITEM 5: operator A lists with an owner filter naming operator B -> 200` / `ITEM 5: and receives nothing -> 0` / `ITEM 5: nor by id -> 404` / `the platform admin is not a member and reads nothing either -> 404` | PASS |
| 6 | `ITEM 6: and the ledger answers with no event -> 0` / `ITEM 6: the closure note did not cross` / `ITEM 6/9: and the ledger agrees with the incident route -> true` | PASS |
| 7 | `ITEM 7: operator B starts an investigation on workspace A's record -> 404` / `ITEM 7: refused at the same predicate as the read -> INCIDENT_NOT_FOUND` | PASS |
| 8 | `admin revokes viewer A from workspace A -> 204` / `ITEM 8: the very next request is refused -> 404` / `ITEM 8: and the scope reports zero workspaces -> 0` / `admin grants it again -> 201` / `ITEM 8: and the next request reads it again -> 200` | PASS |
| 9 | `ITEM 9: the list holds exactly workspace A's record -> true` / evidence 200/404 / timeline 200/404 / `ITEM 9: and the ledger holds no event of it -> 0` | PASS |

第 8 条的**运行中 run** 一半由内核测试覆盖（HTTP 上无法在请求中途观察），见 §3.6。

---

## 7. 反事实：破坏谓词，哪些用例变红

做法（一次性，两次运行之间用备份还原）：把 `scope::predicate` 改成只剩用户主一半——

```rust
// 被破坏后的 predicate()：工作区那一半消失，用户主那一半留下
let _ = workspace_param;
format!("(${all_rows_param}::boolean OR {alias}.owner = ${user_param})")

```

`cargo test -p opsweave-kernel`（`OPSWEAVE_TEST_DATABASE_URL` 指向真库）：

```
test result: FAILED. 166 passed; 10 failed; 0 ignored; 0 measured; 0 filtered out
```

变红的用例与失败原文：

```
---- audit::tests::a_viewer_reads_the_events_of_records_it_may_read_and_none_of_the_others ----
panicked at apps/kernel/src/audit.rs:772:9:
an incident outside the caller's workspaces leaked its event

---- audit::tests::the_three_identities_see_three_different_ledgers ----
panicked at apps/kernel/src/audit.rs:1013:9:
an event from a workspace the viewer is not in reached the viewer

---- incidents::tests::a_viewer_reads_one_workspace_and_never_the_other ----
panicked at apps/kernel/src/incidents.rs:6206:9

---- incidents::tests::an_admin_without_membership_reads_no_incident ----
panicked at apps/kernel/src/incidents.rs:6275:18:
an admin without the membership reads nothing: IncidentView { … }

---- incidents::tests::an_owner_filter_cannot_reach_across_a_workspace_boundary ----
panicked at apps/kernel/src/incidents.rs:6433:9

---- incidents::tests::a_revocation_takes_effect_on_the_next_read ----
panicked at apps/kernel/src/incidents.rs:6489:18:
the revoked member reads nothing: IncidentView { … }

---- investigations::tests::a_membership_revocation_mid_run_takes_the_next_read_away ----
panicked at apps/kernel/src/investigations.rs:3611:14

---- investigations::tests::a_tool_call_from_an_account_in_no_workspace_reads_nothing ----
panicked at apps/kernel/src/investigations.rs:3640:14

---- scope::tests::the_predicate_never_offers_the_ownership_half_without_the_workspace_half ----
panicked at apps/kernel/src/scope.rs:243:9

---- scope::tests::the_rust_mirror_and_the_sql_predicate_agree ----
panicked at apps/kernel/src/scope.rs:287:21
```

值得注意的三点：

1. **一次破坏，两个面同时变红**（incidents 与 audit）——因为审计的 INCIDENT 子句就是
   `scope::predicate`，不存在「改了一处、另一处仍是旧谓词」的状态。
2. **Rust 镜像与 SQL 谓词的一致性测试变红**：`DataScope::covers()` 与 SQL 是两份拼写，
   这个测试是它们唯一的粘合剂，它确实在起作用。
3. **源码扫描守卫没红**：它守的是「旧谓词字面量不许回来」，而不是「谓词的语义对不对」。
   两者互补，不能互相替代——这也是它被单独写出来的原因（`the_old_predicate_is_gone_from_the_kernel`）。

还原后：`test result: ok. 176 passed; 0 failed`。

---

## 8. 门禁（全部实跑）

| 门 | 命令 | 结果 |
|---|---|---|
| cargo test（真库，禁 skip） | `OPSWEAVE_TEST_DATABASE_URL=…/opsweave_d5_scratch OPSWEAVE_REQUIRE_TEST_DATABASE=1 cargo test -p opsweave-kernel` | **176 passed / 0 failed** |
| 反事实 | 同上，谓词被破坏 | **166 passed / 10 failed**（§7） |
| HTTP 验收 | `tests/acceptance/d5_workspace_scope.sh` | **49 passed / 0 failed** |
| fmt | `cargo fmt --all -- --check` | clean |
| clippy | `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| vitest | `pnpm --filter @opsweave/platform-web test` | **281 passed**（25 files） |
| typecheck | `pnpm --filter @opsweave/platform-web typecheck` | clean |
| i18n | `node scripts/check-i18n.mjs` | OK — 1625 keys × 2 locale，0 unused |
| contracts | `python3 tests/contract/validate_contracts.py` | passed（15 schemas / 6 examples） |
| status-vocabulary | `node scripts/check-status-vocabulary.mjs` | clean（41 codes） |
| tokens | `node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json` | PASS（118/14/7/5/19/4，预算未调高） |
| PNG / metrics | `node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit` | PASS（30 页 / 9 断言）；输入是既有审计产物，本轮未重跑 harness |

---

## 9. 旧行为差异清单

### 收窄（谁失去了什么）

| 角色 / 接口 | 改造前 | 改造后 |
|---|---|---|
| admin · `GET /incidents` / `{id}` / evidence / timeline | 平台全表 | 仅其成员工作区（迁移后默认 = legacy） |
| admin · `GET /api/v1/audit`（INCIDENT 事件） | 全表 | 仅其成员工作区 |
| admin · 新建工作区后 | —（工作区不存在） | 创建者 `member: false`，需再调一次授予接口 |
| operator · 全部读与写 | `Owner = 自己` | `Owner = 自己 ∧ 成员工作区` |
| viewer · `GET /incidents` | 平台全表 | 仅其成员工作区 |
| 任何账号 · 新建 `POST /incidents` | 无需 `workspaceId` | 属 0 个工作区 -> 403；属多个 -> 必须指定（400） |
| 任何账号 · 交接 | 只校验目标角色 | 还要校验目标是否为目标工作区成员（409） |

### 放宽（谁得到了什么，以及为什么不是权限扩张）

| 接口 | 改造前 | 改造后 | 理由 |
|---|---|---|---|
| `GET /api/v1/audit` 对 viewer 的 INCIDENT 事件 | 恒为空（owner-only，而 viewer 不可能成为 owner） | 它能读的记录的**事件** | §3.7 一致性；可读的行一行没多 |
| `GET /incidents` 响应的 `scope` | `narrowedTo` 一个字段 | 多一个 `workspaceCount` | 让「0 个工作区」可被解释，替掉按角色推断 |
| 新错误码 | — | `INCIDENT_WORKSPACE_FORBIDDEN` / `INCIDENT_WORKSPACE_REQUIRED` / `BUSINESS_WORKSPACE_NOT_FOUND` / `INCIDENT_OWNER_NOT_IN_WORKSPACE` / `BUSINESS_WORKSPACE_KEY_TAKEN` / `BUSINESS_WORKSPACE_MEMBER_NOT_FOUND` / `BUSINESS_WORKSPACE_MEMBER_UNKNOWN` | 前端按码取文案，不渲染服务端英文 |

### 新增接口

`GET/POST /api/v1/business-workspaces`、`POST/DELETE /api/v1/business-workspaces/{id}/members`。

### 明确未改（登记为后续，不在本阶段）

1. **`apps/kernel/src/jobs.rs:1874,1883` 仍是 `is_admin() || !can_operate()`**——本 ADR 判定为
   「偶然扩宽」的那一行，在 jobs 上仍然活着。jobs 是平台管线数据（不是业务域数据），本阶段不迁移它，
   但它需要一次与 D5 同形的裁定。这是本阶段**最值得紧接着处理**的遗留。
2. **`/api/v1/overview`** 仍向任何已认证调用者广播平台级 attention（`narrowed-reads.md` §5 已记录）。
3. **前端没有工作区选择器**：属于多个工作区的账号创建 incident 会拿到
   `INCIDENT_WORKSPACE_REQUIRED`（按码本地化）。单工作区账号（迁移后的默认形态）不受影响。
4. **Playwright UI 规格未在本轮运行**：`tests/ui/g11-incident-slice.spec.ts` 等用例通过 admin API 现场建
   viewer/operator 账号；迁移后这些账号**不属于任何工作区**，因此「viewer 读到 operator 的记录」这类断言
   会看到空列表。这不是回归，是新语义（新账号必须被授予）；修法是给这些 seed 加一次
   `POST /api/v1/business-workspaces/{id}/members`（legacy 的 id 固定为
   `00000000-0000-4000-8000-000000000001`）。本轮没有改也没有跑它们，因此**不对它们作任何通过声明**。
5. **`incidents.ts:291` 仍按角色推 `seesAll`**（`narrowed-reads.md` §3.4「第二份抄本」）：它只决定
   显示哪一句拒绝文案，服务端才是权威；彻底修需要把 scope 传进 `incidentCapabilities`，属于页面形状
   变更，与选择器一起做。

---

## 10. 自评：这套模型里哪一处仍然是「用一次偶然的属性当成了决定」

**owner。**

`RowRule::OwnedRows` 让 operator 在工作区内只看到自己拥有的行，而 `owner` 这个列的来历是
`jobs.submitted_by` 的镜像（`jobs.rs:1883`）——它记录的是**谁写了这一行**（问责），
在本阶段却被当成**谁可以读这一行**（授权）使用。这不是一个被做出的决定，而是一次继承：

- 同一工作区里的两个 operator 是同事，工作区本身说的就是「这是这个团队的数据」，而 `owner`
  悄悄把这句收窄回「这是我的数据」。工作区被引入的理由（一个业务可见单位）与这一行的效果相反。
- 更糟的是 `owner` 会**被业务动作改变**：交接（`POST /incidents/{id}/owner`）一提交，
  谁能读这条记录就变了。也就是说一条**可见性规则**可以被一次**业务操作**改动，而不是被一次
  **授权操作**改动——这正是「偶然属性被当成决定」的形状：可变的问责字段在承担不可变的授权语义。
- 我没有在本阶段移除它，唯一理由是移除会**扩大** operator 的读（从「自己的」到「工作区的」），
  而任务书明确禁止自动扩大既有角色权限。所以这是一次**自知的技术债**，不是疏忽。

Phase 2 的正确形状只有两个：工作区成员一律可读（删掉行规则，把 `owner` 退回纯问责字段），
或者给行加一个**显式**可见性字段（谁在什么时候因为什么被授权读这一行，可审计、不随业务动作漂移）。
在那之前，`scope.rs` 里 `RowRule` 的文档注释、以及本节的这四段，是唯一阻止下一位读者把
`owner` 再读成一种授权的东西。

**第二处（较弱但同类）**：`Role::Viewer => RowRule::AllRows` 在授权工作区内是正确的行规则，
但它是 D5 事故的**原始素材**：同一行代码在改造前被读成了范围授权。我保留它是因为删掉会改变
viewer 在工作区内的可见性，而它现在的含义由「必须有成员关系」兜住。它离再次被误读只差一个
「有人把 `may_enter` 弄松」——这也是为什么谓词被写成一个返回两半的函数，而不是两个可分别调用的片段。

---

## 11. 变更文件（18 个）

新增：`apps/kernel/migrations/0022_d5_business_workspace_scope.sql`、`apps/kernel/src/scope.rs`、
`apps/kernel/src/workspaces.rs`、`tests/acceptance/d5_workspace_scope.sh`、
`docs/design/g12-scope/d5-business-workspace-adr.md`（本文件）。

修改：`apps/kernel/src/{incidents,audit,investigations,diagnostics,plugins,routes,main}.rs`、
`contracts/openapi/incident-v1.yaml`、`apps/platform-web/src/{incidents.ts,incidents.test.ts,pages/Incidents.tsx}`、
`apps/platform-web/src/i18n/catalogs/{en,zh-CN}.json`。
