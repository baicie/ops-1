# 04 · AdminShell V2 视觉系统与 shadcn-admin 迁移规范

## 4.1 产品气质

关键词：**清晰、专业、轻量、安静、可操作**；不是炫技型 Dashboard。参考 `satnaing/shadcn-admin` 的 Sidebar / Header / Command / Settings / Data Table / Responsive 组件组织，但不复制其业务模型、认证或 TanStack Router。

视觉优先级：读懂系统状态 > 快速完成操作 > 一致性 > 装饰。一个页面最多一个主 CTA，不同错误/风险只使用语义色。不追求高密度卡片瀑布、玻璃拟态、极端圆角、巨型渐变、随机阴影。

## 4.2 基础 Token 建议

**保留现有 `--ow-*` CSS variables**，逐条审计与 shadcn 语义 token 的映射，禁止并行两套互相漂移的色值。建议的 CSS 语义别名（草案，真实名称遵循仓库现有变量）：

```css
:root {
  --background: var(--ow-bg);
  --foreground: var(--ow-text);
  --card: var(--ow-surface);
  --muted: var(--ow-surface-2);
  --border: var(--ow-border);
  --primary: var(--ow-accent);
  /* Danger / warning / success 使用仓库现有语义状态 Token */
}
```

上述只是示意，**不能直接复制未核对的 `--ow-bg`/`--ow-text` 名称**；先读取现有 `styles.css` 和 `tailwind.config.cjs`，构建准确映射表。不要重做整个配色以掩盖布局缺陷。

推荐尺寸（可在审计中校准）：

| 项 | 基准 | 说明 |
|---|---|---|
| 空间 | 4 / 8 / 12 / 16 / 24 / 32px | 统一 4px rhythm |
| Body | 14px、行高 20–22px | UI 长文本优先可读性 |
| Secondary | 12–13px | 辅助文本、表格元信息 |
| 页面标题 | 22–26px / 600 | 不做大 Banner |
| 内容宽度 | 表格页 max-content 1440–1600px 或 full-fluid | 结合节点/日志密度定 |
| 控件高度 | 紧凑 32–36px、标准 36–40px | 一套明确规格 |
| 圆角 | 6/8/12px | 状态/按钮/容器有层级 |
| Border | 1px、语义低对比 | 用线而非到处卡片 |
| 阴影 | none/sm/popover | 不堆积多重阴影 |
| 图标 | lucide-react 单一集合 | 同级 16px / 强调 18–20px |

字体：系统字体优先，数字 `font-variant-numeric: tabular-nums`；不要打包付费字体。中文/英文混排要在窄屏与表格中实测。

