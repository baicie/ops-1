# 多语言插件运行时规范 — Final 0.0.1

> **决策状态**：已接受的设计基线；落地完成与生产可靠性须由测试证据确认。参见 [ADR-007](adr/ADR-007-oci-multilang-runtime.md)、[Runtime Contract](../contracts/openapi/plugin-runtime-v1.yaml)。

## 核心不变量
1. Kernel = Rust/Axum/Tokio；Shell = React/TypeScript；业务插件后端**不限语言/框架**。Java/Spring Boot、Go、TypeScript/Node、Rust、Python 只是官方示例，不构成白名单。
2. **协议优先于 SDK**：业务后端只需实现 HTTP/JSON Runtime v1 协议、业务 OpenAPI、Ready/Live/Info；SDK 是可选封装，无权改变协议。
3. 正式部署后端使用 OCI 镜像 `repository@sha256:<digest>`；每个插件每个版本独立构建与签名。前端是不可变的静态资源，不要求单独运行容器。
4. 一个逻辑插件可以同时贡献 Web Route/Nav/Settings、同步 Service、异步 Worker（Worker 0.0.3+）、配置和持久化 Schema；发布/激活只有一个**版本化逻辑单元**，运行实例可以有 N 个。
5. 不以运行容器语言判断权限。所有授权由 Kernel Identity/Policy/Gateway 与插件内对象级校验共同完成。

## Backend Runtime v1 最小职责
- `GET /_opsweave/runtime/v1/info`：返回插件 ID/version、协议版本、能力声明摘要、build digest。输出与已安装 Manifest 验证；不得由容器自声明新的权限、插件身份、路由或租户。
- `GET /_opsweave/health/live`：本地进程生存；避免调用数据库、LLM、远程服务导致的循环重启。
- `GET /_opsweave/health/ready`：当前是否可接收新请求；不 Ready 不能进入 Effective Routes。
- `GET /_opsweave/health/startup`：可选，用于慢启动 Java/首次加载等；超时和失败策略由部署声明控制。
- 实际业务路径（如 `/api/catalog/*`）由各插件公开 OpenAPI 声明，Kernel Gateway 只暴露 Manifest 明确注册的路径前缀。
- 插件出站请求只能通过受控 Capability Client/Gateway 访问其他插件，服务注册逻辑不向租户泄露节点 IP。

## 语言无关 SDK 契约
| 实现 | 官方初版模板 | 统一义务 |
|---|---|---|
| Java 21 | Spring Boot starter / 可不使用 starter | Runtime Info、Health、请求关联、错误协议、关闭钩子 |
| Go | `net/http` + thin helper | 同上 |
| TypeScript | Node.js + Fastify（示例） | 同上 |
| Rust | Axum helper（可选） | 同上 |
| Python | FastAPI helper（后续） | 同上 |

所有模板运行同一个**黑盒 conformance suite**：验证 endpoint、timeout、header spoof、防超限请求、404/405 语义、权限失败、优雅停机。官方 SDK 不直接取得 Kernel 管理者密钥。任何语言均可跳过 SDK，按合约自行实现。

## 网络与身份边界
```
Browser → TLS ingress → Kernel Gateway → [private mTLS] Node Proxy → Plugin Container
                   └─ RBAC / tenant / capability / rate limit / audit
```
- 插件不得绑定公网接口；节点创建隔离网络，Node Proxy 只能访问其登记的 container ID、port 与 route generation。
- Gateway 删除或重写所有浏览器可伪造的 `X-OpsWeave-*` 身份头；若传递 caller context，仅使用带 audience、scope、exp、tenant、instance 的**内核签名短期工作负载凭据**，插件验证签名和对象级权限。
- 请求 trace context 与 workload caller identity 分离，`traceparent` 不是权限证明。
- Java/Go/TS 与 Rust 同样适用 Deadline、Body 大小、并发、熔断、幂等写和只读重试约束。
- 资源预算由 Node Runtime 在容器层执行（CPU、内存、PID、文件句柄等），不是读取 Manifest 即认为完成隔离。

## 0.0.1 的支持矩阵（约束）
- Linux amd64 参考环境；其他架构只在镜像清单有对应 Platform 且实际测试通过后支持。
- 生产参考容器适配器：**Rootless Docker Engine**（通过受控 Node Runtime 的本地 Unix socket 操作）。未来 Podman/containerd 与 Kubernetes 都必须通过新 Adapter/ADR/E2E 接入，不改变插件 OCI 制品格式。
- 初期仅支持可信发行者、审查后的镜像，不接纳任意公网开发者的可执行程序。
- 仅完成 HTTP/JSON 同步 Service 的双副本；异步 Worker、gRPC 数据面、多主 Kernel、NAT Relay 为后续能力。
- 单个 Node 上可运行多个不同语言容器，Node 无需安装 JDK/Go/Node 运行时，运行时封装在镜像中。

## 不要产生的耦合
- 禁止 Kernel 含 `if language == java` 的业务适配逻辑；Kernel 只看合同、OCI 制品、健康与能力。
- 禁止 Spring 特有注解成为插件准入条件；`plugin-sdk-java` 是便利封装。
- 禁止在安装时执行插件提供的任意宿主 shell 或任意 SQL；迁移由受控策略和插件专属角色执行。
- 禁止把 Java GC pause、Go goroutine、Node event-loop lag 统一解释成同一个标准指标；各自进程遥测通过 OTel 另行采集。
