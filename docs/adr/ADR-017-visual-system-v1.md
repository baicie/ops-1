# ADR-017：Visual System V1 的页面模式、Token 权威与证据协议

- 状态：Accepted（Phase 0 决策；实现按 DS-V1-1..3 分批）
- 日期：2026-11-04
- 版本状态：本 ADR **不**改变 `0.0.5_PARTIAL`；不构成发布授权
- 前置：`AGENTS.md`、`rules/06-ui-ux.md`、`docs/design/ui-visual-v3/spec/{README,page-template,token-table,table-spec,machine-language-rules}.md`、`docs/adr/ADR-016-acceptance-layers-and-code-acceptance-ownership.md`
- 设计输入：`opsweave-visual-system-v1` 设计包（PROPOSED / NOT IMPLEMENTED；基线 `main@b9a01db`）
- 复核基线：`origin/main@775a1e2`（2026-11-04）。设计包基线之后只有 PR #32（`auth.tsx` 登录单次往返）与 PR #33（ADR-016 文档）合入；`apps/platform-web` 的视觉层没有其他漂移。

## 1. 背景与权威顺序

V1 的目标不是换 UI 库，也不是重写界面，而是让仓库已有的 `--ow-*` Token、shadcn/Radix 原语、双 Shell、状态词表和浏览器证据成为**一套可检查的产品视觉系统**。

权威顺序（冲突时从高到低）：

1. `AGENTS.md`（MUST / MUST NOT）；
2. `rules/06-ui-ux.md`（UI MUST / Gate）；
3. `docs/design/ui-visual-v3/spec/*`（当前 normative UI spec）；
4. 本 ADR（对上述 spec 的显式增补/例外）；
5. 设计包与历史验收记录（证据与提案，不是规范）。

设计包 02 §3 自己写明：旧 `page-template.md` 在 ADR 与 Gate 迁移完成前仍是权威。因此本 ADR 不创建第二套模板权威；它只做两件事：把四类页面模式写进 `page-template.md` 的既有例外机制，并把 V1 的其余决策固化。

## 2. 决定

### D1 — 保留 UI 底座

继续使用 React + Vite + TypeScript + Tailwind CSS + Radix + copy-in shadcn 原语。禁止引入 AntD / MUI / Chakra / 第二套 CSS-in-JS。任何整库迁移必须先给出量化缺口（迁移预算、维护成本、可卸载性），另立 ADR；V1 不做。

### D2 — 一套 Token 权威

运行时唯一视觉 Token 仍是 `--ow-*`（`apps/platform-web/src/styles.css`）。Tailwind 只做映射（`tailwind.config.cjs`），不得新增第二套色彩/间距/字号来源；插件从宿主 Token 消费，不修改全局。

设计包 01 §2 的 light/dark 十六进制表是**基线描述**，不是规范调色板。调色板与对比度的规范仍以 `token-table.md` 为准；若要把 WCAG AA 变成强制项，另立 ADR 并增加颜色/对比度 Gate，不能只改文档。

### D3 — 四类页面模式进入 `page-template.md`

在 `page-template.md` 中增加 Pattern A/B/C/D 与 route→pattern registry：

- **B Resource Explorer** 是默认模板；未声明的 route 解析为 B。
- **A Platform Overview**、**C Investigation Workspace**、**D Technical Studio** 是显式模板例外，只能改变该 Pattern 允许的区域与顺序。
- Pattern D 与 `page-template.md:155` P3（删除 `.studio-page .page-header`）的冲突由本 ADR 决定：**V1 保留 Studio 现有 header 作为 Pattern D 的声明例外，不删除、不重构**；P3 的删除动作从 V1 移出，留给 Studio 专项。`--template` Gate 必须能按 Pattern 断言 header，而不是靠 CSS 覆盖。
- Pattern C 必须声明 pane 顺序、焦点顺序、深链与滚动恢复；390px 用 tab/stack 保证全部内容可达。
- 模板迁移步骤：先改 `page-template.md` 与 `check-ui-metrics.mjs --template`，再改页面；任何 route 在 registry 中必须恰好命中一个 Pattern。没有 Gate 之前不得先改页面。

### D4 — Health / Freshness / Trust 是三轴

三轴是既有权威之上的**表现层组合**，不是新状态机：

