# DS-V1-0 — Baseline and design decisions

- 日期：2026-11-04
- `origin/main`：`775a1e2`
- 开发分支：`design/opsweave-visual-system-v1`
- 设计包基线：`b9a01db`（与当前 HEAD 的差异：PR #32 `auth.tsx` 登录单次往返；PR #33 ADR-016 文档。`apps/platform-web` 的视觉层无其他漂移。）
- 数据环境：本机 PostgreSQL 17 / Kernel `775a1e2`（本地构建）/ Chromium（Playwright 1.64.1）。Docker 不可用，因此节点与插件实例无法启动；Overview 与 Observability 的 live 数据是**真实的空/未配置状态**，不是 mock。Incident 数据通过公开 API 由 `tests/ui/g12d-seed.mjs` 创建（3 个 incident，5 条 evidence）。

## 1. 方法与证据

- 静态审计：组件、Token、三标杆、Gate、normative 文档五路并行；每条结论附 `file:line`。
- 浏览器：`tests/ui/visual-v1-capture.mjs` 在真实 Chromium 中登录（admin）并对三页录制 3 视口 × 2 主题 × 2 语言 = 36 张 before，改动后 36 张 after；同时记录 overflow、header 盒、计算字号、表格行高与区域盒。
- 现有测试：`overview-partial.spec.ts`（7）、`visual.spec.ts -g "responsive overview matrix"`（6 组合）、`observability-surface.spec.ts`（fixture 矩阵 7 测试）。
- 明确标注：Observability 的 13 节点矩阵是 `OBS_DATA=fixtures`，仅用于几何/状态验证；Overview 的 live 截图显示"未配置"而不是生产健康。

## 2. 组件所有权（摘要）

完整表见 [component-ownership.md](component-ownership.md)。

| 组件 | 权威 | 重复/旧实现 | 调用规模 | 迁移风险 |
|---|---|---|---|---|
| PageHeader | `components/app/page-header.tsx` | `components/Ui.tsx:11` | 39 / 3 | 低；保留 `data-testid=page-header` 与 80px 下限；旧实现缺 primary/meta/sub |
| Button | `components/ui/button.tsx` + `buttonVariants` | `.btn`（`styles.css:229`） | 30 文件 / 117 `<Button>` / 23 link；`.btn` 16 处全在 Studio | 中；Pattern D 兼容期不迁移；`.btn-secondary` 与 `variant=secondary` 填充不同 |
| Table | `components/ui/table.tsx` | `pages/table-kit.tsx`（组合层）；`plugins-table/nodes-table` CSS | 14 页面 / 17 列表页 | 中；390/768 重测前不得删旧 CSS |
| Status | `status-tone.ts` + `app/status.tsx` + `app/status-indicator.tsx` | `Ui.StatusBadge`（零调用）、`installation-state.ts`、`investigations.ts` 私有 tone | 33 StatusPill / 29 StatusIndicator / 23 Badge | 高；`AVAILABLE` 显示 "Uninstalled" 与 `STATUS_MAP` 的 "Available" 分歧；`CANCELLED` 在 investigation 是 warning、全局是 neutral |
| AsyncBoundary | `components/app/async-boundary.tsx` | `Ui.ErrorState`、`business-states.tsx` | 19 实例 / 13 文件；10 处 `ErrorState` 打印原始 `error.message` | 中；后者违反"服务端英文不直接渲染"的 i18n 规则 |
| Dialog/Sheet | `components/ui/dialog.tsx` | `Ui.Modal`、`app/sheet.tsx`、`ConfirmAction` | 9 直接 + 12 ConfirmAction | 中低；`.modal*` 与 DialogHeader 几何不可互换 |
| MetricCard | `components/app/metric-card.tsx` | 15 处手写 `.panel.metric-card` | 18 权威 / 15 旧 | 中；旧卡无 NO_DATA/UNKNOWN 与 observedAt；`IncidentDetail.tsx:319` 用 em dash |

## 3. Token 与字体

实测 `node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json`：

```
ok radius-tier 0 budget 0 · control-tier 0 budget 0 · type-tier 6 budget 6
ok one-header 3 budget 3 · uppercase-guard 0 budget 0 · format-locale 0 budget 0
PASS
```

