# G11 D3/D4 · Incident 业务 UI 与真实 Golden Path

- 状态：**D3 实现 + D4 端到端验收完成（本文件即证据索引）**
- 上游：`docs/design/g11-incident/incident-adr.md`（领域/状态机/权限/并发）、`contracts/openapi/incident-v1.yaml`
- 后端实现：`apps/kernel/src/incidents.rs`（D1/D2，本次仅新增 `owner` 列表筛选与对应单测）
- 前端实现：`apps/platform-web/src/pages/Incidents.tsx`（列表）、`pages/IncidentDetail.tsx`（详情）、`src/incidents.ts`（纯逻辑）
- 验收脚本：`tests/ui/g11-incident-slice.spec.ts`

---

## 1. 这次到底交付了什么

`/app/incidents` 不再是 NOT SHIPPED 占位页，而是一个读真实 Kernel API 的业务页面：

| 页面 | 路由 | 能做什么 |
|---|---|---|
| Incident 列表 | `/app/incidents` | 真实列表 + status/severity/owner 三个服务端筛选、手动创建、分页、真链接进详情 |
| Incident 详情 | `/app/incidents/:incidentId` | 时间线、证据列表（来源/采集时间/可信度/内容引用）、追加证据、人工结论（写入一次） |

**没有引入任何 UI 框架**：全部复用既有设计系统（`PageHeader`/`table-kit`/`AsyncBoundary`/`Status`/`Badge`/`Modal`/`useToast`/`.panel`/`.kv-grid` 等），没有新 CSS 类，`styles.css` 一行未改。

### 页面上故意不存在的东西
- 没有 AI 诊断、没有生成的根因、没有任何 "ai_*" 字段的展示（接口里也没有）。
- 没有 mock / fixture / 示例事件：所有行都来自 `GET /api/v1/incidents`。
- 没有"健康计数"：列表只报"本页 N 条"，不报总数（接口不提供聚合，ADR §7）。

### 诚实边界（页面上永久可见，不是文档里的脚注）
列表页有一块 `data-testid="incidents-boundary"` 面板，逐条写明：
1. 记录只能来自**人工录入**或 **API**；
2. **Zabbix / Nebula 采集未接入**，没有连接器；
3. **没有 AI 诊断**；
4. 筛选里有 CLOSED 是因为契约允许，但**本切片没有关闭接口**；
5. **没有全文搜索**（接口无该参数，只过滤已加载页会漏掉游标未取的记录）；
6. 负责人姓名来自**仅管理员可读**的用户目录，其他角色看到的是 id。

---

## 2. 交互状态矩阵