- Health 消费 `status-tone.ts` 的 wire code → state 映射；
- Freshness 消费 `observability-model.ts` 的 `Reading` 联合与时间戳；
- Trust 消费 `incidents.ts` 的 `EVIDENCE_TRUST_CODES` 与 `claimedTrust/verifiedTrust`。

禁止新增 wire code、禁止在 `STATUS_MAP` 增加 `LIVE` 行、禁止用一个综合绿色 Badge 覆盖三轴；`NO_DATA / UNKNOWN / STALE` 继续是协议词汇，不得折叠为 0、绿色或空白。`machine-language-rules` M1 的"每区域一个虚线 Token"预算与 C5 继续有效。后端证据校验、readback 与权限语义不变。

### D5 — 字体阶梯：11/13/15/26，标题为有下限的显示档

当前实现（`styles.css:101-111`）：label 11 / meta 13 / sm 12 / base 14 / lg 16 / xl `clamp(20px,2.1vw,26px)` / metric 21 / hero `clamp(30px,4vw,44px)`。gate 的实际状态是 `type-tier 6 budget 6`，这 6 个预算正是这 6 个非 11/13/15/26 的声明，不是"允许 6 处违规"。

决定：

1. **正文/次要/标签**收敛到 15 / 13 / 11。`--ow-type-sm` 的 12px 被删除，其 122 处调用在 DS-V1-1 中随 token 值变为 13px；`--ow-type-base` 变为 15px；`--ow-type-lg` 的 16px 并入 15px。
2. **标题**使用 `--ow-type-xl: clamp(20px, 2.1vw, 26px)`（目标名 `--ow-type-title`，DS-V1-1b 改名）：1440 的实测是 26px，390 的实测是 20px。26 是**上限**，不是所有宽度都平铺 26px——390 上的长事件标题平铺 26px 会挤占阅读区，实测 20px 更稳。这是**显式显示例外**，必须同时写进 `token-table.md` 与 `scripts/check-ui-tokens.mjs` 的命名例外表；不得只改文档而让检查器继续把 clamp 当违规。
3. **metric** 保持 21px，作为第二个命名的显示例外。实测把 `--ow-type-metric` 设成 26px 后，Overview 的 KPI `0` 比健康判决更抢眼，且首屏下移 33px；21px 让 title 26 > KPI 21 > body 15 的层级成立。
4. **hero** 只保留在 `/login`；`InstallWizard` 的 `.readiness-number` 改用 title clamp。例外必须有命名清单，不再用"预算里还有 6"冒充豁免。
5. **先改值，后改名**。删除/重命名 token 会触碰 307 处 `font-size` 声明；DS-V1-1 先用最小 token-block 改动把值收敛，并同步修改 `styles.token-contract.test.ts`（它当前断言 base 14 / sm 12，是迁移的硬阻塞），再决定是否改成 job-name（label/meta/body/title）。Tailwind 的 `text-sm/base/lg/xl` 必须映射到同一组值；`text-xs` 当前指向未声明的 `--ow-type-xs`，必须删除或补声明。
6. `ui-debt.json` 的 `type-tier` 只能随树下降，不能为了绿而提高；`one-header` 从 3 降到 0 需要先迁移双 `PageHeader`。

DS-V1-1 执行值迁移（token 块、Tailwind 映射、契约测试、checker 命名例外）；DS-V1-1b 完成改名：`--ow-type-sm` 并入 `meta`、`base`/`lg` 并入 `body`、`xl` 改名为 `title`，四个 job 名成为唯一词汇。改名是零像素变化（值未动），36 张矩阵的 header/h1/h2/metric/overflow 与 DS-V1-1 基线一致。

### D6 — 证据协议：PASS / FAIL / NOT_RUN，fixture/live 必须可机读

每个检查只允许三种结论：`PASS`（有真实执行证据）、`FAIL`（执行且失败）、`NOT_RUN`（未执行，写明原因）。截图只证明渲染，不证明交互断言。

- 产物必须携带：commit SHA、capturedAt、route、viewport、theme、locale、fixture/live、数据状态；缺失字段 fail closed。
- 路由覆盖必须可检查：某个 route 从矩阵中消失不能被当作通过；`check-ui-metrics` 现在只在输入展开为 0 个文件时 fail closed，`{"pages":{}}` 会打印 PASS——这是已知漏洞，V1 的 Gate 迁移必须补 route coverage。
- 完整矩阵只进 CI artifact 或未跟踪目录；Git 只保留 `tests/ci/tracked-png-budget.json` 预算内的精选基线。当前 25 个 bucket 全部零余量（408/408 文件，65.97/68.24 MiB），**V1 不得提高预算**；新增基线必须显式调整 manifest 并在同一 review 中说明。
- 测试 Fixture 必须标注为 fixture，不得当作生产读数。

