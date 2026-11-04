# Evidence Index — Visual System V1 Phase 0 + first flagship

- 执行日期：2026-11-04
- 环境：macOS 15.7.7 / Apple M1；Node 22.12.0；pnpm 10.34.3；Playwright 1.64.1（Chromium）；PostgreSQL 17（本机）；Kernel 由 `775a1e2` 源码构建；Docker **不可用**
- 基线：`origin/main@775a1e2`
- 开发分支：`design/opsweave-visual-system-v1`
- 数据来源：
  - Overview / Observability live：本地 Kernel + 空数据库的真实状态（无 Docker，无节点/插件实例）；不是 mock，也不是生产读数。
  - Incident：`tests/ui/g12d-seed.mjs` 通过公开 API 创建 3 个 incident / 5 条 evidence；admin 属于 legacy workspace。
  - Observability 13 节点矩阵：`OBS_DATA=fixtures`，已在 spec 注释和 metrics `config.data` 中标为 fixture。

## 1. 浏览器捕获

```bash
CAPTURE_URL=http://127.0.0.1:18291 \
CAPTURE_INCIDENT=<g12d seed incidentA> \
CAPTURE_SHA=775a1e2 \
CAPTURE_OUT=artifacts/ui/visual-v1/before \
node tests/ui/visual-v1-capture.mjs
# 改动后同命令，CAPTURE_OUT=artifacts/ui/visual-v1/after
```

产物（未跟踪，`.gitignore` 已声明 `artifacts/ui/visual-v1/`）：

| 目录 | 内容 |
|---|---|
| `artifacts/ui/visual-v1/before/` | 36 张 PNG + `_manifest.json` + 每页 `_metrics_*.json` |
| `artifacts/ui/visual-v1/after/` | 同上；三页矩阵在 `25a784c`，证据 403 特写与全页截图在 `d47fbfd`，Observability metrics 在 `ef30d48`（均基于 `775a1e2`） |
| `artifacts/ui/observability/shots/` | `observability-surface.spec.ts` 的 fixture 矩阵（未跟踪） |
| `artifacts/ui/visual-v1/after/` | 证据 403 的两张 capture：`incident-forbidden-1440-light-en`（全页，stale banner）与 `incident-forbidden-panel-1440-light-en`（permission-wall 面板特写）；未跟踪，不作为 Git evidence link，由 `g11-incident-state-gaps.spec.ts` 复现 |

`_manifest.json` 记录 base URL、base SHA、capturedAt、Chromium 版本、账号、每页 metrics 文件名。该脚本不断言任何东西，只记录；断言在 Playwright 测试里。

### 1.1 关键测量（1440-light-en / 390-light-zh-CN）

| 指标 | Overview before | Overview after | 说明 |
|---|---|---|---|
| page header 高度 | 80 / 80 | 80 / 80 | 未变 |
| overflow | -15 / -15 | -15 / -15 | 无横向溢出 |
| h1 | 26px / 20px | 26px / 20px | 标题 clamp：1440 上 26，390 上 20 |
| h2 | 16px | 16px | 未变 |
| metric value | 21px | 21px | 未变 |
| status label | 12px | 12px | 未变 |
| `.console-grid` y | 352 / 544 | 377 / 589 | 来源行 +25px（1440）/ +45px（390，换行两行） |

其他两页的 before/after 几何一致（Incident header 107/96/226，证据行 42px 桌面 / 192px 390；Observability live 为空，header 80/143/124）。after 的可见变化只在 Overview：事件词表本地化、来源行、INFO 图形、健康判决对账。

## 2. 静态/单元门禁

| 检查 | 命令 | 结果 |
|---|---|---|
| TypeScript | `pnpm --filter @opsweave/platform-web typecheck` | **PASS** |
| Vitest | `pnpm --filter @opsweave/platform-web test` | **PASS** — 31 files / 426 tests（`overview-events`、`evidencePanelState` 403、`entityState` degraded、0/0 与过滤谓词） |
| Build | `pnpm --filter @opsweave/platform-web build` | **PASS** — vite build，169.26 kB CSS / 1,313.78 kB JS（既有 chunk 警告，未新增） |
| i18n | `node scripts/check-i18n.mjs` | **PASS** — en/zh-CN 各 1,920 keys；17 条既有 unused warning（非本轮新增） |
| Status vocabulary | `node scripts/check-status-vocabulary.mjs` | **PASS** — 41 protocol codes |
| UI Token ratchet | `node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json` | **PASS** — radius 0/0、control 0/0、type 6/6、one-header 3/3、uppercase 0/0、format 0/0 |
| UI geometry | `node scripts/check-ui-metrics.mjs artifacts/ui/observability/metrics` | **PASS** — 24 page measurements，0 violations（14 节点 fixture；tracked metrics 已更新） |
| PNG budget | `node tests/ci/check-tracked-png-budget.mjs` | **PASS** — 408 files / 65.97 MB（ceiling 408 / 68.24 MB），0 新增 |
| Spec coverage | `node tests/ci/check-spec-coverage.mjs` | **PASS** — 30 covered / 23 explicit-skip / 0 unreferenced；`overview-matrix`、`overview-partial`、`observability-surface` 均 COVERED ← g12-acceptance |
| Whitespace | `git diff --check` | **PASS** |

## 3. Playwright

