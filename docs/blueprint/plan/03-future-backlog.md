# 后续 Backlog，明确不阻塞 0.0.1

## 0.0.3
Typed DAG、durable execution、checkpoint/fencing、retry policy、批次/来源版本、Worker placement；数据面和控制面的隔离（OTel 仍由 Collector 负责）。

## 0.0.4
Pipeline Studio：Node Palette、Graph Editor、Property Inspector、Preview Trace、Diff/Publish、运行历史；Graph IR 唯一真相。

## 0.0.5
高级 Ops Center：历史日志存储、指标趋势、警报策略、数据质量规则、血缘和保留期。

## 0.0.6
Observability SDK/Collector、Metrics/Logs/Traces Explore、Host/Service/Instance 关联、OpenTelemetry 与 Nebula RUM 接入。

## 0.0.7+
AI Provider、Tool/Skill Registry、模型预算、多机 Worker、Evidence/RCA/Investigation、GPU placement、K8s provider、NAT Relay、multiple Control Plane replicas、external untrusted plugin sandbox、multi tenant isolation、Marketplaces。

## 进入版本门槛
未来需求须具备：独立用户故事、插件边界、依赖/Capability 契约、权限模型、故障语义、评测/成本和可回滚方案。未经批准不得偷渡到 Kernel。
