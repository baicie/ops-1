# G09 / P0 — Visual/E2E/CI + 精确 SHA 的 Staging 验收门禁

读取 `docs/09-interaction-state-matrix.md`、`docs/10-release-and-preview-gates.md`、`checklists/gate-checklist.md`、现有 GitHub workflow 与 `tests/ui/*`；先看最新 PR HEAD 的 CI、Staging 当前 `/api/v1/version`、deploy-script 是否已经修复 SHA mismatch。不能重做已完成的修复。

## 按顺序执行

1. 在最新源代码对关键 Routes/Permissions/Plugins 形成真实 E2E 测试矩阵：匿名、viewer、operator、admin；旧路由深链；过期 Session；Surface Switcher；插件 v1/v2；业务/管理分离。
2. 完成视觉截图证据：1440/1024/390 × Light/Dark × en/zh，至少 Admin Overview/Plugins/Nodes、Business Shell、Switcher、Login、403、Extension Error；没有真实插件数据时明确 Not Run，不造 Mock 成功。
3. 真实检查 Accessibility（焦点、键盘、ARIA、Dialog、命令面板、对比度）。增加稳健选择器与部分像素截图基线；只有真正 `toHaveScreenshot` 存在才称视觉回归。
4. 执行 Web Typecheck/Build、i18n Keys/unused/硬编码、Playwright、涉及 Rust 的 `cargo fmt --all -- --check` + Rust Tests/Contracts。记录每个命令、退出码与真实失败。
5. 修复 UI/部署相关故障：所有 Deploy 标记成功时，实际 served Full SHA 必须匹配目标，Node/Kernel 等基本健康；必要时自动回滚，不能无声 `Healthy`。
6. 处理 Staging 的真实 blocker（外网、插件、浏览器 Smoke），在权限不足时记录 BLOCKED 且保留本地成功证据；不使用人工拷贝镜像冒充全自动。
7. 产出按 Commit SHA 归档的截图、Playwright Trace/HTML、路由和角色矩阵，上传 CI Artifact，并在 Draft PR 增量更新一条状态评论。
8. 安全检查：截图日志不得包含 Cookie、Password、Access Token、连接密码；未授权 Admin API 403 的证据可审计。

## Gate

实际测试和截图归档，版本一致，自动部署状态真实，PR 可点击查看效果。Staging 不可用就 `STAGING_BLOCKED / LOCAL_VERIFIED`，不要提升 Production Release Gate。完成后 G10。
