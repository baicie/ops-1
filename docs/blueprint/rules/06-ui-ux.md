# U-06 UI/UX 强制规则

- MUST：先有任务流、页面 IA、状态矩阵、线框，再写 React 页面；不要以“更高级/好看”为唯一设计输入。
- MUST：共享 Design Tokens/组件/导航，插件不覆盖全局 CSS、认证、权限提示；一个页面至多一个主要 CTA。
- MUST：Loading/Empty/Error/Unknown/Partial/Stale/Forbidden/Conflict 语义完整，真实数据不得 Mock 冒充。
- MUST：1440/1024/390 × Light/Dark 截图人工审阅，键盘可用、focus visible、主要状态不只靠颜色。
- MUST：Node/Plugin/Log 有原始 observedAt 和查询失败状态，未知不显示绿，日志 event gap 不显示已追完。
- SHOULD：表格、日志、画布使用专属高密度组件而非 Card 堆砌，重要操作可从 1–2 个明显位置找到。
- Gate：通过 `checklists/UI_GATE.md`，视觉修复前后有真实截图与运行日志。
