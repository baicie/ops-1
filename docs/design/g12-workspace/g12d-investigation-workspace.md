# G12 Phase D — Investigation Workspace（精修）实测报告

分支 `feat/g12-workspace`（自 `feat/g12-lifecycle`）。工作树 `ops-0.0.4-studio`。
本轮只改前端表现层：`apps/platform-web/src/**`、`tests/ui/**`、`docs/design/g12-workspace/**`。
**未改 API、未改权限、未动 kernel、未引入任何新依赖或第二套 UI 框架、未 merge/tag/force-push。**

## 0. 改动清单（12 个文件，未超 20）

| 文件 | 性质 |
|---|---|
| `apps/platform-web/src/styles.css` | 标题系统（D2）+ 工作区三栏（D1）+ 时间线/轨道样式（D3） |
| `apps/platform-web/src/components/app/page-header.tsx` | 动作栏可命名（`actionsLabel`），单 CTA 规则不变 |
| `apps/platform-web/src/components/app/investigation-layout.tsx` | 由 G07 的空区域声明重写为真实三栏 + <1024 的 tab 模型 |
| `apps/platform-web/src/pages/IncidentDetail.tsx` | 8 张纵向卡片 → 三栏工作区；新增事件列表 rail |
| `apps/platform-web/src/studio/PipelineEditor.tsx` | 9 个控件回到 PageHeader actions，删除 `.studio-toolbar` |
| `apps/platform-web/src/i18n/catalogs/en.json`、`zh-CN.json` | 各 +15 键（rail/pane/idle 状态） |
| `apps/platform-web/src/styles.token-contract.test.ts` | 删除对已删原语 `.investigation-region` 的引用（见 §6） |
| `tests/ui/g12d-workspace.spec.ts` | 新增：D1/D2/D3 断言 + 视觉矩阵 |
| `tests/ui/g12d-seed.mjs` | 新增：仅走公开 API 的夹具脚本 |
| `tests/ui/g12d-probe.spec.ts` | 新增：前后对照的几何测量（非断言） |
| `tests/ui/g11-page-header-growth.spec.ts` | 基线规则随 D2 更新（见 §6，**需评审确认**） |

## D1 · 任务型页面：三栏 + 移动端 Tab

### 结构

    ┌──────────────┬───────────────────────────┬──────────────────────────┐
    │ rail 232px   │ analysis minmax(0,1fr)    │ detail 320px             │
    │ 事件列表      │ 进展指标 / 时间线 / 审计   │ 选中证据内容 / 人工结论   │
    │ 状态筛选+计数 │ 证据分诊表                 │ 生命周期（关闭/移交）/ 事实 │
    └──────────────┴───────────────────────────┴──────────────────────────┘

* DOM 顺序 = 阅读顺序 = tab 顺序：rail → analysis → detail。
* `>=1024px`：三栏同屏，**页面不滚动，每个 pane 各自滚动**（`.main-content:has(.investigation-page){height:calc(100vh - var(--ow-topbar));overflow:hidden}`）。
* `<1024px`：同一批 pane 变成 tabs（`role=tablist` / `role=tabpanel`，roving tabindex，←/→/Home/End 自动激活）。
* 选择联动：中栏点 `View content` → 右栏出现证据查看器；手机上同时把 tab 切到 detail（`onPaneChange`）。
  路由变化（换事件）时 pane 复位到 analysis，避免“列表变了、事件没变”。
* 左栏是**真实可用**的列表：API `GET /api/v1/incidents?limit=50`，筛选 chip 由返回数据推导（无空结果 chip）、
  `aria-pressed` 标记选中、`aria-current="page"` 标记当前事件、加载/不可用/空/空筛选四态各自成句。

### 实测（`artifacts/g12d/d1-*.png`，断言在 `g12d-workspace.spec.ts` D1）

