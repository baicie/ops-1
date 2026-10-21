# OpsWeave Final Decisions — 2026-10-22

**版本**：架构蓝图 1.1.0（设计产物）；平台发布目标 0.0.1；数据插件发布目标 0.0.2。此文档为**设计冻结说明**，不是上线证明。

## 十项冻结决策
1. 产品：**分布式、前后端可热插拔的模块化应用平台**；数据接入、数据目录、Pipeline 是首批业务，Observability/RUM/AI 为后续插件。
2. Kernel：Rust/Axum/Tokio + PostgreSQL 控制面唯一事实源；身份/权限/签名/注册/部署/Gateway/Bootstrap Diagnostics 属于不可卸载信任根。
3. Frontend：React + TypeScript Web Shell；可信 Remote Module 动态加载，资产独立静态分发且 Hash 不可变；未来不可信 UI 必须 iframe 隔离。
4. Backend：**Language-Agnostic**。Java/Go/TypeScript/Python/Rust 均可实现业务插件，不要求使用官方 SDK；首版真实合约实验至少 Java + Go + TypeScript。
5. 正式制品：业务后端 **OCI 镜像@SHA256 Digest**，Web 静态 Bundle/Asset Index；一个受信、签名的 Plugin Package 关联二者，不把容器二进制装入内核。
6. 运行：Linux Node Runtime（守护进程）通过受控 **Rootless Docker Engine** Adapter 启动插件容器；Docker Socket 不向插件开放；正式插件不可直接宿主进程运行。本地 Dev Mode 才允许原生进程/HMR。
7. 分布式：Kernel 单实例 + 两台 Node 真机进行 0.0.1 双副本验证；Node 主动 mTLS 控制通道，私网可路由数据代理；无 NAT 透明穿透、无多 Kernel HA 承诺。
8. 控制一致性：Desired/Observed/Effective 三态、Generation/CAS、无状态同步双副本、先 Ready 再切路由、未知不假装已停止；Durable Worker/Lease 在 0.0.3 后落地。
9. 自运维：Kernel 最小恢复 CLI/诊断；Node 基础采样、实例 stdout/stderr 的鉴权 SSE；Ops Center 可插件化。历史 Logs/Traces/Metrics Pipeline 不塞 0.0.1。
10. 范围：0.0.2 安装两个独立插件 Data Catalog + Data Integration，并用 HTTP/JSON（含可验证真实源）完成 Schema/Mapping/Validation/Dataset 最小闭环；Pipeline Engine 0.0.3、编辑器 0.0.4、治理 0.0.5、可观测/AI 后续。

## 与上版差异
- **更新/细化**：`backend.imageDigest` → `backend.imageRef@sha256`；健康检查拆分 live/ready/startup；附独立 Plugin Runtime v1 OpenAPI；Web Asset Index+Digest；构建/发行/安装/镜像验签链；开发与生产的不同运行模式；三语言一致性 Gate；控制台发布向导与多阶段升级。
- **保留**：内核/Node/Capability 架构、三态、资源权限/网络边界、0.0.1/0.0.2 目标、完整 UI/Rules/Skills、PG 模型、分布式验收。
- **明确排除**：不重新以 AI RCA 为 0.0.1 主线；不绑定某个 IDE 规则格式；不宣称这份 Markdown/Schema 是已跑通的平台；不承诺容器天然就是强隔离沙箱。

## 推荐阅读顺序
1. [首页](README.md) / [交付索引](DELIVERY_INDEX.md) / [工程总规则](AGENTS.md)。
2. [多语言 Runtime](docs/20-language-agnostic-plugin-runtime.md)、[OCI 制品](docs/21-oci-artifacts-and-signing.md)、[部署拓扑](docs/22-oci-deployment-and-topology.md)。
3. [插件协议](docs/23-runtime-protocol-and-sdk.md)、[多语言项目模板](docs/24-multi-language-plugin-templates.md)、[升级恢复](docs/25-rolling-release-and-rollback.md)。
4. [开发/运维用户旅程](docs/26-operator-and-developer-journeys.md)、[真实验收](docs/27-implementation-and-conformance-gates.md)、[插件部署 UI](docs/ui/05-plugin-dev-build-deploy-ui.md)。
5. [0.0.1 新增任务](plan/04-001-oci-multilang-acceptance.md)、[原 0.0.1 任务](plan/01-001-epics-and-issue-backlog.md)、[0.0.2 任务](plan/02-002-epics-and-issue-backlog.md)。

## 设计与实现之间的差距
- 已有：完整文档、JSON/YAML 草案、离线解析/Schema 检查器、工程模板、验收计划。
- **未有**：运行平台代码、真实 OCI 镜像、可信签名、Docker Engine+三机运行、Java/Go/TS Conformance 测试结果、实际数据、安全审计结论和性能报告。
