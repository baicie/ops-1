# 0.0.1 增量开发 Backlog：OCI / 多语言 / 发布链

> 这是对 [0.0.1 主任务](01-001-epics-and-issue-backlog.md) 的补充与细化，不新建独立版本；不得把 Data Catalog/AI 业务塞进 0.0.1。

| ID | 任务 | 前置 | 可验证成果 |
|---|---|---|---|
| M01 | 冻结 Manifest v1.1 + Runtime OpenAPI + Golden fixtures | E01 | JS/Rust/Java/Go 四语言均可读取同一契约 |
| M02 | 构建 Rootless Docker Linux Node Adapter | E04 | 单机资源配额/Socket/无特权约束真实运行 |
| M03 | OCI 发布链：immutable Digest、签名、SBOM、Registry | E02 E03 | 篡改与 Registry 故障被拒绝 |
| M04 | Web Asset Index、签名静态资源分发、Remote Loader | E06 | 无 Shell build 改变独立切 v1/v2 |
| M05 | Hello Java (Spring Boot 21)、合约及 Dockerfile | M01 M02 | real Docker image 通过 conformance |
| M06 | Hello Go (`net/http`)、合约及 Dockerfile | M01 M02 | 通过与 Java 相同 conformance |
| M07 | Hello TypeScript (Node/Fastify)、合约及 Dockerfile | M01 M02 | 通过相同 conformance + Web Remote |
| M08 | Node A/B 跨节点镜像拉取、Deploy/Drain/Rollback | M02 M03 M05 | 两副本、1 节点故障不拖垮 Gateway |
| M09 | 控制台安装向导、权限 Diff、发布与回滚 UI | M03 M04 M08 | 6 场景截图 + 错误恢复 |
| M10 | 真实三机故障注入与发布 Gate | M05 M06 M07 M08 M09 | C01–C14 证据表全通过或明确失败 |

推荐实施次序：`M01 → (M02 ∥ M04) → M03 → (M05 ∥ M06 ∥ M07) → M08 → M09 → M10`。必须先跑真实的 Java/Go/TS 才能宣称多语言容器运行时已完成；不能把 Dockerfile 存在当成通过。