### D7 — 组件所有权

唯一权威：

| 组件 | 权威 | 迁移/例外 |
|---|---|---|
| PageHeader | `components/app/page-header.tsx` | `components/Ui.tsx:11` 是旧实现，3 个调用点；DS-V1-1 迁移后删除，保留 `data-testid="page-header"` 与 80px 下限 |
| Button | `components/ui/button.tsx` + `buttonVariants` | `.btn` 只剩 `studio/PipelineEditor.tsx` 16 处；Pattern D 兼容期保留，V1 不迁移 |
| Table | `components/ui/table.tsx` | `pages/table-kit.tsx` 是组合层不是第二原语；`plugins-table/nodes-table` CSS 在 390/768 重测前不得删除 |
| Status | `status-tone.ts` + `app/status.tsx` + `app/status-indicator.tsx` | `Ui.StatusBadge` 零调用，删除；`installation-state.ts` 与 `investigations.ts` 的私有 tone 表是域扩展，必须收敛到同一词汇或记录例外 |
| AsyncBoundary | `components/app/async-boundary.tsx` | DS-V1-1b 完成：10 处 `Ui.ErrorState` 已删除，页面/页内/section 三种用法由 `report` 与 `source` 区分；原始句子经 `AsyncErrorMessage` 标注来源，不再直接当正文 |
| Dialog/Sheet | `components/app/dialog-frame.tsx` | DS-V1-1b 完成：`Ui.Modal`、`SheetContent`、`ConfirmAction` 共用 `DialogFrame`（一个 head/body/foot，三种几何）；`.modal*` 已删除，Radix 仍是底座 |
| MetricCard | `components/app/metric-card.tsx` | DS-V1-1b 完成：15 处手写 `.panel.metric-card` 已迁移；`.metric-*` CSS 删除；`size="small"` 取代 `.metric-value.small`；未加载的计数是 NO_DATA/UNKNOWN，不是 0 或 em dash |

不得新建 `components/domain/`，直到本 ADR 的 ownership map 被实现并证明至少两处复用；域组件可以消费状态权威，不得重新推导。

### D8 — 本轮交付范围

本轮（Draft PR #34）交付：

1. Phase 0：基线、组件所有权、Token/文档冲突、证据索引；
2. 第一标杆 `/admin/overview`：健康判决与计数对账、来源/观测时间行、事件词表本地化、INFO 严重度图形、测试修正；
3. DS-V1-1：类型值 11/13/15/26、双 PageHeader 删除、死 `StatusBadge` 清理；
4. DS-V1-1b：token 改名为 label/meta/body/title、`ErrorState`→`AsyncBoundary`、15 处 `MetricCard`、`DialogFrame`、`check-ui-metrics` 空页/route manifest；
5. DS-V1-1c：Dialog ARIA 与 busy 关闭策略、Boundary 状态所有权、Sources 12 组合与 sheet 契约、MetricCard 响应式矩阵、matrix manifest 与故障注入；
6. 不交付：三个标杆的完整视觉重排、Studio 重构、CSS 模块化拆分、后端/API/DB/权限变更。

### D9 — 产品词汇：AVAILABLE 与 CANCELLED

本轮只记录词汇决定与影响面，不在本 PR 改全局状态表（另起小 PR）。

**AVAILABLE** 是"该插件包可供安装"，不是安装状态。`lib/installation-state.ts` 把 `AVAILABLE` 映射为 `notInstalled`，所以安装状态上下文里显示 "Uninstalled / 未安装" 是正确的；`status-tone.ts` 的 `AVAILABLE → "Available"` 描述的是包状态，不得拿来渲染安装状态。前端两个上下文必须各自命名轴：包可用性用 Available，安装状态用 Not installed；同一屏出现两者时必须带轴标签（如 "Package: Available · Installation: Not installed"），不能只留一个裸词。影响面：`pages/Plugins.tsx` 的 `AVAILABLE` 过滤值、`installation-state.ts`、`status-tone.ts`；本轮不改。

