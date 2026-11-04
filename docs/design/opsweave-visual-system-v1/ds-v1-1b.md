# DS-V1-1b — Token 改名、ErrorState/MetricCard/Dialog 收敛、route coverage

- 日期：2026-11-04
- 状态：**PASS（四个收敛项 + 门禁加固）**；未做项见 §7
- 决策：[ADR-017 §D5 / §D7](../../adr/ADR-017-visual-system-v1.md)
- 基线：`origin/main@775a1e2`；实现分支 `design/opsweave-visual-system-v1`（接在 DS-V1-1 的 `19ae2dd` 之后）
- 前一批：[ds-v1-1.md](ds-v1-1.md)

DS-V1-1 是 values-first：先把 11/13/15/26 写进旧 t-shirt token，再改名。这一批完成改名与三个组件的单一实现，并把 `check-ui-metrics` 的两个 fail-open 洞补上。

## 1. Token 改名（零像素变化）

| before | after | 说明 |
|---|---|---|
| `--ow-type-label: 11px` | 不变 | 微标签、表头、eyebrow |
| `--ow-type-meta: 13px` | 不变 | 表值、次要数据 |
| `--ow-type-sm: 13px` | 删除，调用改读 `--ow-type-meta` | DS-V1-1 已把值改成 13 |
| `--ow-type-base: 15px` | 删除，调用改读 `--ow-type-body` | 正文、控件、表单 |
| `--ow-type-lg: 15px` | 删除，调用改读 `--ow-type-body` | 面板标题靠字重，不靠字号 |
| `--ow-type-xl: clamp(20px,2.1vw,26px)` | `--ow-type-title` | 命名例外，gate 白名单同步 |
| `--ow-type-metric: 21px` | 不变 | 命名显示例外 |
| `--ow-type-hero: clamp(30px,4vw,44px)` | 不变 | 仅 `/login` |

- 这是纯改名：`sm` 与 `meta` 在 DS-V1-1 后同为 13，`base` 与 `lg` 同为 15，`xl` 与 `title` 是同一个 clamp。36 张 `after-ds-v1-1b` 矩阵与 `after-ds-v1-1` 逐项对比，Overview/Observability 的 `header`、`h1`、`h2`、`metricValue`、`overflow` **全部一致**；Incident 只多出四个此前不被 `.ow-metric-value` 选择器测到的 KPI 卡（见 §3）。
- `tailwind.config.cjs` 的 `text-sm/base/lg/xl` 全部指向新 token；`text-xs` 保持删除。
- `styles.token-contract.test.ts` 断言四个 token 各一次；重复的 `meta`/`body` 声明已删。
- `check-ui-tokens.mjs` 的 `TYPE_TOKENS` 与 `TYPE_EXEMPT_TOKENS` 使用最终名；`type-tier` 预算仍为 0。
- `token-table.md` 的 V1 note 从"目标/待改名"改为已改名；删除列表只保留 t-shirt 名，不再把 metric/hero 误列为删除项。

## 2. `Ui.ErrorState` → `AsyncBoundary`

`ErrorState` 的 10 个调用点全部迁移；组件本身删除。旧实现把 `error.message` 直接当正文打印，违反 AGENTS.md 的"不得把服务端英文句子渲染给用户"。

- `AsyncBoundary` 新增两个 prop：
  - `report?: boolean`（默认 `true`）：页面级 boundary 才向 chrome 报告 body 状态；`InstallWizard` 的上传失败是页内 section 错误，传 `false`，不让 topbar 声称整个平台不可用。
  - `source?: 'kernel' | 'plugin'`（默认 `kernel`）：插件加载/渲染失败没有 HTTP status，原因用 `extensions.error.isolationNote`，原始句子标注为 plugin，不冒充 Kernel。
- 错误正文抽成 `AsyncErrorMessage`，`AsyncBoundary` 与 `ConfirmAction` 共用：本地化原因 + `ui.error.code` / `ui.error.requestId` + 带来源标签的原始句子。
- 迁移映射：
  - `studio/PipelineEditor.tsx`：加载失败 → boundary；"没有数据"不再是伪造的 `new Error(t(...))`，改为 `EmptyState` + retry。
  - `extensions.tsx`：扩展列表失败 → boundary（kernel）；插件加载失败与 `ExtensionBoundary` 的渲染异常 → boundary `source="plugin"`。
  - `InstallWizard.tsx`：`report={false}`。
  - `InstanceLogs.tsx`、`OpsCenter.tsx`、`PluginDetail.tsx`、`Nodes.tsx`：页面级 boundary；403 现在渲染既有的 permission wall，而不是旧的"加载失败 + retry"。
- 死 CSS `.error-state` / `.error-icon` 与 gate 的 DECORATION 条目一并删除；`error.unknown` 不再被引用，从两个 catalog 移除（i18n 回到 17 条既有 unused）。

## 3. 15 处 `.panel.metric-card` → `MetricCard`

