# D-04 分布式与一致性规则

- MUST：Desired/Observed/Effective 状态分离；Node 心跳离线显示 UNREACHABLE/UNKNOWN，不等于已 STOPPED。
- MUST：部署命令携带 generation、commandId、TTL、幂等控制；跨节点状态和 Gateway Router 要以 PG 可恢复记录为基础。
- MUST：数据面路由只对达到 Readiness 且通过 policy 的实例开启；实例失联、Draining 必须摘除路由。
- MUST：两节点版本变更保证旧服务在可用时保留，失败后不因一条超时请求无限重试。
- MUST：长任务上线时实现 Lease、Fencing、Checkpoints 与重复副作用边界，不把 DB 锁持有整个模型调用周期。
- MUST：所有网络调用有 timeout/cancellation/backpressure；断线日志重连标明 gap；历史采集不伪造完整性。
- Gate：真实三机实验 + kill/partition/restart/rollout/security test，在同一份报告中可复现。
