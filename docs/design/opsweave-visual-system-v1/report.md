# OpsWeave Visual System V1 交付报告（Phase 0 + first flagship）

- 日期：2026-11-04
- 执行环境：macOS 15.7.7 / Apple M1；Node 22.12.0；pnpm 10.34.3；Playwright 1.64.1（Chromium）；PostgreSQL 17（本机）；Docker 不可用
- 原始基线 `origin/main` SHA：`775a1e2`
- 实际开发分支 / HEAD：`design/opsweave-visual-system-v1` / `25a784c`（Overview 实现）+ `d47fbfd`（Incident 语义修复）
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
- `tests/ui/visual-v1-capture.mjs`：Phase 0 的 before/after 矩阵捕获工具（不断言，产物未跟踪）。
- `docs/adr/ADR-017-visual-system-v1.md`、`docs/design/opsweave-visual-system-v1/*`。

**未改动但验证过的相关页面**

- `/app/observability`：fixture 矩阵 7/7 PASS；未做视觉重做。
- `/app/incidents/:id`：before 矩阵已捕获；本轮只修证据 403 与 0/0 provenance，未做完整视觉重做。
- Pipeline Studio：未改；Docker 不可用，未运行 Studio smoke，标 `NOT_RUN`。

**与旧规范的冲突和 ADR**

见 `phase-0-baseline.md` §6 与 ADR-017。最关键的三个：四类页面模式进入 `page-template.md`（Pattern D 保留 Studio header，P3 移出 V1）；字体 12/14/16 与 11/13/15/26 的冲突（ADR-017 §D5 决定值先行、标题 20→26 例外）；`code_acceptance` 与本轮无关，未改。

## 2. 三个标杆的 Before / After

| 页面 | Before 证据 | After 证据 | 数据真实性与关键状态 | 结论 |
|---|---|---|---|---|
| `/admin/overview` | `artifacts/ui/visual-v1/before/overview__r{1440,1024,390}-{light,dark}-{en,zh-CN}.png` | `artifacts/ui/visual-v1/after/overview__...` | live 空/未配置（无 Docker）；PARTIAL/DEGRADED/ATTENTION/READY+计数矛盾由 `overview-partial.spec.ts` 对真实 `/api/v1/overview` 改写后验证 | **PASS（本轮范围）** |
| `/app/observability` | `.../before/observability__...` | 未重做（after 仅同状态捕获） | live 空 + 13 节点 fixture 矩阵（`OBS_DATA=fixtures`，明确标注） | **NOT_RUN（视觉重做）**；现有 fixture 矩阵 PASS |
| `/app/incidents/:id` | `.../before/incident__...`（g12d 种子 incident A，5 条 evidence） | `.../after/incident-forbidden-1440-light-en.png`、`.../after/incident-forbidden-panel-1440-light-en.png`；正常布局沿用 before | 真实 g12d 数据 + 对证据端点强制 403（明确为 forced）；403/0-0 语义由 `g11-incident-state-gaps.spec.ts` 6/6 与 `g12-lifecycle` 1/1 验证 | **PASS（403/0-0 语义）**；完整视觉重做 **NOT_RUN** |

关键状态（Overview）：正常/未配置、PARTIAL（503、空 body、pending）、DEGRADED、ATTENTION、READY+非就绪计数、INFO、未知 health code。`UNKNOWN` 不再画成 ATTENTION；`PARTIAL` 的来源行在首屏可见；READY 不再在计数未就绪时打印 all-clear。

## 3. 门禁及真实命令