| 页面 | 迁移 |
|---|---|
| `IncidentDetail.tsx` | 4 卡；evidence 计数在未加载时是 `NoData`，不再打印 em dash；`data-testid="incident-detail-evidence-count"` 保留在值内 |
| `Jobs.tsx` | 3 卡 |
| `Pipelines.tsx` | 4 卡；"latest run" 在 jobs 未加载时是 `NO_DATA`，不再把未加载说成 "No runs" |
| `Governance.tsx` | 4 卡；缺失值用 `state="unknown"`，不再在卡片里塞 `UnknownValue` |

- `MetricCard` 新增 `size?: 'default' | 'small'`：pill/时间戳不是计数，保留 body 15；这取代了 `.metric-value.small` 这套第二值词汇。
- 卡片高度规则改为按 band 容器作用：`.metric-grid`、`.summary-grid`、`.pipeline-stats`、`.job-stats` 的直接 `.ow-metric` 子项统一 92px 下限。否则迁移后 Incident/Jobs/Pipelines 的卡会按内容塌陷，同一行出现 92 与 68 两种高度。
- Governance 的 `grid-cols-1 sm:grid-cols-2 xl:grid-cols-4` 是死代码：`styles.css` 在 Tailwind 之后加载，`.metric-grid` 的 4/2/1 一直覆盖它们。容器改为单一 `.metric-grid`，不留两套互相打架的列规则。
- 删除 `.metric-card` / `.metric-label` / `.metric-value*` CSS；`code-rules.test.ts` 的"每个 class 可达"检查通过，说明没有残留选择器。
- 读取这些 class 的审计 spec 同步改为 `[data-metric]` / `.ow-metric` / `.ow-metric-value`（`admin-polish`、`b1-visual-review`、`b3-b4-audit`、`b4-remaining`、`business-workspace`、`dual-surface`、`studio`、`visual-layout`）。`dual-surface`/`business-workspace` 的"此 surface 不应有指标卡"断言现在匹配真实存在的 `.ow-metric`，不再因 class 消失而空转通过。

### 3.1 与 DS-V1-1 基线的几何对比

`after-ds-v1-1b`（36 张）对比 `after-ds-v1-1`：

- Overview：`header.h` 80、`overflow` -15、`h1` 26/20、`metricValue` 21，全部未变。
- Observability：三个视口 `header.h`、`overflow` 未变。
- Incident：`header.h` 1440 108（zh 111）、1024 98/100、390 229/232，与基线一致；`overflow` -15；表格行 42/195。新增的 `metricValue` 读数来自四个 KPI 卡（26 / 21.5 / 20 随 title clamp），此前是 `.metric-value`，capture 只测 `.ow-metric-value`，所以基线里是 `null`。

## 4. Dialog / Sheet 统一为 `DialogFrame`

新增 `components/app/dialog-frame.tsx`：一个 head / body / foot，三种几何（`center`、`sheet-left`、`sheet-right`）。Radix Dialog 仍是底座，焦点陷阱、Escape、滚动锁和 `aria-modal` 不重写。

- `Ui.Modal`（1 个调用点）→ `DialogFrame size="medium"`。
- `app/sheet.tsx` 的 `SheetContent`（命令面板、Sources 详情/配置）→ `DialogFrame variant="sheet-left|right"`；`Sheet` 仍是 Dialog root，调用方 API 不变。
- `ConfirmAction`（12 个调用点）→ `DialogFrame size="small"`；错误正文改用 `AsyncErrorMessage`，不再打印原始 `error.message`。
- CSS：`.modal` / `.modal-*` / `.modal-backdrop` 全部删除，替换为 `.ow-dialog` / `.ow-dialog--center|small|medium|large|sheet-left|sheet-right` / `.ow-dialog-head|title|description|body|foot`。侧边几何写在 CSS 而不是 utility，因为 `styles.css` 在 Tailwind 之后加载；手写规则会覆盖同特异度的 utility，之前 sheet 没用 `.modal` 才没有这个冲突。
- 命令面板的 `.ow-command-sheet` 覆盖改为作用在 `.ow-dialog-head` / `.ow-dialog-body` 上。

## 5. `check-ui-metrics` route coverage

两个 fail-open：

1. **空 `pages` 通过**：`{"pages":{}}` 循环 0 次，打印 `ok pages=0` 并 exit 0。现在 `page-map-empty` 是 FAIL。
2. **没有 route 清单**：无法区分"测了全部"与"掉了一条路由"。新增 `--manifest`：
   - `docs/design/ui-visual-v3/spec/route-manifest.json` 是审计拥有的 10 条路由；detail 路由按形状匹配（`/admin/nodes/:id`）。
   - 每个 `_metrics_*.json` 单独核对：清单里的路由没测 → `route-missing`；测了清单外的路由 → `route-unknown`（防止拼写错误新增一条、掩盖掉的那条）。
   - 空 manifest 或无法编译的 regex 是 exit 2，不是"没有期望"。
   - staging-preview 的几何门禁改为传 `--manifest`。
- `scripts/check-ui-metrics.test.mjs`（`node --test`，5 条）覆盖：空 pages、缺路由、未知路由、全覆盖通过、仓库 manifest 可解析。已加入 CI 的 web job。

## 6. 验证