- `type-tier 6` 不是"允许 6 处违规"，它**恰好**是 6 个非 11/13/15/26 的 `--ow-type-*` 声明：sm 12、base 14、lg 16、xl clamp、metric 21、hero clamp。
- 307 处 `font-size` 声明读取这 8 个 type token（其中 122 处读 sm 12）。改名会触碰 307 处；改值只触碰 token 块。
- `styles.token-contract.test.ts:29-36` 断言 base 14 / sm 12，是 R2 迁移的硬阻塞；迁移必须同 PR 修改该测试。
- `tailwind.config.cjs:75-81` 把 `text-sm/base/lg/xl` 映射到同一组 token；`text-xs` 指向未声明的 `--ow-type-xs`（当前无使用，潜在静默继承）。
- `components/app/avatar.tsx:13` 有 `text-[11px]` 硬编码，现有 gate 不扫描 TSX 的任意字号。
- `token-table.md` 中的 ratchet transcript 是历史运行（radius 118/119 等），与当前树不符；bare `check-ui-tokens.mjs` 会以 exit 2 退出（要求 `--ratchet`）。这些是文档债，不是代码失败。

决策见 [ADR-017 §D5](../../adr/ADR-017-visual-system-v1.md)：目标 11/13/15/26；标题保留 20→26 的响应式上下限（显式例外）；hero 仅 login/403；先改值后改名；`ui-debt` 只降不升。

## 4. 三个标杆的现状与差距

### A. `/admin/overview`

现状：健康带（chip + headline + detail + 关注链接）→ 4 KPI → 关注/可用性（窄列）+ 审计（宽列）；390 堆叠。已有 PARTIAL/DEGRADED/ATTENTION/未配置/403 状态。

关键差距：

1. **READY 与计数矛盾**：Kernel 的 `health` 只由 attention 列表推导（`apps/kernel/src/plugins.rs:647-653`），fresh `DEGRADED` 节点或未就绪副本不产生 attention 行；页面却打印 "Every enrolled node is reachable, every desired replica is ready"（`Overview.tsx:176-177`）。本轮已修：只有计数全部就绪才显示 all-clear。
2. **UNKNOWN 被画成 ATTENTION**：任何非 READY/DEGRADED 的 health 都落到 `tone-warn` + "Platform attention needed"。本轮改为 neutral + "Platform health is unknown"。
3. **没有 freshness 策略**：没有 `isStale`，失败刷新会把整页替换为 error；上一次好读数不会以 STALE 保留。本轮记录为未决（异步行为需要产品决策）。
4. **两次独立轮询**：shell 15s、页面 10s，最多一个轮询周期内 topbar 与 body 可矛盾。未改。
5. **PARTIAL 只在模块面板内**：诊断失败/403 都计为 missing；本轮用来源行的 `data-source-state=missing` 在首屏可见，但 notice 位置未动。
6. **空事件文案断言了页面不知道的原因**："Install a signed plugin or join a node to begin." 即使空的原因是 scope。本轮记录，未改。
7. **Kernel 文案在 band 中没有来源标签**：attention list 有 `kernel` 标签，band detail 没有。本轮已补。
8. **KPI 时间只有页面级**：4 张卡 `showSampled=false`，诊断 30s 与页面 10s 不同。本轮用来源行分列两个时间。
9. **DEGRADED 且 criticalCount=0 时会打印 "0 critical issues"**：本轮加 guard。
10. **INFO 严重度画成 notConfigured**：本轮新增 `info` 指示状态。

### B. `/app/observability`

现状：`Reading` 联合把"缺失即 0"变成类型错误；图表在 null/gap/generation 断线；KPI 报告 reporting/unobservable/peak CPU/memory；390 记录卡；fixture 矩阵覆盖 13 种状态。

关键差距（未修，下一阶段）：