| 断言 | 结果 |
|---|---|
| 1440：三 pane 同时可见、无 tab 条、rail 行数 >1、时间线事实 >1、证据行 >2 | 通过 |
| 1440：三栏左右顺序 rail < analysis < detail，每栏宽度 >200px | 通过 |
| 1440：右栏查看器 `left >= detail.left` 且宽度不超出 pane | 通过 |
| 1024：仍是三栏（侧栏在 <1025 已收起，宽度够） | 通过 |
| 390：tab 3 个，初始只显示 analysis，切到 rail 后 rail 行数 >1 且无横向滚动 | 通过 |
| 390：每行 rail 项是 `href=/app/incidents/{id}` 的真实链接且文本非空 | 通过 |

## D2 · PageHeader 系统方案（**不许逐页规避**）

### 缺陷链（实测，不是推断）

1. `.page-header{height:80px}` → 内容超一行时第二行落到盒子外，被后续 section 覆盖点击（g11 已改 `min-height`）。
2. 为了让高度可预测，`>=769px` 时 `.page-description` 被 `white-space:nowrap;overflow:hidden;text-overflow:ellipsis` **截断一句话**。
3. 于是 Studio 的 9 个控件（1440 下 842px 宽）只能被**逐页**搬到 `.studio-toolbar` 行——把标题缺陷变成页面级规避。

### 方案：不是新组件，是三条布局规则

| 规则 | 声明 | 作用 |
|---|---|---|
| 副本栏有基线 | `.page-header-copy{flex:1 1 360px}` | 决定**谁离开这一行**：不是把控件压扁，而是动作栏换行 |
| 动作栏独占对齐 | `.page-actions{flex:0 1 auto;margin-left:auto}` + 手机 `flex:1 1 auto`（原 `flex:1`=`basis:0`） | 换行到哪一行都保持右对齐；控件按自身宽度换行而非被压缩 |
| 描述不截断 | 删除 ellipsis；`white-space:normal;text-wrap:pretty;overflow-wrap:anywhere` | 长描述按整行增长，语义完整 |
| 不抖 | `.page-header-meta{min-height:24px}`、chip `flex:0 0 auto`、`.page-stack>.page-header{flex:0 0 auto}` | chip 换字不换行高；标题不被 flex 挤压 |

`min-height:80px` 保留为**地板**：内容能放下的页仍恰好 80px（下面 12 条路由实测未变），放不下的页**按整行**增长，且增长在自己的盒子里。

### Studio 规避的收口（前后对照）

* 前：`<PageHeader … />` + 紧随其后的 `<div className="studio-toolbar" role="group">9 控件 + 主 CTA</div>`，另有 60 行 CSS 论证“为什么这一页要单独一行”。
* 后：9 个控件作为 `PageHeader actions`（`actionsLabel` 保留组语义），主 CTA 作为 `primary`；`.studio-toolbar` 规则删除。
  `.studio-shell` 也不再写 `calc(100vh - 288px)`（288 = 手算的“topbar 56 + header 80 + gutter + 40px 工具栏行”），
  改为 `.main-content`→`.studio-page`→`.studio-shell` 的 flex 填充：画布拿“剩下的高度”，与 header 实际高度解耦。
* 全站证据：`grep -rn "studio-toolbar" src` 只剩注释里的历史说明；DOM 断言 `document.querySelectorAll('.studio-toolbar').length === 0`（D2 用例，6 组组合全部为 0）。

### 系统级前后对照（同一页面、同一注入、两次构建）

注入法：在同一页面把标题换成 zh/en 混排长标题、描述换成两语句、动作栏追加 10 个真实按钮（**只加 DOM，不改产品文案**）。
`/admin/overview`，原始测量见 `/tmp/g12d/before|after/before.json`：

| 组合 | 注入后 headerH（前） | 注入后 headerH（后） | 控件可点（前） | 控件可点（后） |
|---|---:|---:|---|---|
| 1440 | 143 | 131 | 是 | 是 |
| 1024 | 138 | 126 | 是 | 是 |
| **390** | 124 | **220** | **否（5/12 不可点）** | **是（12/12）** |

390 是这一轮的核心：`flex:1`(=basis 0) 让 12 个控件挤进一行、单个宽度掉到 ~24px，`elementFromPoint` 打不中；
改成 `basis:auto` 后动作栏按行换行，12 个全部可点、全部在 header 盒内、后续 section 不覆盖。

