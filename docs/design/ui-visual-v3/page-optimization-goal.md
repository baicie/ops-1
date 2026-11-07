# 全站页面优化目标（Visual V3 → S2/S3）

- 日期：2026-11-07
- 基线：`main` `2d6e7fc`（#34/#35 Visual System 已合入）
- 依据：[visual-audit.md](visual-audit.md) 20 页评分与 `spec/` 门禁

## 目标

所有路由在 390 / 1024 / 1440，Light/Dark，en/zh-CN 下满足：

1. `scrollWidth <= viewport + 1`，无页面级横向溢出；表格内部滚动只允许在 `.table-panel`。
2. 每页一个 h1，标题是**页面名**；pipeline/incident 等实体名在副标题，不丢“我在哪”。
3. 状态与 tone 走 `status-tone` 闭集；已知状态不得渲染为 UNKNOWN 虚线胶囊。
4. 表格遵循 `table-spec`：40px 行、390 卡片降级、IdentityCell、LongId 截断+复制。
5. 指标条 ≤3 张卡；不叠 `panel + metric-card`；数字字号不随视口 `clamp()` 变。
6. 长 id、digest、JSON 不撑破布局；JSON 在有界容器内滚动。
7. 视觉审计每页均分 ≥3.5；单页不得 <3.0。
8. 1440/1024/390 截图与 `check-ui-metrics` 进入 CI；中文/英文布局差 ≤1px 宽度。

## 执行顺序（按审计均分从低到高）

| 顺序 | 页面 | 审计均分 | 主要问题 |
|---|---|---|---|
| 1 | `/admin/jobs/:id` | 2.4 | 整页 390 溢出、标题不是页面名、Attempts 列宽 |
| 2 | `/admin/pipelines/:id/editor` | 2.3 | 排版/响应式最低 |
| 3 | `/admin/activity` | 2.5 | 信息层级、390 |
| 4 | `/admin/pipelines/:id` | 2.6 | 流程条内部溢出 |
| 5 | `/admin/settings/diagnostics` | 2.6 | 信息层级 |
| 6 | `/admin/governance` | 2.8 | 对齐、数据可读性 |
| 7 | `/admin/nodes/:id`、`/admin/instances/:id/logs` | 2.9 | 响应式 |
| 8 | 其余 ≥3.0 页面 | — | 统一 token、状态、表格 |

## 完成情况（2026-11-07，分支 `fix/ui-page-ia`）

| 顺序 | 页面 | 本轮结果 |
|---|---|---|
| 1 | `/admin/jobs/:id` | h1 为“任务详情”，pipeline 名/状态/revision/短 id 进副标题；3 张指标卡；长 id/digest/JSON 有界；Attempts 表格收进 `.table-panel`。 |
| 2 | `/admin/pipelines/:id/editor` | h1 为“Pipeline Studio”，定义名进身份行；修正 1024 下 inspector 被旧规则推到独立行、右侧留 280px 空列的问题，画布与 inspector 回到两列。 |
| 3 | `/admin/activity` | 390 卡片接入 `.ow-card-2l` 两行布局（身份行 + 结果/时间），行高从约 161px 降到约 85px；分页与连续事件折叠此前已存在。 |
| 4 | `/admin/pipelines/:id` | 指标条 4→3（删除与 revision 历史重复的 Updated）；最新 digest 与历史 digest 改 `LongId`（截断 + 复制，不再四行折行）；Recent jobs 改用 `IdentityCell`（pipeline 名 · 4 位 id），revision 降为身份行 qualifier，390 两行卡片。 |
| 5 | `/admin/settings/diagnostics` | 修复 V4 台账样式误伤旧事件列表：`event-list` 的 V4 规则收进 `.event-ledger`，Recent audit 恢复 24px 图标 + 标题/主体 + 右侧时间的紧凑行（原为 100px 竖排块）。 |
| 6 | `/admin/governance` | 3 张表格 40–42px 行高、≤2 facts、无 390 溢出；390 卡片接入两行布局（102→56px）。4 张指标卡保留（见下）。 |
| 7 | `/admin/nodes/:id`、`/admin/instances/:id/logs` | Node events 与 Diagnostics 同因修复（共享 `.event-list`）；实例日志在 390/768/1024/1440 无溢出，头部 meta 正常换行。 |
| 8 | 其余页面 | 补齐详情页 h1：`/admin/plugins/:id`、`/admin/pipelines/:id/run`、`/app/incidents/:id`、`/app/observability/nodes/:id` 均以页面名为 h1，实体名进身份行；删除随之失效的 `title-with-status` CSS 与两条 i18n 键。 |