| 检查 | 命令 | PASS / FAIL / NOT_RUN | 日志/artifact/HEAD |
|---|---|---|---|
| TypeScript | `pnpm --filter @opsweave/platform-web typecheck` | **PASS** | 本机，`775a1e2` + 工作树 |
| Frontend Vitest | `pnpm --filter @opsweave/platform-web test` | **PASS** — 31 files / 420 tests | 同上 |
| Build | `pnpm --filter @opsweave/platform-web build` | **PASS** | 同上 |
| i18n | `node scripts/check-i18n.mjs` | **PASS** — 1,920 keys × 2；17 条既有 unused | 同上 |
| Status vocabulary | `node scripts/check-status-vocabulary.mjs` | **PASS** — 41 codes | 同上 |
| UI Token ratchet | `node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json` | **PASS** — 0/0/6/3/0/0 | 同上 |
| UI geometry | `node scripts/check-ui-metrics.mjs artifacts/ui/observability/metrics` | **PASS** — 24 measurements，0 violations | fixture 矩阵 |
| Playwright Overview 状态 | `... playwright test overview-partial.spec.ts` | **PASS** — 7/7 | 本机 Kernel `18291` |
| Playwright Overview 矩阵 | `... playwright test visual.spec.ts -g "responsive overview matrix"` | **PASS** — 6 组合 | 本机 |
| Playwright Observability fixture | `OBS_DATA=fixtures ... playwright test observability-surface.spec.ts` | **PASS** — 7/7 | fixture，明确标注 |
| Playwright Incident 状态 | `... playwright test g11-incident-state-gaps.spec.ts` | **PASS** — 6/6（含新增证据 403） | 本机 Kernel `18291` |
| Playwright Incident lifecycle | `... playwright test g12-lifecycle.spec.ts -g "an operator closes a concluded incident"` | **PASS** — 1/1（trusted 行仍在 present 时渲染） | 本机，DB `opsweave_visual_v1` |
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
- Evidence claim != verified：Incident 的 claimed/verified 由既有 `incident-trust.tsx` 覆盖；本轮只把 assurance 的集合从"全部 evidence"改为 verdict 实际考虑的 `considered` 集，trust 渲染本身未改。`incidents-workspace` 的 trust 用例因种子缺少 SOURCE_ATTESTED 行而 FAIL（预存在 fixture 不符），不作为本轮回归。
- 403/409/异步失败/readback：Overview 的 403 由 AsyncBoundary 覆盖；Incident 证据子资源 403 现在渲染 permission wall（无 retry、无 0/0 provenance），stale banner 用本地化 HTTP 类别而非原始 `FORBIDDEN`；409/readback 由既有 g11/g12 覆盖。
- 健康判决与计数矛盾：新增回归测试，`data-health=DEGRADED` vs `data-kernel-health=READY`，band/detail/module 一致。

## 5. 余留风险与裁决

- **P0（下一阶段）**：Observability 实体页对 unreachable/revoked 打印存储的 0/N；Reporting 卡在无数据时 0/0；DEGRADED 被折叠成 unknown。这些是"缺失被画成数字"的真实风险。
- **P1**：Overview 无 STALE 策略、shell/页面双轮询可短暂矛盾、KPI 逐卡时间缺失；Observability 的 hover-only observed time、错误被吞、`staleSamples` 未渲染；Incident 的 header 缺 owner/scope、审计不可折叠、verifiedAt 未渲染、fingerprint 只在 viewer、rail 首答前 0/0。
- **已修（本轮）**：Incident 证据 403 死代码；`incident-evidence-trusted` 在 loading/forbidden 时的 0/0；assurance 改为 considered 集；stale banner 的原始码与浏览器 locale 时间。
- **P1（门禁）**：三标杆矩阵不在 PR 门禁；`check-ui-metrics` fail-open；PNG 预算零余量；无对比度/触摸目标/视觉 diff；`tests/ui` 不 typecheck。
- **P2**：字体 12px 迁移的表格卡片几何重算；`Ui.StatusBadge` 零调用未删；`AVAILABLE`/`CANCELLED` 语义分歧；`components/domain/` 未建。
- **裁决**：`READY_FOR_REVIEW`，**仅限 Phase 0 + Overview 第一标杆 + Incident 证据语义修复**。全量 V1（三标杆、字体/组件收敛、Gate 迁移）**NOT_READY**，不在本 PR 声称完成。
- 下一最小 PR 建议：① 修 Observability 0/0 与 DEGRADED 折叠；② 把三标杆矩阵接入 PR 门禁并补 route coverage；③ 再做 DS-V1-1 的字体/PageHeader/Button 收敛。
- 本 PR **未**自动合并、未转 Ready（Draft）、未打 Tag、未发布、未部署。
