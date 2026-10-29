# G01 / P0 — Design System 与 shadcn-admin 视觉规范落地

请基于 G00 的代码审计执行。读取 `docs/04-design-system-and-shadcn-admin.md`、`docs/05-frontend-architecture.md`、`checklists/visual-review-rubric.md`，核实当前 `--ow-*` CSS Token 的**真实名称**，不要把设计包示例变量直接贴进 CSS。

## 实施步骤

1. 对比现有 Admin 页面与 shadcn-admin 的 layout/typography/density/toolbar/command/side navigation 设计方式，做明确视觉基线和差异表；不 fork 模板。
2. 维护一份 Token Mapping：background/foreground/card/muted/border/primary/ring/success/warning/destructive、spacing/radius/type scale/shadow。
3. 在现有 Tailwind/shadcn 基础上规范 Theme 与 CSS 层级；保留现有深浅色和中文默认显示；不引第二套 Token，不引 MUI/AntD/Clerk/TanStack Router。
4. 检查现有 Button/Card/Badge/Dialog/Table/Input/Tooltip/Select 等 primitive 的 focus、disabled、loading、命令可访问性；只补确实缺失的。
5. 增量实现 OpsWeave 语义组件雏形：`PageHeader`, `StatusIndicator`, `AsyncBoundary`, `DetailSheet`，先服务真实样板页，不做庞大 UI 工具箱。
6. 提供 1440/1024/390 × Light/Dark × zh-CN/en 的至少一个真实对照场景，比较旧版与新版 CSS 影响；注重焦点、对比度与布局稳定。
7. 运行 Typecheck/Build/i18n/相关 UI Tests；CI 若失败定位本轮与前序原因，记录最终 SHA。

## 强制约束

- 不重新造现有组件；不把 shadcn-admin 整库代码搬进 OpsWeave。
- 若复制 MIT 上游特定文件必须保留许可与来源；优先自写薄复合组件。
- 不因为“好看”给所有区域套 Card；列表/日志/表格必须保留专业信息密度。
- 不触碰 Backend RBAC 或签名 Manifest（留到 G05/G06）。

## Gate

真实页面光暗两主题样式一致、token 单一、操作可用；截图有完整 SHA 与基线对照、手工视觉 Review、有测试。完成后继续 G02。
