# G12 R2 Phase 2 · Investigation Panel 真实视觉与交互验收

分支 `feat/g12-ai-investigator`，HEAD `dffb328`。工作树 `ops-0.0.4-studio`。
本轮只改前端（`apps/platform-web/src/**`）、UI 测试（`tests/ui/**`）与文档；截图与量测产物全部落在未跟踪的 `artifacts/g12-r2p2/`。

## 0. 环境与可复现命令

| 项 | 值 |
|---|---|
| Kernel | `target/debug/opsweave-kernel`，`cargo build -p opsweave-kernel` 由 HEAD 构建，监听 `127.0.0.1:18199` |
| 数据库 | 隔离库 `opsweave_g12p2`（`dropdb/createdb` 后由 Kernel 迁移），未触碰共享库中的其它 schema |
| 前端 | `apps/platform-web/dist` 由 HEAD `pnpm --filter @opsweave/platform-web build` 产出，Kernel 以 `OPSWEAVE_WEB_DIST` 直接托管 |
| 浏览器 | Playwright `chromium`（`tests/ui/playwright.config.ts`），`workers=1` |
| 数据 | `node tests/ui/g12r2-seed.mjs`，**只走公开 API**，无 DB 直写、无网络桩 |
| 断言 | `npx playwright test g12r2-states.spec.ts g12r2-races.spec.ts g12r2-matrix.spec.ts` |

```
env DATABASE_URL=postgres://<user>@127.0.0.1:5432/opsweave_g12p2 OPSWEAVE_BIND=127.0.0.1:18199 \
    OPSWEAVE_WEB_DIST=apps/platform-web/dist OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL=admin@g12r2.invalid \
    OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD=g12r2-admin-password-1 target/debug/opsweave-kernel
```

## 1. 2.1 数据清单（每类：怎么造、真实 API 调用、Kernel 回什么）

三条业务工作区（`business workspace`）先行：`POST /api/v1/business-workspaces {key:"g12r2"}` + 4 次 `POST /api/v1/business-workspaces/{id}/members`。没有工作区时 `POST /api/v1/incidents` 返回 403 `INCIDENT_WORKSPACE_FORBIDDEN`——这是产品当前的真实边界，不是脚本的绕过。

| 类别 | 造法（真实 API） | Kernel 结果 |
|---|---|---|
| 有证据的 Incident | `POST /api/v1/incidents`（CRITICAL，startedAt=now-60m）+ 4 次 `POST /api/v1/incidents/{id}/evidence` | 4 行证据，2 行 `contentStatus=STORED`（text/plain 日志 + application/json 查询结果），1 行 `LEGACY_REFERENCE`（只给 contentRef），1 行 `claimedTrust=UNVERIFIED` |
| 无证据的 Incident | 同一 `POST /api/v1/incidents`，不追加证据 | `GET .../evidence` 返回 0 行；run 的假设 `stance=UNCERTAIN`、`gapCodes=["NO_EVIDENCE_ROWS"]` |
| 有反证的 Incident | startedAt=now-30m，另附 2 行 collectedAt=now-96/-88m + 2 行 now-18/-12m 的证据 | 假设 `stance=CONFLICTED`，`supportingEvidence=2`、`contradictingEvidence=2`、`gapCodes=["EVIDENCE_PREDATES_INCIDENT"]` |
| Legacy / Unverified Evidence | 见上：`contentRef` 无 content；`claimedTrust=UNVERIFIED` | `LEGACY_REFERENCE`；未验证计数进入 `EVIDENCE_UNVERIFIED` gap 与 `confidence=MEDIUM` |
| 有存储内容的 Evidence | `content:{contentType,body}` | `STORED`，`GET .../evidence/{id}/content` 回原文 + `x-evidence-digest`/`x-evidence-bytes` |
| 无权读取的 Incident | 由第二个 operator 账号 `other@g12r2.invalid` 创建 | 以 `operator@g12r2.invalid` 读：`GET /incidents/{id}` → **404 INCIDENT_NOT_FOUND**；`GET .../investigations` → **404 INCIDENT_NOT_FOUND**（不泄露存在性） |
| Run 终态 · 已完成 | `POST .../investigations {scenario:"AUTO"}` | `status=SUCCEEDED`，`stopReason=FINAL_ANSWER` |
| Run 终态 · 部分完成 | `{scenario:"CROSS_SCOPE_PROBE", probeIncidentId:<他人事故>, probeEvidenceId:<uuid>}`，由 **operator 账号**发起 | `status=PARTIAL`，5 次工具调用全部 `outcome=REFUSED`（4×INCIDENT_NOT_FOUND、1×SOURCE_UNAVAILABLE），`gapCodes=["TOOL_REFUSED"]` |
| Run 终态 · 取消 | `{scenario:"PACED_TOOL_LOOP", maxSteps:200}` 的 POST 不等待，500ms 后并发 `POST .../cancel` | 原请求最终返回 `status=CANCELLED`、`stopReason=CANCELLED`，cancel 请求本身 200 |
| Run 终态 · 预算耗尽 | `{scenario:"BUDGET_TOOL_CALLS", maxToolCalls:2}` | `status=BUDGET_EXHAUSTED`，`stopReason=TOOL_CALL_BUDGET` |
| Review 接受 / 拒绝 | `POST .../review {decision:"ACCEPTED"|"REJECTED", note}` | `review.decision` + `review.note` 出现在 run 文档；第二次 review 被判 `INVESTIGATION_ALREADY_REVIEWED` |

