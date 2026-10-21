# 0.0.2 数据基座：Epics / 前后端功能计划

| ID | Epic | 子模块 | Done |
|---|---|---|---|
| D00 | Data Capability Contract | data.catalog.v1、data.source.v1、Data grants、Schema version | 两插件独立构建安装，Capability 测试通过 |
| D01 | Data Catalog Backend | Dataset/Schema Draft/Immutable Revision、类型、字段、权限 | Publish 与旧 revision 共存，禁止越权 |
| D02 | Data Catalog UI | Dataset list/detail、Schema Editor/Diff、Lineage summary | 空/失败/冲突状态完整且深链 |
| D03 | DataSource Backend | HTTP/JSON Connector、Test、Discovery、SecretRef、Snapshot | 实际 HTTP 访问+受限 SSRF，返回明确 failure |
| D04 | DataSource UI | Connection Wizard、字段发现、映射表、Preview | 预览无写入、失败可修复 |
| D05 | Ingestion Flow | Source→Parse→Map→Validate→Dataset Sink，单次 Run | 重复回执幂等、unknown 显式可见 |
| D06 | Quality & Run History | Input/accepted/rejected/unknown、Run/Batch、短期保留 | 来源和受控记录可追溯 |
| D07 | Integration Tests | Catalog 禁用保护、升级兼容、API 无跨表读取、真实数据 | 两插件在异节点上通过 Gateway 协作 |

## Done 测试案例
- Dataset field 加 nullable 字段是兼容升级，必填字段破坏升级须拒绝/分版本显式处理。
- Source connection 成功不等于样本读取成功；Discovery 无字段不等于空数据合法入库。
- 下游 Dataset 拒绝/超时，不自动把外部已发生写入算作失败可重试；以幂等键和回执核验。
- 插件的 `data.source.v1` 权限撤销后，正在预览的页面不能继续查看新数据。
- Catalog 插件 disable 时，有明确被 Integration 依赖的信息；无权限用户看不到敏感连接信息。