| 状态 | 触发条件（真实） | 页面表现 | 机器可读锚点 |
|---|---|---|---|
| loading | 请求未返回（含 CDP 限速下的真实慢请求） | 骨架屏 / `aria-busy` | `[data-detail-state="loading"]`、`[data-testid=incident-evidence-loading]` |
| empty（真空） | 接口 200 且 0 行 | EmptyState：**"还没有任何故障记录"** + 说明"这是空结果，不是系统健康" | `[data-testid=incidents-empty][data-empty-state="none"]` |
| empty（被筛掉） | 筛选后 0 行 | EmptyState："没有符合筛选条件的故障" + 清除筛选 | `[data-empty-state="filtered"]` |
| error | 请求非 2xx 且无旧数据 | 按**稳定错误码**本地化原因 + code + requestId + 重试 | `[data-testid=incident-list-error][data-error-code]` |
| stale | 已有数据 + 刷新失败（真实断网） | 保留行 + "当前显示 {时间} 读取到的数据；最近一次刷新失败：…" | `[data-testid=incident-freshness][data-stale="true"]` |
| evidence missing | 接口 200 且证据 0 条 | "还没有任何证据" + 说明确认类结论需要证据 | `[data-evidence-state="missing"]` |
| evidence present | 有证据 | 表格：类型/可信度/来源/采集时间/内容引用（可复制） | `[data-evidence-state="present"]` |
| evidence unavailable | 证据请求失败且无数据 | "证据读取失败（这不是没有证据）" + 原因 + 重试 | `[data-evidence-state="unavailable"]` |
| verdict open | 无结论 | 表单：结论（CONFIRMED/INCONCLUSIVE）+ 理由（≥10 字） | `[data-verdict-state="open"]` |
| verdict recorded | 已有结论 | 结论 chip + 签名人 + 理由 + 时间；重申不可修改 | `[data-verdict-state="recorded"][data-verdict-value]` |
| verdict sealed | 记录 status=CLOSED | "已关闭，不再接受结论"（不提供会 409 的表单） | `[data-verdict-state="sealed"]` |
| forbidden (403) | viewer 创建 / 追加证据 / 下结论 | 按码本地化："当前角色可读不可写…" + `FORBIDDEN` + requestId | `[data-error-code="FORBIDDEN"]` |
| 409 无证据 | CONFIRMED 且无证据 | "确认类结论至少需要一条证据：先追加证据，或改下无法定论的结论" | `[data-error-code="INCIDENT_EVIDENCE_REQUIRED"]` |
| 409 已结论 | 二次下结论 | "该故障已经有一个人工结论：结论只能写入一次" | `[data-error-code="INCIDENT_ALREADY_CONCLUDED"]` |
| 404 越权/不存在 | operator 打开他人记录 | "该故障对你不可见"（不渲染任何行） | `[data-detail-state="not-found"]` |

**失败文案规则**：前端**只用错误码**取文案（`incidents.error.<CODE>`），从不把 Kernel 的英文句子直接渲染给用户；码表里没有的码显示"内核以错误码 {code} 拒绝了该请求"。

---

## 3. 权限三档实测（真实浏览器 + 真实后端）

| 动作 | admin | operator | viewer |
|---|---|---|---|
| 读列表 | 全部 | **仅自己 owner 的** | 全部 |
| 读他人详情（直接 URL） | 200 | **404 → 页面显示"对你不可见"** | 200 |
| 创建 incident | ✅ 201 | ✅ 201（owner=自己） | **403 → 表单内显示 FORBIDDEN** |
| 追加证据 | ✅ | ✅ 限自己 | **403** |
| 下结论 | ✅ | ✅ 限自己 | **403（记录保持 open）** |
| 负责人姓名 | 显示姓名 | **显示 id 前 8 位 + 提示"当前角色无法读取用户目录"** | 同 operator |

三档都由**服务端**决定，前端只做呈现；页面上没有"按角色隐藏按钮"的授权逻辑（viewer 能看到创建按钮，点下去得到服务端的 403 与原因——这是比"藏起来"更强的证明）。

---

## 4. D4 Golden Path 逐条证据

运行环境：scratch 库 `opsweave_g11_d3`，Kernel `127.0.0.1:18199`（**非** 18181），浏览器 Chromium（Playwright），页面来自真实构建产物 `apps/platform-web/dist`。

| # | Golden path | 证据 |
|---|---|---|
| 1 | 页面上创建 incident（标为人工创建） | `data-source="MANUAL"` 断言；`data-status=OPEN`；截图核对：详情页徽标读作 Manual / Open，时间线首条是 Created（截图未入库，见 §4.1） |
| 2 | 刷新后仍存在（真持久化） | `page.reload()` 后 `data-incident-id` 与 h1 仍在（同一行测试断言） |
| 3 | 加一条 evidence，来源与内容可核验 | 提交后读回：`[data-evidence-content-ref]` == 输入值、`data-evidence-source` == `operator:<admin email>`、`data-evidence-kind=LOG_EXCERPT`；刷新后仍在；截图核对：证据表只出现一行 `LOG_EXCERPT`，来源列是 operator 邮箱，可信度列非空（截图未入库，见 §4.1） |
| 4 | 页面上能查询与浏览 | 列表 status=INVESTIGATING 命中、severity=MINOR 显示 filtered 空态、severity=MAJOR 再次命中；截图核对：三态依次为 1 行命中 / filtered 空态 / 1 行命中（截图未入库，见 §4.1） |
| 5 | 提交 Human Verdict 且真保存 | 提交 CONFIRMED → `data-verdict-state=recorded`、status 变 CONCLUDED；刷新后 `data-verdict-value` 仍为 CONFIRMED；列表 CONCLUDED 筛选命中、OPEN 筛选落空；截图核对：结论 chip 为 Confirmed 并带签名人与理由（截图未入库，见 §4.1） |
| 6 | 不同权限得到正确结果 | viewer 创建与下结论各拿到一次 403，页面按码本地化成同一句并附 requestId；operator 空态 / 越权 404「对你不可见」/ 自有闭环（截图核对，均未入库，见 §4.1） |
| 7 | 浏览器与后端 E2E 通过 | `5 passed (14.1s)`，命令与输出见 §6 |

