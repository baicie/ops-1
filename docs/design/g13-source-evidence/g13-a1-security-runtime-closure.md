# G13-A.1 — Workspace-Bound Evidence & Production Connector Integration

- 日期：2026-11-06
- 分支：`feat/g13-a1-workspace-attestation`（基于 #38 `99fd9b2`）
- 依赖：
  - #38 `feat/g13-a-source-evidence`（HEAD `99fd9b2`，14/14 CI，Draft）
  - #39 `feat/g13-a-collect-ui`（HEAD `81d1765`，11/11 CI，Draft，基于 #35）
  - #34 / #35 Visual System Stack（未合并）
- 合并顺序：#34 → #35 → #39；#38 → 本 PR。本 PR 不包含 #34/#35 的视觉提交，也不修改 #38/#39 的 HEAD。

## 1. 目标与结论

G13-A 已经能把真实采集结果作为不可变字节写入 Incident Evidence。本轮补齐三个会阻止生产使用的缺口：

1. **Attestation 不绑定 Workspace**：A+B 成员可把 B 的采集写入 A 的 Incident。
2. **生产插件拿不到凭据/签名密钥**：实例环境只有 context key、DB URL、capability token。
3. **没有真实 Gateway/Node/OCI 闭环**：此前只有 Kernel↔插件直连和分解测试。

本轮的结论是：前两项已修复并有真实证据；第三项在真实 Kernel + Node Runtime + OCI 容器 + Gateway + PostgreSQL + 浏览器上跑通，上游是本地 Zabbix fixture，真实 Zabbix 仍为 `NOT_RUN`。

## 2. Attestation V2

### 2.1 签名载荷（Golden Vector）

```
{"v":"opsweave-evidence-attestation-v2","adapterId":"zabbix-main",
 "workspaceId":"00000000-0000-4000-8000-000000000001",
 "incidentId":"b17265e7-3ac8-4877-bad4-40c4d2df4a87",
 "kind":"METRIC_SNAPSHOT","source":"zabbix:probe",
 "collectedAtUnix":1793423844,"contentRef":"sha256:probe-1",
 "issuedAtUnix":1793423844}
```

- Rust `attestation_payload` 与 Node `attestationPayload` 各自硬编码同一字符串；两侧测试同时失败或同时通过。
- `workspaceId` 在 `adapterId` 之后、`incidentId` 之前；顺序变化即签名失效。

### 2.2 信任路径

- 插件从**持久化的 `zabbix_collections.workspace_id`** 读取 workspace；请求体里的 `workspaceId` 被忽略（socket test 用 B 覆盖 A，签名仍是 A）。
- Kernel：
  1. 用 `attestation.workspaceId` 构造 v2 载荷并验签；
  2. 从 `kernel.incidents.workspace_id` 读取**权威** workspace（与所有 Incident 读取使用同一 `DataScope` predicate）；
  3. 两者不一致 → 403 `EVIDENCE_WORKSPACE_MISMATCH`，事务不写任何行；
  4. 一致 → 写入 `SOURCE_ATTESTED`。
- `workspaceId` 被修改后签名失效（401 `EVIDENCE_ATTESTATION_INVALID`），不会进入“比较”分支。
- `incidentId`、`contentRef` 同样在签名内；改任何一个都验签失败。

### 2.3 V1 兼容策略

- V1 新写入**一律拒绝**：v2 验签失败后尝试 v1 载荷，若 v1 可验证则返回 401 `EVIDENCE_ATTESTATION_VERSION_UNSUPPORTED`。
- 不存在“全局 V1 兼容开关”；没有环境变量能让 v1 重新授权新证据。
- 已落库的历史行不被改写；它们保留写入时的 `verified_trust`/`verification_method`。
- 其他旧适配器若必须保留 v1，只能在 Kernel 侧为它们建立可信 workspace 约束并单独审查；本轮没有这样做，也不把 v1 重新开放。
- `g12_trusted_evidence.sh` 已升级到 v2（从 DB 读取 incident workspace，签名含 workspaceId，并新增跨 workspace 403 反例）；本地真实 Kernel 上 **53/53** 通过。