### 12 条已发布路由：基线**没有移动**

同一探针在改动前后跑同一批路由（1440/1024/390）：`headerH` 全部相同——1440/1024 均为 80，390 为 72/114/135/146/218（视页面而定），
`escapesHeader=false`、`allReached=true`、横向溢出为负（无滚动）。唯一差异是 `/app/incidents/{id}` 的 1440 行，
前后两次采样落在不同渲染阶段（一次已加载为 167、一次加载中为 80），因此该行不参与前后对照；
它的正式数字来自视觉矩阵（见 §4：未结事件页 1440 = 107、1024 = 96、390 = 218/221；已结页 80/80/146）。

### 长标题/长描述/多语言不遮挡

D2 用例在 `/app/incidents` 上对 **en / zh-CN × 1440 / 1024 / 390** 六组注入后测量：

| 语言 | 宽度 | headerH(出厂) | headerH(注入后) | 控件 | 标题行 | 描述行 | 不可点 | 标题裁切 | 描述截断 |
|---|---:|---:|---:|---:|---:|---:|---:|---|---|
| en | 1440 | 80 | 198 | 11 | 2 | 3 | 0 | false | false |
| en | 1024 | 80 | 235 | 11 | 2 | 3 | 0 | false | false |
| en | 390 | 114 | 439 | 11 | 4 | 6 | 0 | false | false |
| zh-CN | 1440 | 80 | 203 | 11 | 2 | 3 | 0 | false | false |
| zh-CN | 1024 | 80 | 240 | 11 | 2 | 3 | 0 | false | false |
| zh-CN | 390 | 116 | 400 | 11 | 4 | 6 | 0 | false | false |

证据口径：`titleClipped = h1.scrollHeight > h1.clientHeight+1`、`descTruncated = .page-description.scrollWidth > clientWidth+1`、
`unreachable = elementFromPoint(控件中心) 落在控件内`。zh 比 en 高 2–5px 是行高差异（预期），两者都无裁切。

### 状态 chip 变化不抖动

同一页把状态 chip 文本换成更长标签：`headerH 107 → 107`，**delta = 0**（`artifacts/g12d/d2-chip-jitter.json`）。

## D3 · 视觉与交互逐项（同页同状态前后对照）

| 项 | 前 | 后 |
|---|---|---|
| 排版/字体 | 描述被 ellipsis 截断；`.timeline` 用 12px 且带左侧竖线 | 描述整行显示 + `text-wrap:pretty`；时间线 13px(`--ow-type-meta`)、时间列 `tabular-nums` 右对齐、窄屏回落到左 |
| 信息层级 | 8 张等宽卡片纵向堆叠（状态/严重度/证据数/更新时间与“事实”同权） | 指标进中栏顶部；事实（id/owner/revision/closedBy）降到右栏参考区；决策（结论/关闭/移交）独占右栏 |
| 时间线 | 每行一个 flex 行，点与文字同级，无 kind 语义 | 网格两列（marker + 内容），marker 按 `data-fact-kind`（started 中性 / evidence 蓝 / verdict 绿）着色，行间 1px hairline，末行无分隔 |
| Evidence Viewer | 表格下方展开，会把中栏内容继续往下推 | 移到右栏主从视图；未选中时有明确 idle 说明（`incidents.detail.evidence.idle.*`）；`data-evidence-idle` 可测 |
| 签署与关闭 | 与移交混在同一面板、位于页面底部 | 仍在同一 panel（一次决定一件事），但固定出现在右栏，与证据证据链相邻；关闭表单/只读原因/已关闭记录三态未变 |
| 空状态与错误 | 证据/审计/时间线各自成句 | 保留并统一：rail 新增 加载/不可用/空/空筛选 四态；右栏新增 idle 态 |
| 数据来源可读性 | 证据表“Collected”列 ISO 时间在窄栏内折成两行（`2026-10-` / `31T05:52:09.083Z`） | 时间戳列禁止折行；rail 每行给出 状态+严重度+更新时间+owner 四要素 |
| 多面板布局 | 无 | §D1 |
| 键盘 | 无 tab 模型 | tablist roving focus；←/→/Home/End 自动激活并移动焦点；`Enter` 触发证据行 `View content`；焦点环实测 `outlineWidth>=2px` 且 `outlineStyle!=none` |
| 深浅色一致性 | — | 矩阵 24 组合中 light/dark 的 headerH、溢出、不可点数完全一致；未新增/修改任何颜色 token |

