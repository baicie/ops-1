# OpsWeave Visual System V1 交付报告（Phase 0 + first flagship）

- 日期：2026-11-04
- 执行环境：macOS 15.7.7 / Apple M1；Node 22.12.0；pnpm 10.34.3；Playwright 1.64.1（Chromium）；PostgreSQL 17（本机）；Docker 不可用
- 原始基线 `origin/main` SHA：`775a1e2`
- 实际开发分支 / HEAD：`design/opsweave-visual-system-v1` / `25a784c`（Overview）+ `d47fbfd`（Incident 语义）+ `ef30d48`（Observability 语义）+ `c90c8f6`（Gate wiring）+ `31d0d88`（DS-V1-1）+ `16ede58`/`d3d5955`（DS-V1-1b）+ DS-V1-1c（本批）
- Draft PR / base / mergeability：[#34](https://github.com/baicie/ops-1/pull/34) / `main` / Draft
- 工作树状态：实现与文档已提交；`artifacts/ui/visual-v1/` 为未跟踪的本地证据

## 1. 本轮范围

**实际改动**

- `apps/platform-web/src/pages/Overview.tsx`：健康判决与计数对账；来源/观测时间行；事件词表本地化；Kernel 文案来源标签；DEGRADED 零 critical 的 guard。
- `apps/platform-web/src/pages/overview-events.ts`：事件码 → catalog key 的单一映射（新增 incident 生命周期事件）。
- `apps/platform-web/src/pages/overview-events.test.ts`：映射与双语 catalog 的单元测试。
- `apps/platform-web/src/components/app/status-indicator.tsx`：新增 `info` 组件态（INFO 严重度不再借 notConfigured 图形）。
- `apps/platform-web/src/styles.css`：`.status-indicator--info`、`.ow-source-line`。
- `apps/platform-web/src/i18n/catalogs/{en,zh-CN}.json`：`event.incident.*`、`overview.health.{countsConflict,degraded,unknown,unknownDetail}`、`overview.sources.*`、`state.info`。
- `tests/ui/overview-partial.spec.ts`：来源行状态断言；READY+非就绪计数的矛盾测试；修正两条已过时的本地化断言。
- `apps/platform-web/src/pages/IncidentDetail.tsx`：evidence 403 的 status 传入 `evidencePanelState`；`incident-evidence-trusted` 只在 `present` 时渲染；assurance 改为 verdict 实际考虑的 `considered` 集；stale banner 使用本地化 HTTP 类别与页面语言时间，原始码只在 `data-error-code`。
- `apps/platform-web/src/incidents.test.ts`：403 分类测试（含"旧列表仍在时 403 仍是 forbidden"）。
- `tests/ui/g11-incident-state-gaps.spec.ts`：新增证据 403 permission-wall 用例；断言无 retry、无 0/0 provenance、stale banner 不打印原始码；捕获 forbidden 面板截图。
- `apps/platform-web/src/pages/observability-model.ts`：`EntityState` 增加 `degraded`（stale 优先）；`stateCanReport` 含 degraded；`entityRows` 不再用 `?? 0` 制造 0/0；`rowSeverity` 用与 KPI 相同的"任一指标有读数"谓词。
- `apps/platform-web/src/pages/Observability.tsx`：Reporting 卡在 total=0 时 UNKNOWN 而非 0/0；中段刷新失败显示本地化 NoticeBar 并保留旧行；coverage note 显示 staleSamples 计数。
- `apps/platform-web/src/pages/ObservabilityEntity.tsx`：DEGRADED 提示；实例 KPI 在不可上报状态显示 UNKNOWN；instances/events 面板补 loading/unavailable 分支。
- `apps/platform-web/src/pages/observability-model.test.ts`、`tests/ui/observability-surface.spec.ts`：DEGRADED/0/0/缺失计数/刷新失败的单测与 Playwright 断言；fixture 从 13 增至 14（新增 degraded 节点）。
- `tests/ui/overview-matrix.spec.ts`：新的 12 组合 Overview 矩阵（3 视口 × 2 主题 × 2 语言），断言 header、无横向溢出、无 pageerror、来源行与审计面板；截图写入未跟踪的 `artifacts/ui/visual-v1/gate`。
- `tests/ci/g12_acceptance_ci.sh`、`.github/workflows/g12-acceptance.yml`、`tests/ci/check-spec-coverage.mjs`：把 `overview-matrix`、`overview-partial`、`observability-surface` 加入确定性 g12 job 与两条事件的 `paths:`，移除 observability 的 `KNOWN_UNRUN`。
- `tests/ui/visual-v1-capture.mjs`：Phase 0 的 before/after 矩阵捕获工具（不断言，产物未跟踪）。
- `docs/adr/ADR-017-visual-system-v1.md`、`docs/design/opsweave-visual-system-v1/*`。

**未改动但验证过的相关页面**

- `/app/observability`：fixture 矩阵 11/11 PASS（含新增 DEGRADED / 0-0 / 刷新失败断言）；本轮修语义，未做完整视觉重排。
- `/app/incidents/:id`：before 矩阵已捕获；本轮只修证据 403 与 0/0 provenance，未做完整视觉重做。
- Pipeline Studio：未改；Docker 不可用，未运行 Studio smoke，标 `NOT_RUN`。

**与旧规范的冲突和 ADR**

见 `phase-0-baseline.md` §6 与 ADR-017。最关键的三个：四类页面模式进入 `page-template.md`（Pattern D 保留 Studio header，P3 移出 V1）；字体 12/14/16 与 11/13/15/26 的冲突（ADR-017 §D5 决定值先行、标题 20→26 例外）；`code_acceptance` 与本轮无关，未改。

### DS-V1-1 — Token 值与 PageHeader 收敛

本轮同时执行 DS-V1-1 的第一批：类型值迁移（body 15 / sm 13 / label 11 / title clamp 20→26；metric 21 作为命名例外；hero 仅 login）、删除双 PageHeader（3 个调用点迁移）与零调用的 `Ui.StatusBadge` 及其 6 条 `.status-*` CSS。`type-tier` 与 `one-header` 从 6/3 降到 **0/0**，Tailwind 删除未声明的 `text-xs`，`styles.token-contract.test.ts` 与 `check-ui-tokens` 的例外表同步。metric 的 26px 第一版在实测中让 KPI 的 `0` 比健康判决更抢眼并把首屏下移 33px，已回退为命名的 21px 例外。完整记录：[ds-v1-1.md](ds-v1-1.md)。

### DS-V1-1b — 改名与组件收敛

- **Token 改名（零像素变化）**：`sm→meta`、`base|lg→body`、`xl→title`；Tailwind、契约测试、gate 白名单同步。
- **`Ui.ErrorState` 删除**：10 个调用点迁移到 `AsyncBoundary`；新增 `report`（页内 section 不污染 chrome 状态）与 `source`（插件句子不冒充 Kernel）；`AsyncErrorMessage` 由 boundary 与 `ConfirmAction` 共用。
- **15 处 `.panel.metric-card` → `MetricCard`**：IncidentDetail 的 em dash 改为 `NoData`，Pipelines 未加载的 job 列表不再说 "No runs"；新增 `size="small"`；删除 `.metric-*` CSS 并同步 8 个审计 spec 的选择器。
- **Dialog/Sheet 统一**：新增 `components/app/dialog-frame.tsx`，`Modal`/`SheetContent`/`ConfirmAction` 共用一个 head/body/foot 与三种几何；`.modal*` 删除，替换为 `.ow-dialog*`。
- **`check-ui-metrics` 加固**：空 `pages` 不再通过；新增 `--manifest` route 清单与 `route-missing`/`route-unknown`；5 条 gate 自测进入 CI。
- 完整记录：[ds-v1-1b.md](ds-v1-1b.md)。仍未做：`.btn`（Studio 例外）、CSS 拆分、`AVAILABLE`/`CANCELLED` 产品决策、第二/第三标杆的完整视觉重排。

### DS-V1-1c — 审查整改与验收收口

- **Dialog ARIA**：`aria-describedby` 不再被组件覆盖；有描述时指向真实节点，无描述时属性缺席；标题 accessible name 由 DOM 验证。
- **Pending 关闭策略**：写入进行中关闭键禁用而非隐藏，Escape/遮罩被阻止；失败恢复、重试、单次写入均有测试。
- **Boundary 状态所有权**：`platform-status` 改为 per-boundary 报告表，卸载撤销自己的报告；插件失败是 attention 而非 Kernel unavailable；插件恢复后 chrome 不再残留。
- **Sources**：实例分母未知不再打印 `0/0`；sheet 关闭焦点回到行操作；`sources-audit` 的 viewport、动作 id、凭证字段与文案断言全部修正；12 组合矩阵覆盖 detail/config。
- **MetricCard**：4 个迁移页面 × 3 视口 × 2 主题 × 2 语言矩阵；缺失计数为 UNKNOWN/NO_DATA。
- **UI Metrics Gate**：无条件要求 theme/locale；`--matrix` 24 组合执行清单；14 条自测含删除/重复组合故障注入；CI 对 tracked artifacts 直接运行两个清单。
- 完整记录：[ds-v1-1c.md](ds-v1-1c.md)。

## 2. 三个标杆的 Before / After

| 页面 | Before 证据 | After 证据 | 数据真实性与关键状态 | 结论 |
|---|---|---|---|---|
| `/admin/overview` | `artifacts/ui/visual-v1/before/`（36-image matrix） | `artifacts/ui/visual-v1/after/`（同矩阵） | live 空/未配置（无 Docker）；PARTIAL/DEGRADED/ATTENTION/READY+计数矛盾由 `overview-partial.spec.ts` 对真实 `/api/v1/overview` 改写后验证 | **PASS（本轮范围）** |
| `/app/observability` | `artifacts/ui/visual-v1/before/`（observability__*） | `artifacts/ui/observability/shots/`（14 节点 fixture 矩阵，未跟踪） | live 空 + 14 节点 fixture（新增 DEGRADED）；DEGRADED / 0-0 / 刷新失败由 `observability-surface.spec.ts` 断言 | **PASS（语义修复）**；完整视觉重排 **NOT_RUN** |
| `/app/incidents/:id` | `artifacts/ui/visual-v1/before/`（incident__*，g12d 种子 incident A，5 条 evidence） | `artifacts/ui/visual-v1/after/` 的 `incident-forbidden-*` 两张 capture（未跟踪）；正常布局沿用 before | 真实 g12d 数据 + 对证据端点强制 403（明确为 forced）；403/0-0 语义由 `g11-incident-state-gaps.spec.ts` 6/6 与 `g12-lifecycle` 1/1 验证 | **PASS（403/0-0 语义）**；完整视觉重做 **NOT_RUN** |

关键状态（Overview）：正常/未配置、PARTIAL（503、空 body、pending）、DEGRADED、ATTENTION、READY+非就绪计数、INFO、未知 health code。`UNKNOWN` 不再画成 ATTENTION；`PARTIAL` 的来源行在首屏可见；READY 不再在计数未就绪时打印 all-clear。

**Gate wiring（本轮）**：`overview-matrix.spec.ts`、`overview-partial.spec.ts`、`observability-surface.spec.ts` 进入 `g12-acceptance` 的确定性 job，并写入该 workflow 的 `pull_request`/`push` paths；`check-spec-coverage` 现在报告三者 COVERED，`observability-surface` 不再是 `EXPLICIT_SKIP`。Incident 矩阵继续由 `g12d-workspace.spec.ts` 覆盖；`incidents-workspace.spec.ts` 仍是 explicit skip（fixture 缺 SOURCE_ATTESTED）。

## 3. 门禁及真实命令

| 检查 | 命令 | PASS / FAIL / NOT_RUN | 日志/artifact/HEAD |
|---|---|---|---|
| TypeScript | `pnpm --filter @opsweave/platform-web typecheck` | **PASS** | 本机，`775a1e2` + 工作树 |
| Frontend Vitest | `pnpm --filter @opsweave/platform-web test` | **PASS** — 31 files / 426 tests | 同上 |
| Build | `pnpm --filter @opsweave/platform-web build` | **PASS** | 同上 |
| i18n | `node scripts/check-i18n.mjs` | **PASS** — 1,940 keys × 2；17 条既有 unused | DS-V1-1b 后 |
| Status vocabulary | `node scripts/check-status-vocabulary.mjs` | **PASS** — 43 codes | 同上 |
| UI Token ratchet | `node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json` | **PASS** — 0/0/0/0/0/0（DS-V1-1b 后） | 同上 |
| UI geometry | `node scripts/check-ui-metrics.mjs artifacts/ui/observability/metrics` | **PASS** — 24 measurements，0 violations | fixture 矩阵 |
| UI geometry + manifest | `node scripts/check-ui-metrics.mjs --manifest docs/design/ui-visual-v3/spec/route-manifest.json artifacts/ui/visual-v3/audit` | **PASS** — 30 measurements / 10 routes | DS-V1-1b |
| Gate self-tests | `node --test scripts/check-ui-metrics.test.mjs` | **PASS** — 14/14（含 matrix 缺组合/重复组合/格式错误） | DS-V1-1c；已加入 CI web job |
| Matrix gate | `node scripts/check-ui-metrics.mjs --matrix docs/design/ui-visual-v3/spec/matrix-manifest.json artifacts/ui/observability/metrics` | **PASS** — 24/24 combinations | DS-V1-1c |
| Dialog contract | `... playwright test dialog-contract.spec.ts` | **PASS** — 4/4（ARIA、pending、palette、modal） | DS-V1-1c |
| Dialog geometry | `... playwright test dialog-geometry.spec.ts` | **PASS** — 16/16 combos, 48 screenshots | DS-V1-1c |
| Boundary ownership | `... playwright test boundary-ownership.spec.ts` | **PASS** — 9/9（503/403/plugin load/render+retry/account/upload/section/client-nav） | DS-V1-1c |
| Sources matrix | `... playwright test sources-audit.spec.ts` | **PASS** — 18/18（12 combos + detail/config + sheet contract） | DS-V1-1c |
| MetricCard matrix | `... playwright test metric-card-matrix.spec.ts` | **PASS** — 12/12 incident combos, 48 screenshots（KPI 21 / label 11；390 为 2×2） | DS-V1-1c |
| Playwright Overview 状态 | `... playwright test overview-partial.spec.ts` | **PASS** — 7/7 | 本机 Kernel `18291`；已进入 g12-acceptance 确定性 job |
| Playwright Overview 矩阵 | `... playwright test visual.spec.ts -g "responsive overview matrix"` | **PASS** — 6 组合 | 本机 |
| Playwright Observability fixture | `OBS_DATA=fixtures ... playwright test observability-surface.spec.ts` | **PASS** — 11/11 | fixture，明确标注；已由 g12-acceptance 在 PR 上运行 |
| Playwright Overview 矩阵 | `... playwright test overview-matrix.spec.ts` | **PASS** — 12 组合 | 本机；已进入 g12-acceptance 确定性 job |
| Spec coverage | `node tests/ci/check-spec-coverage.mjs` | **PASS** — 30 covered / 23 explicit-skip / 0 unreferenced；三个旗舰 spec 均 COVERED ← g12-acceptance | 本机 |
| Deterministic g12 harness | `bash tests/ci/g12_acceptance_ci.sh` | **PASS** — 64 tests（62 passed / 2 skipped），6.6 min；acceptance 195/0；exit 0 | 本机后台，含新增 3 个 spec |
| Playwright DS-V1-1 矩阵 | `artifacts/ui/visual-v1/after-ds-v1-1/` | **PASS（证据）** — 36 images；Overview header 80，无横向溢出 | 本机 |
| Deterministic g12 harness (DS-V1-1) | `bash tests/ci/g12_acceptance_ci.sh` | **PASS** — 64 tests（62 passed / 2 skipped），8.0 min；acceptance 195/0；exit 0 | 类型/PageHeader 变更后 |
| Deterministic g12 harness (DS-V1-1b) | `bash tests/ci/g12_acceptance_ci.sh` | **PASS** — 64 tests（62 passed / 2 skipped），6.5 min；acceptance 195/0；exit 0 | 本机后台，DS-V1-1b 后 |
| Deterministic g12 harness (DS-V1-1c) | `bash tests/ci/g12_acceptance_ci.sh` | **PASS** — 98 tests（96 passed / 2 skipped），7.8 min；acceptance 195/0；exit 0 | 本机后台，含 dialog/boundary/sources/metric 矩阵 |
| Playwright Incident 状态 | `... playwright test g11-incident-state-gaps.spec.ts` | **PASS** — 6/6（含新增证据 403） | 本机 Kernel `18291` |
| Playwright Incident lifecycle | `... playwright test g12-lifecycle.spec.ts -g "an operator closes a concluded incident"` | **PASS** — 1/1（ConfirmAction → DialogFrame） | 本机，DB `opsweave_visual_v1` |
| Playwright command palette | `... playwright test admin-shell.spec.ts -g "command palette opens"` / `-g "navigation becomes a drawer at 1024"` | **PASS** — 2/2（center dialog + 1024 sheet） | 本机 |
| Playwright Incident workspace trust | `... --config incidents-workspace.config.ts -g "every evidence row carries a trust level"` | **FAIL（预存在 fixture 不符）** | 该 spec 期望种子里有 SOURCE_ATTESTED 行；g12d 种子只有 UNVERIFIED/OPERATOR_ASSERTED，且 legend 自带 `ok` chip；本轮改动未触及 trust 渲染 |
| PNG budget | `node tests/ci/check-tracked-png-budget.mjs` | **PASS** — 408 / 65.97 MB，0 新增 | 预算未提高 |
| Accessibility / contrast | — | **NOT_RUN** | 仓库无此 Gate |
| Visual diff | — | **NOT_RUN** | 仓库无 `toHaveScreenshot` |
| Staging（实际执行） | — | **NOT_RUN** | 无凭据；远端层按 ADR-016 为 advisory |
| 全量 11-spec / 53-test | — | **NOT_RUN（本会话）** | G13 条件 1 仍为 39/53 |

## 4. 对抗性验证

- `NO_DATA` 不等于 0：Overview 的零分母保持 em dash + 原因；Observability 的 fixture 断言 `NO_DATA` 只作为 token，不作为数字；本轮未改这些路径，只验证未回归。
- `UNKNOWN` 不等于健康：未知 health code 本轮改为 neutral band + "Platform health is unknown"；`data-kernel-health` 保留原始码。
- `STALE` 时间：Overview 仍无 STALE 状态（未决，ADR-017 §6）；Observability 的 STALE 由既有 `isStale`/NoticeBar 覆盖（fixture 矩阵 PASS）。
- `DEGRADED` 不等于 unknown：fleet chip 与 entity notice 都显示 degraded；degraded 节点仍可上报读数与实例计数；stale 优先于 degraded。
- Observability 的 0/0 与刷新失败：Reporting 卡 `total=0` 显示 UNKNOWN；`entityRows` 缺失实例计数返回 `null`；unreachable 实体 KPI 显示 UNKNOWN；失败刷新保留旧行并显示本地化 NoticeBar。
- Evidence claim != verified：Incident 的 claimed/verified 由既有 `incident-trust.tsx` 覆盖；本轮只把 assurance 的集合从"全部 evidence"改为 verdict 实际考虑的 `considered` 集，trust 渲染本身未改。`incidents-workspace` 的 trust 用例因种子缺少 SOURCE_ATTESTED 行而 FAIL（预存在 fixture 不符），不作为本轮回归。
- 403/409/异步失败/readback：Overview 的 403 由 AsyncBoundary 覆盖；Incident 证据子资源 403 现在渲染 permission wall（无 retry、无 0/0 provenance），stale banner 用本地化 HTTP 类别而非原始 `FORBIDDEN`；409/readback 由既有 g11/g12 覆盖。
- 健康判决与计数矛盾：新增回归测试，`data-health=DEGRADED` vs `data-kernel-health=READY`，band/detail/module 一致。

## 5. 余留风险与裁决

- **P0（未修，需产品决策）**：Incident 的 digest mismatch 仍可读 bytes（安全/产品决策，不能只改视觉）；Observability 的 per-row observed time 仍只在 hover title；Observability/Incident 的完整视觉重排仍 `NOT_RUN`。
- **P1**：Overview 无 STALE 策略、shell/页面双轮询可短暂矛盾、KPI 逐卡时间缺失；Observability 的 history/events 更多边界、per-row observed time 仍 hover-only；Incident 的 header 缺 owner/scope、审计不可折叠、verifiedAt 未渲染、fingerprint 只在 viewer、rail 首答前 0/0。三标杆矩阵已进入 g12-acceptance；`incidents-workspace.spec.ts` 仍是 explicit skip（fixture 缺 SOURCE_ATTESTED）。
- **已修（本轮）**：Observability 的 Reporting 0/0、`entityRows` 缺失计数、unreachable 实体 KPI 0/N、DEGRADED 折叠、实例/事件面板 loading/error、刷新失败静默、`staleSamples` 不可见、Reporting 计数与过滤谓词不一致；Incident 证据 403 死代码、`incident-evidence-trusted` 在 loading/forbidden 时的 0/0、assurance 改为 considered 集、stale banner 的原始码与浏览器 locale 时间；DS-V1-1 的类型值迁移、双 PageHeader 去重、死 `Ui.StatusBadge` 与 `.status-*` CSS、type-tier/one-header 预算归零。
- **P1（门禁）**：三标杆矩阵已进入 g12-acceptance；`check-ui-metrics` 的空页/route fail-open 已修（`--manifest` + 自测），PNG 预算零余量、无对比度/触摸目标/视觉 diff、`tests/ui` 不 typecheck 仍未解决。
- **P2**：CSS 文件拆分、`.btn`（Studio 例外）、`AVAILABLE`/`CANCELLED` 语义分歧、`components/domain/` 未建、route→pattern registry 与 `--template` 全量覆盖。
- **已修（DS-V1-1b）**：token 改名；`ErrorState` → `AsyncBoundary`（含 `report`/`source`/`AsyncErrorMessage`）；15 处 `.panel.metric-card` → `MetricCard`；`.modal*` 与 DialogHeader 两套几何合并为 `DialogFrame`；`check-ui-metrics` 空 pages fail-open 与 route manifest。
- **裁决**：`READY_FOR_REVIEW`，**Phase 0 + Overview + Incident 证据语义 + Observability 语义 + Gate wiring + DS-V1-1 + DS-V1-1b**。全量 V1（三标杆完整视觉重排、route→pattern registry、CSS 拆分）**NOT_READY**，不在本 PR 声称完成。
- 下一最小 PR 建议：① 产品决策：Incident digest mismatch 的可读性；② route→pattern registry 与 `--template` 全量覆盖；③ CSS 模块化拆分与 `.btn`（Studio）迁移。
- 本 PR **未**自动合并、未转 Ready（Draft）、未打 Tag、未发布、未部署。