**TEST_FIXTURE 的三处标注**（API / 数据库 / UI）：
1. API：每个 run 文档带 `adapter:"TEST_FIXTURE"`、`adapterLabel:"TEST_FIXTURE - deterministic test adapter output, not a model's conclusion"`、`synthetic:true`、`usage.costBasis:"TEST_FIXTURE_NO_COST"`。
2. 数据库：`kernel.investigation_runs.adapter_kind='TEST_FIXTURE'`（与 `provider_id='test-fixture-v1'` 由约束绑定）。
3. UI：`[data-testid=investigation-adapter-badge]` 文本 "Test adapter"；`[data-testid=investigation-fixture-notice]` 渲染 `adapter.fixtureNotice`（"No model was consulted…"），带 `role="note"`。

## 2. 2.2 全状态视觉验收（逐项断言 + 截图）

两轮结果，都写进产物：`artifacts/g12-r2p2/logs/pw-final.log`（`21 passed`，面板逻辑定稿后、列表 class 归并前）与 `pw-final2.log`（`20 passed / 1 failed`，归并后重跑；唯一失败是竞态用例 R4 的**测试隔离**问题，见 §3 与 §10）。截图在 `artifacts/g12-r2p2/shots/`。

| 验收项 | 断言（spec 指针） | 截图 |
|---|---|---|
| Run 列表与选择 | `S1`：5 个 run 的 `data-run-status` 逐个核对；选中行 `aria-current`/唯一 `data-selected` | `state-<runId>.png` |
| Run 状态与失败原因 | `S1`：状态徽章文本 + `stopReason` 文本（Answered / Stopped at a budget / Cancelled + 各自原因） | `state-8b26…`、`state-6726…` |
| Tool Invocation | `S2b`：5 行、首行 `data-outcome=REFUSED`、错误码文本 | `state-partial-refused (capture, not committed)` |
| Supporting / Contradicting Evidence | `S4b`：两个分组按标题断言，反证组恰好 2 条 | `sum-conflicted (capture, not committed)` |
| Citation 内容展开 | `S2`：点开后 `data-evidence-id` 与被点 citation 一致，正文含真实日志行 `ERROR payment-webhook`；JSON 行含 `status_code`；Legacy 行说明"只有定位符没有内容" | `citation-content-stored/-legacy (capture, not committed)` |
| Confidence 与 Uncertainty | `S4`：`medium confidence` + uncertainty 段可见 | `hypothesis-provenance (capture, not committed)` |
| Gap Codes | `S4`/`S4b`：`EVIDENCE_UNVERIFIED` 文案、`NO_EVIDENCE_ROWS`、`EVIDENCE_PREDATES_INCIDENT` | 同上 + `sum-uncertain-no-evidence (capture, not committed)` |
| Review 接受与拒绝 | `S5`：UI 提交后徽章 `data-decision` 变更，且回读 API 二次确认 `review.decision` | `review-accepted/-rejected (capture, not committed)` |
| Cancel | `S5`：RUNNING→点按→toast→刷新→列表行 `data-run-status=CANCELLED` | `cancel-after (capture, not committed)` |
| TEST_FIXTURE 标签 | `S3`：徽章文本 + `role="note"` + 高度>10（不是 title/tooltip） | `synthetic-adapter-notice (capture, not committed)` |
| AI Hypothesis 与 Human Verdict 的区别 | `S4c`：面板侧 `AI hypothesis` 标签、判词侧 `Human verdict`；两段文本互不包含；面板内无任何 `data-verdict*` 节点 | `s4c-hypothesis-vs-verdict (capture, not committed)` |

