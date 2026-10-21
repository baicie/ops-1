# 0.0.3–0.1.0 未来能力路线与插件责任

## 0.0.3 Typed Pipeline Runtime
- 受控静态 Node Registry：Source/Parse/Map/Filter/Validate/Route/Sink；类型化输入输出端口、Schema 版本、纯函数转换。
- Pipeline IR 是版本化不可变 JSON，节点/边界上限，静态 DAG 无环检查，确定性执行次序，不允许任意用户代码与任意外部 HTTP。
- Worker 可分布式，但首版单批次有界执行；Checkpoint/Lease/Fencing 独立于 Workflow Graph；JobStore 由 Worker Runtime 接口实现。
- Telemetry 高频 OTLP 流不穿过用户可配置逐行 Workflow Executor，OTel Collector Receiver/Processor/Exporter 是独立数据面。

## 0.0.4 Pipeline Studio
- 左节点库、中画布、右属性、下方样本输入/输出/错误的四区编辑器；支持草稿、预览、版本 Diff、发布和回滚门槛。
- 可视化组件技术选择延后；交互契约不得依赖某家图编辑库内部格式，Graph IR 是唯一真相。
- 禁止“看起来能连”但图引擎无法执行；每一种可连接边必须匹配类型和数据契约。

## 0.0.5 Data Governance / Ops Center 扩展
- Lineage（来源→批次→数据集）、质量规则与门槛、保留期、敏感字段分类、跨插件 Dataset Grant。
- Ops Center 增加 OTel Receiver/Exporter 接入、历史日志和 Metrics；无需再造主机通用系统采集器。

## 0.0.6 Observability 插件
- Metrics/Logs/Traces 查询插件；导出与存储采用 OTel Collector、适配专业后端；Web/Android/iOS RUM 研究在 Nebula 项目独立推进。
- Entity/Topology 插件消费数据目录与标准服务资源标识；关联必须保留来源可信度和时间范围。
- 不将 PostgreSQL 作为海量指标点/原始日志主库；0.0.6 的存储选择需要实测性能和成本 ADR。

## 0.0.7+ AI 插件平台
- AI Model Provider/Tool Registry/Skill Registry/Investigation 作为官方插件；长任务经 Job Runtime 运行于多 Node。
- Agent 通过 Capability API 查询日志、指标、Trace/数据集，必须遵守只读、授权、费用、轮次和 Evidence Grounding。
- GPU 调度是 Placement 适配扩展；不假设某个模型必然需要 GPU（可能走外部 API）。

## 0.1.0 产品稳定窗口
进入 0.1.0 前必须有跨插件兼容矩阵、两节点/多版本回归、数据迁移演练、可重复故障注入与可追溯的 UI 视觉验收；不是看到几个页面正常就打正式版本。
