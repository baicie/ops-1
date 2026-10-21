# M-05 数据契约与迁移规则

- MUST：Kernel、插件各有 Schema/Data Ownership，跨插件通过公共 Capability API；禁止直接访问别的插件私有数据库表。
- MUST：Schema/Plugin Version 固定且可追溯；迁移有审批、Checksum、唯一迁移 ID、幂等可重入策略及失败处理。
- MUST：`EMPTY`、`NO_DATA`、`PARTIAL`、`UNKNOWN` 与成功有不同状态；预览只读，缺数据不能转为 0。
- MUST：写操作有幂等/核验机制，超时后先查询执行结果，不盲目重试；保留输入、输出数量与未知分母。
- SHOULD：0.0.2 只接受 Schema 可控的 HTTP/JSON、固定映射流程；高速遥测使用 OTel 专用管线。
- Gate：安装/禁用/升级两个数据插件不破坏已有 Dataset；错误和缺失有可查询证据。
