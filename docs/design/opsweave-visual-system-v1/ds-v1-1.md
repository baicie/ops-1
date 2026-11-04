# DS-V1-1 — Token 值与 PageHeader 收敛

- 日期：2026-11-04
- 状态：**PASS（值迁移 + PageHeader 去重 + 死 StatusBadge 清理）**；其余 DS-V1-1 项见 §5
- 决策：[ADR-017 §D5 / §D7](../../adr/ADR-017-visual-system-v1.md)
- 基线：`origin/main@775a1e2`；实现分支 `design/opsweave-visual-system-v1`

## 1. 类型阶梯（values-first）

| token | before | after | 用途 |
|---|---|---|---|
| `--ow-type-label` | 11px | 11px | 微标签、表头、eyebrow |
| `--ow-type-meta` | 13px | 13px | 表值、次要数据、行内 meta |
| `--ow-type-sm` | 12px | **13px** | 密集文本；122 处调用随值变化 |
| `--ow-type-base` | 14px | **15px** | 正文、控件、表单 |
| `--ow-type-lg` | 16px | **15px** | 面板标题（semibold） |
| `--ow-type-xl` | clamp(20,2.1vw,26) | 同左 | 标题：26 上限、390 的 20 下限（命名例外） |
| `--ow-type-metric` | 21px | **21px（例外）** | KPI 数字；见 §2 |
| `--ow-type-hero` | clamp(30,4vw,44) | 同左 | 仅 `/login`（命名例外） |

- `--ow-type-sm` 与 `--ow-type-meta` 现在同为 13px；t-shirt 名称保留到 DS-V1-1b 改名。
- `--ow-type-lg` 的 16px 并入 body 15；面板标题靠字重而不是字号建立层级。
- `Tailwind.fontSize.xs` 删除：它指向未声明的 `--ow-type-xs`，是潜在的静默继承 bug。
- `styles.token-contract.test.ts` 从断言 14/12 改为断言 11/13/15/26 + 两个 clamp 例外。
- `check-ui-tokens.mjs` 增加 `TYPE_EXEMPT_TOKENS = {xl, metric, hero}`，并在注释里写明每个例外的理由；`ui-debt.json` 的 `type-tier` 从 6 降到 0。

## 2. 为什么 metric 没有变成 26

第一轮截图（`after-ds-v1-1` 的早期捕获）把 `--ow-type-metric` 设为 26px。实测结果：

- Overview 的 KPI 数字从 21 变为 26，与页面标题同大；健康判决 headline 是 15px；
- 四个 KPI 卡从 113px 高变为 121px，`console-grid` 从 y=352 下移到 385，首屏下移 33px；
- 视觉上 KPI 的 `0` 比“Platform attention needed”更抢眼，违反 Pattern A 的“健康判决优先”。

因此保留 metric 21px 作为**命名的显示例外**，标题保持 20→26 的 clamp；`InstallWizard` 的 readiness 数字从 hero 30–44 改为 title clamp（20–26）。title 26 > KPI 21 > body 15 的层级成立。该决定已回写 ADR-017 §D5 与 `token-table.md` 的 V1 note。

## 3. PageHeader 去重

- 旧实现 `components/Ui.tsx:11` 删除；3 个调用点迁移到 `components/app/page-header.tsx`：
  - `pages/workspace.tsx:143,287`（Workspace Home、Surface not yet）；
  - `shells/surface/SurfaceChrome.tsx:293`（Forbidden）。
- 新组件把 description 放进 `.page-header-sub`（`margin-top:0`），旧实现依赖 `.page-description` 的 8px 上边距；这 3 个页面在 ≥769 的 header 仍为 80px 下限，但 description 会上移 8px。
- `data-testid="page-header"` 现在也出现在 workspace/forbidden；`admin-polish`/`g08-batch-c` 的“每 route 一个 header”断言不受影响。
- `check-ui-tokens` 的 `one-header` 从 3 降到 0，`ui-debt.json` 同步降到 0。

## 4. 死 StatusBadge 与 CSS

- `components/Ui.tsx` 的 `StatusBadge` 零调用，删除；同时删除 `styles.css` 的 `.status`/`.status-ok|warn|danger|info|neutral|unknown` 规则（只有该组件渲染它们）。
- `code-rules.test.ts` 的“每个 class selector 都可从源码到达”先抓住了这 6 个 `.status-*` 孤儿；删除 CSS 后通过。这不是“为了绿删测试”，而是把死代码一起删掉。
- `status-tone.ts` 的注释从 `StatusBadge` 改为“status renderer”；canonical renderer 仍是 `Status`/`StatusPill`/`StatusIndicator`。

## 5. 未做（DS-V1-1b / 后续）

> **2026-11-04 更新：** 本节的前四项（token 改名、`ErrorState`、`MetricCard`、Dialog/Sheet）已在
> [ds-v1-1b](ds-v1-1b.md) 完成；`.btn`、CSS 拆分与 `AVAILABLE`/`CANCELLED` 仍按原计划保留。


- token **改名**（label/meta/body/title）——需要触碰 307 处 `font-size` 声明；本轮只改值。
- `Ui.ErrorState` 10 处调用打印原始 `error.message`，迁移到 `AsyncBoundary`；需要处理“保留旧数据”的页面包装。
- 15 处手写 `.panel.metric-card` 迁移到 `MetricCard`；需要保留审计选择器或同步更新。
- Dialog/Sheet 统一包装（`.modal*` vs DialogHeader 几何不可互换）。
- `.btn` 只在 Studio 16 处使用；Pattern D 兼容期保留。
- 3,650 行 CSS 的模块化拆分（Token/Theme/Primitive 层）——按批次，不在本轮。
- `AVAILABLE`/`CANCELLED` 的状态语义分歧是产品决策，不是机械合并。

## 6. 验证

- `pnpm --filter @opsweave/platform-web typecheck` PASS
- `pnpm --filter @opsweave/platform-web test` **426 PASS**
- `pnpm --filter @opsweave/platform-web build` PASS
- `node scripts/check-ui-tokens.mjs --ratchet ...` **0/0/0/0/0/0 PASS**（type-tier 与 one-header 均 0）
- `node scripts/check-ui-metrics.mjs artifacts/ui/observability/metrics` **24 measurements PASS**（type 变化后行高仍 ≤42）
- 36 张 `after-ds-v1-1` 矩阵：1440/1024/390 × light/dark × en/zh-CN；Overview header 80，无横向溢出；Observability 390 header 146/150，Incident 390 行高 195（均为类型增长的预期值）
- 完整 `g12_acceptance_ci.sh`：**PASS** — 64 tests（62 passed / 2 skipped），8.0 min；acceptance 195/0；exit 0（类型/PageHeader 变更后）
- 未执行：全量 staging、Docker 依赖套件、`admin-shell`/`install-wizard` 的独立截图、视觉 diff

## 7. 回滚

- 类型：回滚 `styles.css` 的 token 块 + `tailwind.config.cjs` + `styles.token-contract.test.ts` + `check-ui-tokens.mjs` 的例外表 + `ui-debt.json`；无数据/API 影响。
- PageHeader：恢复 `Ui.PageHeader` 与两个导入即可；workspace/forbidden 的 8px 位移随旧组件回来。
- StatusBadge/CSS：恢复组件与 6 条 `.status-*` 规则；无运行时状态机影响。
