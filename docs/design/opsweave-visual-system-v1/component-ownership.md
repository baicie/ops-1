# Component Ownership Map — Visual System V1

- 审计基线：`775a1e2`
- 范围：`apps/platform-web/src`
- 方法：静态阅读 + `rg` 调用点统计；未运行浏览器的地方明确标注
- 决策依据：[ADR-017 §D7](../../adr/ADR-017-visual-system-v1.md)

本表是 V1 的唯一组件所有权图。任何新组件必须先回答"它是否与表中的权威重复"；重复即拒绝，除非本表更新并给出迁移/回滚。

## 1. PageHeader

| 项 | 值 |
|---|---|
| 权威 | `components/app/page-header.tsx:12-60` |
| 旧实现 | `components/Ui.tsx:11-32`（无 `primary`/`meta`/`actionsLabel`/`className`/`data-testid`，不包 `.page-header-sub`） |
| 调用 | 权威 39 处；旧 3 处：`pages/workspace.tsx:143,287`、`shells/surface/SurfaceChrome.tsx:293` |
| 视觉差异 | 旧实现 description 直接挂在 `.page-header-copy` 下，迁移后 `.page-header-sub .page-description` 的 `margin-top:0` 会让说明上移 8px；≥769 两者共享 80px 下限 |
| 必须保留 | 每 route 恰好一个 `.page-header`/`h1`（`admin-polish.spec.ts:119`、`g08-batch-c.spec.ts:210` 断言 count=1）；`data-testid=page-header` 的消费者（`admin-polish.spec.ts:113`、`g08-batch-c.spec.ts:208/281`、`gateb-v3-draft.mjs:41`）；80px 下限 |
| 迁移 | DS-V1-1：机械替换 3 个旧调用点 → 删除 `Ui.PageHeader` → 截图对比 3 个 workspace/forbidden 路由（8px 位移） |

## 2. Button

| 项 | 值 |
|---|---|
| 权威 | `components/ui/button.tsx:7-55`（`Button` + `buttonVariants`） |
| 旧实现 | `.btn/.btn-primary/.btn-secondary/.btn-small`（`styles.css:229-246`）、`.btn.active`（`:1002`） |
| 调用 | 30 个文件导入；117 个 `<Button>`、23 个 `buttonVariants` link；`.btn` 16 处全部在 `studio/PipelineEditor.tsx:310-348,420` |
| 差异 | `.btn` min-height 40 / padding 4×12 / gap 8 / `translateY(1px)` active；`Button` 固定 h-40 / gap 7 / `transition-colors`。`.btn` 最接近 `variant=outline`；`.btn-secondary` 是 `--ow-surface`，`variant=secondary` 是 `--ow-surface-2`；`.btn-small` 是 32px + 8px 内边距，`size=sm` 是 32px + 12px |
| 决定 | Pattern D 兼容期**不迁移** Studio 的 `.btn`；其他页面新增一律用 `Button`/`buttonVariants`。若未来迁移，保留 `.btn` DOM 类或同步更新 `v5-acceptance.spec.ts:137,391`、`b1-visual-review.spec.ts:156` |
| 风险 | 中；迁移会改变 Studio 工具栏外观与 `.btn.active` 视图切换 |

## 3. Table

| 项 | 值 |
|---|---|
| 原语 | `components/ui/table.tsx:8-76`（唯一 raw `<table>`） |
| 组合层 | `pages/table-kit.tsx:30-388`（`StackCell`/`IdentityCell`/`RowActions`/`LongId`/`rankCardFacts`/`cardCellClass`），17 个列表页使用 |
| 旧样式 | `.plugins-table`/`.nodes-table`（`styles.css:1969-1976,2076-2113,2475-2524`）、`.ow-table` 覆盖（`:2719-2893`） |
| 差异 | `ui/table` 是原语；`table-kit` 不是第二原语。旧 CSS 在 ≤768 对 `tbody td` 设 `display:flex`，优先级高于 Tailwind，因此 `cardCellClass` 返回 `ow-card-extra` 而不是 `hidden` |
| 决定 | 保留 `ui/table` + `table-kit`。`table-kit` 暂时留在 `pages/`，在 ADR 里记录为 pages-layer 组合例外；不搬到 `components/app/`（会触碰 17 个导入） |
| 风险 | 中；`plugins-table/nodes-table` 在 390/768/769 重测前不得删 |

## 4. Status / Health / Trust