## 4. 视觉矩阵（实测）

命令：`cd tests/ui && OPSWEAVE_URL=http://127.0.0.1:18199 npx playwright test g12d-workspace.spec.ts`
输入：`artifacts/g12d/matrix.json`（其中 `truncated` 即“描述是否被截断”）；截图：`artifacts/g12d/matrix-<宽>-<主题>-<语言>-<open|concluded>.png`（24 张）。

| 宽度 | 主题 | 语言 | 状态 | headerH | 控件 | 横向溢出 | 不可点 | 标题裁切 | 描述省略 |
|---|---|---|---|---|---|---|---|---|---|
| 1440 | light | en | open | 107 | 2 | -15 | 0 | false | false |
| 1440 | light | en | concluded | 80 | 2 | -15 | 0 | false | false |
| 1440 | dark | en | open | 107 | 2 | -15 | 0 | false | false |
| 1440 | dark | en | concluded | 80 | 2 | -15 | 0 | false | false |
| 1440 | light | zh | open | 109 | 2 | -15 | 0 | false | false |
| 1440 | light | zh | concluded | 80 | 2 | -15 | 0 | false | false |
| 1440 | dark | zh | open | 109 | 2 | -15 | 0 | false | false |
| 1440 | dark | zh | concluded | 80 | 2 | -15 | 0 | false | false |
| 1024 | light | en | open | 96 | 2 | -15 | 0 | false | false |
| 1024 | light | en | concluded | 80 | 2 | -15 | 0 | false | false |
| 1024 | dark | en | open | 96 | 2 | -15 | 0 | false | false |
| 1024 | dark | en | concluded | 80 | 2 | -15 | 0 | false | false |
| 1024 | light | zh | open | 98 | 2 | -15 | 0 | false | false |
| 1024 | light | zh | concluded | 80 | 2 | -15 | 0 | false | false |
| 1024 | dark | zh | open | 98 | 2 | -15 | 0 | false | false |
| 1024 | dark | zh | concluded | 80 | 2 | -15 | 0 | false | false |
| 390 | light | en | open | 218 | 2 | -15 | 0 | false | false |
| 390 | light | en | concluded | 146 | 2 | -15 | 0 | false | false |
| 390 | dark | en | open | 218 | 2 | -15 | 0 | false | false |
| 390 | dark | en | concluded | 146 | 2 | -15 | 0 | false | false |
| 390 | light | zh | open | 221 | 2 | -15 | 0 | false | false |
| 390 | light | zh | concluded | 149 | 2 | -15 | 0 | false | false |
| 390 | dark | zh | open | 221 | 2 | -15 | 0 | false | false |
| 390 | dark | zh | concluded | 149 | 2 | -15 | 0 | false | false |

（`横向溢出 = scrollWidth - clientWidth`，负值表示没有溢出；`open` = 含 5 条证据的未结事件，`concluded` = 已签署结论的事件。）

## 5. 门禁

