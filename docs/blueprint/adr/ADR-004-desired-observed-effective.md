# ADR-004：Desired/Observed/Effective 三态（接受）

- **决策**：PG Desired 状态独立于 Node Observed，Gateway Effective Routes 独立计算并版本化；Reconciler 幂等收敛。
- **原因**：跨机失联与启动丢回执无法靠单字段状态正确表达；避免 split-brain 和假恢复。
- **实施**：commandId、generation、CAS、observedAt、Readiness、TTL、失联标 UNKNOWN；异步任务另用 Lease/Fencing。
