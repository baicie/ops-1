# W-08 工作流程与文档规则

- MUST：需求变更关联 Epic/Issue/ADR；一份 PR 只完成一个可审阅的纵向 Slice，避免大批次无验证重构。
- MUST：README、API Schema、Data migrations、Release Notes、Operational Runbooks 伴随实现更新；不能让规则与真实代码长期分叉。
- MUST：所有原型标 `prototype`，所有虚构负载/截图标 `fixture`，所有功能区分 implemented/verified/planned。
- MUST：敏感审计日志/客户数据不得写入仓库/截图/自动化提示词；测试数据来源记录明确。
- SHOULD：每周以 End-to-end User Journey 为主汇报完成度，避免按代码行数/架构图页数评估进度。
- Gate：每个任务完成记录目标与结果、最小可重复验证命令、已知限制、后续风险。