| 门禁 | 命令 | 结果 |
|---|---|---|
| typecheck | `pnpm --filter @opsweave/platform-web typecheck` | 通过（0 error） |
| vitest | `npx vitest run src`（apps/platform-web） | 22 文件 / 247 用例全部通过 |
| build | `pnpm --filter @opsweave/platform-web build` | 通过 |
| i18n | `node scripts/check-i18n.mjs` | OK，1490 键 × 2 语言，0 未使用 |
| tokens | `node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json` | PASS，计数与预算**逐项相同**（118/14/7/5/19/4），未调高任何预算 |
| metrics | `node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit` | PASS（30 页测量 / 9 项断言）——**输入是既有的审计产物，本轮没有重跑该 harness**，见 §6 风险 |
| PNG 预算 | `git ls-files '*.png' \| wc -l` | **379（未变）**；本轮 39 张截图全部落在未跟踪的 `artifacts/g12d/`，不进 Git |
| Playwright（本轮新增） | `npx playwright test g12d-workspace.spec.ts` | **4/4 通过** |
| Playwright（既有基线） | `npx playwright test g11-page-header-growth.spec.ts` | **2 通过 / 1 失败**：`detail pages` 用例在 `/admin/plugins/dev.opsweave.ops-center @1024` 实测 headerH=**102**，基线要求 80。这是本轮唯一未闭合的门禁，见 §6.4 |

## 6. 需要评审确认的三件事（已做/未做，都写清楚）

1. **`tests/ui/g11-page-header-growth.spec.ts` 被修改**（+37/-…）。原因：原规则“内容放得下的页必须 80px”，
   而 `/admin/plugins/{id}` 的 80px 正是 ellipsis 截断换来的；D2 要求去掉截断，于是该页 1024 下变 102（一行描述的高度）。
   改动方式是**把一条检查换成两条更强的检查**：新增 `descriptionTruncated`/`descriptionLines` 两个观测量，
   规则改为“描述需要超过一行时才允许 >80，且此时必须：不截断、控件全在 header 盒内、全部可点、下一区块在 header 之后”。
   同时删除了注入用例里两条“重放 `height:80px` 以复现旧缺陷”的断言——旧缺陷在新布局下**不再可复现**（动作栏改为换行而非被压扁），
   那两条断言的“before 侧”失效，但其守护的性质由该用例其余三条断言 + 新增的“描述不截断”继续守护。**这一步请明确批准或退回。**
2. **`styles.token-contract.test.ts` 删除了一行原语清单**（`.investigation-region`）：该原语本轮随三栏重写被删除，
   工作区的卡片语义已由 `.panel` 承担（清单里本来就有）。不是放宽阈值，是移除一个已不存在的选择器。
4. **未闭合：`g11-page-header-growth.spec.ts` 的 `detail pages` 用例，单页 102px vs 基线 80px。**
   路由 `/admin/plugins/dev.opsweave.ops-center`，宽度 1024，实测 102（80 + 约一行 22px），控件全在盒内、全部可点、描述未截断。
   我在该用例里加的分支本应接住“副本块需要两行”的情况，但没有触发——说明那 22px 不是 `.page-description` 的行
   （`measure()` 量到 `descriptionLines` 仍为 1），而更可能来自该页 `meta` chip 行或 eyebrow 与 `.page-header-sub` 的
   行高组合。**我没有为了让它变绿而继续放宽断言**：该用例的另外两条断言（控件在盒内、全部可点）在 102 下是通过的，
   冲突点纯粹是“这一页应不应该是 80px”。两条路：(a) 接受该页 102px，条件是先把 `descriptionLines` 换成
   “副本块实际占了几行”的量（`Math.max(说明行, chip 行)`），我这轮没时间验证；(b) 该页恢复 ellipsis——与 D2 冲突，不建议。
   需要评审在这两条里选一个，我这轮选择**报红而不是改绿**。

3. **`check-ui-metrics` 的输入是旧产物**：`artifacts/ui/visual-v3/audit/_metrics_*.json` 来自上一轮审计，
   本轮没有重跑 `b5-visual-matrix` harness（它依赖一套本机没有的演示数据）。该门禁的 PASS 只说明“既有产物仍合规”；
   本轮的溢/裁切数字在我自己的 `artifacts/g12d/matrix.json` 里，且断言是 fail-closed 的（`<=1` 溢出、不可点必须为空）。

## 7. 自评：390px 下哪一栏只做到“可达”，没做到“可用”

**左侧 incident 列表栏。**

