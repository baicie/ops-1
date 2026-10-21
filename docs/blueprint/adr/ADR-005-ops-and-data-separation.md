# ADR-005：Bootstrap Operations 与 Telemetry Data Plane 分离（接受）

- **决策**：Kernel 内置只读最小恢复；Ops Center 可卸载；Node 最小 CPU/MEM/实例日志；历史 Metrics/Logs/Traces 走 OTel Collector 等专用存储，后续插件对接。
- **原因**：自运维不能依赖自己可能失败的业务插件；亦不能在 PG 中逐条写入原始日志。
- **后果**：0.0.1 不支持生产历史日志搜索；Live Tail 须有 Cursor/Gap/流限额和权限。
