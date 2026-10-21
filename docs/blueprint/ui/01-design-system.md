# UI Design System / Token / 组件规范

## 设计目标
强调**专业工具的清晰、克制、密度可控**，而不是通过更多卡片、渐变、无意义图形追求所谓“炫酷”。以中性背景、单主强调色、稳健字体比例和高质量表格/日志界面建立视觉统一性。允许主题替换，不允许插件任意 CSS 污染宿主。

## Token（0.0.1 候选值，实施后经六环境截图审查冻结）
| Token | 候选 | 作用 |
|---|---|---|
| `--ow-space-*` | 4/8/12/16/24/32 px | 统一空间系统，禁止零散 magic number |
| `--ow-radius-sm/md/lg` | 4/8/12 px | 控件、卡片、对话框 |
| `--ow-type-xs/sm/base/lg/xl` | 12/13/14/18/24 px | 元数据、控件、正文、节标题、页面标题 |
| `--ow-control-sm/md/lg` | 28/36/44 px | 表格内操作、默认控件、触屏/主交互 |
| `--ow-border` | 1px semantic border | 表格/分区，不靠多层阴影堆视觉 |
| `--ow-motion-fast/normal` | 100/180ms | Hover、Panel；遵守 reduce-motion |
| `--ow-max-readable-width` | 1480px | 大部分业务页面 |

配色：浅色背景近白/柔灰，深色近黑/深灰；中性文字达到 WCAG AA 正文对比，主色只用于当前焦点/主要操作，Danger 只用于真正破坏性操作，Warning 只用于风险和异常。业务状态要带 icon+text，不只靠颜色。

### 组件矩阵
- `PageHeader`：标题、简短任务描述、1 个主要操作、右侧上下文操作。
- `StatusBadge`：Ready/Degraded/Unreachable/Unknown/Failed/Draining 必须对应不同文案，未知不可绿。
- `DataTable`：列宽策略、密度切换、排序/过滤、虚拟化阈值、横向溢出控制、可复制 ID。
- `DetailPanel`：概览、Events、Instances、Permissions、Logs、Versions，选项卡优先，避免一个页面无限向下堆叠。
- `StepWizard`：每步可验证/恢复草稿/返回时不丢状态/明确危险动作。
- `DiffViewer`：插件权限、接口版本、资源需求、Schema 前后差异。
- `LogViewer`：等宽字体、行号/UTC 时间、级别、换行、暂停、跟随、Gap/断线提示。
- `ConfirmDialog`：必须解释影响范围、不可逆项和具体执行对象；危险操作具备双重确认。
- `ErrorState/EmptyState/Skeleton`：可操作指导，不用虚假的示例数据冒充真实运行。

## 页面密度
普通页：大标题、8–16px 控件间距、24px 主要段落间距；Node/Plugin 表格可用 compact 密度；Dashboard KPI 不超过直接用户决策所需数量（通常 4–6），禁止 20 个指标卡。复杂图表应提供表格后备视图和明细抽屉。

## 插件 UI 约束
- 插件接入宿主 Design Tokens 和宿主核心组件，不得全局重置 `body`、`html`、`button` CSS；CSS 模块化/前缀作用域，portal 层级通过 Host API。
- 遵守 Shared React/SDK 兼容规则；高层 `PageHeader`/Alerts/Dialogs 等由 Shell 统一规范。
- 插件状态、权限、失败使用宿主组件；不能自建不一致的登录框、全局通知或导航。
- 提交 UI 时记录 token 新增/变更的理由，不能以一次性 inline style 绕开 Design System。

## Accessibility
- 实际键盘可操作：focus visible、Escape/Tab 顺序、dialog trap、表格可浏览、语义标签；不靠 hover 才能发现关键动作。
- 不以颜色作为唯一状态区分；缩放 200% 至少不遮挡关键内容；尊重 `prefers-reduced-motion`。
- Web Log Streaming 区域的 live announcement 有节流，避免屏幕阅读器被大量事件淹没。