它是真的 tab、真的能筛选、真的能点进下一个事件（1440/1024/390 的截图见 CI artifact，未入库），没有被 `display:none` 藏掉——这一点我守住了。
但在 390px 它**失去了它存在的理由**：桌面端这一栏的价值是“一边读事件、一边看队列里还有什么”，而在 tab 模型下，
列表和事件永远不同屏，"看完这个看下一个"退化成两次点击 + 一次面板切换。
我做的缓解只有：`aria-current` 标当前项、chip 显示各状态计数、筛选状态在 panel 内保留、换事件后自动回到调查栏。
真正该做而没做的是 **Sheet/抽屉浮层**（在任意 pane 之上叠加列表，保留上下文），
本轮没做是因为它要新增一个 overlay 组件与焦点陷阱验证，与“≤20 文件 / 280 分钟 / 不引新依赖”的边界冲突；
我选择交付一个诚实的 tab，而不是一个半成品抽屉。
另外两栏（调查 / 证据与结论）在 390 是等比列可用的：证据表在 <768 走既有的卡片化（`data-label` 行头），查看器满宽。

## 8. 未做/已知限制

* 证据内容查看器（`evidence-viewer.tsx`）**未改**：长行折行、超大 body 的虚拟化、行号均保持原状；本轮只搬了它的位置并补了 idle 态。
* 中栏证据表在 1440 的窄列里仍需横向滚动（5 列 + 长 `contentRef`）；把它改成“列表 + 详情”是下一轮的事。
* `/admin/plugins/{id}` 等描述较长的页在 1024 下 header 由 80 → 102，属于 D2 的预期结果，需与 g11 基线的决策（§6.1）一起评审。
* 结论/关闭/移交三个表单的内部排版未重排，只换了所在栏。

---

## 9. 阶段 D 收敛：22px 的实测归因，与 header 不变量的重写（2026-10-31）

§6.4 那条红（/admin/plugins/{id} @1024 = 102px vs 基线 80px）不是二选一，因为**断言问错了问题**：
D2 之后 header 的高度是内容的结果，不是不变量。本节记录实测归因、重写后的三条不变量、新的反事实，
以及 check-ui-metrics 的覆盖声明。

### 9.1 那 22px 到底是什么（实测，逐子元素）

/admin/plugins/dev.opsweave.ops-center，1440 / 1024，header 内每个子元素的 getBoundingClientRect().height
加 getComputedStyle 的 margin / line-height（探针 tests/ui/g12e-probe.spec.ts 的 TREE evaluate，产物 /tmp/g12e/tree.json）：

| 子元素 | 1440 | 1024 | 计算样式要点 |
| --- | --- | --- | --- |
| p.eyebrow | 16.5 | 16.5 | font-size 11px，line-height 16.5px，margin-bottom 4px |
| h1（含 .title-with-status 的 System 徽章） | 31.2 | 25.8 | --ow-type-xl：26px → 21.504px（随视口收缩），line-height 1.2 |
| div.page-header-sub | **24** | **56** | 里面只有 .page-header-meta > .detail-meta 的 chip 块 |
| div.page-actions | 36 | 36 | 与 copy 同一 flex line（rail1inline） |
| header.page-header（盒） | **80** | **102** | 80 = min-height 地板；102 = 内容 102.3 |

算术（1440）：16.5 + 4 + 31.2 + 24 = 75.7 → 内容比地板低 4.3px → 盒 = 80。
算术（1024）：16.5 + 4 + 25.8 + 56 = 102.3 → 盒 = 102。
**102 − 80 = 22.3，也就是「内容超出地板的量」**：chip 行由 1 行变 2 行（24 → 56，+32），
被 h1 的字号收缩（31.2 → 25.8，−5.4）部分抵消，净 +26.6 内容，扣掉 1440 那 4.3px 余量得 22.3。

margin 复核（结论：**没有意外的 padding/margin 累积，无需修**）：
p.eyebrow 的 margin-bottom: 4px 是该页唯一的非零 margin；
.page-description 与 .page-header-meta 各自的 margin-top: 8px 都被 .page-header-sub 的两条子规则覆盖为 0，
实测 computed margin-top: 0px。所以 22px 不是「两个 8px 叠出来」的，而是 chip 块真的换了一行。

