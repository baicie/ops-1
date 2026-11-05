# OpsWeave DS-V1-2 — 两大核心业务工作台视觉重构

- 日期：2026-11-05
- 状态：**实现完成，独立审查与最新 CI 见 §6 / §7**
- 基线：`design/opsweave-visual-system-v1@e8d1cbf`（PR #34）。本会话开始时 GitHub 网络不可达；网络恢复后确认 **PR #34 仍是 OPEN、未合并**，因此按任务允许的路径创建 **Stacked Draft PR #35**（base `design/opsweave-visual-system-v1`），未合并 #34。
- 分支：`design/opsweave-ds-v1-2`；Draft PR [#35](https://github.com/baicie/ops-1/pull/35)
- 决策：[ADR-017](../../adr/ADR-017-visual-system-v1.md)（视觉系统权威）、`page-template.md`、`token-table.md`

## 1. 目标与边界

把“组件体系已统一”推进到两个真实业务页面好用：

1. `/app/observability` 与 `/app/observability/nodes/:id`
2. `/app/incidents/:id`

不重做后端；不改 Evidence Trust、Incident Lifecycle、AI Investigator 契约；不改 Kernel、Gateway、数据库、权限或公共 API。所有缺失值仍以 NO_DATA / UNKNOWN 表达，DEGRADED 仍是独立健康状态。

**IncidentView v1 不携带 workspace 字段。** 页面因此显示 owner / severity / lifecycle / source / related entity，不伪造“Workspace”。要做到逐事故 workspace，需要先改契约与 ADR，另起任务。

## 2. Observability：值班工程师的五个问题

| 问题 | 页面回答 |
|---|---|
| 哪些资源有故障？ | 第一张 KPI **Needs attention**：degraded / stale / unreachable / unknown / revoked / no sample 的实时分解；点击即筛选 |
| 哪些监控数据可靠、哪些过期？ | **Stale rows** KPI（最旧过期采样时间）与表格每行的 `sample is stale` / `no sample` 标记；全局 source/freshness 行给出最新观测与轮询周期 |
| 故障从什么时候开始？ | 每行 identity 的观测年龄；节点页的 collection 行给出窗口、采样数、断点数与最新采样时间 |
| 影响范围多大？ | **Not observable** 与 **Reporting** 计数；实例 `ready/total` 只在节点可上报时渲染 |
| 下一步点哪里？ | 四张 KPI 都是筛选链接；行与行菜单进入节点；节点页的实例链接进入日志 |

改动：

- KPI 从 `Reporting / Not observable / Peak CPU / Peak memory` 改为 `Needs attention / Reporting / Stale rows / Not observable`。峰值并入 Reporting 的详情，不再占两张卡。
- `FleetSummary` 增加 attention、degraded、staleStates、staleReadySamples、unreachable、revoked、unknown、oldestReportingSampleAt；Attention 的详情只列非零桶，和数字对得上。
- `EntityFilter` 增加 `stale`；KPI 与筛选共用同一个谓词。
- KPI 下新增 source/freshness 行：`Source: Kernel node samples · newest observation … · polled every 5s`。没有观测时明确说没有，不显示“0 秒前”。
- 表格状态列在 Ready 但无样本时显示 `no sample`；stale 仍显示 `sample is stale`。
- 节点页新增 collection 行：窗口、采样数、断点数、最新采样时间；历史窗口从 Radix Tabs 改为 `aria-pressed` 按钮组（原 Tabs 没有 TabsContent，`aria-controls` 指向不存在的节点，axe 判为 critical）。
- 节点状态条允许换行，390 不再让 UUID 与“Newest observation”叠字；窗口按钮在手机上占满一行，`24h` 不再溢出 40px。

## 3. IncidentDetail：调查路径

目标路径：**认识事故 → 浏览时间线 → 检验证据 → AI 辅助分析 → 人工裁定**。

- **Header**：标题下是 `Started … · updated …`；meta 行为 lifecycle、severity、owner（可解析的名称，`incident-header-owner`），≥1101px 再显示 source/related。header 在 1024 仍保持 80px 下限（次要 chip 在该宽度隐藏，Record 面板仍保留完整值）。
- **KPI**：Evidence / Kernel verified / Timeline entries / Audit entries。去掉与 header 重复的 status/severity 和时间；verified 只数 kernel 建立的 provenance，分母是当前 evidence 行数，0 行时为 NO_DATA。
- **Analysis pane**：KPI → Timeline → Evidence → AI Investigation。证据从原来的 AI/audit 之后前移；长证据表仍在 pane 内滚动，但证据标题与 trust 摘要先于 AI。
- **Detail pane**：Evidence viewer → Human verdict → Lifecycle (close/transfer) → Audit trail → Record。Audit 从 analysis 移到 decision pane，支撑裁定而不是打断调查。
- **AI / Verdict 分离**：AI 面板与 Human verdict 面板分别加 `ow-ai-panel`（info 内阴影）与 `ow-verdict-panel`（accent 内阴影）；文案、区域和移动端 tab 也分开。AI 仍明确声明它不是 verdict、不能改 verdict。
- **Mobile**：<1024 仍是三个真实 tab（事件/调查/裁定），不是隐藏两栏；analysis 不再挂证据计数；KPI 2×2；证据阅读、AI、verdict 都可达。

## 4. 统一交互与可访问性

复用 PageHeader、MetricCard、AsyncBoundary、StatusIndicator、Table/Card responsive pattern、DialogFrame；没有第二套组件。

真实修复：

- 亮色 warning 文本 `#a86400` on `#fff4df` = 4.29:1 → 新增 `--ow-warning-ink: #8a5200`（5.86:1），只用于 status chip 的 ink；边界色不变。
- Badge 的 success/warning 文本改读 `--ow-ok-ink` / `--ow-warning-ink`（success 原为 3.9:1）。
- 选中 rail 行的 muted facts 4.47:1 → secondary（7:1+）。
- account 按钮在手机隐藏姓名后没有 accessible name → 增加 `sr-only` 账号菜单标签，同时不触发 label-content-name-mismatch。
- 历史窗口不再用没有 TabsContent 的 Tabs；`aria-controls` 不再悬空。
- 证据 trust chip 的 `ok`/`warn` 文本从 `--ow-ok`/`--ow-warn` 改为 `--ow-ok-ink`/`--ow-warning-ink`（CI 在 768 抓到 3.89/4.29；本地 3/3 复测通过）。
- 键盘焦点环、24px 最小目标、axe WCAG 2.0/2.1/2.2 A+AA 在 1440/1024/768/390 扫描，见 §5。

## 5. 门禁与证据

| 检查 | 命令 | 结果 |
|---|---|---|
| Workbench matrix | `WORKBENCH_MODE=after playwright test workbench-matrix.spec.ts` | 4 视口 × 2 主题 × 2 语言 × 3 页面，1.2 min |
| Workbench a11y | `playwright test workbench-a11y.spec.ts` | 1440 light en、390 dark zh-CN、1024/768 light en；axe + 焦点环 + 24px 目标 |
| Workbench regression | `node scripts/check-workbench-metrics.mjs artifacts/ui/visual-v2/after docs/design/opsweave-visual-system-v2/workbench-baseline.json` | 4 curated labels × 4 pages：region order、KPI identity/columns、tab model、overflow |
| Observability surface | `OBS_DATA=fixtures playwright test observability-surface.spec.ts` | 11/11；metrics 24 measurements，390 overflow -15 |
| Incident regressions | `playwright test g11-incident-state-gaps.spec.ts g12-lifecycle.spec.ts` | 13/13 |
| TypeScript / Vitest / Build | pnpm filters | 见 evidence index |
| G12 harness | `bash tests/ci/g12_acceptance_ci.sh` | **PASS** — 102 tests（100 passed / 2 skipped），11.2 min；acceptance 195/0；workbench gate PASS；exit 0 |

截图（未跟踪，`artifacts/ui/visual-v2/`）：

- `before/` 与 `after/` 各 16 组合 × 3 页面（+ compact detail tab）——真实 Chromium、同一 fixtures/seed。
- CI 中 `artifacts/ui/visual-v2/**` 作为 artifact 上传；PNG 预算不变（只新增 `/tmp` 级未跟踪证据）。

**视觉回归基线是 JSON，不是像素。** 仓库 PNG 预算满额，且像素 diff 需要固定字体/渲染器；`workbench-baseline.json` 只记录能代表重排回归的事实：区域顺序、KPI 身份与列数、tab 模型、overflow。时间/文案/标题长度不入基线，避免 seed/本地化噪声。故障注入：反转 incident 区域顺序后 gate 必须 FAIL（已验证）。

## 6. 独立审查

- 代码审查：见 §6.1。
- 视觉审查：见 §6.2。

### 6.1 代码审查

**P0**：无。

**P1（已修复）**
1. **Stale KPI 与 `?state=stale` 不是同一集合**：KPI 用 `sampleIsStale`（120s），筛选用 kernel `stale`；Kernel 心跳阈值 25s，一个 30s 未心跳的 DEGRADED 节点在 KPI 为 0、筛选却列出。现在 `FleetSummary.staleRows` 与 `filterRows('stale')` 共用 `node.stale || state==='stale' || sampleIsStale`；card 值、最旧采样时间、筛选三者同源。新增测试覆盖 kernel-stale + fresh sample 与 READY + old sample。
2. **失败的 history 渲染成 0 samples / newest never**：`collection` 只看 `history`/`series`，`history.failed` 时仍输出。现在 `history.failed` 直接返回 null，只有 panel 的失败提示。

**P2（已处理；其中一项的“已修复”声明在 DS-V1-2.1 复核中被证明不准确，见下）**
- **attention 桶与数字不闭合**：改为每行只落一个 reason 桶（unreachable/revoked/unknown 优先；noSample 次之；reporting 的 degraded/stale-state/stale-sample 三选一）；桶之和 = attention。新增断言；DEGRADED+无采样的行只计 noSample。
- **“stale”两种定义混用**：attention 里写 “stale state”，独立卡片写 “Stale rows”（kernel stale / state stale / old sample），不再用同一个词表示两个集合。
- **Stale 卡在空舰队用 NO_DATA**：空舰队统一 UNKNOWN；有行但都没有样本时才 NO_DATA。
- **Reporting 卡在 CPU 不可读时丢掉 memory peak**：新增 memory-only 分支，峰值不再从页面消失。
- **Incident verified KPI 把 403/失败读成 NO_DATA**：本批最初只把 `evidenceKpiState` 用在 Evidence 卡；Verified 卡仍写着 `evidence.length === 0 ? 'noData' : ...`，因此 403/503 且零行时仍显示 NO_DATA。DS-V1-2.1 已在真实浏览器复现（`tests/ui/incident-evidence-kpi.spec.ts` 在旧代码上失败），并让两张卡共用 `incidentEvidenceKpiStates(evidenceState, rows)`；成功零行仍是 Evidence 0 + Verified NO_DATA。详见 [ds-v1-2-1-review.md](ds-v1-2-1-review.md)。
- **KPI 与 header 重复 Started/Updated**：KPI 改为 Evidence / Kernel verified / Timeline entries / Audit entries；时间只在 header，调查计数进入 KPI。
- **1440 内部滚动无 affordance**：桌面 pane 强制细滚动条（`scrollbar-width` + `::-webkit-scrollbar`），证据/AI 在 fold 下可见可发现。
- **移动端 tab 语义**：analysis 不再挂 evidence 计数；detail tab 从 “Evidence” 改为 “Decision/裁定”；idle 文案指向 Investigation tab。
- **workbench gate 可被收窄 / 隐藏 grid 的列数**：`--update` 拒绝缺 required page；baseline 必须含 3 个必有页面；KPI 列数只测可见 grid（隐藏 pane 记 null）。
- **a11y 门禁空转**：Tab 越过 skip link；目标清单加 history 按钮；incident axe 等 evidence/AI 非 loading；window buttons 数量断言。
- **badge/warning/success/rail 对比度**与 **account 按钮名**见 §4。

### 6.2 视觉审查

**P0（证据包，不是产品缺陷）**：首轮审查后发现 `before/` 被一次漏写 `WORKBENCH_MODE` 的捕获覆盖成 after 设计，16 对截图逐字节相同，且 before/after 不是同一个 incident。已修复：

- 从 `e8d1cbf` 用 `git archive` 导出旧 `apps/platform-web`，在当前 node_modules 下构建旧 dist，临时替换后捕获真正的 before，再恢复当前 dist。
- 固定同一个 seed incident `192cd642-ca6e-4b39-9ccc-2ca987c8f807`（INVESTIGATING，5 条证据）同时捕获 before/after；证据行、trust chips、timeline 均出现。
- 以 KPI identity（`obs-peak-cpu` vs `obs-attention`）和 metrics `mode` 双重确认 before 不是 after。

**P1（已修复，复审确认 FIXED）**：attention 明细 9 vs headline 8（unknown-01 同时 stale/no sample）→ 单桶分区后 8；并区分 “stale state” 与 “Stale rows”。复审还确认 KPI = Evidence 5 / Kernel verified 0/5 / Timeline 6 / Audit 6，证据在 AI 前，detail tab 已改名 Decision。

**P2（保留/已处理）**：
- 已处理：Kernel verified 0/0 → NO_DATA；Started/Updated 重复 → Timeline/Audit KPI；桌面 pane 滚动条；tab 标签。
- 保留：Node 页 “Instances 3/3” 与实例表两行 In progress 的既有数据口径差异（不是本批引入）；Observability Load 列仍由 `CPU · memory` 两个无子标题百分比组成（列名补了 “Load · CPU / memory”）；“Not observable” 同时包含 unreachable 与 no-sample，note 分开陈述；zh 的 “交接 Incident” 与 “operator” 是既有 catalog 文案；AI 与 verdict 的颜色对比已改为 AI 中性边、verdict accent，但本轮 seed 没有 AI hypothesis，内容级分离仍以 `g12` 的 investigation 测试覆盖。
- 未覆盖：before/after 的 390 dark/zh incident 对在证据修复前被覆盖；修复后全矩阵重新生成，已包含这些组合，但审查文本仍标注首轮未读到。

## 7. CI

- 本地确定性 harness：**PASS**，102 tests（100 passed / 2 skipped），11.2 min；acceptance **195/0**；`workbench regression gate -> PASS`；exit 0。两条 skip 是 Docker/Studio 依赖。
- 第一次 GitHub Actions acceptance（run 41972550193）：browser suite **99 passed / 1 failed / 2 skipped**。唯一失败是 `workbench-a11y` 在 768 的 trust chip：`SOURCE_ATTESTED` #0f8a5f on #e6f6ef = 3.89:1，`UNVERIFIED` #a86400 on #fff4df = 4.29:1。修复为 `.ow-trust[data-trust-tone=ok|warn]` 使用 `--ow-ok-ink` / `--ow-warning-ink`；本地 a11y 3/3（含 5 条 evidence 的固定 incident）通过。
- **重跑（代码 HEAD `0a6430a`）：11/11 checks PASS** —— acceptance 10m45s（browser 100 passed / 2 skipped，8.8m；`workbench regression gate -> PASS`）、golden-path 17m25s、runtime-golden-path 17m28s、rust、web、web-unit、quality-faults、legacy-regression、contracts、artifact-budget、spec-coverage。
- **文档 HEAD `c04bc50`：11/11 checks PASS** —— acceptance 13m39s、golden-path 17m9s、runtime-golden-path 17m29s、legacy-regression 6m26s、rust 2m51s，其余 6 项通过。DS-V1-2.1 的复核、反事实与最新 CI 见 [ds-v1-2-1-review.md](ds-v1-2-1-review.md)。

## 8. 剩余项

- **P0**：见审查回填。
- **P1**：见审查回填。
- **P2**：详情页 per-metric 观测时间仍只在 hover/卡片；事件表在 390 仍是三列卡片；api 没有 incident workspace 字段；virtual keyboard 未模拟；CSS 继续模块化。
- 下一批建议：Observability 的 per-entity 告警阈值/时间对齐、Incident 的 audit 折叠与 evidence 全文搜索、把 workbench JSON 基线扩到 Sources/Jobs/Pipelines。

## 9. 回滚

纯展示层：回滚 `Observability.tsx`、`ObservabilityEntity.tsx`、`observability-model.ts`、`IncidentDetail.tsx`、`investigation-panel.tsx`、`styles.css`、Tailwind 的 ink 映射、i18n 新键；测试与基线同 PR 回滚。无 API/DB/权限/证据语义变更。