额外证明（ADR §3.1 enabled）：**结论之后仍可追加证据**，且追加不会把 CONCLUDED 打回原状（测试断言证据数 1→2、状态仍 CONCLUDED）。

### 4.1 为什么这些截图不提交 Git

上表每一行的"截图核对"都是真跑出来的图，放在本机 scratch 目录 `artifacts/g11-d3/` 下——那个目录有 29 个产物（25 张 PNG + 3 个 JSON + 1 个子目录），**一个都没进仓库**。所以本文件不再复述它们的路径：引用一个只有我这台机器上存在的路径，等于在文档里写一句假话，而读者无法分辨那是证据还是笔误。

不提交的理由，按分量排序：

1. **它们是可重放的验证产物，不是基线。** 基线是"未来的 diff 拿它当对照物"（`artifacts/ui/visual-v3/` 里的那些），不提交就永久失去。这里的截图只回答"某次运行页面长什么样"，重跑 `tests/ui/g11-incident-slice.spec.ts` 就能再得到一份——§6.2 的命令里 `OPSWEAVE_G11_SHOTS=$PWD/../../artifacts/g11-d3` 就是它的输出位置。可复制性在命令里，不在 git 里。
2. **预算已满档，收它们必须拿基线去换。** 守卫的 ceiling 是 379 个文件 / 68.24 MB，当前正好 **379 个文件 / 68.03 MB**：字节余 0.21 MB，文件位数**零余量**。要收 6 张，就得从别的桶里赶走 6 张——而别的桶里被跟踪的每一张都被文档引用、且是成对的 before/after 基线。用一次性证据换可对比的基线是净损失，不是等价交换。
3. **"只收被引用的那 6 张"是没法解释的挑选。** 同一目录 29 个产物地位完全相同（还有 `07`–`11`、`matrix-*` 12 格、两份 header 基线 JSON）。收 6 张等于判剩下 23 个"不重要"，而当时的唯一依据只是"这 6 张恰好被表格引用"。要么整目录收，要么都不收；整目录收必然超预算。
4. **真正的证据本来就是可重跑的断言。** 上表的 `data-source` / `data-evidence-source` / `data-verdict-state` 这些锚点，加上 §6 的命令与原始输出，任何人 checkout 后都能自己验一遍。截图是这些断言的视觉注解：有帮助，但不是不可替代的那一半。

**以后真要收视觉基线怎么办**：像 `artifacts/ui/visual-v3/` 那样先在 `tests/ci/tracked-png-budget.json` 里登记这个桶，同时**下调**别处的 `maxFiles` 腾出位置（只降不升），并在提交信息里写清拿掉了哪个基线、为什么它可弃。不要靠"反正我本地能过"。

**这个 bug 的教训已经进守卫**：`tests/ci/check-tracked-png-budget.mjs` 的 E 类检查过去判断"这个文件在磁盘上存不存在"，而 CI 的 checkout 里只有被跟踪的文件，于是同一份代码本地绿、CI 红。现在它判断的是 **git 是否跟踪**（`git ls-files`），本地与 CI 给同一个答案；判定的对象仍是"文档有没有引用不存在的东西"，阈值一个没动。另外，"文件在磁盘上但没进 git"不再是静默通过，失败信息会直接指出这一点。