- Reporting 卡在无数据/首次加载时打印 `0/0`（`Observability.tsx:215-223`）；Overview 已明确禁止 0/0。
- `DEGRADED` 节点被 `entityState` 折叠成 `unknown`（`observability-model.ts:69-78`），实体页再用"心跳过期"解释一个 fresh 节点。
- 每行 observed time 只在 hover title；`staleSamples` 计算了但未渲染。
- `entityRows` 用 `?? 0` 制造 0/0（`observability-model.ts:251-253`）。
- 已有数据后的 403/失败被 `error={data ? null : error}` 吞掉，只靠 12.5s 后的 STALE 提示。
- 实体页 instances KPI 对 unreachable/revoked 仍打印存储的 0/N；instances/events 面板在 loading/failed 时显示"空"。
- 该页矩阵规格存在，但**不在任何 workflow**（`check-spec-coverage.mjs:57` EXPLICIT_SKIP）；改动可以无浏览器门禁合入。

### C. `/app/incidents/:id`

现状：事件 → 时间线 → 证据 → 判定；Trust 轴分离（claimed vs verified、弱链接、legend）；409/403/异步失败/readback 有独立状态；390 三 pane 以 tab 可达。

关键差距（未修，下一阶段）：

- **证据 FORBIDDEN 是死代码**：`evidencePanelState` 只在传入 status 时返回 forbidden（`incidents.ts:321-331`），`IncidentDetail.tsx:225` 少传一个参数，403 落到可重试的 unavailable。
- `incident-evidence-trusted` 在 loading/forbidden 时打印 "0 of 0 evidence rows carry provenance"。
- `TrustSummary` 汇总全部 evidence，而不是 verdict 实际考虑的集合（`IncidentDetail.tsx:243-246`）。
- header 缺 owner 与权限范围；owner 只在第三 pane。
- 分析 pane 的手写 `.panel.metric-card` 重复 header 的 status/severity；`MetricCard` 导入未用。
- 审计/closure/identity/添加证据表单不可折叠。
- stale banner 直接拼接 `code`，时间用浏览器 locale；`investigation-panel.tsx` 在首次失败时伪造 `lastGoodAt=now`。
- digest mismatch 仍可读 bytes（安全/产品决策，不能只改视觉）。
- `verificationNote` 未翻译、无来源标签；`verifiedAt` 未渲染；fingerprint 只在打开 viewer 后可见。
- rail 在首答前打印 0 of 0。
- 证据子资源 403 没有测试；详情矩阵只 pin en。

**2026-11-04 追加（本轮已修）**：证据 403 的 `evidencePanelState` 现在收到 status，403 显示 forbidden 且不提供 retry；`incident-evidence-trusted` 只在 `present` 时渲染；assurance 改为 verdict 实际考虑的 `considered` 集；stale banner 使用本地化 HTTP 类别与页面语言时间，原始码只在 `data-error-code`。其余条目仍开放。

## 5. Gate 现状（要点）

完整命令/覆盖/预算见审计输出，结论按 `PASS / FAIL / NOT_RUN` 记录：

- **PR 时有浏览器门禁的只有 `g12-acceptance`**：它跑 9 个 spec，不渲染 `/app/observability`，不跑 Overview 的 body/dark/zh 矩阵，不跑 `admin-shell`/`visual.spec`/`overview-partial`/`ui-table-audit`。`staging-preview` 没有 `pull_request` 触发。
- **`observability-surface.spec.ts` 是 EXPLICIT_SKIP**；`overview-partial.spec.ts` 只在 full-tier staging（`continue-on-error`）运行；`incidents-workspace.spec.ts` 也是 EXPLICIT_SKIP。
- **`check-ui-metrics.mjs` fail-open**：输入展开为 0 个文件才失败；`{"pages":{}}` 打印 PASS；没有 route/width/theme 覆盖清单，也不校验 `config.baseURL/theme/data`。
- **PNG 预算零余量**：408/408 文件、65.97/68.24 MiB；全部 25 个 bucket 正好卡在上限；新提交任何 PNG 都会红。
- **没有视觉 diff**：没有 `toHaveScreenshot`/`toMatchSnapshot`；不溢出、不超表格阈值的视觉回归不会被发现。
- **没有 a11y/对比度/触摸目标 Gate**：`gateb-v3-evidence.mjs` 只打印 WCAG 比值，不断言；`dialog-a11y.spec.ts` 只在 full tier。
- **`tests/ui` 不被 typecheck**；root `ui:test` 不被任何 workflow 调用；`test:studio` 不在 CI。
- **`check-spec-coverage` 的 COVERED 语义太弱**：`continue-on-error` 与 shell 条件都被算作覆盖；非 `.spec.ts` 捕获脚本不在清单内。

