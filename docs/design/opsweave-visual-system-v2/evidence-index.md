# DS-V1-2 evidence index

- 日期：2026-11-05
- 环境：macOS 15.7.7 / Apple M1；Node 22.12.0；pnpm 10.34.3；Playwright 1.64.1（Chromium）；本地 Kernel `127.0.0.1:18291` + PostgreSQL 17（`opsweave_visual_v1`，86 incidents）
- 基线：`design/opsweave-visual-system-v1@e8d1cbf`
- 数据：Observability 用 `tests/ui/support/workbench-fixtures.ts` 的 14 节点 fixture（明确标注）；Incident 用真实 seed incident。没有把 fixture 说成 live。

## 1. 浏览器矩阵

```bash
WORKBENCH_MODE=after OPSWEAVE_URL=http://127.0.0.1:18291 \
  pnpm --dir tests/ui exec playwright test workbench-matrix.spec.ts
```

- 4 视口（1440/1024/768/390）× 2 主题 × 2 语言 × 3 页面 = 48 张，另 768/390 的 incident detail tab 各一张。
- 产物（未跟踪，`artifacts/ui/visual-v2/after/`）：`observability__*`、`observability-entity__*`、`incident__*`、`incident-detail-tab__*`，以及每组合 `_metrics_<label>.json`。
- 对照：`artifacts/ui/visual-v2/before/`（同一 fixture/seed、同一浏览器、旧代码）。
- 断言：页面非 loading、无 pageerror、无横向溢出；指标 JSON 记录 regions、KPI 列数/身份、tab 模型、header 高度。

## 2. 可访问性

```bash
OPSWEAVE_URL=http://127.0.0.1:18291 \
  pnpm --dir tests/ui exec playwright test workbench-a11y.spec.ts
```

- 3 个测试覆盖 4 个宽度：1440 light en、390 dark zh-CN、1024 light en、768 light en。
- axe（`@axe-core/playwright`）规则集：wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa；只把 serious/critical 作为失败。
- 真实修复：
  - warning ink 4.29:1 → `--ow-warning-ink: #8a5200`（5.86:1）；success badge ink 3.9:1 → `--ow-ok-ink`；选中 rail facts 4.47 → secondary。
  - account 按钮手机无 accessible name → `sr-only` 账号菜单标签（不触发 label-content-name-mismatch）。
  - history 窗口从无 TabsContent 的 Tabs 改为 `aria-pressed` group，消除 `aria-controls` 指向不存在节点。
- 键盘：Tab 越过 skip link 后检查真实 `:focus-visible` ring；最小目标 24px（含 `.ow-window-switch`）。
- 结果：4/4 PASS。

## 3. Workbench regression gate

```bash
node scripts/check-workbench-metrics.mjs artifacts/ui/visual-v2/after \
  docs/design/opsweave-visual-system-v2/workbench-baseline.json
```

- 4 curated labels × 4 pages：r1440-light-en、r1024-dark-zh-CN、r768-light-zh-CN、r390-dark-en；页面 observability、entity、incident、incident detail-tab（compact）。
- 比较：region 顺序、KPI 身份与列数、tab 模型、visible pane、overflow（+1 容差）、header 高度（观测页 ±24，事故页跳过，seed 标题可变）。
- 故障注入：反转 incident region 顺序 → **FAIL**（已执行）；`--update` 拒绝缺 required page 的 artifact，避免基线被静默收窄。
- 结果：PASS；PNG 预算不增（基线是 JSON）。

## 4. 既有门禁

| 检查 | 结果 |
|---|---|
| `pnpm --filter @opsweave/platform-web typecheck` | PASS |
| `pnpm --filter @opsweave/platform-web test` | **436 tests / 31 files PASS** |
| `pnpm --filter @opsweave/platform-web build` | PASS |
| `node scripts/check-i18n.mjs` | 1,961 keys × 2；17 条既有 unused |
| `node scripts/check-status-vocabulary.mjs` | 43 protocol codes |
| `node scripts/check-ui-tokens.mjs --ratchet …` | 0/0/0/0/0/0 |
| `node scripts/check-ui-metrics.mjs artifacts/ui/observability/metrics` | 24 measurements PASS |
| `node scripts/check-ui-metrics.mjs --matrix …` | 24/24 combinations PASS |
| `observability-surface.spec.ts` | 11/11 |
| `g11-incident-state-gaps + g12-lifecycle` | 13/13 |
| `metric-card-matrix.spec.ts` | 2/2；incident 12/12 |
| `check-spec-coverage` | 37 covered / 22 explicit-skip / 0 unreferenced（workbench specs COVERED ← g12-acceptance） |
| `check-tracked-png-budget` | PASS；408 files / 65.97 MB（预算未提高） |
| 完整 `g12_acceptance_ci.sh` | **PASS** — 102 tests（100 passed / 2 skipped），11.2 min；acceptance 195/0；workbench gate PASS；exit 0 |

## 5. 未运行

- 全量 staging / Docker 依赖套件：本机 Docker 不可用，**NOT_RUN**。
- 虚拟键盘遮挡：**NOT_RUN**（只断言 footer/controls 在视口内）。
- 像素级 visual diff：**NOT_RUN**，用 JSON 结构基线替代，原因见 report §5。