## 3. 跨 Workspace 复现与修复

真实复现（`tests/ci/g13a_evidence_roundtrip.mjs`，真实 Kernel 进程 + 插件进程 + PostgreSQL）：

1. 创建 A、B，同一个 admin 属于两者；
2. 在 B 创建 Source 并 collect；
3. 用 B 的 Collection 向 A 的 Incident 申请 attestation；
4. **修复前**：插件签名不含 workspace，Kernel 只查 Incident scope，返回 201 `SOURCE_ATTESTED`（P1）；
5. **修复后**：签名含 B，Kernel 用 A 的 workspace 构造载荷验签失败/比较不一致 → 403 `EVIDENCE_WORKSPACE_MISMATCH`，A 的证据数不变。

同一脚本还验证：

- A Source → A Incident：201 `SOURCE_ATTESTED`，content 读回逐字节一致；
- A+B 操作员跨 Workspace：拒绝；
- 只有 A 的上下文读取 B Source：列表不返回，probe 404；
- 修改签名外字段：签名失效；
- v1 旧签名：401 `EVIDENCE_ATTESTATION_VERSION_UNSUPPORTED`；
- 重复提交：唯一约束返回同一行（Kernel 测试）；
- Incident 已关闭：409（既有测试）；
- 合法签名但字节不一致：`EVIDENCE_CONTENT_REF_CONFLICT`（既有 + 新测试）。

## 4. 生产 Secret 交付

### 4.1 架构

Kernel 配置（环境变量，部署时注入）：

- `OPSWEAVE_PLUGIN_SECRETS`：`{"<pluginId>":{"<workspaceId>":{"secretref:...":"value"}}}`
- `OPSWEAVE_EVIDENCE_ADAPTER_PLUGINS`：`"<adapterId>:<pluginId>,..."`
- `OPSWEAVE_EVIDENCE_ADAPTERS`：`"<adapterId>:<secret>,..."`（Kernel 验证用；**绝不下发全量**）

`instance_environment`（`apps/kernel/src/capabilities.rs`）：

- 只为请求实例的 `plugin_id` 注入它自己的、按 Workspace 分层的 `OPSWEAVE_PLUGIN_SECRETS`（一个插件可服务多个 Workspace，但每个 ref 只属于一个 Workspace）；
- 插件按 Source 的 `workspace_id` 解析 ref；A 的 Source 不能使用 B 的 ref（创建/更新即 422，`hosts`/`collect` 同理）。扁平 map 被拒绝（fail closed）；
- 只在该插件恰好被分配一个 adapter 时注入 `OPSWEAVE_EVIDENCE_ADAPTER_ID/SECRET`；
- 多个 adapter 分配给同一插件 → 一个都不注入（fail closed）；
- 全局 `OPSWEAVE_EVIDENCE_ADAPTERS` 永不出现在实例环境；
- 已有 Context Key、DB URL、Capability Tokens 不变。

插件（`server.mjs`）：

- 优先读取 `OPSWEAVE_PLUGIN_SECRETS`，回退到本地开发的 `OPSWEAVE_ZABBIX_SECRETS`；
- `/runtime-info` 只报告 `secrets.mode`（workspace/dev/none）与是否配置，不返回值；
- Source 仍只持久化 `secretref:`；数据库不存 Token；错误路径经 `redact`。

### 4.2 威胁模型（不夸大）

环境变量对**容器进程**可见，也对能执行 `docker inspect` 的主机用户/守护进程可见；它与独立 Secret Store 或只读文件挂载**不等价**。本轮选择 env 是因为 Node Runtime 已有实例环境通道，且不需要新平台。缓解：