---

## 5. 自评：哪一条我其实没有端到端跑通

诚实清单，每条都写清"做到哪一步"：

1. **`data-evidence-state="unavailable"`（详情页证据读取失败）没有在浏览器里真实触发过。** 这个状态需要"incident 读到了、evidence 没读到"，真实环境里很难天然出现：断网时两个请求都会失败，页面走的是整页失败分支。目前它只被**单元测试**覆盖（`evidencePanelState(null,true)==='unavailable'`），UI 分支未被 E2E 命中。**没有写进通过项。**
2. **409 `INCIDENT_EVIDENCE_REQUIRED` 与 `INCIDENT_ALREADY_CONCLUDED` 的页面呈现没有走浏览器。** 这两个码用 curl 在真实后端验证过（见 §6 的 `6a`/`8`），前端码表与文案存在，但 E2E 里没有构造"无证据下 CONFIRMED"和"二次下结论"的点击路径（因为测试流程本身先补了证据、只下一次结论）。
3. **CLOSED 状态**：本切片没有任何端点能把记录关掉，所以 `data-verdict-state="sealed"` 与 `[data-evidence-state]←closed` 这两条分支**只由单元测试覆盖**，没有真实数据触发。页面上的"关闭"筛选同理只可能返回空。
4. **server 端 owner 筛选的越权组合**在浏览器里只验证了"operator 看不到他人记录"这一方向（列表 + 直接 URL）；"operator 显式用 owner=他人 id 查询返回空"只在 **Rust 单测**里验证（`owner_filter_narrows_the_scope_and_never_widens_it`），没有走 UI。
5. **分页（nextCursor）**：E2E 没有造 20 条以上记录，因此"下一页"按钮只验证了初始 disabled 状态，没有真翻页。
6. **`GET /verdict` 端点**只被 curl 与 Kernel 单测覆盖；页面读的是详情投影里派生的 `humanVerdict`（同一个权威，ADR §2.4），因此详情页本身不单独调用该端点。

---

## 6. 命令与原始结果

### 6.1 后端可用性（D3 前置闸门）
```
$ DATABASE_URL=postgres://localhost/opsweave_g11_d3 OPSWEAVE_BIND=127.0.0.1:18199 \
  OPSWEAVE_DATA_DIR=/tmp/opsweave-g11-d3/data ./target/debug/opsweave-kernel
... OpsWeave Kernel listening address=127.0.0.1:18199
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18199/livez
200
```
七条端点（admin 会话，真实 201/200/409）：
```
1 POST /api/v1/incidents                        -> 201 {"id":"c9a267bf-...","status":"OPEN","source":"MANUAL",...}
2 GET  /api/v1/incidents                        -> 200 {"items":[...],"nextCursor":null}
3 GET  /api/v1/incidents/{id}                    -> 200 {...}
4 POST /api/v1/incidents/{id}/evidence           -> 201 {"id":"a3e4cb3b-...","kind":"LOG_EXCERPT","source":"operator:admin@opsweave.local",...}
5 GET  /api/v1/incidents/{id}/evidence           -> 200 {"items":[{...}]}
6 POST /api/v1/incidents/{id}/verdict (无证据)   -> 409 {"code":"INCIDENT_EVIDENCE_REQUIRED",...}
7 POST /api/v1/incidents/{id}/verdict (有证据)   -> 201 {"verdict":"CONFIRMED","decidedBy":"9016da15-...",...}
  GET  /api/v1/incidents/{id}/verdict            -> 200 {"verdict":"CONFIRMED",...}
  重复 POST verdict                              -> 409 {"code":"INCIDENT_ALREADY_CONCLUDED",...}
```
新增 owner 筛选（本次唯一后端改动）：
```
GET /api/v1/incidents?owner=<self>   -> 200 items:2  [self,self]
GET /api/v1/incidents?owner=<other>  -> 200 items:0
GET /api/v1/incidents?owner=nope     -> 400 {"code":"INVALID_REQUEST","message":"owner filter must be a user UUID"}
```