### 2.2 的核心判据：「UI 不会让用户误认为模型推测就是事实」

本轮把这条判据从**注释**变成了**渲染事实**，四条互不依赖的证据：

1. **每一段推测自带出处标签。** 假设块第一行是 `[data-testid=investigation-hypothesis-kind]` → "AI hypothesis"，来源是 Kernel 的 `hypothesisKind:"AI_HYPOTHESIS"`（不是前端推断）。断言：`toHaveText('AI hypothesis')` + `data-hypothesis-kind="AI_HYPOTHESIS"`。
2. **合成来源在读者视线内，不在 tooltip 里。** `role="note"` 的 notice + "Test adapter" 徽章，断言可见且高度 >10px。
3. **与人类判词在结构上分离。** 断言假设语句的祖先链中不存在 `[data-testid=incident-verdict]`；反过来断言判词面板文本不包含假设语句；并且面板内**没有任何** verdict 控件（对每个可交互元素取文本做 `confirm|refut|inconclusiv|verdict` 匹配，结果为空数组）。
4. **面板自己把承诺渲染出来。** `VERDICT_SAFETY_KEY` 一句话（"Nothing on this panel can change the Human Verdict…"）以固定 key 渲染，测试断言其文本，而不是断言"源码里存在这个常量"。

并附一条否定证据：本轮**没有**在任何语言下把 stance 文案写成结论（`stance.UNCERTAIN` 渲染为 "Cannot be determined from this record"，`PARTIAL` 渲染为 "Answered on an incomplete read"），断言见 S1/S2b/S4b。

## 3. 2.3 异步竞态：七个场景逐条实测

先审代码再实测。审查发现面板有 **5 处未受保护**的异步写入（不是预设漏洞，是逐行读出来的）：

| # | 位置（改前） | 可写坏状态 |
|---|---|---|
| a | `refresh()` 无代号 | A 的列表晚到会覆盖 B 的 `runs/state` |
| b | `onOpenCitation()` 无代号 | A 的 evidence 正文晚到，会渲染在 B 的页面上；或渲染在已折叠的 citation 下；或顶掉后来打开的 citation |
| c | `selected` 从不失效 | 列表里没有该 run 时，整个 run 详情区**凭空消失**（标题下空白） |
| d | `onReview/onCancel/onStart` 无代号 | 切走之后，旧 incident 的写结果被 `map` 进新 incident 的 `runs`，并弹 toast |
| e | 读失败后旧数据无标注 | 403/401/404/网络失败后，旧 run 与写作控件继续以"当前数据"的样子存在 |

修法（`components/investigation-panel.tsx`）：`epoch`（incident 身份）+ `listTicket`（同 incident 内的读取代号）+ `selectedRef`/`openCitationRef`/`lastGoodAt` 三个稳定身份；**没有一处 timer**。任何响应落地前必须同时满足 incident 代号、run、citation 三者未变。

