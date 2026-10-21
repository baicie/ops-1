# 自运维 / 节点监控 / 实时与历史日志

## 能力分层
1. **Bootstrap Diagnostics（Kernel 内置，不可卸载）**：平台、节点、实例最近状态、生命周期事件、有限诊断日志、手动退役/重试、安全恢复 CLI。Kernel 自救依赖最少组件。
2. **Ops Center（0.0.1 官方插件）**：Node 列表、详细页、插件实例、CPU/内存/磁盘瞬时状态、健康趋势的有限缓存、实时受控日志 Tail、部署事件、恢复操作。
3. **Telemetry Infrastructure（0.0.2+）**：OTel Collector / hostmetrics / filelog，标准指标库和日志库，时间窗口搜索、留存与跨节点关联查询。长时间遥测不直接进 PG 控制面。

## 最小节点指标
`cpu.utilization`、`memory.used/total`、`filesystem.used/total`、`network rx/tx`（基础快照即可），plugin instance CPU/memory、start/restart count、readiness、lastHeartbeatAt。记录 sampledAt、unit、source、quality，NaN/unsupported/采集失败显示无数据，不显示 0。0.0.1 不承诺采样每秒连续保存。

## 三类日志
| 类型 | 0.0.1 | 后续 |
|---|---|---|
| Runtime diagnostics | Node 受控进程 stdout/stderr，有限环形缓冲和本地轮转 | 中央文件日志存储 |
| Live Tail | Kernel 经 Gateway 鉴权后 SSE 转发 Node 上指定实例日志；按流 backpressure | 多流合并、跨节点聚合 |
| Historical Search | 0.0.1 只查有界本地窗口，不宣称全局搜索 | Collector/Filelog → ClickHouse + 查询 UI |

### Log Event 契约原则
`eventId` 唯一、`streamId` 和 `epoch`、`sequence`、`occurredAt`（可无）、`observedAt`（必需）、`nodeId`、`instanceId`、`channel`、`level`、`message`（已做必要截断和脱敏）、`truncated`。Cursor 以 `streamId+epoch+sequence` 不透明编码并签名绑定权限范围，文件轮转造成不同 epoch。不能基于时间戳单字段保证无丢失/不重复。

### SSE 语义
- `GET /api/v1/instances/{id}/logs/live?cursor=...` 受会话授权；`Last-Event-ID` 仅为恢复提示，服务器对 stream/scope 验证。
- 事件 `log`、`gap`、`heartbeat`、`status`，最大事件大小、最大每秒事件、缓冲上限必须设定，溢出时发显式 gap；超出 retention 返回 `CURSOR_EXPIRED`。
- 过滤关键词最好在 Kernel/Node 服务端有界执行；Web `pause` 只暂停渲染还是停止订阅必须区分，并提示可能缺口。
- 多租户/环境限定流访问；日志正文转义、防止 ANSI 控制序列注入；默认不含凭据、原始 Prompt、客户秘密。

## 安装/升级失败如何救援
Recovery CLI 示例（建议实现，不是已可执行）：`opsctl status`、`opsctl nodes list`、`opsctl plugin disable id`、`opsctl doctor`、`opsctl logs kernel --tail=200`。CLI 经相同授权审计，禁绕过权限。Ops Center 插件坏掉仍能访问最小 Bootstrap 诊断路由。

## 为什么 0.0.1 不引入完整存储栈
引入 ClickHouse/VM/完整 Collector 不是验证全栈热插拔的最短路径。0.0.1 有最小健康/实时日志即可；但事件契约、身份和时间语义必须从首版统一，后续可添加独立数据面而无需重写 UI。