**CANCELLED** 是主动取消，`neutral / stopped`，不是失败。取消必须有操作者与时间；异常中断（崩溃、租约丢失、超时）必须使用独立原因码并在界面说明，不得复用 `CANCELLED` 伪装成"用户取消"。影响面：`STATUS_MAP.CANCELLED`、`Jobs.tsx` 的取消确认与 readback、`verified-writes.ts`；本轮不改，只确认现有映射符合该定义。

## 3. 被否决的方案

- **整库迁移到 AntD/MUI**：违反 `AGENTS.md`，且没有量化缺口；否决。
- **第二套 Token / 第二套调色板**：设计包的十六进制表只是基线描述；否决。
- **用 `!important` 或 magic number 让页面"看起来对"**：`page-template` 与 `ui-debt` 已有例外机制；否决。
- **一次性拆完 3,650 行 CSS**：无法归因回归；按 DS-V1-1 分批，每批截图对比。
- **把 Studio 拉进通用模板**：Pattern D 需要画布/工具/属性面板；本轮只做兼容 smoke，不重构。
- **先改页面再补 Gate**：route→pattern registry 与 `--template` 断言先行；否决。

## 4. 兼容 / 迁移 / 回滚

- 无 API、DB、权限、证据语义变更；`auth.tsx` 的登录行为不在本 ADR 范围。
- `page-template.md` 的迁移是"先加 Pattern 与 registry，再改页面"；旧 route 未声明时仍解析为 B，回滚只需移除 Pattern 条目并恢复默认 ruler。
- 字体迁移分两步（值、名字），每步独立可回滚；`styles.token-contract.test.ts` 与 Tailwind 映射必须同 PR。
- 第一标杆的改动是纯展示层；回滚 `Overview.tsx` / `overview-events.ts` / 两个 catalog / `styles.css` 的对应块即可，不涉及数据。
- 不改变 `0.0.5_PARTIAL`，不宣称生产就绪。

## 5. 验收

Phase 0 已执行的证据见 `docs/design/opsweave-visual-system-v1/evidence-index.md`。最低要求：

- `pnpm --filter @opsweave/platform-web typecheck`、`test`、`build`：PASS；
- `node scripts/check-i18n.mjs`、`check-status-vocabulary.mjs`、`check-ui-tokens.mjs --ratchet ...`：PASS；
- `node tests/ci/check-tracked-png-budget.mjs`：PASS，预算不提高；
- `/admin/overview` 的 1440/1024/390 × light/dark × en/zh-CN：真实 Chromium，36 张 before/after，overflow 全为 0（或负值），header 80px 不变；
- 负例：PARTIAL（source 503/空 body/ pending）、DEGRADED、ATTENTION、READY+非就绪计数、INFO、未知 health code；
- `overview-partial.spec.ts` 全绿；`visual.spec.ts -g "responsive overview matrix"` 全绿；
- `observability-surface.spec.ts` 的 fixture 矩阵全绿（fixture 明确标注）；
- 全量 staging、Docker 依赖的 admin-shell/plugin 套件、Observability/Incident 重做、字体迁移：`NOT_RUN`，在报告与证据索引中列明。

## 6. 未决 / 后续

- Overview 的 STALE 策略：失败刷新现在会替换整页（`AsyncBoundary` 收到无条件 error），保留旧读数并标 STALE 需要产品/异步行为决策；本轮不改。
- Overview 的 shell 15s 轮询与页面 10s 轮询可能短暂不一致；共享快照是客户端数据流工作，另立变更。
- KPI 每卡观测时间：当前由来源行覆盖；若产品要求逐卡时间，再评估。
- 12px 表格卡片的几何重算（`table-spec` §2.5 的 70.8px 推导）随 DS-V1-1 的字体迁移一起做。
- Observability 的 0/0、DEGRADED→unknown、hover-only observed time、entity 0/0、被吞掉的 403；Incident 的 forbidden 死代码、0/0 provenance、trust 汇总范围、header owner/scope、可折叠审计、verifiedAt 缺失——记录为下一阶段 P0/P1，不在本轮修。
- Gate 漏洞（GAP-01..GAP-22，见基线报告）：Observability/Overview/Incident 矩阵未进门禁、`check-ui-metrics` 空页 fail-open、PNG 预算零余量、无视觉 diff、无对比度/触摸目标 Gate、`tests/ui` 不被 typecheck——需要独立 PR。
- 0.1.0 与生产门槛不在本 ADR 范围；`0.0.5_PARTIAL` 不变。