| 场景 | 实测断言（原文摘录） | 结论 |
|---|---|---|
| R1 A 的请求晚于切到 B 返回 | `expect(after).toEqual(bRuns.map(r=>r.runId))`；`for (const run of aRuns) expect(after,'A run … leaked into B').not.toContain(run.runId)` | 有漏洞→已修；修后通过 |
| R2 A 的 Evidence 内容晚于切到 B 返回 | `await expect(page.locator('[data-testid=investigation-citation-content]')).toHaveCount(0)`；`await expect(page.locator(PANEL)).not.toContainText('ERROR payment-webhook')` | 有漏洞→已修 |
| R2b 旧 citation 晚于新 citation 返回 | `await expect(body).toHaveAttribute('data-evidence-id', SEED.evidence.storedQuery)`（释放旧响应后仍成立）+ 两个按钮的 `aria-expanded` 分别 true/false | 有漏洞→已修 |
| R3 列表更新后原选中 Run 不存在 | `await expect(page.locator('[data-testid=investigation-selection-gone]')).toBeVisible()` + run 详情仍可见 + 恰好一个 selected | 有漏洞→已修（改为回落到最新 run 并说明） |
| R4 当前 Run 取消/完成后刷新 | RUNNING 时断言 `investigation-status=Running` 且无 review 表单；取消后刷新断言 `Cancelled` + `cancelled by an operator` + 出现 review 表单 | 通过（`pw-final.log`；`pw-final2.log` 中失败，原因见 §10：两个 Playwright 套件同时打同一个 Kernel，被测面板本身如实渲染了 Kernel 的状态） |
| R5 Review 提交期间切换 Incident | B 面板 `not.toContainText`(本次 review 的 note)、列表不含 A 的 run、`.toast` 计数 0；同时 API 回读 `review.decision==='ACCEPTED'`（写没有丢，只是没画错地方） | 有漏洞→已修 |
| R6 权限撤销（403） | banner `data-stale-code=FORBIDDEN` 且含 "requires the operator or admin role"；`investigation-stale=true`；start/cancel/review 表单计数 0；行仍在；解除后刷新 banner 消失、控件恢复 | 有漏洞→已修 |
| R7 404 / 网络失败 | banner 含 "not one you can read"；随后 abort 场景 `data-stale-code=NETWORK` 且含 "the network failed"；恢复后刷新 banner 归零 | 有漏洞→已修（第二次失败会重述 banner，改前会一直显示第一次的错误码） |
| R7b 401 | `await expect(page).toHaveURL(/\/login/)`，面板 `toHaveCount(0)` | 已测且原本成立（401 由 auth 层登出） |

**旧数据可见性的取舍（明说）**：读失败后不把已读到的记录扔掉——那会删掉读者唯一的材料；改为"标注 + 剥夺写权限"：顶部 `role="status"` 的 banner 说明"这是 {时间} 最后一次成功读取的结果，本次失败原因 {原因}"，`data-stale="true"` 落在面板与 run 详情上，start/cancel/review 全部不渲染。

## 4. 2.4 响应式与交互：28 组实测

7 个宽度 × Light/Dark × zh-CN/en = 28 组，每组都选中 run 并展开一条 citation（面板能展示的最宽内容），量测写入 `artifacts/g12-r2p2/matrix.json`：

```
node -e 'console.log(require("./artifacts/g12-r2p2/matrix.json").length)'   # 28
```

**elementFromPoint 的定义（避免自欺）**：只判定"当下这一屏、在这个 pane 的可视区内、且不在浮层 chrome 之下"的控件；被 `scrollIntoView` 推到粘性顶栏下面的控件属于滚动位置，不属于遮挡，单独计数（`skipped`）。两个数字都进表，所以排除项无法掩盖失败；同时断言每组 `controls > 0`（一次都没判定到就是盲区，不是通过）。