| 项 | 值 |
|---|---|
| wire code 表 | `components/status-tone.ts:43-105`（`STATUS_MAP` → tone/state/labelKey/glyph） |
| 渲染器 | `components/app/status.tsx:30-88`（`Status`/`StatusPill`）、`components/app/status-indicator.tsx:20-166`（`StatusIndicator` + 组件态） |
| 旧/重复 | `components/Ui.tsx:37` `StatusBadge`（零调用，可删）；`lib/installation-state.ts:55-145` 四张并行表；`investigations.ts:291-328` 私有 tone；`pages/Access.tsx:41`、`InstallWizard.tsx:27`、`Diagnostics.tsx:44`、`Pipelines.tsx:28-45`、`business-states.tsx:35-55`、`Overview.tsx:27-34` 各自的小映射 |
| 语义分歧 | `AVAILABLE` 在 `InstallationStatus` 显示 "Uninstalled"，`STATUS_MAP` 显示 "Available"；`CANCELLED` 在 investigation 是 warning，`STATUS_MAP` 是 neutral。这两项是产品决策，不能机械合并 |
| 必须保留 | `data-status`（`studio.spec.ts:126`、`g12-lifecycle.spec.ts:172`）、`.status`/`.status-indicator` 文本与 `data-indicator`（`v5-acceptance.spec.ts:88/94/136/465`、`b1-visual-review.spec.ts:102`）；未知码本地化 "Unknown" 且保留原码在 title/data-status；`NO_DATA`/`UNKNOWN` 不折叠 |
| 决定 | `status-tone.ts` 是唯一 wire code 表；`Status`/`StatusIndicator` 是两个 canonical renderer；`Ui.StatusBadge` 删除；域表必须扩展 `STATUS_MAP` 或记录为例外。新增 `info` 组件态只用于 severity/info 文案，不进入 wire code 表 |

## 5. AsyncBoundary / NoticeBar

| 项 | 值 |
|---|---|
| 权威 | `components/app/async-boundary.tsx:67-189`（loading/403/409/error/empty/ready、`reportBodyState`、`useObservedPolling`、`isStale`、`NoticeBar`） |
| 旧/绕过 | **已删除**：`Ui.ErrorState`（10 处）；DS-V1-1b 后无页面直接渲染原始 `error.message`。`shells/workspace/business-states.tsx` 仍持有旧的 workspace 空/错状态，待独立评估 |
| 契约 | `data-async-state`、403 不泄露资源细节、409 conflict、`apiFailureCopy` + `server-message` + `data-source=kernel|plugin`、`reportBodyState`、STALE/PARTIAL/NOT_CONFIGURED 走 `NoticeBar` |
| 决定 | **已执行（DS-V1-1b）**：`ErrorState` 删除，10 个调用点改用 `AsyncBoundary`；`report={false}` 用于页内 section 错误（InstallWizard 上传），`source="plugin"` 用于扩展加载/渲染失败；错误正文由 `AsyncErrorMessage` 统一，`ConfirmAction` 复用。不得把 STALE/PARTIAL 折进 boundary 的 error |

## 6. Dialog / Sheet

| 项 | 值 |
|---|---|
| 原语 | `components/ui/dialog.tsx:5-101`（Radix） |
| 包装 | `components/app/dialog-frame.tsx`（**唯一**：head/title/description/body/foot，`center`/`sheet-left`/`sheet-right` 三种几何）；`Ui.Modal`、`app/sheet.tsx`、`app/confirm-action.tsx` 都是它的薄包装 |
| 调用 | Modal 1（`Incidents.tsx:735`）；Sheet 3（`command.tsx:153`、`Sources.tsx:706/805`）；ConfirmAction 12；命令面板中心态仍直接使用 `DialogContent`（palette 的 sr-only 标题与固定 20vh 定位是独立形状） |
| 必须保留 | `aria-modal=true`、confirm testid/`data-confirm-state`、`ow-dialog--small|medium|large` 尺寸映射、`.ow-dialog-body` 唯一滚动容器 |
| 决定 | **已执行（DS-V1-1b）**：`.modal*` 与裸 `DialogHeader` 两套几何合并为 `.ow-dialog*`；侧边几何写在 CSS（`styles.css` 晚于 Tailwind 加载），不再依赖 utility 覆盖顺序 |

## 7. MetricCard

| 项 | 值 |
|---|---|
| 权威 | `components/app/metric-card.tsx:17-84`（`.ow-metric`，state ready/noData/unknown、denominator、sampledAt、href、data-metric） |
| 旧/手写 | 15 处 `.panel.metric-card`：Governance 4、IncidentDetail 4、Jobs 3、Pipelines 4 |
| 差异 | **已消失（DS-V1-1b）**：15 处旧卡全部迁移；`.metric-card` / `.metric-label` / `.metric-value*` CSS 删除；审计选择器改为 `[data-metric]` / `.ow-metric` |
| 决定 | **已执行（DS-V1-1b）**：`MetricCard` 是唯一 KPI 卡；新增 `size="small"` 取代 `.metric-value.small`；未加载的计数是 `NO_DATA`/`UNKNOWN`（IncidentDetail 的 em dash 与 Pipelines 的 "No runs" 都已改）；`showSampled={false}` 用于没有真实 observedAt 的旧页面，不伪造时间 |

## 8. 页面层例外

- `pages/table-kit.tsx` 是 pages-layer 的组合层，不是 `components/app/` 的 DataTable；在 ADR 中记录例外，不为了目录美观迁移。
- `components/domain/` 尚未创建；在至少两处复用与状态权威证明之前不得创建。
- `studio/` 的 `.btn`、`.studio-page .page-header` 是 Pattern D 的声明例外，V1 只做兼容 smoke。