### 第二轮逐页修正（同日）

- `/admin/pipelines` 列表：身份列改为 `IdentityCell`（名称 + 4 位 id，全文在 title/复制菜单），revision 由列改为身份行 qualifier；390 两行卡片。游标分页三按钮在 390 会把 “First page” 挤出左边界（`left=-16` 但 `scrollWidth` 仍是 375），改为换行后全部可见。
- 面包屑叶子：`/plugins/install`、`/plugins/:id`、`/nodes/:id` 不再显示原始路径段/长 id，改用 `install.title`、`page.pluginDetail`、`nodeDetail.title`。
- `/admin/access`：发布者与用户卡片接入两行布局；指纹在 390 可省略号收缩并保留复制；长指纹不再与标签挤在一起。
- `/admin/ops-center`：390 下节点名曾被 “Unreachable” 胶囊挤成 `e..`，节点/插件行改为身份独占一行、状态/内存/时间共享第二行。
- `/app/incidents`：related entity 是定位符不是身份，改用 `shortLocator()` 中段省略并保留 title，不再撑破 390 卡片。
- `/admin/settings`：runtime policies 为空时不再显示一个复制空对象的按钮。
- `/app/sources`：0 个连接器时不再显示 `0 / 0`（分母为零不是比例）。
- 390 卡片密度：Activity 125→85px、Governance 102→56px、Diagnostics 节点表 107→62px、Observability 实体 107→58px。

第 5 条“指标条 ≤3 张卡”按与 `page-template.md` §2.3（KPI band 4/2/1 列）冲突处理：重复事实的卡已删（Job Detail、Pipeline Detail），但 IncidentDetail 的 Evidence/Kernel verified 有独立 UNKNOWN 状态机（`incident-evidence-kpi.spec.ts` 逐个 pin 住），Governance/Sources/Observability 的四张卡各自来自不同观测源，合并会把已知数与 UNKNOWN 混成一张卡。这四页保留四卡，理由记录在此，不冒充已按 ≤3 执行。

### 验证

```
pnpm --filter @opsweave/platform-web typecheck     # pass
pnpm --filter @opsweave/platform-web test          # 32 files / 457 tests pass
pnpm --filter @opsweave/platform-web build         # pass
node scripts/check-i18n.mjs                        # OK, 2018 keys, 17 unused
node scripts/check-status-vocabulary.mjs           # clean (43 codes)
node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json  # PASS
```

浏览器矩阵用本地 Vite dev + Playwright 路由桩测量（26 条路由 × 390/768/1024/1440 light-en，另加 390 dark-en 与 390/1024/1440 light-zh-CN）：

- 所有组合 `scrollWidth - clientWidth = -15`（滚动条槽），无页面级横向溢出；
- 每页恰好一个 h1，且为页面名；
- en 与 zh-CN 的 `scrollWidth` 差为 0px；
- 桌面表格行高 40–42px；390 卡片 56–142px（Activity 85、Governance 56、Diagnostics 62、Observability 实体 58、Pipelines 80、Nodes 121、Plugins 110），事故证据富文本行 257px 为多字段证据卡，不按普通列表卡压缩。

未做的事：第 7 条“视觉审计均分 ≥3.5”需要人工逐页判读，本轮不冒充已达成；证据截图未入库（仓库 PNG 预算为零余量），正式矩阵仍由 `staging-preview` 的 `ui-table-audit.spec.ts` + `check-ui-metrics.mjs --manifest` 守门。
