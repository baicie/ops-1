# G13-B1 切片 0–1 实施记录（Source Registry）

- 状态：已实现，**Automation 未启用**
- 日期：2026-11-06
- 决策：[ADR-018](../../adr/ADR-018-automation-principal.md)、[ADR-019](../../adr/ADR-019-event-identity-and-dedup.md)
- 迁移：`apps/kernel/migrations/0026_g13b0_source_registry_and_event_identity.sql`
- 代码：`apps/kernel/src/telemetry_sources.rs`、`apps/kernel/src/config.rs`

## 1. 本切片做了什么

1. **迁移 0026**：新增 `kernel.telemetry_sources`、`kernel.telemetry_events`、`kernel.automation_principals`；给 `kernel.incidents` 增加 `source_id`、`origin`、`recurrence_of`；`audit_events.actor_type` 增加 `AUTOMATION`。
2. **Source registry**：Kernel 在启动时从部署配置 `OPSWEAVE_AUTOMATION_SOURCES` 同步注册表；endpoint/TLS 从 A.2 credential binding 复制，不重复配置。
3. **只读管理面**：`GET /api/v1/telemetry/sources`（admin）返回注册表元数据；不含 Secret，不含签发端点。
4. **测试**：配置解析、READY/INVALID/DISABLED、binding 缺失、TLS 策略、sourceId 不能换 Workspace、Workspace+Source+NativeId 唯一性。

本切片**没有**：automation principal 签发、Event ingest、collect/evidence 自动化、任何 UI 写入口。`OPSWEAVE_AUTOMATION_SOURCES` 只影响注册表，不影响现有采集。

## 2. 配置形状

```json
{
  "zabbix-source": {
    "<workspace-uuid>": {
      "<source-uuid>": {
        "secretRef": "secretref:zabbix/main",
        "state": "READY"
      }
    }
  }
}
```

- `sourceId` 必须全局唯一；同一 id 出现在两个 Workspace 时第二个被丢弃并告警。
- `state` 只接受 `READY` / `DISABLED`。
- `secretRef` 必须以 `secretref:` 开头。
- endpoint/TLS **不在此配置**：从 `OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS` 的 `(plugin, workspace, ref)` 复制，避免两套配置漂移。
- 非法 JSON、非法 UUID、重复 id → 丢弃该条（fail closed）。

## 3. 注册表状态

| 状态 | 含义 |
|---|---|
| `READY` | binding 存在、TLS 策略安全；B1 slice 2 只能为它签发 principal |
| `DISABLED` | 配置显式禁用，或从配置移除（不删除，保留事件/事故归因） |
| `INVALID` | 配置错误：`CREDENTIAL_BINDING_MISSING`、`ENDPOINT_NOT_HTTPS`、`INSECURE_ENDPOINT_FORBIDDEN`、`SOURCE_ID_REASSIGNED` |

- `READY` 必须有 endpoint + tls；`INVALID` 必须有 reason（数据库 CHECK 强制）。
- `VERIFY` + `http://` → `ENDPOINT_NOT_HTTPS`。
- `TEST_PLAINTEXT` 且部署未设置 `OPSWEAVE_ALLOW_INSECURE_SOURCE_ENDPOINTS=1` → `INSECURE_ENDPOINT_FORBIDDEN`。
- 同一 sourceId 被改到另一 Workspace/plugin → `SOURCE_ID_REASSIGNED`，保留原行，不迁移历史 Incident。

## 4. 去重索引迁移

```sql
-- legacy rows keep the old global key
CREATE UNIQUE INDEX incidents_source_native_idx
  ON kernel.incidents (source, native_id)
  WHERE native_id IS NOT NULL AND source_id IS NULL;
-- new rows are workspace+source scoped
CREATE UNIQUE INDEX incidents_workspace_source_native_idx
  ON kernel.incidents (workspace_id, source_id, native_id)
  WHERE source_id IS NOT NULL AND native_id IS NOT NULL;
```

- 历史行 `source_id IS NULL`，不回填、不合并；旧索引语义保持不变。
- 两个 Workspace 可以复用同一 `nativeId`（测试覆盖）。
- 同一 Workspace+Source+NativeId 的第二次插入由数据库返回 23505（测试覆盖）。

## 5. 验证

```bash
OPSWEAVE_TEST_DATABASE_URL=... OPSWEAVE_REQUIRE_TEST_DATABASE=1 \
  cargo test -p opsweave-kernel telemetry_sources::
```

结果：5/5（registry 4 + 去重索引 1）；完整 Kernel 套件 211/211；clippy `-D warnings` 通过；契约校验 17 schemas。

## 6. 下一步（切片 2）

- `POST /internal/v1/automation/principals`：实例身份 + live generation + 注册表 READY + 预算；
- `AutomationPrincipal` extractor；jti/过期/撤销/节点换代；
- 在签发之前，任何 automation 端点保持关闭。

启用条件：注册表 READY、principal 验证、审计 `AUTOMATION` 三项同时通过；否则 `G13_B1_READY` 不能升级为运行时就绪。
