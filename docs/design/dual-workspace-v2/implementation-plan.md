# 实施计划与 PR 策略（G00 产出）

## 1. Gate → 分支 → PR

| Gate | 分支 | PR | Base | 交付 |
|---|---|---|---|---|
| G00 | `feat/ui-admin-shell-v2` | **本 PR（Draft）** | `feat/0.0.5-staging-preview` (#11) | 审计文档、路由图、权限矩阵、令牌审计、ADR、旧版截图 |
| G01 | 同上 | 同上 | — | Design Tokens 增补 + Sidebar/Command/Breadcrumb/Sheet 复合件 |
| G02 | 同上 | 同上 | — | AdminShell V2（Header/Sidebar/Command/Theme/用户菜单/Surface Switcher 容器） |
| G03 | 同上 | 同上 | — | Overview/Plugins/Nodes 三样板页精修（真实数据与状态） |
| G04–G05 | `feat/ui-dual-surfaces` | 新 Draft | `feat/ui-admin-shell-v2` | 双 Shell 路由、无感切换、旧 URL 兼容、后端授权闭环 |
| G06 | `feat/ui-surface-extensions` | 新 Draft | `feat/ui-dual-surfaces` | v1 兼容 + v2 surface 贡献合同、命名空间、授权 |
| G07 | `feat/ui-business-shell` | 新 Draft | 同上 | 业务 Shell 与 IA（真实 COMING_SOON/空状态） |
| G08–G10 | `feat/ui-admin-polish-and-gates` | 新 Draft | — | 其余 Admin 页面、浏览器门禁、独立审查修复 |

**纪律**：不往 PR #11 继续堆 UI 改动；每 Gate 多 Commit、单 PR 内的切片可独立 review；不 merge/tag/release/force push。

## 2. 本 PR 的切片划分（G00 已完成 / 待做）

1. `docs(design)`: 设计包入库 + 五份审计文档 + ADR（本提交）
2. `feat(ui)`: G01 令牌与复合件
3. `feat(ui)`: G02 AdminShell V2
4. `feat(ui)`: G03 三样板页
5. `test(ui)`: 每切片的截图与 Playwright

## 3. 风险与依赖

| 风险 | 处理 |
|---|---|
| PR #11 仍有 75+ 文件改动，本 PR stacked 其上会让 review 更难 | 只提交 `docs/design/**` 与 UI 层文件，不触碰 #11 已改的部署/后端文件 |
| 镜像自动投递 BLOCKED | Staging 验证沿用「手工送镜像 + 明确标注」；不以手工成功冒充自动部署 |
| 无 HTTPS | 截图与凭据只在受限环境使用；继续标记 P0 |
| 插件 surface 改动涉及签名 manifest | G06 前先出 ADR + contracts，不原地改已签名字段 |
| 业务 Workspace 无真实数据 | G07 只建壳与 COMING_SOON，禁止伪造 Incident |

## 4. 完成判定（G00）

- [x] 真实 HEAD/PR/CI 状态
- [x] 真实路由图（20 条 + `/ext/*`）
- [x] 已有/缺失组件表（12 原语 vs 需新增 5 类）
- [x] 权限矩阵与 38 处校验点
- [x] 令牌与状态矩阵审计
- [x] ADR-UI-001..006
- [ ] 旧版截图基线（本轮执行）
- [ ] 独立 Draft PR 创建（本轮执行）
