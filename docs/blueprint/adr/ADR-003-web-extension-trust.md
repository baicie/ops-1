# ADR-003：可信 Web Remote 动态加载（接受，有限范围）

- **决策**：React Shell 使用受控插件 Web SDK + Remote Loader，0.0.1 仅白名单可信发布者动态页面/导航/设置；内容寻址资源。
- **重要局限**：Remote JS 与宿主同 Realm，不能被视作安全沙箱；动态注销不等于清除已经执行过的 JS 副作用。
- **迁移**：若要开放第三方未知作者，则增加隔离 Origin + sandbox iframe + versioned message API；未验收不得宣称支持。