由此：**§6.4 那个猜测（「meta chip 行或 eyebrow 与 .page-header-sub 的行高组合」）被实测取代**——
eyebrow 恒为 20.5px 且不随宽度变化，它不是 22px 的来源；来源是 .page-header-meta > .detail-meta
在 1024 的 copy 列宽下把 6 个 chip 折成两行。这是 D2 的**预期结果**（chip 换行，而不是被 ellipsis 裁掉），
该页 102px 应被接受，而「必须是 80」这条断言应被删除（见 9.2）。

### 9.2 新的不变量：三条真的，加两类互比

tests/ui/g11-page-header-growth.spec.ts 重写。断言对象从「高度」换成三件事（每次测量都跑）：

1. **没有控件被盖住** —— elementFromPoint 在控件中心必须命中自身或其后代；没命中时把**盖住它的元素**记进 coveredBy。
2. **没有文字被裁切** —— 对 header 内每个自有文本节点：scrollWidth <= clientWidth、scrollHeight <= clientHeight
   （在 overflow 隐藏时）且未声明 text-overflow: ellipsis / -webkit-line-clamp；违例逐条列出。
3. **下一区块不重叠** —— nextElementSibling 的 top >= header 的 bottom。

高度只保留一条比较，且**从不与常数比较**：同类别（列表 / 详情）同宽度下，
两页只有在 header **形状键**不同时才允许高度不同。形状键由 DOM 量出来：
eyebrow?/title<N>行/desc<N>行/meta<N>行/rail<N>行·是否独占一行。
同形状不同高 = 失败（这正是 G11 的原始缺陷：同一模板上 36/60/72/86/122px 的红）。
两类的实测值每次运行都打印（本轮输出）：

```
list @1440     pages=12  heights=[80]  shapes=4   (overview:80 nodes:80 ... incidents:80)
list @1024     pages=12  heights=[80]  shapes=4
list @390      content-high by design, heights=[72, 114, 135, 151]
detail @1440   pages= 3  heights=[80, 107]      shapes=3  (plugin-detail:80 pipeline-detail:80 incident-detail:107)
detail @1024   pages= 3  heights=[80, 96, 102]  shapes=3  (plugin-detail:102 pipeline-detail:80 incident-detail:96)
class values @1440: list=[80]  detail=[80, 107]
class values @1024: list=[80]  detail=[80, 96, 102]
```

另外两类共享**同一个地板**：min(detail) === min(list)（上面 1440/1024 均为 80），
这条比较的是**另一类**而不是常数——详情页允许比列表页高，但不允许有比列表页更低的地板。

本机（自建 scratch，见 9.4）跑出来的详情页只有 3 条：node-detail / job-detail / instance-logs
因为这台机器没有 Node Runtime 与 Job 记录（Docker daemon 未运行）而被**跳过并打印 skipped**，
不是「测过且通过」。这一条限制在评审时需要知道。

### 9.3 新反事实：注入过小高度 → 控件真的被盖住 → 撤销 → 恢复

旧的两条「重放 height:80px 复现旧缺陷」的断言已按裁决删除，换成一条**测量驱动**的反事实，
跑在 **studio 编辑器**（header 里 9 个控件的那一页，也正是 .studio-toolbar 当初存在的理由）。选择这一页是实测的：
在 /app/incidents 上同样的注入**不再复现**（该页只有 1 个控件，且它下面的 section.panel 起始位置在逃逸行之下，
探针实测 0/1 被盖住），在那里断言只会空洞通过。

注入值不从常数来：contentNeed = 最低控件 bottom − header top（本次 152），注入 height: 48px（其一半）。
实测（/tmp/g12e/run8.log、artifacts/g11-d3/header-counterfactual.json）：

```
counterfactual: injected height 48px of 152px of content
counterfactual message: counterfactual: a control is covered - elementFromPoint at its centre resolves to
  [{"label":"Undo","reached":false,"reachedBy":"react-flow__pane draggable"}, ...
   {"label":"Preview","coveredBy":"H2"}, {"Detail","coveredBy":"H2"}, {"Create draft","coveredBy":"H2"}]
```

