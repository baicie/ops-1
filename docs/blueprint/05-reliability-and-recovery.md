# 可靠性、状态一致性、恢复与可观测

## 状态事实来源
- PostgreSQL：可声明的 desired deploy、active version、审批与审计、受控生命周期事务。不能用 Redis 或 Node 心跳缓存替代。
- Node：observed process/resource/log stream，含 `observed_at` 和节点 `generation`；过期后标记 `STALE/UNKNOWN`。
- Gateway：effective routes，每一次更新必须与 activation revision / policy 一致，可重建，丢失不意味着服务停止。

## 停机与隔离
- Kernel 崩溃时 Node 继续保留本地已启动的有期限工作负载，不接受未经验证的新敏感命令；独立健康检查可以继续记录有限本地状态。
- Node 网络断开：从 Gateway 有效路由剔除，保留 observed 的最后见证与 UNKNOWN，禁止宣称旧进程已退出；恢复后通过持久 generation 对账。
- 插件崩溃：Node 按 restart policy 有界重启，超过阈值进入 BACKOFF/FAILED；Kernel/其它节点不应被拖垮。
- 新版本不可用：候选不生效，旧路由不切换；已经破坏 Schema 兼容不能称自动回滚。

## 容量与预算
- 默认限制：每插件包解压大小、镜像大小、实例 CPU/内存、API 请求大小、并发请求、Node 控制连接数、日志事件长度、Tail buffer、SSE 订阅数、存储配额、审计保留期。
- 配额是配置与验收变量，而不是“用户可以无限扩容”；超限明确 `RESOURCE_EXHAUSTED`，保留诊断信息。
- SSE 以 event_id 和按流递增 cursor 断点恢复；如果窗口被轮转则返回 `CURSOR_EXPIRED` 并展示 Gap，不伪造连续性。

## 备份与恢复
- 0.0.1 内部实验：每日 PG 备份 + 周期性恢复演练脚本、Package Store 摘要校验、节点重新 enrollment/重联并对账；Backup 不等于 restore verified。
- 必须记录每种数据的 RPO/RTO **目标** 和实测；初始只要求恢复演练成功，不冒充 7x24 生产 SLA。
- 数据所有权清晰：禁用/卸载保留数据，purge 单独授权并备份验证。

## 平台自观测
- Kernel/Node 统一结构化日志字段：timestamp UTC、level、component、node_id、deployment_id、instance_id、request_id、trace_id、event_type；所有 ID 没有时保留空而不是造值。
- Kernel 提供 `/livez`、`/readyz`、`/health/details`（后一接口仅授权），Node metrics 快照、最小本地日志尾读、插件事件。
- 不允许业务 Ops Center 插件决定 Kernel 是否健康；Kernel 内部诊断和恢复 CLI 无业务依赖。
- 0.0.2+ 可用 OTel Collector hostmetrics/filelog → VictoriaMetrics/ClickHouse 进行长期存储；Node 控制状态不应作为高频遥测数据面。

## 容灾演练矩阵
| 故障 | 必须看到的结果 |
|---|---|
| Node 电源断开 | 网关停止新路由、显示 UNREACHABLE、其他副本可服务 |
| 网络分区（Node 进程仍运行） | UNKNOWN 而非 STOPPED、无同一有状态任务双主提交 |
| Kernel 重启 | 已安装/期望部署从 PG 读取，重新对账而不是丢失 |
| 插件启动失败 | 原 active version 保持、错误能在 bootstrap 日志查询 |
| 插件升级 API 不兼容 | 版本激活前拒绝或走兼容适配；前端旧 tab 提示刷新 |
| SSE 断线及日志轮转 | 断线/缺口显式可见，不声称 exactly once |
| PG 连接中断 | 写请求失败或待确认，不伪造安装成功 |
