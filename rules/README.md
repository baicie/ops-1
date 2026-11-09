# 统一项目规则（与 IDE、代码生成平台无关）

`rules/*.md` 是规范性文件，优先级：`AGENTS.md` → 架构 ADR/冻结契约 → `rules/*.md` → 每项 Skill 流程 → 局部编码风格。发生冲突时不得静默选择，必须在任务中说明并提交 ADR。团队成员或任何自动化都可阅读这些普通 Markdown 文档；不使用特定工具的 `.mdc` 或私有配置格式。

## 规则执行机制
- 新建任务：填写 `docs/blueprint/templates/IMPLEMENTATION_PLAN.md` 和相关 Issue，勾选规则影响域。
- PR 检查：执行 `node tests/ci/check-retired-paths.mjs`（退役路径零残留）与本文档列出的 contract/integration/security/ui Gates。
  文档包自身的完整性（Blueprint 包内 Markdown 断链、JSON Schema 示例）由 `docs/blueprint` 包携带的 `scripts/verify_package.py` 校验，
  该脚本以包根为基准，不在仓库根运行。
- 审查：使用 `docs/design/dual-workspace-v2/pack/checklists/gate-checklist.md`（PR/Gate）与 `visual-review-rubric.md`（UI 视觉）；
  安全与发布分别走 `docs/blueprint/skills/security-review/SKILL.md` 与 `docs/blueprint/skills/release-gate/SKILL.md`。
- 无法自动化的规定，指定人工验收和证据路径；没有证据不能标记通过。

- `09-oci-supply-chain.md`：OCI 不可变镜像、签名、镜像管理 socket 隔离、资源和供应链。
- `10-language-agnostic.md`：语言无关 Runtime Protocol 与 SDK/业务边界。
- `11-refactor-retirement-and-cleanup.md`：搬迁/退役的原子完成、门禁不得静默空转、活文档与历史记录的区分。
