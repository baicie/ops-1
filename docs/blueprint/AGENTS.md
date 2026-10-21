# OpsWeave 项目协作总规约（平台无关）

本规约适用于人类研发者与任何代码生成/执行助手，不依赖某一编辑器、Agent 产品或云厂商。严格程度：**MUST** 不可违反；**SHOULD** 默认遵循，例外须 ADR；**MAY** 可选。所有实现必须遵循 `rules/` 及 `docs/` 的架构基线。

## 工作步骤（MUST）
1. 读取相关设计文档/ADR，先列出受影响的契约、模块、权限与迁移。
2. 对每项任务写清输入/输出、状态、错误、所有者与验收条件；若需求未定，最小化、明确标注假设。
3. 涉及跨模块 API、数据库、权限、运行时、制品格式、部署语义时必须先更新契约和 ADR，再编码。
4. 测试必须覆盖成功、拒绝、超时、失联、升级失败、恢复、权限变更；报告真实运行过的命令与结果。
5. 若 UI 有变化，必须提交交互状态矩阵和真实浏览器截图，手工审查 1440/1024/390 宽度与明暗主题。
6. 完成后更新实现状态、风险清单、迁移说明和变更摘要；不得伪造通过率、生产就绪声明。

## 绝对禁止（MUST NOT）
- 将业务插件功能写入 Kernel；未经 ADR 添加新的不可卸载能力。
- 从 Web 直接连接 Node Runtime、插件容器端口或数据库；绕过 Gateway 的 RBAC 和资源范围。
- 将业务插件作为任意 Rust dylib 加载进 Kernel，或允许插件获得宿主 Docker Socket、root Shell、任意宿主文件访问。
- 用心跳离线推断实例已停止；把 `UNKNOWN`、`PARTIAL`、`NO_DATA` 伪装成健康状态。
- 在禁用、卸载、回滚时隐式删除业务数据；假定任意 Schema 迁移可自动回滚。
- 在生产/测试失败后静默回退 Mock；用组件存在/页面显示代替实际 E2E。
- 为满足演示而给公共接口暴露 dev token、宽泛 CORS、明文密钥、未鉴权 SSE。
- 让用户、插件或模型自报的 tenant/subject/permissions 代替可信身份。
- 给前端远程模块共享原始认证令牌、密钥；依赖 Prompt/CSS 隐藏来实现权限控制。
- 引入 Kafka、Service Mesh、Wasm、任意动态插件商店、通用 DAG 等无对应交付 Gate 的基础设施。

## 文档约束
- 源协议只在 `contracts/`；Generated code 不得手改；兼容性改变必须有升级和回滚/拒绝策略。
- 版本号按 `plan/` 管理；**实现状态、测试状态、产品状态独立记录**。
- 所有时间戳 UTC ISO 8601；跨语言事件 `occurred_at` / `observed_at` 不得混淆；Opaque cursor 不得反推出宿主路径。
- 任何 AI、采集、网络、存储成本要有预算、上限和失败语义。
- 所有依赖与容器制品通过锁文件/摘要/可重复构建管理，升级单独审查。

## 规则索引
- `rules/01-architecture.md`；`02-plugin-runtime.md`；`03-security.md`；`04-distributed.md`；`05-data.md`；`06-ui-ux.md`；`07-testing-release.md`；`08-docs-and-workflow.md`。
- 任务专用流程位于 `skills/*/SKILL.md`，任何团队成员均可手工遵循。

## 2026-10-22 OCI 多语言增补（与原规约同等效力）
- 0.0.1 Plugin Runtime HTTP/JSON v1 不绑定 Java/Go/TypeScript/Rust/Python；官方 SDK 是可选便利包。修改协议先升级 `contracts/`、用 Java/Go/TS 同一黑盒测试验证。
- 生产后端 OCI 镜像通过 Digest 固定、签名验证、独立镜像仓库分发；开发本机进程/HMR 只能是 DEV_ONLY。
- 发布包 Backend Image、Web 静态资产索引、Registry ZIP Bundle 属于不同受信内容；禁止自引用 ZIP 哈希或误用 Tag。
- Rootless Docker Node Adapter 是 0.0.1 参考实现，不能被业务容器获取 socket；cgroup 资源/用户权限与网络隔离必须实测。
- 发布到真实两节点前必须通过 [OCI Release Review](skills/oci-release-review/SKILL.md) 和 [Multi-language Conformance](skills/multilang-conformance/SKILL.md)。
- 新增平台无关强制 Rules：`rules/09-oci-supply-chain.md` 与 `rules/10-language-agnostic.md`；新增 0.0.1 子任务见 `plan/04-001-oci-multilang-acceptance.md`。
