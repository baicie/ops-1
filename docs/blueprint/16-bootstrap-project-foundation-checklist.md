# 工程基础建设：项目从零启动的完整清单

## 1. 目录与版本
- [ ] Rust workspace/TS workspace 的版本文件、锁文件、构建缓存策略、统一 lint/format 类型规则。
- [ ] 0.0.1 内核公共 ABI/API 版本标记与 Plugin SDK 兼容范围，契约生成与兼容快照。
- [ ] 依赖更新脚本、容器基础镜像 digest、Reproducible Build 与 SBOM 发布归档。
- [ ] Developer Mode 与 Release Mode 完全区分，正式环境没有隐式 dev identity/Mock fallback。

## 2. 代码质量
- [ ] `cargo fmt`、`cargo clippy`、`cargo test --locked`（示意，实际工具链固定后锁定命令）；TS strict/typecheck/lint/build。
- [ ] 单元/集成/E2E/故障注入/UI 回归测试目录与 fixture 来源标注。
- [ ] PR、ADR、Issue、Threat Model 模板与审核分工；危险规则人工签署责任。
- [ ] 生成 SDK/Schema 和差异对比脚本，发布后验证兼容版本。

## 3. 开发环境
- [ ] Linux Node 实验机、OCI Engine 版本锁、权限受限的 Node 系统服务。
- [ ] PostgreSQL 初始化脚本与迁移权限隔离，备份/恢复脚本和清理逻辑。
- [ ] 本地团队发行者签名环境及只存放公钥的 trust store；Node enrollment 生成/吊销脚本。
- [ ] TLS ingress、本地证书管理、端口/防火墙与开发用 private network 演练。
- [ ] 统一 CLI / 实验报告，清理工作目录不能误删客户目录/非本项目容器。

## 4. 服务运维
- [ ] health/live/readiness 自诊断、结构化日志、审计、request ID/trace context、限额指标。
- [ ] 实例运行状态机、启动/停止幂等、readiness、backoff、未知和恢复状态。
- [ ] OTel/exporter 后续挂接点，但 0.0.1 不强依赖 ClickHouse/VM/Kafka。
- [ ] 部署时的版本矩阵、签名制品、运营恢复手册与异常错误码字典。

## 5. 开源工程元信息
- [ ] 项目许可证与依赖许可证策略（由项目所有者明确选择）。
- [ ] SECURITY.md / 漏洞披露、CONTRIBUTING.md、变更日志、支持范围、版本政策。
- [ ] 商标与包名、镜像命名空间和证书信任根的所有权；可选行为遥测必须默认透明并尊重隐私。

## 6. 首版质量门槛
- [ ] 单机 E2E 与三机 E2E 都能从新环境复现。
- [ ] 未经验证的设计假设保留在风险登记表，不被标成实现功能。
- [ ] UI 六环境审查、越权和异常演练完成；真实失败案例能借助 Bootstrap 自救。

## 2026-10-22 Init/Bootstrap 补充
- [ ] Node Systemd 专属用户、Rootless Docker Engine socket、cgroup v2 限额在 Linux amd64 实机确认；保留故障时的 Bootstrap Diagnostics。
- [ ] Java 21 / Go / Node(TypeScript) 三个 Hello 源码/锁文件/容器构建出真实不可变 OCI Digest，并用统一 Runtime v1 Tester 验收。
- [ ] OCI Registry、可信签名 Publisher、前端静态 Asset Store、网络与 TLS 主机/证书、PG Backup 位置写入 `.env.example` 所需占位说明；真实 Secret 单独管理。
- [ ] 使用受控权限组从 CI 发布 Bundle、OCI Images、SBOM、签名；不能让 Web UI 在内核主机随意运行编译命令。
- [ ] CI 门槛分开记录 schema-parse、contract-test、single-node、real-three-host；没有真正环境记 NOT_RUN。
