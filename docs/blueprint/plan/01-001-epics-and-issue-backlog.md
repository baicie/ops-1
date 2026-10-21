# 0.0.1 执行计划：Epics / PR 拆解 / 依赖顺序

| ID | Epic | 交付内容 | 依赖 | 完成标准 |
|---|---|---|---|---|
| E00 | Project Bootstrap | mono repo、lint/format/test/lock、README/ADR/CI、Dev compose | 无 | clean checkout 可运行检查 |
| E01 | Contract Foundation | Manifest/Capability/Node/Deployment/Logs Schema、OpenAPI、生成工具 | E00 | Schema examples + compatibility tests |
| E02 | Identity & Trust | User session、roles、Publisher allowlist、Node enrollment/mTLS、audit | E01 | 伪造/过期/撤销用例拒绝 |
| E03 | Registry & Lifecycle | Immutable package store、验签、依赖、Staging/activation revision | E01 E02 | 错包拒绝，状态可重建 |
| E04 | Single-node OCI Host | Node Runtime、OCI deploy adapter、health、resource caps | E01 E02 | 插件容器故障隔离 |
| E05 | Gateway & Capability | provides/requires、auth、sync request routing、deadline | E02 E03 E04 | 插件调用权限/超时测试 |
| E06 | Web Shell SDK | React Shell、Remote loader、Nav/Route/Settings、cleanup | E01 E03 | 热注册无需 Shell rebuild |
| E07 | Reconciler & Placement | desired/observed/effective、generations、2-node deployment | E04 E05 | 两节点副本 Readiness 与失联测试 |
| E08 | Ops Center & Diagnostics | basic metrics、instance logs SSE、Audit UI、recovery CLI | E04 E06 E07 | 异常仍能救援，日志 GAP 正确 |
| E09 | Full-stack Hello + v2 | two versions、permissions diff、bad image、API mismatch test | E03 E05 E06 E07 | 全生命周期 E2E |
| E10 | Verification & Release | fault injection/security/visual QA/restore documentation | E00–E09 | 完成 `tests/acceptance/` 矩阵且真实证据齐全 |

## 交付顺序（支持多线并行）
- Track A（平台协议/控制面）：E00 → E01 → E02/E03 → E05 → E07。
- Track B（节点/部署）：E00 → E01 → E04 → E07/E08。
- Track C（前端）：E01 → E06 → E08/E09。
- Track D（质量与基建）：E00 起持续 E10；不要临近发版才补 CI/安全。

## 每个 Epic 的设计任务规则
需要 Issue 内含：业务场景、功能所有者、可验证 API/Schema、授权策略、失败状态、可观测事件、非目标、验收实验、回滚/迁移。没有这些字段不标为 Ready。

## MVP 实验矩阵
A. 单机 Hello 插件安装启停；B. 两节点两个副本；C. 升级期间连续只读请求；D. 失败版本回退；E. Node/Kernel 断线；F. 插件 Resource exhaustion；G. 非法签名与依赖；H. 禁用仍被调用；I. 其他角色看日志 403；J. SSE gap；K. 重启后 reconciliation；L. UI 390px/深色。

## 防止范围失控
**不接 Zabbix、不写 Data Catalog、不做通用 Pipeline、不做 AI Harness、不造插件商店。** 上述问题可以在 `plan/03-future-backlog.md` 记录，不让 E00–E10 延期。

## 新增的多语言 OCI 实施子任务（必须纳入 E01/E04/E06/E09/E10）
详见 [M01–M10](04-001-oci-multilang-acceptance.md)。0.0.1 不只是“一个 Rust Hello Plugin”：必须使用真正 OCI 镜像验证至少 Java 21/Spring Boot、Go、Node/TypeScript 的同一公开 Runtime Protocol，并在独立两 Node 上运行同一个镜像 Digest 两副本。资源限额与 Node Engine Socket 不泄漏为发布阻断测试。