### 6.2 D4 浏览器 E2E
```
$ cd tests/ui && OPSWEAVE_URL=http://127.0.0.1:18199 \
  OPSWEAVE_ADMIN_EMAIL=admin@opsweave.local OPSWEAVE_ADMIN_PASSWORD=*** \
  OPSWEAVE_G11_SHOTS=$PWD/../../artifacts/g11-d3 \
  npx playwright test g11-incident-slice.spec.ts --reporter=list
  ✓ 1 the admin creates an incident, it survives a reload, evidence is verifiable, the list queries it, and a verdict sticks (5.1s)
  ✓ 2 a viewer reads every incident and is refused every write, with the refusal explained (1.6s)
  ✓ 3 an operator cannot see a record owned by someone else, and can still close its own loop (2.1s)
  ✓ 4 the loading state is a real pending read, and a real transport failure is reported as stale (1.2s)
  ✓ 5 the list and the detail survive 1440/1024/390 in both themes, and the header action is reachable (3.0s)
  5 passed (14.1s)
```
既有 G07 业务套件（本次改了其中两条断言）：
```
$ npx playwright test business-workspace.spec.ts --reporter=list
  8 passed (12.5s)
```

### 6.3 回归闸门
```
$ pnpm typecheck                      -> 5 个包 Done（platform-web / hello-web / data-catalog-web / data-integration-web / hello-ops-web）
$ pnpm --filter @opsweave/platform-web test     -> Test Files 22 passed, Tests 209 passed
$ pnpm build:web                      -> dist/assets/index-*.js 1,101.97 kB, built
$ node scripts/check-i18n.mjs         -> OK — 1356 keys across 2 locale(s), 0 unused
$ node scripts/check-status-vocabulary.mjs -> clean (41 protocol codes)
$ node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json -> PASS
$ node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit -> PASS (30 page measurements)
$ cargo fmt --all -- --check          -> clean
$ cargo clippy --locked --workspace --all-targets -- -D warnings -> Finished (no warnings)
$ OPSWEAVE_TEST_DATABASE_URL=postgres://localhost/opsweave_g11_d3_test OPSWEAVE_REQUIRE_TEST_DATABASE=1 \
  cargo test --locked --workspace     -> 全部 suite ok（kernel 89 passed；incidents 模块 11 条，其中 8 条 DB 级，OPSWEAVE_REQUIRE_TEST_DATABASE=1 下无 skip）
```
闸门阈值一字未改：`ui-debt.json`、`table-spec.md`、`check-ui-*` 脚本全部原样。

---

## 7. 这个 UI 支持什么、不支持什么

**支持**
- 列表：status / severity / owner 三个服务端筛选、分页游标、每行真链接（可 Cmd-点击、可复制链接）、复制 id。
- 详情：身份/来源/关联对象、真实时间线（开始 / 每条证据的 `collectedAt` / 结论签署时间）、完整证据表（含可信度与不透明内容引用）、追加证据、写入一次的人工结论。
- 创建：标题、severity、开始时间、关联对象；`source=MANUAL` 显式发送并在表单里写明。
- 三档权限下读出正确差异；失败一律按错误码本地化并附 code/requestId。
- 明暗主题 + 1440/1024/390 三档宽度：2 主题 × 3 宽度 × 列表/详情共 12 格逐格核对过（截图未入库，理由见 §4.1）。

