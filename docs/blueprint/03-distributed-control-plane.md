# Node / Deployment / Reconciliation / Routing

## 一、节点模型
`node_id`、`node_identity`、`generation`、`os/arch`、`capabilities`、`labels`、`last_seen_at`、`observed_resources`、`status`、`cert_expires_at`。身份不能由节点提交的 name/IP 自证；Node 使用一次性 enrollment 经批准取得唯一证书和轮换策略。

## 二、两条网络通道（0.0.1 明确条件）
- 控制：Node 主动发起的长连接，经过 mTLS，携带 Hello/Desired/Observed/Event/Heartbeat/CommandAck；丢失后 Node 按受限离线策略运作。
- 数据：Gateway 经可路由私网到 Node 私有 mTLS reverse proxy，由 Node 转发到允许的插件容器端口，插件端口不对其他网络开放。**不承诺 NAT 穿透**，跨 NAT 的 Relay/Overlay 在 0.0.3+ 另做 ADR。
- 每个连接使用明确 max-connections、request-size、deadline、stream-count、backpressure；不能将实时日志无限排队在控制心跳线程里。

## 三、声明式部署
`PluginDeployment` 包含 `pluginId/version/artifactDigest/desiredReplicas/placement/resources/strategy/generation`。Node Runtime 收到的是**签名的、受 Kernel 授权的目标状态**，不是“随便执行命令”。

`Instance` 指向 Node、deployment、version、generation，状态 `STARTING/READY/UNHEALTHY/UNREACHABLE/STOPPED/UNKNOWN`，带 observedAt、health checks、container ID，不允许宿主进程随意改 registry desired state。

## 四、对账算法（简化）
```text
Every cycle or event:
  desired := read transactional snapshot from PostgreSQL
  observed := last authenticated Node reports (+ TTL)
  eligible := nodes passing identity, health, OS/arch, resource, label
  newPlan := diff(desired, observed, eligible)
  if plan stale vs deployment.generation: abort/retry
  persist plan + audit event; apply idempotent commands
  wait readiness and update effective route snapshot via CAS
  if timeout/unknown: preserve UNKNOWN; do not assume stop
```

系统设计为未来多 Kernel 预留 leader epoch/reconciler lease，但 0.0.1 只有一个 Kernel；不能因此声称实现了 leader election HA。node heartbeat 初始建议 10s、失联阈值 30s，必须可配置并用故障注入校准。

## 五、服务发现与路由
`Effective Routes = Healthy Instances ∩ Valid Activation Revision ∩ Allowed Policy`。
每个 request 绑定主控生成的 `trace_id` 和 `request_id`，包含调用方 Workload Identity、tenant/scope。路由使用超时与熔断；旧版 drain 时允许已接受请求完成至截止时间；健康并不等于已获得请求权限。

### 0.0.1 调度能力
- 可指定 `replicas`、nodeSelector、CPU/memory reservation、maxInstancesPerNode=1；默认无 GPU 调度。
- Node 心跳后资源报告具有过期时限；不可用节点不参与新放置。
- 控制面失联，普通已启动容器可继续提供受限**只读/已授权**请求至令牌有效期，禁止新敏感任务和部署；该策略必须测试。
- 0.0.1 做 **同步 Service 的双副本**，不在 0.0.1 交付分布式长任务引擎。

## 六、后续 AI Worker / 分布式 Job 的预留契约
Job、Attempt、Lease、FencingToken、Checkpoint、ResultVersion。长任务通过持久 Job认领（队列或数据库语义）；`SKIP LOCKED` 可以用于短事务 claim，不等于整个执行阶段持锁。每次 attempt 新 fencing token，持久写入端校验代次；外部模型调用可能重复计费，不承诺 exactly once。完整 Worker 和 Durable Job Scheduler 为 0.0.3+。

## 七、需要避免的设计陷阱
- 不用 Node 心跳是否在线替代业务插件 readiness。
- 不将同一插件两个副本视为两个独立安装版本。
- 不把 API Gateway 变成共享万能 RPC，所有能力有自己的版本化 schema。
- 节点资源声明不等于实际可用，必须保留配额/争用观测。
- 一台机器故障导致服务降级，并不自动意味着平台已经实现“故障自动迁移”——受状态与副本数约束。

## OCI 原生调度边界（修订）
- Scheduler 读取 `backend.imageRef@digest` 而不是语言/框架字段；Node 在部署前选择与镜像 OS/arch 匹配的 OCI Index Platform。0.0.1 验证 Linux amd64。
- Node Engine Adapter 的管理 socket 与插件容器分离，0.0.1 参考 Rootless Docker，禁止通过用户插件创建 privileged 或 host namespace 容器。
- Instance 额外记录 `runtime_adapter_version`、image digest、OS/arch、health 协议/快照和 Gateway Route Revision；可据此验证 Java/Go/TS 被同等调度。
- Node 控制与 Gateway 数据代理仅在受信私网内可用；生产 Plugin HTTP 端口不得对浏览器直连。详细见 [OCI 部署](22-oci-deployment-and-topology.md)。