## 4.3 整体 Shell 布局

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ 左：Logo/当前 Console      顶栏：搜索 ⌘K / 状态 / 主题 / 账号/切换入口 │
├──────────────────┬──────────────────────────────────────────────────────┤
│ 平台概览         │ Breadcrumb / Page Title / Primary Action            │
│ 组件与插件       │ ──────────────────────────────────────────────────── │
│ 节点与实例       │ 主要内容：列表 / 概览 / 详情 / 诊断                   │
│ 发布和版本       │ 可筛选、可深链、状态明显                             │
│ 运行与任务       │                                                      │
│ 安全与审计       │                                                      │
│──────────────────│──────────────────────────────────────────────────────│
│ 环境 STAGING     │ 可选页脚：SHA / 构建 / 版本 / 诊断状态               │
└──────────────────┴──────────────────────────────────────────────────────┘
```

- Desktop >=1280：220–256px 可收起 Sidebar，Header 56–64px，高度不跳动；内容独立滚动。
- 1024：允许收起至图标导航，展开弹出或固定；保持操作条可用。
- 390：Sheet Drawer、固定主操作、不强制横向大表格；详情用 Sheet 或移动布局。
- AdminShell “布局可折叠”与 Business Workspace “时间窗多面板”是不同模板，**不能共享到强耦合**。
- Platform Console 与 Business Workspace 共享色彩、Typography、Input/Button/Popover 等 token/primitive，但不共享领域 Navigation。

## 4.4 必须打磨的通用复合组件

| 组件 | 语义 | 必须覆盖的状态 |
|---|---|---|
| AppSidebar / NavSection | 分组、选中、折叠、移动端 | active / disabled / hidden / loading |
| GlobalCommand | 授权页面/资源导航 + 快捷操作 | loading / empty / keyboard / forbidden |
| PageHeader | 标题、描述、Breadcrumb、单主 CTA | loading / permission / destructive |
| DataTable | 筛选、排序、分页、密度、列操作 | loading / empty / error / forbidden / stale |
| StatusIndicator | `READY` / `DEGRADED` / `UNKNOWN` 等 | 状态色+图标+文字，禁仅用颜色 |
| DetailSheet | 侧向细节、可复制 ID、操作历史 | open/close、focus restore、Esc |
| ConfirmAction | 删除/禁用/回滚/升级 | pending/timeout/error/retry、二次确认 |
| ResourceSummary | Node/Plugin 用量与容量 | unit/采样时间/unknown/snapshot stale |
| AsyncBoundary | 数据请求/恢复/无权 | 各状态独立 UI |
| VersionPill | 环境、部署 SHA、健康 | Server authoritative / mismatch |

这些是 `apps/platform-web/src/components/` 的 **OpsWeave 自有语义组件**；内部使用 shadcn/ui 基础 primitive，不抄另一个组件库。

## 4.5 三个 Admin 样板页详细规格

### A. Platform Overview

只回答“平台能否稳定服务？”及“管理员现在要处理什么？”

- 第一层：可用性与异常，显示 Kernel / Node / Plugin Runtime / Catalog 等实际状态，含 `observedAt`。
- 第二层：需要处理的事项（每项可深链），例如节点断连、插件无 READY、副本不一致、部署失败。
- 第三层：近期变更与操作审计，按时间倒序。
- 未接入的模块只标 `NOT_CONFIGURED/UNKNOWN`，不能用 0 或绿色代替。
- 关键操作：查看异常细节、刷新。禁止堆一墙无动作的 KPI。

### B. Plugins / Components

- 上方摘要：已安装/待升级/异常（统计口径明确）。
- Toolbar：搜索、状态/来源筛选、安装 CTA。
- 表格：名称、Publisher、版本、Digest/Trust、Activation、READY Replicas、最近健康/事件、操作菜单。
- 详情：Overview / Deployments / Revisions / Events / Diagnostics / Assets；敏感配置遮蔽。
- 强危操作（disable/rollback/uninstall）应有权限说明、预检查、二次确认与原有数据保护语义。

### C. Nodes

- 真实观测态：READY / STALE / UNREACHABLE / REVOKED 要明显区分。
- 资源列：CPU/内存使用率/容量/样本时间；缺失快照显示 `NO_DATA`，而不是 0%。
- 筛选状态、操作系统、环境；支持列表/卡片（小屏）。
- 详情：基础属性、Heartbeats/Resources、关联插件实例、最近操作与健康时间线。
- 时间曲线：缺失段断开、单位/采样率/窗口可见。不存在的数据不画假曲线。

## 4.6 设计质量 Gate

- Light/Dark 对比度满足 WCAG 2.2 AA 的适用项目（文本一般 >=4.5:1，大文本 >=3:1）；焦点显著。
- 1440 / 1024 / 390 宽度、每种主题与中英文：真实浏览器截图；至少 Overview、Plugins、Nodes、Login、Switcher、Forbidden。
- 交互：鼠标、键盘 Tab/Enter/Esc、Command Palette、Focus Restore、Touch、Screen Reader label。
- 状态：Loading / Empty / No Data / Unknown / Stale / Partial / Error / Forbidden / Conflict / Demo / Success。
- 不依赖 `toHaveScreenshot` 以外的视觉证据夸大“像素测试通过”；若建立像素基线须提交基线与差异规则，不以截图存在代替断言。
- 与原功能回归：安装、详情、节点列表、登录、插件动态扩展不退化。

## 4.7 上游许可与升级策略

shadcn-admin MIT；参考布局与行为即可。若复制原代码：保留 LICENSE/copyright notice，在第三方说明中列清复制的具体文件和对应版本 SHA；检查 shadcn/ui/Radix/Tailwind 当前 API 兼容，勿批量升级到新主版本。仓库已存在的 shadcn/ui 组件优先复用。
