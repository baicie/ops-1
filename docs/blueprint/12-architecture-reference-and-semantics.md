# 参考规范与协议语义说明

这些资料是**设计参考**而不是对我们实现状态的证明。依赖具体 API、版本、许可证必须在 bootstrap 阶段复核并锁定。

- [OpenTelemetry Collector 架构](https://opentelemetry.io/docs/collector/architecture/)：Receiver / Processor / Exporter 管线，用于未来专业遥测采集。
- [OpenTelemetry Collector Components](https://opentelemetry.io/docs/collector/components/)：不同信号的现成组件，避免重造采集器。
- [OWASP Third Party JavaScript Management](https://cheatsheetseries.owasp.org/cheatsheets/Third_Party_Javascript_Management_Cheat_Sheet.html)：可信/不可信浏览器插件的隔离区别。
- [PostgreSQL SELECT / SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html)：适用于有竞争队列消费者的短事务取锁，不替代长时任务租约。
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)：平台、插件、Node 的请求链路追踪。
- [RFC 9110 HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110)：HTTP API 行为。
- [WHATWG Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)：单向实时日志事件流。
- [OCI Image Specification](https://github.com/opencontainers/image-spec)：后端插件制品的规范基础。
- [Kubernetes Controller pattern](https://kubernetes.io/docs/concepts/architecture/controller/)：期望与实际状态持续对账模型。

**暂不锁定**各库最新小版本（Rust、React、OCI Runtime、Module Federation），因为文档不是已成功部署的仓库；实际 bootstrap 必须固定直接/传递依赖并记录通过测试的组合，不能复制想象中的 lockfile。