| width | theme | locale | doc overflow | panel overflow | controls judged | excluded | covered | tabs |
|---|---|---|---|---|---|---|---|---|
| 1440 | light | en | -15 | 0 | 11 | 12 | 0 | no |
| 1440 | light | zh-CN | -15 | 0 | 12 | 11 | 0 | no |
| 1440 | dark | en | -15 | 0 | 11 | 12 | 0 | no |
| 1440 | dark | zh-CN | -15 | 0 | 12 | 11 | 0 | no |
| 1024 | light | en | -15 | 0 | 10 | 13 | 0 | no |
| 1024 | light | zh-CN | -15 | 0 | 11 | 12 | 0 | no |
| 1024 | dark | en | -15 | 0 | 10 | 13 | 0 | no |
| 1024 | dark | zh-CN | -15 | 0 | 11 | 12 | 0 | no |
| 1023 | light | en | -15 | 0 | 17 | 6 | 0 | yes |
| 1023 | light | zh-CN | -15 | 0 | 17 | 6 | 0 | yes |
| 1023 | dark | en | -15 | 0 | 17 | 6 | 0 | yes |
| 1023 | dark | zh-CN | -15 | 0 | 17 | 6 | 0 | yes |
| 900 | light | en | -15 | 0 | 17 | 6 | 0 | yes |
| 900 | light | zh-CN | -15 | 0 | 17 | 6 | 0 | yes |
| 900 | dark | en | -15 | 0 | 17 | 6 | 0 | yes |
| 900 | dark | zh-CN | -15 | 0 | 17 | 6 | 0 | yes |
| 768 | light | en | -15 | 0 | 18 | 5 | 0 | yes |
| 768 | light | zh-CN | -15 | 0 | 17 | 6 | 0 | yes |
| 768 | dark | en | -15 | 0 | 18 | 5 | 0 | yes |
| 768 | dark | zh-CN | -15 | 0 | 17 | 6 | 0 | yes |
| 641 | light | en | -15 | 0 | 16 | 7 | 0 | yes |
| 641 | light | zh-CN | -15 | 0 | 16 | 7 | 0 | yes |
| 641 | dark | en | -15 | 0 | 16 | 7 | 0 | yes |
| 641 | dark | zh-CN | -15 | 0 | 16 | 7 | 0 | yes |
| 390 | light | en | -15 | 0 | 15 | 8 | 0 | yes |
| 390 | light | zh-CN | -15 | 0 | 16 | 7 | 0 | yes |
| 390 | dark | en | -15 | 0 | 15 | 8 | 0 | yes |
| 390 | dark | zh-CN | -15 | 0 | 16 | 7 | 0 | yes |

`doc overflow` 为负是竖向滚动条宽度导致的 `scrollWidth < clientWidth`，断言阈值 ≤1。

**本轮 2.4 抓到并修掉的真问题**：390/en 曾出现 `doc +29px / panel +57px`。定位（`matrix.json.offenders`）= `span.inline-flex.items-center +29px`，即共享 `Badge` 的 `whitespace-nowrap` 装着一整句 gap 文案（"Some cited evidence has no provenance…"）。修法：只在面板内允许这三类徽章换行（`styles.css` 新增 3 条 scoped 规则）。修后 28 组 doc/panel overflow 全部 ≤1。

补充实测（同一 spec 的其他用例）：
- **M2（390，Tabs 可达性）**：rail/analysis/detail 三个 pane 都在（`toBeHidden` 而非 `toHaveCount(0)`）；点分析区证据行的 `evidence-open` 后 `investigation-tab-detail[aria-selected=true]` 且 detail pane 含真实日志行；在分析区切换 run 后 `data-run-status` 与徽章同步，`data-selected` 恰好 1 个。
- **M3（900，键盘）**：`ArrowRight/ArrowLeft/Home/End` 推动 tab 选择与 pane；面板内连续 10 次 Tab，每次命中的元素都 `visible` 且仍在面板内；Escape 不清空 pane。
- **M4（641，长内容）**：JSON 正文 `pre` 的 `scrollWidth-clientWidth ≤ 1`（换行而不是横向裁切），正文长度 >300 字符，pane 与 document 均无横向溢出。

## 5. 2.5 视觉质量：同页同状态的改善前后

`artifacts/g12-r2p2/compare/` 里是同一 URL、同一 run（`completed`）、同一 citation 展开状态、同一视口的**面板元素截图**：
`before-1440-light-en (capture, not committed)` vs `after-1440-light-en (capture, not committed)`，`before-390-light-zh (capture, not committed)` vs `after-390-light-zh (capture, not committed)`。