- 每插件独立 map；adapter 一对一分配；
- 容器非 root、`--read-only`、cap-drop ALL、no-new-privileges、无宿主 Docker Socket；
- Kernel/Node 日志不打印值（golden path 检查 token/adapter secret 不出现在日志）；
- 轮换/撤销需要重新部署实例（见 §9）。

### 4.3 生命周期与轮换

1. 管理员配置 `secretref:` 与 `OPSWEAVE_PLUGIN_SECRETS`（部署配置）。
2. 插件实例启动时由 Kernel 注入；Node 只把该实例的 env 交给容器。
3. Adapter 轮换：更新 Kernel `OPSWEAVE_EVIDENCE_ADAPTERS` 并重新部署插件。旧实例在停止前仍持有旧密钥，但 Kernel 只接受新密钥 → 旧实例的 attestation 401；滚动更新期间可能短暂失败（fail closed）。
4. Zabbix Token 轮换：更新 `OPSWEAVE_PLUGIN_SECRETS` 后必须**停止并重新创建**实例。`opsctl deploy` 对已 ACTIVE 的 0.0.1 会返回 409 `VERSION_ALREADY_ACTIVE`，所以路径是 disable→deploy 或发布新版本；Node 重启会**收养**已有容器，不会刷新 env。旧实例在替换前仍持有旧 Token。
5. Adapter 撤销：仅删除 `OPSWEAVE_EVIDENCE_ADAPTER_PLUGINS` **不是**撤销——它只停止注入，运行中的实例仍持有旧密钥，Kernel 仍会接受其签名。必须同时轮换/移除 `OPSWEAVE_EVIDENCE_ADAPTERS` 中的密钥并替换实例；旧实例随后验签失败（fail closed）。
6. Plugin Disable/Uninstall/重部署：旧容器被停止，环境不再授予；没有持久化密钥。
6. 已签 Evidence 保留 `verifier_identity` 与 `verification_method`，轮换不改变历史行的来源审计事实。

## 5. 真实 Gateway / Node / OCI 路径

`tests/ci/g13a1_gateway_e2e.sh`：

- 隔离 PostgreSQL 容器（55432）；
- 真实 Kernel（18185）+ 真实 Node Runtime（9105）+ 本地 registry（5001）；
- 真实 OCI 插件容器（本次 digest `sha256:a10d5e93…`，与清单一致）；
- Kernel Gateway `/api/v1/gateway/opsweave.zabbix-source/...`；
- 本地 Zabbix JSON-RPC fixture（`UPSTREAM_ZABBIX_FIXTURE`）；
- Playwright 浏览器（1440 + 1024 + 390）。

流程：

1. Kernel 配置 adapter + adapter→plugin + plugin secret；
2. Node 注册 READY，拉取并启动插件容器；
3. storage binding、install、deploy、activate；
4. Gateway 创建 Workspace/Incident/Source；
5. probe、hosts、items、collect；
6. 插件签名 v2（workspace 来自 collection）；
7. 浏览器点击 Collect → Save，Kernel 验签/摘要/workspace，写入 `SOURCE_ATTESTED`；
8. 浏览器列表出现新行；A/B 跨 Workspace 写入被 403；
9. （浏览器保存后）Investigation Runner 的 `TEST_FIXTURE` 读取并引用 Gateway 写入的 evidence；
10. 人工 `CONFIRMED` Verdict 单独写入，不改变 AI 假设；
11. 重启插件容器、重启 Kernel，Source 与 Evidence 仍可读；
12. 容器安全检查（非 root、read-only rootfs、CPU/Memory/PID 限制、无 docker.sock、无明文 token 日志）。

Probe 使用未认证的 `apiinfo.version`，不证明凭据；凭据交付由 `hosts`/`items`/`collect` 的认证请求证明。Fixture 不证明真实 Zabbix 响应形状；脚本每次输出都标注 fixture。

## 6. UI 联调