| 套件 | 命令 | 结果 |
|---|---|---|
| Overview 状态 | `OPSWEAVE_URL=http://127.0.0.1:18291 pnpm exec playwright test overview-partial.spec.ts`（cwd `tests/ui`） | **PASS** — 7/7 |
| Overview 响应式矩阵 | `... playwright test visual.spec.ts -g "responsive overview matrix"` | **PASS** — 1 test / 6 组合（1440/1024/390 × light/dark），无 pageerror，无 overflow |
| Overview 12 组合矩阵（门禁） | `... playwright test overview-matrix.spec.ts` | **PASS** — 1 test / 12 组合（3 视口 × 2 主题 × 2 语言），已进入 g12-acceptance |
| Observability fixture 矩阵 | `OBS_DATA=fixtures ... playwright test observability-surface.spec.ts` | **PASS** — 11/11（14 节点 fixture；新增 DEGRADED、zero fleet 0/0、unreachable KPI、刷新失败 4 个断言）；已进入 g12-acceptance |
| Deterministic g12 harness | `bash tests/ci/g12_acceptance_ci.sh` | **PASS** — 64 tests（62 passed / 2 skipped），6.6 min；acceptance 195/0；exit 0 | 本机后台，含新增 3 个 spec |
| Incident 状态缺口 | `... playwright test g11-incident-state-gaps.spec.ts` | **PASS** — 6/6（含新增证据 403） |
| Incident lifecycle | `... playwright test g12-lifecycle.spec.ts -g "an operator closes a concluded incident"` | **PASS** — 1/1（trusted 行仍在 present 时渲染） |
| Incident workspace trust | `... --config incidents-workspace.config.ts -g "every evidence row carries a trust level"` | **FAIL（预存在 fixture 不符）** — g12d 种子只有 UNVERIFIED/OPERATOR_ASSERTED，spec 期望 SOURCE_ATTESTED；页面 legend 自带 `ok` chip；本轮未改 trust 渲染 |

`overview-partial.spec.ts` 新增/修正的用例：

- 来源行：overview/diagnostics 各自 `answered`；diagnostics 503/空 body → `missing`；held-open → `pending`。
- READY + `nodesTotal=1,nodesReady=0` + `instancesTotal=1,instancesReady=0`：band `data-health=DEGRADED`、`data-kernel-health=READY`、headline `overview.health.countsConflict`、detail 为 nodes 0/1，模块行 degraded。
- 原 warning attention 用例：标题改为断言 catalog 本地化结果，detail 断言保留原文并单独断言 `kernel` 来源标签（原断言在页面本地化后已过时）。

## 4. 已知失败 / NOT_RUN

| 项 | 状态 | 原因 |
|---|---|---|
| 全量 staging-preview / 远端浏览器层 | **NOT_RUN** | 本机无 staging 凭据；ADR-016 已把远端层定为 advisory |
| `incidents-workspace` 的 trust 用例 | **FAIL（预存在 fixture）** | 该 spec 是 EXPLICIT_SKIP；g12d 种子没有 SOURCE_ATTESTED 行，页面 legend 自带 `ok` chip；本轮未改 trust 渲染，失败不是本轮引入 |
| Docker 依赖的 admin-shell / plugin-surfaces / studio 套件 | **NOT_RUN** | 本机 Docker 不可用，无法启动节点与插件实例 |
| `g11-page-header-growth.spec.ts` | **NOT_RUN** | 需要 pipeline/Studio 数据；header 未改动，PR CI 的 g12-acceptance 覆盖 |
| 全局字体迁移（11/13/15/26） | **NOT_RUN** | 决策已写 ADR-017 §D5；实现属 DS-V1-1，需要同步改 `styles.token-contract.test.ts` 与 Tailwind 映射 |
| 双 PageHeader / `.btn` / `ErrorState` 收敛 | **NOT_RUN** | DS-V1-1 |
| Observability / IncidentDetail 完整视觉重排 | **NOT_RUN** | 语义修复已完成；布局/视觉重排下一阶段。三标杆矩阵已接入 g12-acceptance；`incidents-workspace.spec.ts` 仍 skip（fixture 缺 SOURCE_ATTESTED） |
| route→pattern registry 与 `--template` gate | **NOT_RUN** | ADR-017 §D3；先改 spec/gate 再改页面 |
| 对比度 / 触摸目标 / axe | **NOT_RUN** | 仓库当前无此 Gate；`gateb-v3-evidence.mjs` 只打印比值 |
| 视觉 diff（toHaveScreenshot） | **NOT_RUN** | 仓库当前没有；截图只作证据 |
| 全量 11-spec / 53-test 确定性套件 | **NOT_RUN（本会话）** | 不属于视觉本轮；G13 条件 1 仍为 39/53（ADR-016 §5） |

## 5. 预存在缺陷（不属于本轮，未修）

- `g11-page-header-growth.spec.ts` 的 Studio 用例在有 pipeline 的 host 上失败（`controls.length` 0，期望 ≥9）；在 `b9a01db` 上已复现。
- `check-ui-metrics.mjs` 对 `{"pages":{}}` fail-open；无 route/width/theme 覆盖清单。
- `observability-surface.spec.ts`、`incidents-workspace.spec.ts`、`admin-shell.spec.ts`、`visual.spec.ts`、`overview-partial.spec.ts` 不在 PR 门禁（见 `phase-0-baseline.md` §5）。
- `tests/ui` 不被 typecheck；`test:studio` 不在 CI。
- `AVAILABLE` 在插件安装状态显示 "Uninstalled" 与 `STATUS_MAP` 的 "Available" 分歧；`CANCELLED` 在 investigation/全局 tone 不一致。

## 6. 结论

Phase 0 的静态与浏览器证据齐全；第一标杆的改动通过类型、单元、i18n、状态词表、Token、几何、PNG 预算与相关 Playwright。未执行项全部标 `NOT_RUN`；没有把 fixture、截图或未运行项写成 PASS。
