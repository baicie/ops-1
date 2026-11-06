# ADR-016: G13-A — Source persistence, scoped identity, and evidence content binding

- 状态：Accepted（0.0.5 内增量）
- 日期：2026-11-06
- 基线：`main@79cb084`
- 前置：[ADR-012](ADR-012-capability-fabric-and-plugin-storage.md)、[ADR-015](ADR-015-evidence-attestation-and-telemetry-sources.md)、`rules/01`、`rules/03`、`rules/05`
- 相关实现：`apps/kernel/src/gateway.rs`、`apps/kernel/src/incidents.rs`、`plugins/zabbix-source/backend/`、`contracts/openapi/zabbix-source-v1.yaml`

## 1. 背景

ADR-015 把证据信任交给 Kernel 校验，并让 Zabbix 成为独立插件。G13-A 要把它变成一条真实业务闭环：选择 Incident → Source → Host/Item/时间窗 → 采集 → 签名 → Kernel 保存字节 → Investigator 引用 → 人工裁定。

现状有四个必须解决的缺口：

1. `server.mjs` 的 `SOURCES` / `COLLECTIONS` 是进程内 `Map`，插件重启即丢配置，已完成的采集也无法再取来签名（R-11 / N-9）。
2. 插件直接读取 `x-opsweave-user-role`，不验证 Gateway 身份；`x-opsweave-caller-context` 也不验签。G10 权限 ADR 的 R1 已登记该风险。
3. `contentRef` 只覆盖采集结果的一个子对象，插件从不把对应字节交给 Kernel；Kernel 的 `content` 存储路径已存在（0018），但两者没有接上。
4. `GET /sources` 返回 `{sources,nextCursor}`，契约要求 `{items}`；`package.json` 指向不存在的 `server.test.mjs`。两者都是基线缺陷。

## 2. 决策

### 2.1 Source 与 Collection 落插件自有 Schema

- 只使用 Kernel 注入的 `OPSWEAVE_PLUGIN_DATABASE_URL`；该 URL 的角色只有 `plugin_<id>` schema 的 `USAGE/CREATE`，`search_path` 已指向该 schema（ADR-012 §3）。Kernel 不新增 Zabbix 表。
- 新增表（均 additive）：
  - `zabbix_sources`：`source_id` 稳定 UUID、`workspace_id`、`created_by`、名称/端点/凭据引用/预算、`status` 与 `last_probe`、`created_at/updated_at`。
  - `zabbix_source_audit`：创建、更新、探活的操作者、动作、细节与时间。
  - `zabbix_collections`：`collection_id`、`source_id`、`workspace_id`、`created_by`、`outcome`、`content_ref`、证据快照 `body`、`observed_at`、`expires_at`。保留有上限（时间 + 行数），过期后 `/attestation` 返回 404，而不是签一份不存在的数据。
- 迁移是插件内的有序 additive 计划，记录在 `zabbix_schema_migrations(version, checksum, applied_at)`，带 advisory lock 与 checksum 校验；已应用的版本 checksum 变化即拒绝启动。没有 DROP/反向迁移。
- **fail closed**：没有 `OPSWEAVE_PLUGIN_DATABASE_URL` 或数据库不可用时，生产模式启动失败，不以内存配置静默降级。只有显式 `OPSWEAVE_ALLOW_MEMORY_STORAGE=1`（仅测试/本地）允许内存模式，且 `/runtime-info` 必须报告 `storage.mode = "memory"`。
- 凭据仍只存 `secretref:`；Token 只在单次调用内解析，永不入库、不出接口、不入日志。探活结果与时间持久化。

### 2.2 Kernel 签名的调用者身份（含 Workspace）

- Gateway 代理用户请求时，不再只注入裸的 `x-opsweave-user-role`。它额外注入：

  `x-opsweave-user-context: owu1.<base64url(payload)>.<base64url(HMAC-SHA256)>`

  payload 为 `{v:1,userId,role,pluginId,workspaceIds,issuedAt,expiresAt,requestId}`，密钥是由 Kernel 的 cursor secret 按 `caller-context:<pluginId>` 派生的每插件密钥（与 workload context 同一派生，不同前缀）。
- Gateway 在签发前读取 `kernel.business_workspace_members` 得到**权威**成员集合；admin 不会因为角色自动获得任何 workspace。
- 插件验证签名、`v`、`pluginId`、过期时间后才接受身份；**不再读取裸的 `x-opsweave-user-role`**。workload 调用必须验证 `oww1` caller-context（与 data 插件相同），其 workspace 只能来自 grant scope 中的 `workspace:<uuid>`。
- 这样即使插件数据端口被同网段容器直连，伪造角色头也不构成身份；R1 的边界从"网络位置"变成"持有每插件密钥"。
- Source 的 `workspaceId` 在创建时必填且不可变；列表、探活、hosts/items/collect、attestation 都要求 `source.workspace_id ∈ identity.workspaces`，越界一律 404（不泄露存在性）。Incident 一侧仍由 Kernel 的 `DataScope` 判定，插件不代替它。