- #39 **无需修改**：它把 `evidence.attestation` 原样转发，v2 新增的 `workspaceId` 随之到达 Kernel；UI 不填写 workspace/trust 字段。
- 真实浏览器用例（`tests/ui/g13a1-real-collect.spec.ts`）在真实栈上运行：
  - 1440：Collect → Save → 列表新增一行 `SOURCE_ATTESTED`（取最新一行，不用 `.last()`）；
  - 1024：同一流程，无横向溢出；
  - 390：同一流程，无横向溢出。
- `#39` 的 15 单测 + 14 浏览器用例保持通过；本 PR 不包含 UI 代码提交。

## 7. 证据完整性与失败语义

沿用 G13-A 并新增：

- 签名覆盖 v2 载荷（含 workspace）；Kernel 从提交字节重新计算 sha256，与 `contentRef` 不一致 → `EVIDENCE_CONTENT_REF_CONFLICT`；
- 读回时重新计算，损坏 → 500 `EVIDENCE_CONTENT_INTEGRITY_FAILED`，不返回坏字节；
- `EMPTY`/`NO_DATA`/`UNKNOWN`/`PARTIAL`/`TIMEOUT` 不合并；`TIMEOUT` 不可 attest；
- 64 KiB 有界快照：两阶段二分，500 series 也不会超过上限；`snapshot.truncated` 强制 `PARTIAL`；
- 真实数值 0 不变成缺失（既有 schema/单测）。

## 8. CI

本 PR 新增/复用：

- `zabbix-plugin`：unit + 真实 socket + 真实 PostgreSQL 持久化（V2 断言包含在内）；
- `g13a-roundtrip`：真实 Kernel + 插件 + PostgreSQL + 跨 Workspace 拒绝；
- `rust`：V2 签名、workspace mismatch、v1 拒绝、无字节 attestation、tamper/incident replay；
- `g13a1-gateway`：真实 Kernel + Node + OCI + Gateway + fixture + 浏览器（UI dist 从 #39 构建）；上游 fixture，真实 Zabbix NOT_RUN；
- `acceptance`：G12 旧脚本已更新为带 content 的 attestation。

## 8.1 本轮 CI（PR #40，head `9af1c51`）

15/15 PASS：

- `acceptance` 6m36s（G12 v2 脚本）
- `g13a1-gateway` 3m38s（真实 Gateway/Node/OCI + 浏览器 1440/1024/390）
- `rust` 2m6s（203 tests，含 64 incident）
- `g13a-roundtrip` 1m50s
- `golden-path` 16m49s、`runtime-golden-path` 17m11s、`legacy-regression` 5m13s
- `web`、`web-unit`、`zabbix-plugin`、`contracts` ×2、`spec-coverage`、`artifact-budget`、`quality-faults`

## 9. 独立审查

独立 reviewer 针对 `99fd9b2..HEAD` 与未跟踪的 golden path 脚本逐行复核。独立 reviewer 发现并已修复：

- **P0**：`OPSWEAVE_PLUGIN_SECRETS` 原先按插件扁平存放，A 的 Source 可以选择 B 的 `secretref`，插件会把 B 的 Token 发到 A 的端点。现在 map 按 Workspace 分层；Source 创建/更新要求 ref 在其 Workspace 中；解析按 Source 的 `workspace_id`；扁平 map 被拒绝。新增 socket 测试证明 A 用 B 的 ref 返回 422，并证明 A/B 两个 Source 分别发送各自的 Token。
- **P1**：G12 `g12_trusted_evidence.sh` 仍签 v1，现在会 401。已改为 v2（从 DB 读取 incident workspace），并新增“签名属于另一个 Workspace → 403 mismatch”。本地真实 Kernel **53/53**。
- **P1**：新 CI job 的 env 变量名写错（`PLUGIN_HOST` 未被脚本读取），且 pull registry 用桥接 IP 不是 `localhost`；已修正并加 registry readiness。
- **P1**：轮换语义被文档夸大；已按实际行为改写（disable→deploy/新版本、Node 收养、adapter 撤销需轮换密钥）。

