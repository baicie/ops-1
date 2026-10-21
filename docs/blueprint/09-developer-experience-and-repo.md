# 项目基础建设 / Developer Experience / Repository Engineering

## Monorepo 与包管理
- Rust Workspace：Kernel、Node、CLI、Contracts、执行适配层；固定 toolchain；严格 lint、clippy、fmt，CVE/许可证审查；依赖边界扫描。
- TypeScript Workspace：Web Shell、Plugin Web SDK、Design System、Demo Plugin、UI contract fixtures；严格 TypeScript，pnpm lock，eslint/prettier，单元/组件/E2E。
- Schema/OpenAPI：`contracts` 是唯一公共契约真相，Rust/TS Client 都生成；所有生成器版本固定，生成物有可追溯 digest。
- OCI build：每个后端插件独立 immutable image tag+digest，基础镜像固定 digest，发布 SBOM/签名/镜像扫描结果。

## 初始化规范
- 不硬编码假应用可用命令：首先搭建 `tools/bootstrap` 真正的统一引导脚本，再记录通过环境（Linux 目标节点、Windows/macOS 研发主机）。
- 一条命令启动本机 Kernel、PG、Web、1 个 Dev Node；第二条命令部署两节点实验：但这些是**计划实现的 CLI 入口**，当前 ZIP 不含可执行服务。
- `.env.example` 只包含占位，真实 secret 不进入仓库；dev enrollment 独立签发并自动过期。
- 快速失败：依赖不可用、证书错误、ABI 不兼容、Docker Engine 不在可控环境，必须给出明确诊断，不默默回退 Mock。

## CI 流程（CI 产品无关）
```text
format + lint
  → contract schema + API backward-compat check
  → Rust unit/domain + TypeScript unit
  → plugin package build/verify + SBOM
  → PG integration + 1-node integration
  → real 2-node full-stack E2E + failure injection
  → 1440/1024/390 light/dark visual QA + a11y
  → release artifacts + signed manifest + provenance
```
标准命令封装在 `scripts/ci/`，CI/本地只调用同一个入口；不因 CI Provider 不同而定义两套规则。长测试可放 nightly，但 0.0.1 Release Gate 必须有最近的真实两节点证据。

## 分支/代码审查
每一个 PR 至少给：动机、领域影响、合同变化、权限变化、用户可见行为、测试与日志、升级/回滚策略、ADR 引用、截图（若有 UI）。跨模块或协议变更不能绕过架构审查。评测报告按环境区分 fixture/local-real/production，不得混淆。

## 项目公共文件
`README`、`LICENSE`（许可证由项目所有者决定）、`CONTRIBUTING`、`CODE_OF_CONDUCT`、`SECURITY`（漏洞披露）、`CHANGELOG`、`CODEOWNERS`（可选）、`SUPPORT`、`docs/adr`、`governance`、`threat-model`、`ci-scripts`、`release-notes`。

## 文档即接口
重要模块至少有 Overview、Public API、State Machine、Failure Modes、Security/Permission、Operational Runbook、Testing Matrix 和 ADR。禁止纯粹“源码即文档”的跨语言插件协议。

## 多语言插件工程基线（2026-10-22）
- 在已有 Monorepo `plugins/` 加 `hello-java`、`hello-go`、`hello-typescript` 三个官方 CI 模板；不要求每个插件复制完整 Monorepo。
- Java：Gradle/JDK21，Java module 规则与依赖锁；Go：go.mod/go.sum 与 race test；TS/Node：lockfile、typecheck、API contract test；Rust Kernel 独立运行单元。
- 正式镜像由 CI 创建并签名：**不可变 Image Digest 与 frontend asset Digest、Plugin Bundle Digest 是不同制品层级**。Dev Server/HMR 仅限开发模式、绝不作为发布态功能。
- CI 增补 `plugin-runtime-v1` 语言无关黑盒合约测试、前端签名清单/旧 Tab 兼容性、两个 Node 相同 image digest 的 Rootless Docker 部署回归。
- 开发指导：[多语言模板](24-multi-language-plugin-templates.md)、[发布链](21-oci-artifacts-and-signing.md)、[合约验收](27-implementation-and-conformance-gates.md)。
