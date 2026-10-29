# 每阶段 PR / Gate 验收模板

## 基线
- [ ] 真实 `HEAD`、Base、Draft PR、依赖链、工作树状态记录。
- [ ] 影响的后端 API、签名 Manifest、角色、页面及旧 URL 有清单。
- [ ] 设计依据与 ADR 变更说明；未变更理由明确。

## 代码与验证
- [ ] 对已有代码先查存在与否，不重复造轮子。
- [ ] 关键成功/拒绝/失败/取消/超时/兼容测试通过。
- [ ] TypeScript Typecheck、Web Build、i18n 对应校验通过。
- [ ] 如涉及 Rust、Contracts、权限，追加 `cargo fmt`/Tests/Contracts/授权回归。
- [ ] 旧 E2E 不是被移除、skip、blind retry 掩盖。

## UI 与产品
- [ ] 有明确受影响页面、用户任务、CTA 和真实操作反馈。
- [ ] 1440/1024/390 + Light/Dark + zh-CN/en 截图。
- [ ] Loading/Empty/Error/Forbidden/Stale/Unknown/No Data 状态与单位/时间语义正确。
- [ ] A11y 键盘、Esc、Focus、Dialog、Tooltip、命令面板可用。
- [ ] 非管理用户没有 Admin 导航，服务端拒绝 Admin API。
- [ ] 插件 v1/v2 与签名版本兼容（相关 Gate）。

## Staging
- [ ] 目标完整 40 位 SHA。
- [ ] `/api/v1/version` 返回实际 served SHA 与目标完全相同。
- [ ] 部署成功/失败/回滚与真实运行状态一一对应。
- [ ] 真实浏览器截图关联 SHA、URL、测试运行。
- [ ] 不删除/重置 PostgreSQL、Node 身份、插件包、数据目录。
- [ ] Staging 有网络/凭据阻断时如实 BLOCKED，提供本地独立验收。

## 交付报告
- [ ] A Git/PR/HEAD/Base
- [ ] B 本轮功能与目录/契约
- [ ] C 真正运行过的命令、测试数量和失败
- [ ] D 视觉截图 / Playwright URL
- [ ] E Staging URL、served SHA、部署/回滚结果
- [ ] F 兼容性/权限/安全风险
- [ ] G 未完成项 P0/P1/P2
- [ ] H 下一阶段明确工作依赖
- [ ] I 状态：`PARTIAL / BLOCKED / LOCAL_VERIFIED / STAGING_VERIFIED / READY_FOR_REVIEW`

**统一红线：** `0.0.5_PARTIAL` 的生产质量状态不得因 UI PASS 改成 Ready。任何未做/未运行的部分写 NOT_RUN，不能推定成功。
