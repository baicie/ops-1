# 10 · 开发 Preview、CI、视觉验收及发布门禁

## 10.1 分离三个 Gate

1. **UI Slice Gate**：当前 Slice 可用、旧功能回归、真实浏览器截图、路由/权限/设计令牌/i18n 测试。
2. **Staging Preview Gate**：指定完整 SHA 构建、部署、健康、浏览器访问、版本自证，故障有回滚、数据不重置。
3. **Production Release Gate**：完整系统可靠性/迁移/安全/性能/独立审查（0.0.5 仍 PARTIAL）。不能以 UI Preview PASS 代替 Production Ready。

## 10.2 每 Slice 检查命令（执行前按真实包脚本调整）

```bash
pnpm install --frozen-lockfile
pnpm --filter @opsweave/platform-web typecheck
pnpm --filter @opsweave/platform-web build
node scripts/check-i18n.mjs
pnpm --filter @opsweave/ui-tests exec playwright test staging-smoke.spec.ts
cargo fmt --all -- --check
```

这些是候选验证命令；遇到包名/Node/Rust 不匹配时应读取真实 `package.json` 和 Workflow，记录实际使用命令。UI PR 若变更 Kernel auth/contract，应额外跑 Kernel tests、contracts、相应 Data Foundation / Runtime Golden Path。禁止跳过失败只贴成功测试。

## 10.3 E2E 必须验证

- `admin` 真正切换 `/admin` ↔ `/app`，不会重新发起 Login。
- viewer 无 Admin Switch/深链拒绝；operator 迁移兼容；API 401/403。
- 旧路由书签依权限兼容。
- 动态插件 v1 兼容、v2 双 Surface、激活/卸载后 UI 刷新。
- 1440/1024/390 + Light/Dark + zh-CN/en。
- Dashboard、Table、Sheet、Dialog 的键盘/焦点/语义与无横向溢出。
- 切换用户/权限撤销后缓存不泄漏。
- `403`, `404`, `NO_DATA`, `UNKNOWN`, `ERROR`, `STALE` 等状态不冒充成功。
- 前端和 Kernel 的 served SHA 与期望 commit 匹配。

## 10.4 CI 与 Staging 已知问题（审查时发现，实施时重查）

PR #11 曾经有 Rust format 失败；`deploy-staging.sh` 的 `/api/v1/version` 不匹配需硬门禁（有后续 commit `scripts/tests/deploy-served-sha.test.sh`，不可假定尚未修复；**先验证当前 HEAD**）。GitHub Runner 与国内主机的大镜像传输曾阻断全自动预览；Node Plugin Placement、Catalog/Integration 激活曾阻断真实业务演示。以上均为历史风险，不得机械重复修复已完成的项。

**不允许**每个 UI Slice 因 Staging 外网或插件故障无法验证便宣称 `Preview Ready`；可以明确 `LOCAL_VERIFIED / STAGING_BLOCKED`，继续本地截图与 CI。

## 10.5 CI Artifact 与 PR 反馈

```text
artifacts/ui-v2/<commit>/<surface>/<route>/<viewport>-<theme>-<locale>-<state>.png
artifacts/ui-v2/<commit>/playwright-report/
artifacts/ui-v2/<commit>/route-permission-matrix.json
artifacts/ui-v2/<commit>/visual-diff.json
artifacts/ui-v2/<commit>/deployment.json
```

PR 摘要至少含：GATE ID、HEAD、Stacked Base、预览 URL、实际 served SHA、Playwright 结果、截图链接、变更影响、未通过项和上一可回滚 SHA。不得把敏感账号密码、cookie、headers 或数据源凭据上传到公共 Artifact。

## 10.6 成功判定

- `GATE_IMPLEMENTED`: 真实代码提交。
- `LOCAL_VERIFIED`: 所需本地验证全通过。
- `STAGING_VERIFIED`: 针对精确提交的 Staging 实测通过。
- `READY_FOR_REVIEW`: 该 PR 的门禁通过，非生产发布许可。
- `BLOCKED`: 有外部权限/基础设施/上游依赖且不再能安全推进，附证据。
- `PARTIAL`: 有已知代码/测试/功能缺口。

## 10.7 视觉质量不是照片数量

使用真实页面内容、可比截图、A11y 检查、手工差异评审，审查不应只凭“没有溢出”就宣布设计成熟。必须定义 Typography、密度、对齐、hover/focus、颜色对比、组件状态的验收点。
