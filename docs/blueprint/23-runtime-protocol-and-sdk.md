# Plugin HTTP/JSON Runtime v1 与 SDK 一致性

## 核心端点与稳定语义
参见 [OpenAPI](../contracts/openapi/plugin-runtime-v1.yaml)。Runtime 端点供**Node 内部探测或 Kernel 私有 Gateway**调用，不直接提供互联网访问。

| 请求 | 成功 | 失败与边界 |
|---|---|---|
| `GET /_opsweave/runtime/v1/info` | 包含 ID、version、`runtimeProtocol=http-json-v1`、capabilityDigest、buildDigest | 与可信 Manifest 不一致则 `NOT_READY/REJECTED` |
| `GET /_opsweave/health/live` | 200 | 500 表示自身状态不可继续服务；不能依赖下游查询作每次 Liveness |
| `GET /_opsweave/health/ready` | 200 | 503 not ready，不进有效路由；停机时先变 not ready |
| `GET /_opsweave/health/startup` | 200（可选） | 超时/失败依据启动策略进入 Failed 或重试有界 |
| `GET /api/<prefix>/...` | 具体业务 Schema | Gateway 和业务服务双重授权，明确 idempotency |

## HTTP 约束
- Protocol v1：HTTPS/mTLS 保护 Gateway↔Node；Node↔Container 在不可公网的专用本地网络中，强制身份隔离。HTTP/1.1 JSON 即可；gRPC 是后续可选 Adapter，不要求首版。
- 标准响应 `requestId`, `code`, `message`, `retryable`，不可外泄 private host/stack。
- Header：`X-OpsWeave-Request-Id` 仅日志关联；`X-OpsWeave-Caller-Context` 若引入，必须为由内核签名的短期令牌，后端严格验 `iss,aud,sub,tenant,scope,exp` 与当前对象权限。
- 超时、内容长度、最大并发、停止接入期间 Grace Period、幂等键冲突处理需要有标准测试；节点不得替插件随意重试有副作用请求。
- 业务 API 应避免把后端框架的特殊类型/异常流出 public schema。

## SDK 拆分
`plugin-contracts`（唯一 Schema/OpenAPI） → 生成不同语言 DTO/Client（只生成类型，禁止手改） → `plugin-sdk-*`（可选的便利封装）。Plugin Web SDK 从 Shell 获取 Capability Client、Host Router、Design Tokens；不能得到原始会话 Token。

SDK 只能完成：绑定 Runtime Info/Health、结构化日志/Trace Context、安全调用 Capability Gateway、Graceful Shutdown。不得代替业务权限判断、擅自签发工作负载凭据、管理容器或数据迁移。

## Conformance Test Harness
Tester 对真实实例（容器）发送不同条件：
1. `GET info` 的 manifest identity/version/digest 匹配。
2. 启动中 `ready=503`、正常后 200；`live` 不依赖故意故障的下游。
3. 路由只在 readiness 通过后可用，停用或权限撤销后拒绝调用。
4. 大 Body/超时/非法 JSON、伪造 caller header、未知路径、错误响应闭合。
5. 请求追踪 requestId 与 trace context 不影响授权；未知 tenant 不得响应数据。
6. SIGTERM 时先 not-ready、等待有限窗口，再中止；旧副本 Drain 状态可见。
7. 同一个测试规范对 Java、Go、TS 三个真实服务运行，语言不会改变 Gateway 行为。

0.0.1 中 Java/Go/TS 的 Hello 示例皆为**真实部署验收对象**；Rust/Python 在协议定义层支持，官方 SDK 可后续跟进。不要宣称所有语言已经完成测试。
