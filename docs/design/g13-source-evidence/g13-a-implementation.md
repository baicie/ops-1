# G13-A — 真实遥测采集到 Incident Evidence 的端到端闭环

- 日期：2026-11-06
- 基线：`main@79cb084`
- 后端/插件 PR：[#38](https://github.com/baicie/ops-1/pull/38) `feat/g13-a-source-evidence`（Draft，base main）
- UI PR：[#39](https://github.com/baicie/ops-1/pull/39) `feat/g13-a-collect-ui`（Draft，base `design/opsweave-ds-v1-2`）
- 本文件所在分支：`feat/g13-a-source-evidence`
- 说明：#34 / #35 未合并，UI 按约束建立在 #35 基线上；本功能不改写两条冻结分支的历史。

## 1. 结论摘要

G13-A 把 Zabbix 从“能采集、能签名”推进到“采集结果作为不可变字节进入 Incident Evidence，并由 Kernel 独立验签、摘要、保存”。本轮**没有**重写 Incident、Evidence、Human Verdict、Investigation Runner 或 Zabbix JSON-RPC 适配器。

已落地：

- `GET /sources` 契约漂移修复（`{items}`），以及另外两个审计中发现的漂移：`clamped` 实际是数组而契约写成布尔、`collect()` 从未生成契约要求的 `collectionId`。
- 插件拥有自己的 PostgreSQL Schema：Source 跨重启保留、凭据只存 `secretref:`、探活结果与时间持久化、配置更新审计、Collection 有界保留。
- Kernel → 插件的用户身份改为每插件密钥签名的 `x-opsweave-user-context`，携带 Kernel 当次查询出的 Workspace 成员集合；插件不再读取裸的 `x-opsweave-user-role`。
- 采集结果生成确定性的证据快照字节，`contentRef` 就是这些字节的 SHA-256；超过 64 KiB 时生成有界快照并标 PARTIAL。attestation 响应携带字节，Kernel 自行计算摘要、验签并保存。
- 真实 HTTP Socket 测试、真实 PostgreSQL 持久化测试、真实 OCI 镜像构建/非 root/健康检查。
- 前端在 IncidentDetail 证据区提供 Collect from source，采集与保存分离，覆盖 13 个状态；浏览器测试覆盖 390px 完成采集与保存。

**未运行**：真实 Zabbix 实例；完整 Golden Path（真实 Kernel + 真实 Node Runtime + 容器插件经 Gateway）；真实模型调查。详见第 9 节与第 11 节 verdicts。

## 2. 架构

```text
Browser (IncidentDetail)
   │  collect / attestation (session cookie)
   ▼
Kernel Gateway  /api/v1/gateway/opsweave.zabbix-source/...
   │  strips client x-opsweave-*; injects signed user context
   │  {userId, role, pluginId, workspaceIds, exp, requestId}
   ▼
Node data proxy  /internal/v1/proxy/{instanceId}/api/zabbix-source/...
   │  bearer data_token; forwards the signed headers
   ▼
Zabbix plugin (own schema plugin_opsweave_zabbix_source)
   │  verifies HMAC context; workspace scope; budget; SSRF guard
   │  collect → canonical evidence snapshot + sha256
   ▼
Zabbix JSON-RPC (real instance or UPSTREAM_ZABBIX_FIXTURE)
   │
   ▼
Plugin signs (adapterId, incidentId, kind, source, collectedAt, contentRef, issuedAt)
   │  returns evidence.content.body = exact bytes
   ▼
Browser relays attestation + content to
Kernel POST /api/v1/incidents/{id}/evidence
   │  incident scope; derive sha256(body); contentRef match;
   │  verify HMAC; CHECK constraints; write evidence + content in one tx
   ▼
Kernel evidence row: verified_trust=SOURCE_ATTESTED, method=SOURCE_ADAPTER
   │
   ├─ GET .../evidence/{evidenceId}/content → same bytes, fixity re-checked
   └─ Investigation Runner read_evidence tool → same rows/content
```

## 3. 复用与缺口

| 能力 | 复用于 | 本轮动作 |
|---|---|---|
| Incident/Evidence API 与 scope | `apps/kernel/src/incidents.rs`、`scope.rs` | 不改语义；新增跨进程内容+签名测试 |
| Evidence Content 存储/读回/保留期 | G12 B（迁移 0018） | 直接复用；插件提供字节 |
| Adapter 验签与 `SOURCE_ATTESTED` | ADR-015 / 0017 | 不改判定；只把字节接上 |
| Investigation 只读证据工具 | `investigations.rs` | 不改；Golden Path 中应引用同一 evidenceId（本轮未跑，见 §9） |
| Workspace 成员与 Incident Scope | `workspaces.rs`、`scope.rs` | Gateway 新增权威成员查询并签名 |
| Plugin Schema/角色 | ADR-012 / `storage.rs` | 复用 `OPSWEAVE_PLUGIN_DATABASE_URL`；插件内 additive 迁移 |
| Zabbix 七态/预算/SSRF/脱敏 | `zabbix.mjs` | 复用；新增快照与字节输出 |
| 组件体系 | DS-V1-2（#35） | 复用 PageHeader/DialogFrame/Async 语义；不建第二套 |

缺口与处理：

| 缺口 | 处理 |
|---|---|
| Source/Collection 仅在内存 | 插件自有 schema + 有界保留 |
| 插件信任未签名角色头（G10 R1） | 仅接受 Kernel 签名的 user/workload context |
| `contentRef` 没有对应字节 | `buildEvidence()` 产出字节；attestation 返回；Kernel 摘要校验 |
| `GET /sources` 返回 `{sources,...}` | 改为契约的 `{items}`；仓库内无既有消费者 |
| `package.json` 指向不存在的 `server.test.mjs` | 新增真实 socket 套件并纳入 CI |
| `clamped` 契约与运行时不一致 | 契约改为命名的数组 |
| `collect()` 未生成 `collectionId` | 生成稳定 UUID 并随结果返回/入库 |

## 4. 契约与迁移

契约（`contracts/openapi/zabbix-source-v1.yaml`、`contracts/schema/zabbix-source.v1.schema.json`）：

- `GET /sources` → `{items:[ZabbixSource]}`。
- `POST /sources` 必填 `workspaceId`；`POST /sources/{id}/probe`、hosts/items/collect 均按签名 Workspace 过滤。
- 新增 `PUT /sources/{sourceId}`（名称/端点/凭据引用/TLS/预算；Workspace 不可变；审计）。
- `CollectionResult.clamped` 为字符串数组；新增可选 `snapshot`（`maxBytes/originalBytes/truncated/reason/requestedSamples/returnedSamples/droppedSeries`）；`snapshot.truncated=true` 时契约强制 `outcome=PARTIAL`。
- `/collections/{id}/attestation` 的 `evidence` 新增 `content {contentType, body}`；`body ≤ 65536`，其 SHA-256 必须等于 `contentRef`。
- 新增 `503 StorageUnavailable` 与错误码 `ZBX_SOURCE_CONFLICT`、`ZBX_STORAGE_UNAVAILABLE`、`ZBX_IDENTITY_UNVERIFIED`、`ZBX_WORKSPACE_REQUIRED`。

ADR：[`ADR-016`](../../adr/ADR-016-g13-source-persistence-scoped-identity-and-evidence-content.md)。

迁移（插件内，additive，带 checksum 与 advisory lock）：

```sql
zabbix_schema_migrations(version, checksum, applied_at)
zabbix_sources(source_id, workspace_id, created_by, name, endpoint,
               credential_kind, credential_ref, verify_tls, status,
               last_probe, budget, created_at, updated_at,
               UNIQUE(workspace_id, endpoint))
zabbix_source_audit(audit_id, source_id, workspace_id, actor_id, action, detail, at)
zabbix_collections(collection_id, source_id, workspace_id, created_by,
                   outcome, content_ref, body, observed_at, expires_at, created_at)
```

## 5. Source 持久化

- 启动时读取 `OPSWEAVE_PLUGIN_DATABASE_URL`（Kernel 按 ADR-012 注入的 plugin schema/role）。连接或迁移失败 → 进程退出；没有 URL 且未设置 `OPSWEAVE_ALLOW_MEMORY_STORAGE=1` → 退出码 1。内存模式只在测试/本地显式开启，并由 `/runtime-info` 报告 `storage.mode`。
- 迁移在启动时执行，checksum 已应用后变化即拒绝启动；没有 DROP/反向迁移。
- Source ID 是创建时生成的 UUID，持久化后稳定。凭据只存 `secretref:`，并有数据库 CHECK；Token 只在单次调用中解析。
- 探活是唯一改变 `status` 的路径，`lastProbe` 与时间随 source 持久化。
- 创建/更新/探活写审计；重复 `(workspace_id, endpoint)` 返回 409（并发创建只有一个成功，见测试）。
- Collection 保留 24h 且每 Workspace 最多 500 条；过期后 `/attestation` 返回 404，而不是签一份不存在的数据。

## 6. 采集与签名数据流

`buildEvidence(result)`：

1. 覆盖 `{sourceId,outcome,requestedItems,answeredItems,clamped,budget,observedAt,series}`；
2. `canonical()` 生成稳定 key 顺序的 JSON；`contentRef = "sha256:" + sha256(bytes)`；
3. 超过 65536 字节时：先降每 series 样本上限，再按顺序丢弃尾部 series；`snapshot` 记录原始字节、请求/返回样本数、丢弃 series 数与 `CONTENT_LIMIT`；`outcome` 变为 `PARTIAL`，签名覆盖快照本身；
4. `collect()` 只构建一次字节，并以不可枚举属性交给服务器持久化；HTTP 响应仍是契约的 `CollectionResult`，不含 `evidenceBody`。

attestation：

- 读取已持久化的 `content_ref` 与 `body`（重启后仍可取）；
- 拒绝 `UNAVAILABLE` / `UNKNOWN`（以及 UI 层的 `TIMEOUT`）；
- 签名覆盖 `v, adapterId, incidentId, kind, source, collectedAtUnix, contentRef, issuedAtUnix`；
- 返回 `evidence.content = {contentType:"application/json", body}`。

Kernel：

- 从 `content.body` 自行计算 sha256，与请求里的 `contentRef` 不一致 → `EVIDENCE_CONTENT_REF_CONFLICT`，不写入；
- 校验签名（未知 adapter / 签名错误 / 时间窗）后才写 `SOURCE_ATTESTED`；
- evidence 行与 content 行在同一事务；读回时重新计算摘要，损坏则 500 而不是返回坏字节。

## 7. 权限矩阵

| 场景 | 期望 | 实现/证据 |
|---|---|---|
| 无签名身份 / 仅 `x-opsweave-user-role` | 401 `ZBX_IDENTITY_UNVERIFIED` | socket test |
| Viewer 读 sources | 200 | socket test |
| Viewer 创建/更新/探活/采集/attestation | 403 | socket test（写路径）；`requireUser` |
| Operator 在 Workspace A | 可创建/采集/签名 A 的 source | socket test |
| Operator 只属于 A，访问 B 的 source | list 不返回；get/probe/collect/attestation 404 | socket test |
| 同一 Operator 属于 A+B | 两个 Workspace 的 source 都可见 | 按签名 `workspaceIds` 过滤 |
| Workload 调用 | 只能读，且只在其 grant 的 `workspace:<uuid>` 内；写 403 | socket test |
| 伪造 user context（错误密钥） | 401 | socket test + Kernel 单测 |
| 过期/错插件绑定的 user context | 401 | identity resolver + Kernel 单测 |
| Incident 已关闭 | 前端隐藏入口；Kernel 仍拒绝写 | 复用 Kernel 409 |
| Incident Owner Transfer | 不影响插件 Source scope；Kernel 按 Incident scope 判定 | 未新增插件逻辑 |

## 8. 失败语义

插件保留七态，并新增证据快照：

| 状态 | 含义 | 可否保存证据 |
|---|---|---|
| `OK` | 窗口被覆盖且有样本 | 是 |
| `EMPTY` | 源端权威回答“此窗口没有记录” | 是（缺失被确立） |
| `NO_DATA` | 无法确立是否有记录 | 是（作为“无法确立”的事实） |
| `PARTIAL` | 部分 item 无答案或预算/内容裁剪 | 是（快照/分母如实） |
| `UNKNOWN` | 请求发出后结果未知 | 否 |
| `UNAVAILABLE` | 端点从未连上 | 否 |
| `TIMEOUT` | 截止时间先到 | 否（UI 与插件一致拒绝） |

`PARTIAL` 不会被显示为 `OK`：契约强制 `snapshot.truncated → outcome=PARTIAL`，运行时同样覆盖；socket test 断言裁剪快照的 outcome 与字节上限。

## 9. 真实运行过的命令与结果

环境：macOS 15.7.7 / Apple M1；Node 22；PostgreSQL 17（本地 5432）；Docker 29.7.2。

| 检查 | 结果 |
|---|---|
| `node --test plugins/zabbix-source/backend/zabbix.test.mjs` | PASS — 26/26 |
| `node --test .../server.test.mjs`（真实端口 + 真实 HTTP upstream fixture） | PASS — 20/20 |
| `node --test .../storage.test.mjs`（真实 PostgreSQL，`OPSWEAVE_REQUIRE_PLUGIN_DATABASE=1`） | PASS — 8/8 |
| `npm test`（三套合计，真实库） | PASS — 55/55，0 skipped |
| `cargo test -p opsweave-kernel --bin opsweave-kernel incidents::tests::`（真实 PostgreSQL） | PASS — 59/59，含 byte-for-byte、错误摘要拒绝、无字节 attestation 拒绝 |
| `cargo test ... a_user_context_is_bound_to_one_plugin_key` | PASS |
| `python3 tests/contract/validate_contracts.py` | PASS — 16 schemas / 6 examples，含新增负向检查 |
| `cargo clippy -p opsweave-kernel --all-targets -- -D warnings` | PASS |
| `pnpm --filter @opsweave/platform-web typecheck`（UI 分支） | PASS |
| `node scripts/check-i18n.mjs` | PASS — 2000 keys × 2，17 条既有 unused |
| `pnpm ... vitest run src/pages/incident-collect.test.ts` | PASS — 13/13 |
| `playwright test g13-collect-evidence.spec.ts`（本地 Kernel 18181，API stub） | PASS — 4/4 |
| `scripts/build-zabbix-plugin.sh` | PASS — image `sha256:924d59e0…`, User `65532:65532`, signed bundle |
| 容器 `/livez` `/readyz` | 200/200；`/runtime-info` storage.mode=memory |
| 无存储启动容器 | exit 1，拒绝以内存注册表启动 |
| `node tests/ci/g13a_evidence_roundtrip.mjs`（真实 Kernel 进程 + 真实插件进程 + 真实 PostgreSQL + 本地 HTTP fixture） | PASS — 插件签名字节 → Kernel 验签 `SOURCE_ATTESTED` → 读回逐字节一致；Investigation Runner 的 `TEST_FIXTURE` 读取并引用该 evidence；人工 Verdict 单独写入 `CONFIRMED`；跨 Workspace 列表为空/404；插件重启后 source 与 collection 仍可用 |
| PR #38 CI | 见 §10（提交时 pending） |

**跨进程证据闭环**：已运行 `tests/ci/g13a_evidence_roundtrip.mjs` 并通过——真实 Kernel 进程、真实插件进程、真实 PostgreSQL、真实 HTTP。插件产生的字节被 Kernel 以 `SOURCE_ATTESTED` 写入，内容端点读回逐字节一致；插件重启后 source 与 collection 仍可用；Workspace 越权列表为空、探活 404。上游是 `UPSTREAM_ZABBIX_FIXTURE`。

**完整 Golden Path（真实 Gateway + 真实 Node + 容器）**：`NOT_RUN`。剩余缺口：
- Kernel Gateway 的身份注入/转发只有单测（`user_context_token`）与插件侧验证，未在三进程链路中实测；
- 真实 Node Runtime 拉取 image 并启动容器；
- 适配器密钥送达插件的机制（当前 Kernel 只向实例注入 context key、DB URL、allowlist，不注入 adapter secret；生产需要插件 secret store，尚未实现）；
- 真实模型 provider（本轮用 `TEST_FIXTURE`，不声称 REAL_MODEL_E2E）。

这些是下一阶段的首要工作，不能把跨进程闭环当作完整 Gateway/Node 路径通过。

**真实 Zabbix**：`NOT_RUN`，socket 测试使用本地 `UPSTREAM_ZABBIX_FIXTURE`，不声称真实响应形状已验证。

**截图**：UI 分支捕获了 8 个组合（1440/1024/768/390 × light/dark × en/zh-CN）到 `artifacts/ui/g13-collect/`，作为证据目录不提交；Playwright 同时断言弹窗与页面均无横向溢出。完整 16 组合矩阵仍未覆盖。

## 10. CI

- 新增 `ci.yml` 的 `zabbix-plugin` job：真实 PostgreSQL service、`npm ci`、unit + real-socket + persistence，`OPSWEAVE_REQUIRE_PLUGIN_DATABASE=1`（缺库即失败，不静默跳过）。
- `g12-acceptance` 的脚本与 path filter 加入 `tests/ui/g13-collect-evidence.spec.ts`，`check-spec-coverage` 报 39 covered / 0 unreferenced。
- PR #38 / #39 的 CI 结果在合入前复核；本轮报告不把 pending 写成 pass。

## 11. Verdicts

| Verdict | 状态 | 依据 |
|---|---|---|
| `SOURCE_PERSISTENCE_READY` | **PASS** | 8 个真实 PostgreSQL 测试：重启保留、凭据引用、并发/重复、DB 不可用、多 Workspace、迁移 checksum |
| `CONNECTOR_RUNTIME_READY` | **PARTIAL** | 20 个真实 socket 测试；OCI 镜像 digest 固定、非 root、健康 200、无存储 fail closed。生产实例拿不到 Zabbix/Adapter secret，且未通过真实 Node Runtime 部署 |
| `SOURCE_EVIDENCE_READY` | **PARTIAL** | `g13a_evidence_roundtrip.mjs` 真实进程通过：字节→验签→存储→读回一致；但独立审查确认 A+B 成员可把 B 的采集写入 A 的 Incident（attestation 未绑定 workspace），该 P1 未关闭 |
| `AUTHORIZATION_READY` | **PARTIAL** | 插件侧工作区/角色/签名/伪造测试通过；Gateway 注入路径只有单元测试，未在三进程链路中实测 |
| `UI_GOLDEN_PATH_READY` | **PARTIAL** | 13 单测 + 4 浏览器测试（含 390）；后端为 stub；视觉矩阵未跑 |
| `OCI_DEPLOYMENT_READY` | **PARTIAL** | 镜像构建/推送/digest/非 root/健康已验证；未部署到真实 Node Runtime |
| `REAL_ZABBIX_VERIFIED` | **NOT_RUN** | 无真实实例；不以 fixture 冒充 |

## 11.1 独立审查

两路独立 reviewer（后端/插件、UI）对 `cdb6e5b` 与 `82a175d` 逐行复核，未发现 P0。已在本轮修复：

- `buildEvidence()` 的 64 次迭代上限会在 500 series 时返回 131 KB，超过 64 KiB 且被 Kernel 拒绝；改为两阶段二分（样本数、series 数），并新增 500 series 与 500×0 的单测；socket 截断用例改为确定性超限。
- Viewer 可以 POST `/collect`（读 scope），能消耗出站预算并挤掉他人的未签名 collection；改为要求 `telemetry.source.write`，新增测试。
- `PUT /sources/{id}` 修改端点/凭据/TLS 后仍保留 `READY` 与旧 `lastProbe`；现在连接参数变化即回到 `UNVERIFIED` 并清空探活，新增测试。
- Kernel 接受“有 attestation、无 content”的 Legacy 引用并记录 `SOURCE_ATTESTED`；现在要求 attested 证据必须携带 content，并新增拒绝测试；replay 测试改为携带相同字节。
- Gateway 未转发 `no-store`，Cookie 响应可能被中间缓存；现在强制 `cache-control: no-store` 与 `vary: cookie`。
- Gateway 复制了 `DataScope` 的成员查询；改为调用 `DataScope::resolve`。
- `/collect` 忽略 source 预算且预算可低于 schema 最小值；现在请求预算只能收窄 source 预算，并在边界校验整数/范围。路径 UUID、`workspaceId`、`incidentId` 统一小写化并在边界校验。
- 契约与实际响应不一致：attestation 响应的 `evidence.attestation`、`outcome`、kind 枚举、错误码、`maxSamplesPerItem` 默认值已对齐；create+audit 改为同一事务；npm lock 改用官方 registry。

仍未关闭（P1，不能以 PASS 掩盖）：

1. **跨 Workspace 证据归属**：attestation 元组不含 `workspaceId`，Kernel 只校验 Incident scope。A+B 成员可把 B 的采集写入 A 的 Incident。修复需要 attestation v2（签名绑定 workspaceId）并让 Kernel 对照 `incidents.workspace_id`；本轮未实现，verdict 因此为 PARTIAL。
2. **生产 Secret 交付**：插件进程需要 `OPSWEAVE_ZABBIX_SECRETS` 与 `OPSWEAVE_EVIDENCE_ADAPTER_SECRET`，但 Kernel 的实例环境不注入它们，manifest 也没有 secret mount。真实容器部署下 probe 成功（`apiinfo.version` 不需要认证），hosts/items/collect 会 422，attestation 503。必须先实现插件 secret store 或按插件配置的 adapter，且不能把 Kernel 共享密钥下发给所有插件。
3. **Gateway 端到端**：`x-opsweave-user-context` 的注入/转发只有 Kernel 单测与插件侧验证，未在三进程链路中实测；真实 Node 部署也未跑。
4. **探活语义**：`apiinfo.version` 不需要凭据，probe 的 `UNAUTHORIZED` 分支在真实 HTTP 下不可达；`basic` 凭据被接受但 RPC 只发 Bearer。需要决定是改探活为认证调用，还是把状态改名为 REACHABLE 并移除 basic。

## 12. 风险与下一阶段

风险：

1. **Adapter secret 送达**：生产插件需要签名密钥，但当前实例环境不注入；需要插件 secret store 或按插件的 adapter 配置，且不能让 Kernel 的共享密钥泄露给所有插件。
2. **Gateway 未端到端实测**：签名上下文的注入与转发只有单元/插件两侧证据。
3. **Evidence 跨 Workspace 归属**：Kernel 不知道 source 的 workspace；同一用户属于 A+B 时可以把 B 的采集写入 A 的 Incident。授权用户不会被越过，但跨边界的数据归属需要 attestation v2 或 Kernel 侧 source 归属。
4. **64 KiB 快照丢失原始样本**：已用 `snapshot` 与 PARTIAL 声明，不声称完整。
5. **HMAC 共享密钥**（延续 ADR-015 R-2）：无轮换/吊销。
6. **真实 Zabbix 响应形状**仍未验证。

G13-B（提出但不实现）：Zabbix Trigger/Event → `source + nativeId` 去重 → 创建/关联 Incident → 时间窗采集 → Evidence → Investigation → Human Verdict；需要评估告警恢复、乱序、重复 Webhook、Workspace Mapping；不得自动关闭 Incident，不得让 AI 替代人工 Verdict。