| 观察点 | 改前 | 改后 | 是否只是"更整齐" |
|---|---|---|---|
| 面板总高（1440/en，同状态） | **4017 px** | **2105 px** | 功能性：长日志不再把结论顶出去 |
| Run 选择器 | 5 个等宽描边"按钮"堆叠，每行重复 "Test adapter"，选中态只有一圈边框 | 安静的行列表，选中行有左侧强调条 + `aria-current`，采样器只说明一次 | 偏观感，但选中态从"看不出"变成"看得出"（有可断言状态） |
| 面板内的嵌套卡片 | 4 个 `.panel.metric-card` 嵌在 `.panel` 里（框套框）+ 4 条 KV | 1 条 `.investigation-meta` 定义列表，8 个数字一段 | **只是更整齐**（见 §8 自评） |
| 假设块 | 陈述/推理/不确定三段同字重同色；无来源标签；citation 是整段 UUID | "AI hypothesis" 标签打头；陈述为正文尺寸，推理降级，不确定性带 2px 左规；citation 为 8 位短码（完整 id 在 `title`/`aria-label`/`data-evidence-id`） | 功能性（语义层级 + 可追溯不变） |
| Citation 正文 | 直接铺在面板底部，24 行日志把 review 推到屏幕外 | 打开在**命名它的 citation 下方**，并在 240px 内滚动 | 功能性（就近 + 不淹没结论） |
| 读失败 | 旧数据 + 控件照旧 | banner 重述 + `data-stale` + 写控件撤销 | 功能性 |
| gap 徽章 | nowrap 整句，390 溢出 29px | 允许换行 | 功能性（真溢出） |

## 6. 门禁（本轮真实运行）

| 门禁 | 命令 | 结果 |
|---|---|---|
| typecheck | `pnpm --filter @opsweave/platform-web typecheck` | PASS（`tsc --noEmit` 无输出） |
| vitest | `pnpm --filter @opsweave/platform-web test` | PASS：**25 文件 / 281 测试** |
| build | `pnpm --filter @opsweave/platform-web build` | PASS（`tsc --noEmit && vite build`，`built in ~4s`） |
| i18n | `node scripts/check-i18n.mjs` | PASS：1630 keys（+5：`hypotheses.kind`、`citation.toggle`、`selectionGone`、`staleNotice`、`error.network`），0 unused |
| status-vocabulary | `node scripts/check-status-vocabulary.mjs` | PASS：clean（41 protocol codes） |
| tokens --ratchet | `node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json` | PASS，计数与预算**逐项相同**：118/14/7/5/19/4（未调高任何预算） |
| metrics | `node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit` | PASS（30 页测量 / 9 断言）——**输入是既有审计产物，本轮没有重跑该 harness**，见 §7 风险 |
| PNG 预算 | `git ls-files '*.png' | wc -l` | **379（未变）**；本轮全部截图在未跟踪 `artifacts/g12-r2p2/` |
| Playwright | 见 §2/§3/§4 | `pw-final.log`：**21 passed**；`pw-final2.log`：**20 passed / 1 failed**（R4 测试隔离，见 §10） |

## 7. 越界发现（不在本轮可改范围，已记录未修）

1. **Kernel 500：跨范围 probe 在"调用者本来读得到目标"时会把别人的证据写进本 run。** 复现：管理员在事故 A 上以 `CROSS_SCOPE_PROBE` 探测事故 C（管理员可读）→ 5 次读取成功、transcript 吸收了 C 的证据 → 假设引用 C 的 evidence → 触发器拒绝 → `500 INTERNAL`：`hypothesis … cannot cite evidence …: that evidence does not belong to the incident this investigation is about`。属 `apps/kernel/src/investigations.rs`，本轮不可改。产物因此改用"operator 探测他人事故"来造 PARTIAL（真实拒绝、无外域证据写入）。
2. **被拒绝的工具调用不记录 `authorizationPredicate`**（Kernel 侧该列写 NULL）。所以"被哪条谓词拒绝"这一列在 UI 上**无法**出现；面板改为展示 Kernel 实际记录的 `errorCode` 文案（`INCIDENT_NOT_FOUND` / `SOURCE_UNAVAILABLE`），断言也据此写，未放宽。
3. `check-ui-metrics` 的输入是上一轮审计产物，**其 PASS 不覆盖本轮改动**（与前几轮同一处置方式，未重跑 `ui-table-audit` 以省 Playwright 配额）。