### 2.3 证据快照与内容字节

- 插件新增导出的 `evidenceSnapshot(result)`：对 `{sourceId,outcome,requestedItems,answeredItems,clamped,budget,observedAt,series}` 做确定性 canonical JSON，得到**恰好**要提交的字节；`contentRef = "sha256:" + sha256(这些字节)`。签名覆盖该 digest。
- 若 canonical 字节超过 Kernel 的 65536 字节上限：
  - 生成有界快照（先按每 series 样本上限收缩，再按顺序丢弃尾部 series），记录 `originalBytes`、`maxBytes`、`requestedSamples`、`returnedSamples`、`droppedSeries`、`reason=CONTENT_LIMIT`；
  - `outcome` 变为 `PARTIAL`；
  - 签名只覆盖实际快照，不宣称包含全部原始数据。
- `/collections/{id}/attestation` 的响应新增 `evidence.content = {contentType:"application/json", body}`，body 与 `contentRef` 逐字节一致；attestation 升级为 v2，签名覆盖 Collection 行中的 `workspaceId`，Kernel 与 Incident 的 workspace 比较后才写入（ADR-015 §5.1）。调用方把 `attestation` 与 `content` 一起 POST 到 Kernel 的 evidence 端点；Kernel 自行计算摘要、验签、保存字节。插件与 UI 都不能填写 `verifiedTrust`。
- 采集结果只在插件内保留有界时间；签名响应可重放同一 collectionId（同一字节、同一 digest），Kernel 的唯一约束会把它折叠为同一行。

### 2.4 契约修正

- `GET /sources` 统一为 `{items:[...]}`，与 OpenAPI 一致；仓库内没有既有消费者依赖 `sources` 字段（Sources 页面目前是 fixture 壳）。
- `POST /sources` 增加必填 `workspaceId`；`ZabbixSource` 返回 `workspaceId`。新增 `PUT /sources/{sourceId}` 用于名称/端点/凭据引用/预算更新，并写审计。
- `CollectionResult` 增加可选 `snapshot`；`/attestation` 响应增加 `content`。错误码增加 `ZBX_SOURCE_CONFLICT`、`ZBX_STORAGE_UNAVAILABLE`、`ZBX_IDENTITY_UNVERIFIED`。

## 3. 备选方案与否决

1. **插件继续信任角色头，只靠网络策略**：否决。R1 已说明部署一旦暴露数据端口即可伪造。
2. **插件向 Kernel 查询 workspace 成员**：否决。插件没有用户会话，且会引入一次跨进程授权查询；签名上下文一次携带权威结果更简单。
3. **把完整遥测写进 Kernel 或对象存储**：否决。ADR-015 与 64 KiB 边界明确；用有界快照并如实标注 PARTIAL。
4. **插件把 Token 交给 UI 代签**：否决。签名密钥不得离开插件进程。

## 4. 影响与风险

| 风险 | 处理 |
|---|---|
| Gateway 每请求多一次成员查询 | 单表索引查询；可按用户短缓存，但首版不做缓存，避免撤销后仍可见 |
| 生产环境未 provisioning storage binding | 插件 fail closed 并在 `/runtime-info` 报 `storage.mode=unconfigured`；部署清单必须包含 `POST /api/v1/plugin-storage/opsweave.zabbix-source` |
| HMAC 共享密钥（延续 ADR-015 R-2） | 每插件派生密钥 + 300s/120s 窗口；非对称签名仍留后续 |
| 64 KiB 快照丢失原始样本 | 明确 `snapshot` 元数据与 PARTIAL，不声称完整；原始采集仍受预算上限约束 |
| Collections 保留期后无法补签 | 返回 404 `COLLECTION_NOT_FOUND`，由 UI 提示重新采集，不签过期数据 |
| 迁移 checksum 锁死 | 只允许新增版本；修改已应用 SQL 会拒绝启动，需新版本迁移 |

## 5. 验收

- `GET /sources` 契约、服务端、Schema、示例、契约测试一致；真实 HTTP 测试覆盖。
- `node --test plugins/zabbix-source/backend/*.test.mjs`：纯函数 + 真实 server socket + 真实 PostgreSQL 持久化（创建→重启→仍在；无 SecretRef 拒绝；并发/重复；DB 不可用 fail closed；多 workspace 隔离）。
- Kernel：伪造 user-context、过期、错插件密钥、跨 workspace 全部拒绝且有测试；合法签名路径通过。
- 证据：插件字节 → Kernel 摘要一致 → `SOURCE_ATTESTED` → 读回相同字节；错误摘要/重放/跨 incident 全部拒绝。
- Golden Path 用隔离 PostgreSQL、真实 Kernel、真实插件 HTTP、真实 Gateway；上游标注 `UPSTREAM_ZABBIX_FIXTURE`；真实 Zabbix 为 `NOT_RUN`。
- 新增测试被 CI 实际执行（不是只存在于仓库）。