这些是 DS-V1-3/独立 Gate PR 的范围，本轮不修，但报告里不把它们写成 PASS。

## 6. 与 normative 文档的冲突（逐条）

| # | 主题 | 现有规范 | 设计包/V1 | 处理 |
|---|---|---|---|---|
| 1 | 四类页面模式 vs 单一固定模板 | `page-template.md:3-4,84-86,240` | Pattern A/B/C/D + route registry | ADR-017 §D3；先改 page-template + `--template` gate，再改页面 |
| 2 | Studio header vs P3 | `page-template.md:155` 要求删除 `.studio-page .page-header` | Pattern D 保留专用 topbar，V1 只 smoke | ADR-017 §D3：Pattern D 声明例外，P3 移出 V1 |
| 3 | 12px vs 11/13/15/26 | `token-table.md:116-133` 删除 sm；`styles.css:105` 仍 12px；table-spec 用 12×1.4 推导 70.8px | 设计包要求 15/13/11/26 | ADR-017 §D5：值先行，12→13，重算 table-spec §2.5 |
| 4 | hero "已豁免" vs gate | `token-table.md:128-130` 声称有豁免；`check-ui-tokens.mjs:123-133` 没有 | 设计包依赖 Gate 执行例外 | ADR-017 §D5：实现命名例外表；hero 仅 login/403 |
| 5 | 设计包十六进制表 vs token-table | `token-table.md:474-483` 明确不做颜色；`rules/06` 禁止第二套 | 设计包给出精确色值，称为"现有 Token" | 保留 token-table 为唯一权威；色值表只作基线证据；对比度 Gate 另立 ADR |
| 6 | 内容边距 24 vs 32 | `page-template.md:139-142` ≥1280 = 32 | 设计包"通常 24" | 保留 page-template；修正设计包文字 |
| 7 | 间距 Gate | `code-rules.md` R7 声称 435→52 / 115→108；`ui-debt.json:8-9` 有键；`check-ui-tokens.mjs` 不读 | 设计包要求无固定尺寸绕过 Token | 未实现 R7；V1 不宣称间距已 gate |
| 8 | 12 组合证据矩阵 | doc 09/10 与 `AGENTS.md` 要求；实际 `ui-table-audit` 只 1440/390 light、10 路由 | 设计包要求每页 12 组合 | 本轮用新捕获脚本补齐三页 36 张；Gate 迁移另立 |
| 9 | 截图存储 | doc 09 说 CI artifact；`tracked-png-budget.json` 408/408 | 设计包说精选基线入 Git、全矩阵 artifact | 本轮全矩阵未跟踪；预算不提高 |
| 10 | Slice 状态词汇 | doc 10.6 没有 NOT_RUN；`rules/07` 要求 NOT_RUN | 设计包要求 PASS/FAIL/NOT_RUN | 检查级用 NOT_RUN；Slice 级映射另记 |
| 11 | 三轴 vs 既有封闭词汇 | `machine-language-rules.md:296` "No new state token"；`status-tone.ts` 闭集；`incidents.ts:30` trust 闭集 | 设计包加 Health/Freshness/Trust | ADR-017 §D4：表现层组合，不新增 wire code，不加 LIVE 行 |
| 12 | fixture vs 真实数据 | `rules/06:5` 禁止 mock 冒充；设计包允许标注的 fixture | 设计包要求 fixture/live 标注 | 保留；Gate 需机读 fixture/live |
| 13 | `components/domain/` | `code-rules` A1/A7 单一状态/表格权威 | 设计包建议新目录 | ADR-017 §D7：先所有权图，后建目录 |
| 14 | 文档引用的 gate 运行 | `token-table.md`/`spec/README` 引用旧预算与旧输出 | 设计包要求实际输出 | 本轮以 HEAD 775a1e2 的实测输出为准；旧 transcript 标为历史 |

## 7. 结论

Phase 0 的退出条件已满足：有可复核基线、所有权图、Token/文档冲突清单、ADR、真实浏览器 before 证据；没有未解释的门禁变化。第一标杆已按 ADR-017 §D8 完成并附 after 证据。三标杆全量、字体迁移、组件去重与 Gate 迁移是后续阶段，不能在报告中写成已完成。
