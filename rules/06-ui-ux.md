# U-06 UI/UX 强制规则

- MUST：先有任务流、页面 IA、状态矩阵、线框，再写 React 页面；不要以“更高级/好看”为唯一设计输入。
- MUST：共享 Design Tokens/组件/导航，插件不覆盖全局 CSS、认证、权限提示；一个页面至多一个主要 CTA。
- MUST：Loading/Empty/Error/Unknown/Partial/Stale/Forbidden/Conflict 语义完整，真实数据不得 Mock 冒充。
- MUST：1440/1024/390 × Light/Dark 截图人工审阅，键盘可用、focus visible、主要状态不只靠颜色。
- MUST：Node/Plugin/Log 有原始 observedAt 和查询失败状态，未知不显示绿，日志 event gap 不显示已追完。
- SHOULD：表格、日志、画布使用专属高密度组件而非 Card 堆砌，重要操作可从 1–2 个明显位置找到。
- Gate：通过 `checklists/UI_GATE.md`，视觉修复前后有真实截图与运行日志。

## 前端技术栈（MUST）

- 新建页面/组件：**Vite + React + TypeScript + Tailwind CSS + shadcn/ui**。参考开源 `shadcn-admin` 模板的分层与页面骨架，但组件按 shadcn copy-in 模式落到 `apps/platform-web/src/components/ui/`，由仓库自己持有；**不**把模板或组件库作为运行时依赖。
- 图标用 `lucide-react`；样式只用 Tailwind 工具类 + 语义化 CSS 变量（token），禁止新增第二套设计令牌或运行时 CSS-in-JS。
- 禁止并列引入第二套 UI 框架（MUI/AntD/Chakra/Bootstrap）；迁移期间若确需并存，必须有 ADR 与下线日期。
- 迁移策略：**新代码必须用新栈**；存量页面按批次替换，每批同步更新 E2E 选择器与截图，不允许一次性大重写。

## 国际化（MUST）

- 所有用户可见文案来自消息目录，默认支持 `en` 与 `zh-CN`；新增语言只加目录，不改组件。
- 键名规范 `<namespace>.<key>`；同一键必须存在于所有已支持语言，缺键视为构建失败。
- 禁止在 JSX/字符串模板里拼接句子；插值用命名参数。时间/数字/相对时间用 `Intl` 或基于 `Intl` 的封装。
- 后端面向用户的错误必须带稳定错误码（如 `DEPLOYMENT_NOT_READY`），前端按码映射本地化文案；原始服务端消息只能进诊断详情，不能作为主文案。
- 切换语言必须持久化并在刷新后生效；`<html lang>` 必须随语言更新。
- E2E **禁止**按本地化文案定位元素；用 role + 稳定 accessible name 或 `data-testid`。截图基线按语言分开存放。

## 验收（MUST）

- 提交前必须有：缺键检查、未使用键检查、`t()` 之外的硬编码可见字符串抽查。
- 每种语言至少一张 1440 宽截图 + 390 宽截图；明暗主题各一份。
- i18n 迁移完成的页面才允许新增文案；未迁移页面不得扩大英文硬编码面积（新增文案必须同时给两语言）。