| 检查 | 结果 |
|---|---|
| `pnpm --filter @opsweave/platform-web typecheck` | **PASS** |
| `pnpm --filter @opsweave/platform-web test` | **PASS** — 31 files / 426 tests |
| `pnpm --filter @opsweave/platform-web build` | **PASS** — 166.77 kB CSS / 1,315.81 kB JS |
| `node scripts/check-i18n.mjs` | **PASS** — 1,930 keys × 2；17 条既有 unused |
| `node scripts/check-status-vocabulary.mjs` | **PASS** — 41 codes |
| `node scripts/check-ui-tokens.mjs --ratchet ...` | **PASS** — 0/0/0/0/0/0 |
| `node scripts/check-ui-metrics.mjs artifacts/ui/observability/metrics` | **PASS** — 24 measurements |
| `node scripts/check-ui-metrics.mjs --manifest ... artifacts/ui/visual-v3/audit` | **PASS** — 30 measurements / 10 routes |
| `node scripts/check-ui-metrics.mjs` on `{"pages":{}}` | **FAIL（预期）** — `page-map-empty`，exit 1 |
| `node --test scripts/check-ui-metrics.test.mjs` | **PASS** — 5/5 |
| `node tests/ci/check-tracked-png-budget.mjs` | **PASS** — 408 / 65.97 MB（ceiling 408 / 68.24 MB） |
| `overview-matrix.spec.ts` | **PASS** — 12 组合 |
| `overview-partial.spec.ts` | **PASS** — 7/7 |
| `observability-surface.spec.ts`（fixtures） | **PASS** — 11/11 |
| `g11-incident-state-gaps.spec.ts` | **PASS** — 6/6 |
| `g12-lifecycle.spec.ts -g "an operator closes a concluded incident"` | **PASS** — 1/1（ConfirmAction → DialogFrame） |
| `admin-shell.spec.ts -g "command palette opens"` | **PASS** — 1/1（center dialog 之外的 palette） |
| `admin-shell.spec.ts -g "navigation becomes a drawer at 1024"` | **PASS** — 1/1（`ow-command-sheet` → DialogFrame sheet） |
| Governance KPI band 4 / 2 / 1 | **PASS** — 临时 Playwright probe（data-catalog fixtures）；1440=4、1024=2、390=1 |
| 36 张 `after-ds-v1-1b` 矩阵 | **PASS（证据）** — 见 §3.1 |
| 完整 `g12_acceptance_ci.sh` | 见 §6.1 |

### 6.1 全量确定性 harness

`bash tests/ci/g12_acceptance_ci.sh`：**PASS** — 64 tests（62 passed / 2 skipped），6.5 min；acceptance 195/0；exit 0。它包含三标杆矩阵、`g12-lifecycle`（ConfirmAction → DialogFrame）、`g12d-workspace`（IncidentDetail 的四个 MetricCard）以及 `admin-shell` 之外的 sheet 路径。

## 7. 未做（记录，不冒充完成）

- **`.btn`（16 处，仅 Studio）**：Pattern D 兼容期保留。`PipelineEditor` 的工具栏是 Studio 自己的密度，迁移到 shadcn Button 需要先重测 390 的 9 控件换行。
- **CSS 模块化拆分**：`styles.css` 仍约 3,600 行。本批改了 token 名与 dialog/metric 块，拆分按批次另外做；`check-ui-tokens`/`code-rules` 仍只读单一文件，拆分时必须同步改成多文件读取。
- **`AVAILABLE` / `CANCELLED` 语义**：`AVAILABLE` 在插件安装状态显示 "Uninstalled"、`STATUS_MAP` 显示 "Available"；`CANCELLED` 在 investigation 与全局 tone 不一致。这是产品词汇决策，不是机械合并；未改。
- **Observability / IncidentDetail 的完整视觉重排**：本批只做组件收敛；布局重排仍是下一阶段。
- **`sources-audit.spec.ts`**：预存在缺陷，spec 用 `{ w, h }` 作为 Playwright `viewport`（Playwright 要 `{ width, height }`），14 个矩阵用例在改动前就无法启动。本批未修，已在 evidence index 标为预存在 FAIL。
- **全量 staging / Docker 依赖套件**：未运行（本机 Docker 不可用）。

## 8. 回滚

- Token 改名：把 `styles.css`/`tailwind.config.cjs`/两个契约测试/gate 白名单里的 `meta→sm`、`body→base|lg`、`title→xl` 反向替换；值不变，无像素回滚。
- ErrorState：恢复组件与 10 个调用点；`AsyncBoundary` 的 `report`/`source` 是可选 prop，不回滚也不影响旧行为。
- MetricCard：恢复 `.metric-card`/`.metric-label`/`.metric-value` CSS 与 15 处 markup；审计 spec 的选择器同步还原。
- DialogFrame：恢复 `.modal*` CSS 与 `DialogShell`/旧 `SheetContent`；Radix 底座未动，交互语义不受影响。
- route coverage：`--manifest` 是可选参数；删除 manifest 文件即可回到旧行为（但空 pages 的 FAIL 应保留）。
