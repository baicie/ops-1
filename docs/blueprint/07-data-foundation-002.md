# 0.0.2 Data Foundation：第一个真实业务插件家族

## 两个独立、可热安装的全栈插件
- `opsweave.data-catalog`：`Dataset`、`SchemaDefinition`、`FieldDefinition`、`ModelRevision`、基础 `EntityType`；负责数据结构版本与注册，不负责连接外部源。
- `opsweave.data-integration`：`DataSource`、`ConnectorType`、CredentialReference、`SourceSnapshot`、`IngestionSpec`、`IngestionRun`、`QualityResult`；依赖 Catalog 公共 `data.catalog.v1`，不访问其私有表。
- 第一个 Connector 选 **HTTP/JSON（含样本文件）**，第二个可选 Zabbix 只做 **一条有边界的真实读链路**，不为了初版接入十种复杂源。

## 0.0.2 Golden Path
安装 Catalog → 创建 Dataset 与带版本的 Schema → 安装 Integration → 新建 HTTP/JSON Source + 授权 Secret Reference → Test Connection → Discover Fields → Preview Samples（只读，少量、有边界） → 映射目标字段 → Validate + Quality Report → 发布 IngestionSpec → 明确触发一次 IngestionRun → 写入 Dataset → 查看来源、版本、批次、错误。

## 模型表与数据语义
| 对象 | 关键语义 |
|---|---|
| DataSource | type、endpoint-ref、credential-ref、capability、owner、connectionStatus |
| Dataset | datasetId、ownerPlugin、schemaRevision、storageProvider、retentionPolicy |
| SchemaDefinition | immutable revision、fields、type、nullable、semantic tags、hash |
| FieldMapping | source path、target field、explicit cast/default、error policy |
| IngestionSpec | source pin、schema pin、transform revision、target dataset、schedule mode |
| IngestionRun | runId、inputCount、accepted/rejected/unknown、start/end、reason、source snapshot |
| DataLineage | source ID + revision → ingestion run → dataset ID + revision，首次只做到批次级 |
| DataQuality | 总数/缺失/校验拒绝/UNKNOWN、样本上限和计算分母 |

**Schema 不应与后端存储表一对一绑定**；Catalog 管语义/契约，具体数据存储由插件适配，核心数据治理先支持小样本、主键与字段映射，不承诺大规模 CDC/增量水位事务。

## 接入流程（0.0.2 不等于通用 DAG）
```text
Source → Parse → Project/Map → Validate → Dataset Sink
```
明确 Source 读取上限、批次、超时、最大原始样本体积，预览失败不调用 Sink。入库需要幂等 sourceBatchKey；外部源不可重复读取时要标记 UNKNOWN，而不是自动重发。

## UI
- Sources：列表+类型筛选/健康/最近验证/连接权限；Source Detail：概览、Connection Test、发现字段、失败诊断。
- Data Catalog：Dataset 列表、Schema Diff、版本不可变、字段类型与来源。
- Ingestion Run：批次状态/accepted/rejected/unknown、原错误列表（脱敏）、retry eligibility、查看 lineage。
- Form Wizard：Connect → Discover → Map → Test → Publish，阶段隔离、草稿可恢复。

## 验收
1. 从零通过插件管理器安装这两个插件，Kernel 和 Shell 二进制不变化。
2. Integration 没有 Catalog 依赖无法激活；Catalog 被依赖时非法 Disable 被拒绝。
3. HTTP/JSON 成功导入合法样本，错误数据拒绝且与 UNKNOWN 分离；预览不写目标。
4. 插件升级使用新 Schema 而旧 Schema 仍可读；不兼容发布拒绝并提供 Diff。
5. 插件禁用之后 Dataset 仍保留（访问可以显示插件不可用），恢复后没有重复写入。
