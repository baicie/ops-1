# 11 · Architecture Decision Record（汇总草案）

## ADR-UI-001 — 两个 Surface、一个 Web App / Kernel（建议 Accepted）

**决策：** 初期在 `apps/platform-web` 内实现 `/admin/*` 与 `/app/*` 两个独立 Shell，但共享 React/Vite、Auth、i18n、shadcn primitives、Gateway、Rust Kernel、数据库。未来多业务 Workspace 是 Business 领域概念，不把 Admin 当成一个普通 Workspace。

**后果：** 两个 IA 独立；路由/插件贡献新增 Surface 属性；单一部署/会话成本最低；浏览器 JS 在同 Origin 下不存在强隔离，不可作为多租户安全边界。

## ADR-UI-002 — shadcn-admin 是参考，不是依赖（建议 Accepted）

**决策：** 借鉴 Sidebar、Command Palette、表格、Profile Menu 的视觉与交互；沿用当前 Vite+React+TS、Tailwind、shadcn copy-in、现有 Router/i18n；不引入 Clerk/TanStack Router 迁移，也不 fork/upstream merge 模板。

**后果：** 降低接入成本；设计令牌必须属于 OpsWeave。若复制上游 MIT 文件保留许可证和来源。

## ADR-UI-003 — API 授权权威在后端（MUST）

**决策：** 客户端 Surface/Navigation 只控制可见性；权限由 Rust Kernel/Gateway 校验；插件提供的是最低能力要求，不是授予权限。`admin` Role 先用于过渡，但最终解耦 `platform:access` 与精细 Operation 权限。

**风险：** 旧 `operator` 有实际平台维护能力，直接仅允许 admin 访问全部 Console 可能破坏既有使用；需要角色-API 迁移矩阵。平台 admin 不等于跨业务域全部可读。

## ADR-UI-004 — 签名 v1 Extension 兼容优先（MUST）

**决策：** 不在已签 Manifest 原地加入字段；新 `surface` 贡献需要版本化合同，兼容 v1 语义。每一版本重建/重签；默认拒绝核心路径冲突；Server-side 授权。

**风险：** 远端 UMD 在主页面 JS 运行，不能宣称 sandbox；后续可信插件清单/隔离部署另立 ADR。

## ADR-UI-005 — UI 与 Investigation 业务分开分期

**决策：** 先做 Admin 品质，再做 Dual Shell/权限，再做第一条 Incident/Evidence 业务能力；不制造满是 Mock 的 RCA 页来装饰产品。

**风险：** 过度美化 Admin 又一次延迟用户价值；必须在 UI Gate 达成后冻结新的大范围 Admin 设计重构。

## ADR-UI-006 — 原始 Java 设计与当前 Rust Kernel 取舍

**背景：** `reference/` 的旧设计描述 Java Platform API 权威；现有 `baicie/ops-1` 真正实现的是 Rust Kernel 与 Plugin Runtime。

**决策：** UI/双 Shell 不改变当前 Kernel 架构；0.1.0 Incident/Investigation 权威归属需要单独 Architecture ADR，禁止为了契合原始文档重建第二套身份/Incident 数据库或直接重写 Java。

## 风险登记

| ID | 风险 | 级别 | 缓解/出门条件 |
|---|---|---|---|
| R1 | 仅 CSS 隐藏 Admin 菜单造成权限绕过 | P0 | Kernel/API 403 + E2E |
| R2 | 多 Surface 插件路由碰撞/权限绕过 | P0 | versioned manifest / namespace / negative tests |
| R3 | 复制 shadcn-admin 全站业务代码导致依赖爆炸 | P1 | cherry-pick pattern / token / license audit |
| R4 | 已有 operator 失去原功能 | P1 | role-route-API matrix 与兼容过渡 |
| R5 | Admin 美化掩盖业务产品缺失 | P1 | UI 阶段结束后 Incident Golden Path 任务 |
| R6 | 业务 Workspace 假数据伪装成功 | P1 | DEMO 状态显式、真实接口证据 |
| R7 | Staging 部署不是真正目标 SHA | P1 | Served SHA 强门禁、CI Artifact |
| R8 | 多 Shell 不必要拆分成多个仓库/身份 | P2 | 单 App 按需拆分 |
| R9 | Token 名称写错导致新旧样式并存 | P2 | 当前变量映射清单/Visual Diff |
| R10 | 无真正 `workspaceId` 授权却声称多业务 Workspace | P1 | 首版仅一个默认业务入口，后续领域设计 |