**不支持（本切片没有，页面也不假装有）**
- 关闭（CLOSED）、重开、删除、合并 incident；owner 转移/指派。
- 全文搜索、按时间范围筛选、总数/统计/SLA/MTTR 聚合。
- REFUTED 结论（API 支持，本表单只提供 CONFIRMED / INCONCLUSIVE，页面写明）。
- 结论修改或再次确认（写一次，无更新端点）。
- Zabbix / Nebula 采集接入；任何 AI 诊断或自动根因。
- 证据内容内联查看（`contentRef` 是不透明定位符，Kernel 从不抓取；页面不代抓，避免 SSRF 面与"看起来能看"的假象）。
- 证据编辑/删除（只追加）。
- 列表的"两行卡"手机优化（`.ow-card-2l`）：当前 390 下是标准 label|value 卡片，未做两行压缩。
- 调查工作区布局（`components/app/investigation-layout.tsx`）：占位页删除后**已不再挂载**，组件与它的 CSS 保留（仍在源码树内，未产生孤儿样式），等调查切片真正要用时再接。
- **本次改动未提交**：工作区为未提交状态（`git status` 见交付说明），由上层决定提交时机；PR #16 保持 Draft，未 merge / tag / force-push。

---

## 8. 实现期间发现的既有缺陷

```text
.page-header 在 ≥769px 是固定 80px（styles.css, page-template §2.1）。
当 header 的文案列 + 操作列在同一行放不下时，.page-actions 换行到 80px 之外，
而它后面那个 section 正常从 80px 开始排——于是后一个面板在绘制顺序上盖住了按钮。
E2E 第一次跑就撞上了：Playwright 反复报
  "<div class='panel-head'> from <section ...incidents-boundary> subtree intercepts pointer events"
也就是真实用户点不动"录入故障"。
```
处理：**没有改 `styles.css`**（那会改变所有页面的 header 高度、需要重做全量视觉基线）。本页改为"header 只放一个主操作 + 短描述"，刷新按钮移到筛选工具条，并留下 E2E 几何断言（`elementFromPoint` 命中创建按钮）防止回归。**这是壳层的既有隐患，其他页面写长描述时同样会踩到，建议单独开一条修复项。**

---

## 9. 本次改动的文件

后端/契约（3）
- `apps/kernel/src/incidents.rs`：列表新增 `owner` 筛选（先角色范围、再筛选，只收窄不放宽）+ `INVALID_REQUEST` 校验 + 1 条 DB 单测
- `contracts/openapi/incident-v1.yaml`：`GET /incidents` 增加 `owner` 参数与语义说明

前端（7）
- `apps/platform-web/src/pages/Incidents.tsx`（新）、`pages/IncidentDetail.tsx`（新）、`src/incidents.ts`（新）、`src/incidents.test.ts`（新）
- `src/types.ts`、`src/components/status-tone.ts`（+10 个码）、`src/App.tsx`（两条路由）
- `src/pages/workspace.tsx`：删占位页；capability 注册表加 `shipped`，"待处理"区与能力清单改为"已交付"
- `src/i18n/catalogs/en.json`、`zh-CN.json`：+108 组新键，-18 个随占位页失效的旧键

测试（2）
- `tests/ui/g11-incident-slice.spec.ts`（新，5 条）
- `tests/ui/business-workspace.spec.ts`（改写 2 条断言 + 首页/能力清单断言）

文档（1）：本文件

---

## 10. D3 评审后的修正与实测（2026-10-31）

D3 评审点了六条，本次修前四条。后端两条（审计与业务写同事务、create 重放返回 409 而不是 404）的论证与实测在 ADR §4.4 / §5.1；本节只记与页面有关的一条**决定**和一条**订正**。

运行环境与前文相同：scratch 库 `opsweave_g11_http`、Kernel `127.0.0.1:18199`（**非** 18181）、页面来自真实构建产物 `apps/platform-web/dist`、Chromium。

### 10.1 viewer 看得见写入口：保留入口，让 403 当文案

决定是 ADR §4.5 的 (b) 方案：入口对 viewer 照常渲染，点一次拿到服务端的高质量 403，而不是按角色禁用/隐藏。本次用真实浏览器复核了这条规则的每一格：

