# ADR-UI-001…006（G00 决策记录）

状态：Accepted（作为 UI V2 的实施前提）。若后续变更需新开 ADR，不在此原地改写结论。

## ADR-UI-001 · 两个 Surface，一个 Web App / 一个 Kernel

**决策**：初期在 `apps/platform-web` 内实现 `/admin/*` 与 `/app/*` 两个独立 Shell，共享 Vite/React、Auth、i18n、shadcn 原语、Gateway、Rust Kernel 与数据库。未来多个业务 Workspace 是业务领域概念，Admin 不是其中一员。

**理由**：单一部署与会话成本最低；同 Origin 下多应用并不能提供安全隔离，真正的边界在 Kernel/Gateway 授权。

**后果**：路由与插件贡献需要新增 `surface` 维度；浏览器内不假设强隔离；不使用 iframe 或多仓库拆分来「制造」隔离。

## ADR-UI-002 · shadcn-admin 是参考，不是依赖

**决策**：借鉴 Sidebar、Command Palette、表格密度、Profile Menu 的布局与交互，但**不 fork、不 upstream merge、不迁移 TanStack Router / Clerk**；保留现有 React Router、Auth、i18n 与 `--ow-*` 令牌。

**理由**：现有栈已稳定且有 12 个原语与 880 条 i18n 文案；迁移路由与身份框架的收益不足以抵消风险。

**后果**：如复制上游 MIT 组件，保留许可证与来源注释；所有令牌必须属于 OpsWeave（禁止并行第二套）。

## ADR-UI-003 · 授权权威在后端（MUST）

**决策**：前端 Surface/导航只决定可见性；权限由 Kernel/Gateway 校验。`admin` 角色作为过渡，最终拆分为 `platform:access` 与更细的 operation 权限。

**理由**：风险 R1（仅 CSS 隐藏可被绕过）为 P0。

**后果**：每个 `/admin/*` 路由必须有对应的 API 403 证据；G05 需产出 38 处校验点的实测矩阵。

## ADR-UI-004 · 签名 v1 扩展兼容优先（MUST）

**决策**：不在已签名 manifest 中原地加字段。新增 `surface` 贡献通过**版本化合同**（`navigation.item.v2` 等）实现，v1 语义保持不变并默认归入 admin surface。

**理由**：已签名包不可改；破坏兼容会让既有插件安装/激活失败。

**后果**：G06 先出 contracts 变更 + ADR，再改 Kernel 与前端；负向测试覆盖旧包加载与冲突路径。

## ADR-UI-005 · UI 品质与 Investigation 业务分期

**决策**：先让 Platform Console 精致统一，再做双 Shell 与授权，最后才启动 0.1.0 Incident/Evidence 业务纵切。**不得**用 Mock 的 RCA/Incident 页面装饰产品。

**理由**：风险 R5/R6；业务页面造假会让后续真实实现返工。

**后果**：`/app/*` 在 G07 只建壳并显式标注未上线能力。

## ADR-UI-006 · 原始 Java 设计不改变当前 Rust Kernel

**决策**：设计包 `reference/` 中的 Java Platform API 是历史提案。UI V2 不迁移后端语言、不建第二套身份/Incident 数据库。

**理由**：现有 Kernel 是真实运行事实（Staging 已验证）；为避免双权威。

**后果**：0.1.0 Incident 权威模型需单独 Architecture ADR；UI 期只承诺 Surface 与交互。
