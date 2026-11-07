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

## 已开始

S2 `/admin/jobs/:id`：h1 改为“任务详情”，pipeline 名进副标题；长 id/digest/JSON 在页面内可换行或滚动；Attempts 表格收进 `.table-panel`。后续 PR 按上表继续。
