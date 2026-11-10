# W-08 工作流程与文档规则

- MUST：需求变更关联 Epic/Issue/ADR；一份 PR 只完成一个可审阅的纵向 Slice，避免大批次无验证重构。
- MUST：README、API Schema、Data migrations、Release Notes、Operational Runbooks 伴随实现更新；不能让规则与真实代码长期分叉。
- MUST：所有原型标 `prototype`，所有虚构负载/截图标 `fixture`，所有功能区分 implemented/verified/planned。
- MUST：敏感审计日志/客户数据不得写入仓库/截图/自动化提示词；测试数据来源记录明确。
- SHOULD：每周以 End-to-end User Journey 为主汇报完成度，避免按代码行数/架构图页数评估进度。
- Gate：每个任务完成记录目标与结果、最小可重复验证命令、已知限制、后续风险。
- **MUST：PR 合入后清理分支与 worktree。** 删除所有已合入的本地与远端分支（不止当次那一条），移除已合入 worktree 并 `git worktree prune`。

  **判定"已合入"的唯一可靠方法**：本仓库只允许 squash 合入（见仓库设置，merge/rebase 均已禁用），因此
  - `git rev-list --count origin/main..<branch>` 恒为 `0`——不可用；
  - `git log --grep` 找不到 squash 后的提交——不可用；
  - **正确做法**：取 `git merge-base origin/main <branch>`，对该区间内每个改动文件比对 `git rev-parse <branch>:<file>` 与 `git rev-parse origin/main:<file>`；全部一致才可删。若某文件在 main 上被后续改动覆盖，需逐行核对分支新增内容是否已存在于 main，而不是凭文件哈希下结论。

  同时确认对应 PR 状态为 `MERGED` 而非 `CLOSED`（后者代表被放弃，内容可能从未进入 main）。远端分支删除属于外部可见操作；这是合并后的常规收尾，不需要逐次征求同意。