即 9/9 控件全部不可达：前 6 个被画布（react-flow__pane）盖住，后 3 个被下方面板的标题（H2）盖住。
撤销后 headerH 回到 152，9/9 恢复可点。断言链：
headerH === 注入值、controlsInsideHeader === false、allReached === false、
逃逸控件 >1、被盖控件 >1、捕获到的失败文本必须包含 a control is covered（保证这条不变量不是装饰）。

### 9.4 check-ui-metrics 的处置（PR 描述原文，请照抄）

> **本轮 check-ui-metrics 未重跑，该 PASS 不覆盖本轮改动。**
> artifacts/ui/visual-v3/audit/_metrics_*.json 是上一轮审计的产物；重跑需要 b5-visual-matrix harness
> 与一套本机不存在的演示数据（Docker daemon 未运行 → 没有 Node Runtime / Plugin / Job，registry 也不可达）。
> 本轮的几何验证来自 tests/ui/g11-page-header-growth.spec.ts（三条不变量 + 两类互比 + 反事实），
> 它跑在自建的 scratch 实例上：127.0.0.1:18199、独立库 opsweave_g12e、OPSWEAVE_DATA_DIR=/tmp/g12e/data，
> 页面数据由 tests/ui/g12d-seed.mjs 通过公开 API 播种（pipeline orders-ingest 因
> CATALOG_UNAVAILABLE: no compatible READY provider 无法经 API 创建，改为**直接写 scratch 库的两行 fixture**；
> 这是数据缺口，不是产品路径）。跑完已销毁 scratch 实例。

### 9.5 Studio 页复核（删掉 .studio-toolbar 之后）

用例 the studio workspace is usable at 1440 / 1024 / 390 after .studio-toolbar was removed，三个宽度都打印：

```
studio  width  headerH  headerBottom  controls  railWrapped  shellTop  shellHeight  canvasHeight  shape
         1440      152           224         9        false       236          640           640  eyebrow/title1/desc2/meta2/rail1inline
         1024      122           190         9        false       202          679           540  eyebrow/title1/desc1/meta2/rail1inline
          390      293           357         9        false       369          579           440  eyebrow/title1/desc2/meta2/rail3inline
```

断言：9 个控件**全部在 header 盒内**且**全部可点**（elementFromPoint）、
.studio-shell 的 top >= header 的 bottom、shell 高 > 300、.studio-canvas 存在且高 > 100
（1440 = 640 / 1024 = 540 / 390 = 440）、.studio-toolbar 数量为 **0**、无横向溢出。
1024 时 header = 122 而不是 80：copy 70 + 12 行间距 + 控件行 40 —— 控件行换到 header 自己的第二行，
这是「header 拥有这个排列」的实测证据，也正是删除 toolbar 的前提。

### 9.6 自评：新的不变量里，哪一条仍然只是代理指标

**类别互比里的「形状键」仍然只是代理指标。** 它量的是「header 承载了几行」（标题行数、描述行数、chip 行数、控件行数、
控件行是否独占一行），而断言说的是「形状相同 ⇒ 高度相同」，这一步隐含了「每行的高度对所有页面都一样」的假设。
这个假设今天成立（chip 行 24、文本行 21、h1 在该宽度下 26 或 31），但它是可被打破的：
某天给 chip 换一个更大的 font-size，两个形状键相同的页面就会**合法地**不同高，而门禁会报红——
那时报红的是「每行高度不再统一」，不是「header 的高度失控了」。另外 rows() 用「子元素最多的那一层容器」来判定行数，
这本身也是启发式（多层 flex 嵌套时会挑错层）。三条不变量里没有这个问题：它们量的是命中、裁切、重叠本身。

反事实也有一个残余代理性：它是**注入**出来的过小高度，不是历史提交的复现；它能证明「这条不变量是承重的」，
不能证明「当年的缺陷正是由 height:80px 引起的」——后半句只能由 git 历史与当时的 Playwright 报错文本作证。