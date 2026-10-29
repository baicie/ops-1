# 设计令牌与组件审计（G00）

## 1. 令牌现状

- `styles.css` 中 `--ow-*` 引用 **455 处**；语义色已通过 `tailwind.config.cjs` 暴露（background/foreground/card/primary/secondary/muted/accent/destructive/success/warning/info/border/border-strong/input/ring/surface*），并额外补了 `foreground-secondary`。
- 明暗主题：`html[data-theme="dark"]` 重声明同一批变量，因此 Tailwind 的 `dark:` 变体基本不需要。
- 字号/圆角/阴影已映射：`--ow-type-*`、`--ow-radius-*`、`--ow-shadow`。

**结论**：令牌层已统一，G01 的工作是**补齐 AdminShell 需要的规格**（密度、行高、控件尺寸、focus ring、分隔线、侧栏宽度），不是再建第二套。

## 2. 组件现状（12 原语）

`badge, button, card, dialog, dropdown-menu, input, label, select, separator, table, tabs, tooltip`

**G01/G02 缺口**：
| 需要 | 现状 | 方案 |
|---|---|---|
| Sidebar（可折叠、分组、移动抽屉） | 手写 `.sidebar` CSS | 新增 `ui/sidebar.tsx` 复合件，令牌驱动 |
| Command Palette | 无 | 新增 `ui/command.tsx`（cmdk 或自建，需评估依赖增量） |
| Breadcrumb | 手写 | `ui/breadcrumb.tsx` |
| Avatar / 用户菜单 | 手写 `.user-menu` | `ui/avatar.tsx` + 复用 dropdown-menu |
| Sheet（移动端抽屉） | 无 | `ui/sheet.tsx` |
| Skeleton / Empty / Error 统一 | `Ui.tsx` 里已有但非原语 | 保持现实现，仅统一视觉规范 |
| Table 密度/选择/排序 | `table.tsx` 基础版 | G03 按样板页需求增补，不提前做通用表格框架 |

## 3. 交互状态矩阵（来源于 docs/09，G03/G09 验收）

每个页面必须能分别呈现：Loading、Empty、Error、Forbidden、Partial、Unknown、Stale。
现状核查：
- Loading/Empty/Error：`Ui.tsx` 的 `Skeleton`/`EmptyState`/`ErrorState` 已具备，页面普遍使用；
- **Forbidden**：**缺失**——非管理员访问当前无 403 页面，G05 补；
- Partial/Unknown/Stale：数据层有语义（`UNKNOWN`/`UNREACHABLE`/stale 心跳），UI 已用虚线/告警文案表达，G03 需逐页确认。

## 4. 无障碍基线

已有：`role=dialog` + `aria-modal`、Esc 关闭、焦点还原、`data-testid="language-switcher"`、`dialog-a11y.spec.ts` 常驻用例。
缺：Command Palette 键盘导航、Sidebar 折叠按钮 aria、跳过导航链接（现为 "Skip to content"，需在双 Shell 下各自保留）。
