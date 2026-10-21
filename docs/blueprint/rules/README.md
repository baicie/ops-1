# 统一项目规则（与 IDE、代码生成平台无关）

`rules/*.md` 是规范性文件，优先级：`AGENTS.md` → 架构 ADR/冻结契约 → `rules/*.md` → 每项 Skill 流程 → 局部编码风格。发生冲突时不得静默选择，必须在任务中说明并提交 ADR。团队成员或任何自动化都可阅读这些普通 Markdown 文档；不使用特定工具的 `.mdc` 或私有配置格式。

## 规则执行机制
- 新建任务：填写 `templates/IMPLEMENTATION_PLAN.md` 和相关 Issue，勾选规则影响域。
- PR 检查：执行 `scripts/verify_package.py`（文档包验证）与未来项目的 contract/integration/security/ui Gates。
- 审查：使用 `checklists/PR_GATE.md`、`SECURITY_GATE.md`、`RELEASE_GATE_001.md`。
- 无法自动化的规定，指定人工验收和证据路径；没有证据不能标记通过。

- `09-oci-supply-chain.md`：OCI 不可变镜像、签名、镜像管理 socket 隔离、资源和供应链。
- `10-language-agnostic.md`：语言无关 Runtime Protocol 与 SDK/业务边界。
