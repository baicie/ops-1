# Runtime Events / Audit / SSE Contract

## 统一事件外壳
- `eventId`：全局唯一，用于审计去重。
- `eventType`：如 `plugin.staged`, `plugin.activated`, `deployment.ready`, `node.unreachable`, `instance.log.gap`。
- `occurredAt`、`observedAt`：可能不同，事件时间不能冒充接收时间。
- `actor`：User/Kernel/Node/Workload 明确区分；由可信来源构造。
- `subjectRef`：plugin/deployment/node/instance；包括版本/generation。
- `requestId`、`causationId`、`correlationId`、`traceId` 可选，不能自造成功。
- `result`：`ACCEPTED/CONFIRMED/REJECTED/UNKNOWN`。
- `details`：有界、脱敏、被授予的 scope；不暴露密钥、原始日志批量正文。

## 状态生命周期
- `PluginPackage` 是安装制品，不等于运行实例；`PluginDeployment` 是期望复制集，不等于单个 `PluginInstance`。
- `Node ONLINE` 是认证的心跳最近可见；`Instance READY` 是就绪探测见证；`EffectiveRoute` 是通过当前权限和 activation revision 可使用的实例集合。
- 失联时 `observedAt` 仍保留最后见证，状态进入 Unknown/Unreachable，不能因为没有报告就当进程停止。

## SSE
- Server-Sent Events 流 `event: log`, `event: status`, `event: gap`, `event: heartbeat`。
- 消息中的 `id:` 是**不透明的签名 cursor**，不是 Node 本地文件路径、业务主键、递增序号原文。
- 按 `streamId + epoch + sequence` 定位续传，超限或轮转造成缺口时发显式 gap，客户端重新订阅需重新授权。