| 观测量 | 实测值 |
|---|---|
| 列表页 `[data-testid=incident-create-open]`（Record an incident） | `visible=true`、`enabled=true` |
| 点开 → 填标题 → 提交 | `[data-testid=incident-create-error]`，`data-error-code="FORBIDDEN"` |
| 提交后读者看到的文案 | `Your role can read incidents but not write them. Creating, adding evidence and recording a verdict are refused by the server.` + `Request ID <uuid>` |
| 详情页 `[data-testid=incident-evidence-form]` | `visible=true`、提交按钮 `enabled=true` |
| 证据提交 | `[data-testid=incident-evidence-write-error]`，`data-error-code="FORBIDDEN"`，同一句文案 |

也就是说 §3 里那条"页面上没有按角色隐藏按钮的授权逻辑"从"当时的做法"升级为**被明确选定、并写进 ADR 的产品规则**；它换来的代价（viewer 会看到两个永远失败的入口，每点一次重读一遍 403）与替代方案（禁用 + 解释）的比较见 ADR §4.5，不再悬着。

### 10.2 订正：`808047b` 的波及面比提交信息写的更大

`808047b`（"the page header was a fixed box"）的提交信息写"十二页数字不变，只有实例日志页变了"。**这句话不准确**：本次在自己的 scratch 实例上复测，`/app/home` 与 `/app/investigations` 两页的 header 高度和首块位置也变了。

测量方法（可复现）：登录后逐页 `page.goto`，取 `document.querySelector('header.page-header')` 的 `getBoundingClientRect()` 作为高度，取它的 `nextElementSibling` 的 `top` 作为首块位置；宽度 1440/1024/390。

| 页面 | 1440 en | 1440 zh-CN | 1024 en | 390 | header 内操作数 |
|---|---|---|---|---|---|
| `/app/home` | **80.7 / 161** | **83.2 / 163** | 80 / 184 | 157.5 / 250 | 0 |
| `/app/investigations` | **80.7 / 161** | **83.2 / 163** | 80 / 184 | 94.5 / 187 | 0 |
| 被抽样的十二页（`/admin/*` 11 个 + `/app/incidents`） | 80 / 160 | 80 / 160 | 80 / 184 | 各不相同（<769px 规则不适用） | 1–2 |

单元格是 `header 高度 / 首块 y`（px）。评审报出的 83/163 就是 **zh-CN（产品默认语言）下的这两页**；同一页在 en 下是 80.7/161。**变的是同两个页面，差的只是行高**——这正是"只测了一门语言就宣布零回归"会漏掉的那一格。

为什么会变：这两页用的是 `apps/platform-web/src/components/Ui.tsx` 里的 `PageHeader`，它的文案栈实测高 **80.7px（en）/ 83.2px（zh-CN）**（eyebrow 16.5/17.6 + margin 4 + h1 31.2 + margin 8 + 描述 21/22.4）。旧规则是固定 `height: 80px`，所以这两页**在修复前就已经比盒子高 0.7px（en）/ 3.2px（zh-CN）**，居中后上下各溢出约 0.35px / 1.6px——就是 §8 描述的那个缺陷，只是 808047b 的抽样没抽到它们。`min-height` 让盒子把内容装进去，像素数因此改变。

**功能上是否无害：无害，而且这两页原本也站在缺陷那一侧。**

1. 这两页的 header 里**没有任何操作**（`actions=0`），而缺陷唯一能被用户感知的形态是"按钮被下一个面板盖住、点不动"——这里没有按钮可盖。
2. 首块只下移了溢出的那一点（160 → 161 / 163），既不与 header 重叠，也不产生横向位移。
3. 十二个抽样页面在 en 与 zh-CN 下实测仍是 80/160，等于 808047b 自己记录的修复前基线（本次 header 基线测量里 `headerH` 与 `previousHeaderH` 都是 80、`firstBlockY` 与 `previousFirstBlockY` 都是 160；这份基线同样是本机 scratch 产物，未入库，理由见 §4.1）。所以 808047b 对那十二页的回归结论成立，错的只是**页数**：变的是三页，不是一页。

历史提交按评审要求不改，口径以本节为准。