仍作为 P2 记录：probe 使用未认证的 `apiinfo.version`（secret 交付由 hosts/items/collect 证明）；golden path 的清理/log 检查、固定端口、测试镜像未 pin digest 等 harness 问题见 §11。

## 10. 迁移、回滚、密钥轮换

- 无数据库迁移：V2 只改变签名载荷；历史 evidence 行不改写。
- 回滚：旧 Kernel 不识别 v2 → 新插件签名会被 v1 校验拒绝。因此**不能用“回滚 Kernel 二进制”作为回退**；正确回退是停止新写入并恢复上一版插件+Kernel 的部署，历史行保持。
- 轮换：见 §4.3；没有在线轮换 UI，重启/重部署生效；旧实例窗口已记录。
- 旧 v1 适配器：不再接受新写入；若必须保留，需要独立的服务端 workspace 约束设计。

## 11. 残留 P0 / P1 / P2

- **P0（已修复）**：扁平 per-plugin secret map 允许 A 的 Source 借用 B 的 ref；已改为 per-workspace map，并在创建/更新/解析三处拒绝跨 Workspace。
- **P1（生产）**：Secret 通过环境变量交付，主机/Docker inspect/argv/Kernel `/proc` 可见；不是独立 Secret Store。Zabbix Token 与 Adapter 撤销需要替换实例（disable→deploy/新版本）；旧实例窗口已记录。
- **P1（兼容）**：v1 新写入被全面拒绝；旧适配器若仍在生产写入，需要单独迁移计划（本轮无此类适配器）。G12 验收脚本已迁移到 v2。
- **P2**：`basic` 凭据仍被接受但 RPC 发送 Bearer；probe 使用未认证的 `apiinfo.version`；在线轮换/吊销后台未实现；真实 Zabbix NOT_RUN。
- **NOT_RUN**：真实 Zabbix 实例、真实两节点 OCI 发布、付费模型 E2E。

## 12. 下一阶段

- 为 Zabbix Token/Adapter 引入按插件的 secret store（文件挂载或外部 store），并实现在线轮换/吊销；
- 真实 Zabbix 接入后用同一 golden path 跑 `REAL_ZABBIX_VERIFIED`；
- G13-B：Trigger/Event → `source + nativeId` 去重 → Incident → 采集 → Evidence → Investigation → Human Verdict；不自动关闭 Incident，不让 AI 替代 Verdict。

## 13. Verdicts

| Verdict | 状态 | 依据 |
|---|---|---|
| `WORKSPACE_ATTESTATION_V2` | **PASS** | v2 golden vector（Rust/Node 同字节）、跨 Workspace 真实拒绝、tamper/incident/v1 测试、Kernel 权威 workspace 比较 |
| `PLUGIN_SECRET_PROVISIONING` | **PASS（env 交付，威胁模型已记录）** | 真实 Node/OCI 容器拿到 Kernel 注入的 per-workspace secret 与 adapter key；A 的 Source 不能借用 B 的 ref（422）；fixture 要求 token；隔离/多分配 fail closed 单测；日志无明文 |
| `GATEWAY_NODE_E2E` | **PASS** | 真实 Gateway → Node → OCI 容器 → fixture；浏览器 1440/1024/390 Collect+Save；TEST_FIXTURE 调查器引用 Evidence；人工 Verdict；重启恢复 |
| `SOURCE_EVIDENCE_INTEGRITY` | **PASS** | 字节→摘要→验签→存储→读回一致；错误摘要/跨 workspace/v1 拒绝 |
| `UI_INTEGRATION` | **PASS** | #39 无需修改；真实栈浏览器用例 2/2；不填 trust/workspace |
| `REAL_ZABBIX_VERIFIED` | **NOT_RUN** | 只有本地 fixture，不能替代真实实例 |
| `INTEGRATION_READY` | **PARTIAL** | 真实栈全链路通过；真实 Zabbix 与生产 secret store 未接入 |
