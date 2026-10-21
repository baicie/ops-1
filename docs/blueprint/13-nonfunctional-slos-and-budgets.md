# 非功能性需求 / 性能预算 / 定量验收

## 0.0.1 内部实验目标（非生产 SLA）
| 指标 | 设计目标 | 测试方式 |
|---|---|---|
| Kernel 启动 | 依赖就绪后健康接口 30s 内 Ready | 清洁环境 10 次测量 p95 |
| Node 丢联发现 | 可配置；默认 10s heartbeat、30s Unreachable | 注入 20/40s 网络中断 |
| 单实例日志订阅 | 至少 1 个并发订阅可持续跟踪，断线可知 gap | 1k/s 测试样本并验证溢出 |
| 双节点部署 | 两副本都 Ready，且只对 Ready 路由 | 三机端到端实验 |
| 插件 v1→v2 | Kernel/Web Shell 进程不中断、路由不指向未 Ready 实例 | 滚动发布 + API 探针 |
| 节点单故障 | 另一个 Ready 实例仍可应答，失败显式显示 | kill Node/插件容器 + API 探针 |
| 插件内存超限 | 影响被限制在受控实例/Node 范围内 | cgroup 内存压力实验 |
| 安全拒绝 | 未签名包、越权日志、非法能力调用 100% 拒绝 | Contract + security tests |
| Web 页面 | 无横向溢出、关键动作可键盘访问 | 1440/1024/390 x Light/Dark |

所有目标须测量真实结果、设备配置、样本数、时间窗，不能只写“性能达标”。

## v0.0.1 强制限额维度
Package compressed/uncompressed size、Entry count、Plugin instances/Node、CPU/memory/pids、Log event bytes、Tail buffer bytes、SSE subscribers、Request body bytes、Request duration、Max concurrent RPC、Node heartbeat size、Artifact cache bytes。可以在实现时从保守值启动，经测试增大；每一限制必须有错误码和 UI 可读说明。

## 观测一致性
所有采集指标必须给 `observedAt` 和采样来源；状态记录不能以展示时间取代采集时间。所有“Ready”均有上次探测证据，不允许将只有心跳的在线节点显示为插件服务健康。
