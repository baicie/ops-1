# ADR-006：0.0.2 Data Catalog / Integration 独立插件（接受）

- **决策**：Dataset/Schema 与 DataSource/Connector/Run 分别拥有独立版本、Schema 和 Capability，通过 Gateway 调用。
- **首版闭环**：HTTP/JSON Connect → Discover → Map → Preview → Validate → Dataset Sink；预览不写入；禁止 Catalog 在被依赖时意外 Disable。
- **后续**：0.0.3 才将固定数据流扩展为 Typed Pipeline IR 和 Durable Job；高吞吐 OTLP 走独立 Collector。