## 8. 自评：2.5 里哪一处只是"看起来更整齐"，而没有更好用？

**`.investigation-meta` 这一条。** 改前是 4 个描边 metric 卡 + 4 条 KV 行，改后是 8 个 `dt/dd` 的一段。它确实少了框套框、少了重复标题，但读者能做的事**一件都没变**：8 个数字既没有排序、没有阈值告警、也没有一比一的因果提示（比如 tokens 用了多少、还剩多少预算）。它消除的是视觉噪音，不是操作成本——如果只允许我留下三处改动，这一处会被我砍掉。

其余改动我认为不是"整理"：AI 假设标签、citation 正文就近展开 + 自带滚动、读失败的标注与写控件撤销、选中 run 消失时的回落说明、gap 徽章的换行（修 390 真溢出）都能用断言证明行为变化，且都对应一条验收判据。

## 9. 未验证 / 已知边界（不许含糊）

1. **R4 的加固未再跑**。`pw-final2.log` 里 R4 失败，根因不是面板：同一时刻另一个 Playwright 套件（`pw-run13.log` 那一轮）仍在跑，两轮各自起了一个 `PACED_TOOL_LOOP`。数据库是证据：
   ```
   g12r2-race-r4-…157128 | BUDGET_EXHAUSTED | STEP_BUDGET | steps=200   （本轮 R4 自己的 run）
   g12r2-race-r4-…154892 | CANCELLED        | CANCELLED   | steps=13    （另一套件的 run）
   ```
   旧写法用"最新出现的 RUNNING run"取被测对象，于是抓到的是别人的 run。已改为用本测试自己的 `idempotencyKey` 精确取（run 文档带 `idempotencyKey`）。**这处改动没有再跑一次 Playwright**——配额已用满 14 次；面板侧的行为已在 `pw-final.log`（21/21）验证过，未验证的只是这条测试的选择器。
2. **`check-ui-metrics` 的 PASS 不覆盖本轮**（输入是上一轮审计产物，未重跑 `ui-table-audit.spec.ts`）。
3. **被拒绝的工具调用没有 `authorizationPredicate`**（Kernel 写 NULL），面板因此无法展示"被哪条谓词拒绝"；这是数据缺口，不是 UI 缺口，已在 §7.2 记录。
4. **`docOverflow` 的 -15** 是竖向滚动条宽度导致 `scrollWidth < clientWidth`，不是负溢出。
5. 本轮**没有**验证真实模型 provider（`HTTP_OPENAI_COMPATIBLE`）：环境只有 `TEST_FIXTURE`，与 ADR-G12-004 §7 的 BLOCKED 状态一致。

## 10. 改动文件

| 文件 | 性质 |
|---|---|
| `apps/platform-web/src/components/investigation-panel.tsx` | 面板重构：身份守卫、来源标签、meta 段、假设块、就近 citation、stale 语义 |
| `apps/platform-web/src/styles.css` | 面板 22 条规则（只用既有 token；新增 scoped 换行修复） |
| `apps/platform-web/src/i18n/catalogs/en.json` / `zh-CN.json` | +5 key，两侧同键 |
| `tests/ui/g12r2-seed.mjs` | 真实 API 造数（含四终态与权限边界） |
| `tests/ui/g12r2-states.spec.ts` | 2.2（8 条） |
| `tests/ui/g12r2-races.spec.ts` | 2.3（9 条） |
| `tests/ui/g12r2-matrix.spec.ts` | 2.4（4 条，28 组合） |
| `tests/ui/g12r2-compare.spec.ts` | 2.5 before/after 同页同状态截图 |
| `docs/design/g12-r2/g12-r2-phase2-visual-acceptance.md` | 本文件 |