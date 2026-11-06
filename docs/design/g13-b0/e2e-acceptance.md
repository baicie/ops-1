# G13-B0 E2E 验收矩阵（冻结）

- 状态：Frozen for G13-B1
- 运行基线：G13-A.1/A.2 的隔离 PostgreSQL + Kernel + Node + digest-pinned OCI + Gateway + Playwright 测试系统
- 约束：Fixture 不是真实 Zabbix；无授权真实实例时 `REAL_ZABBIX_VERIFIED=NOT_RUN`

## 1. 自动化身份

| # | 场景 | 期望 | 层次 |
|---|---|---|---|
| A1 | 插件自报 Workspace 申请 principal | 拒绝，403 `AUTOMATION_WORKSPACE_NOT_BOUND` | Kernel 单测 + 真实 socket |
| A2 | 用 A 的 source 申请 B 的 token | 拒绝，403 `EVENT_SOURCE_FORBIDDEN` | Kernel 单测 |
| A3 | `allowedOps` 越权（collect + verdict） | 签发拒绝，422 `AUTOMATION_SCOPE_INVALID` | Kernel 单测 |
| A4 | token 过期 | 401，不落 Event | Kernel + Gateway |
| A5 | jti 重放 | 第一次 202，第二次 409 `AUTOMATION_REPLAY` | Kernel 并发测试 |
| A6 | 实例撤销/节点换代 | 旧 token 401 `AUTOMATION_INSTANCE_STALE` | 真实 Node 重启/替换 |
| A7 | 预算耗尽 | 429，无部分 Evidence | Kernel 单测 + 真实栈 |
| A8 | 审计 actor | `AUTOMATION` + principalId，无用户 UUID | DB 断言 |
| A9 | Automation 写 Verdict/Close | 403；事件/审计仍可读 | Gateway |
| A10 | 人类 Session 换 automation token | 拒绝 | Kernel 单测 |

## 2. Event 与去重

| # | 场景 | 期望 |
|---|---|---|
| E1 | 同一 idempotencyKey 重试 10 次 | 1 条 Event、1 个 Incident，返回同一 id |
| E2 | 32 并发同键 | 1 个 Incident（数据库唯一索引裁决） |
| E3 | 两个 Workspace 相同 nativeId | 各自 1 个 Incident |
| E4 | PROBLEM 多次（不同 occurredAt） | 多 Event、1 Incident |
| E5 | RESOLVED | 不改 Incident 状态、不 Close |
| E6 | RESOLVED 后新 PROBLEM（旧单 CLOSED） | 新 Incident + `recurrence_of`，旧单不重开 |
| E7 | 乱序/延迟 | 落库 `late=true`，不迁移状态、不 collect |
| E8 | 无效签名/错误摘要 | 401/422，不落行，审计 REJECTED |
| E9 | Event payload 伪造 Evidence | 不可能：Evidence 必须走 v2 attestation + 内容摘要 |
| E10 | 历史行迁移 | 旧行可读/可关闭；冲突迁移失败并列出 |

## 3. 采集与 Evidence（沿用 A.2）

| # | 场景 | 期望 |
|---|---|---|
| C1 | Automation 对绑定 source collect | 使用批准的 endpoint/TLS；成功 |
| C2 | source endpoint 被改为攻击者 | 422 `ZBX_CREDENTIAL_ENDPOINT_MISMATCH`，攻击者 0 Authorization |
| C3 | 跨 Workspace secretRef | 422/403，不泄漏 |
| C4 | 历史/unbound source | fail closed |
| C5 | Basic/TLS/明文策略 | 按 A.2 语义 |
| C6 | collect → attestation v2 → Evidence | workspace/incident/contentRef 一致；字节读回一致 |
| C7 | Automation 追加 Evidence 到其他 incident | 403 |
| C8 | Investigator 只写 hypothesis | 无 verdict 写入；人工随后 CONFIRMED |
| C9 | CLOSED 后追加 Evidence | 409 `INCIDENT_CLOSED` |

## 4. 运行时与 UI

| # | 场景 | 期望 |
|---|---|---|
| R1 | 插件/Kernel 重启 | principal 失效/重建；Event/Incident 可读；旧 token 不静默成功 |
| R2 | Source 禁用/凭据轮换 | 新 collect 失败；无旧凭据成功 |
| R3 | 容器安全 | 65532、read-only、资源限制、无 docker.sock、digest 固定 |
| R4 | 日志扫描 | 无 Secret/Token/Authorization |
| U1 | 1440/1024/390，en/zh-CN | 正常采集、拒绝、过期、轮换中不可用、恢复 |
| U2 | Automation 徽标与人工 Verdict | 二者视觉/语义分离；无 i18n 硬编码 |
| U3 | 失败文案 | 稳定错误码映射，不渲染服务端英文 |

## 5. 真实实例边界

- 无授权 Zabbix：`REAL_ZABBIX_VERIFIED=NOT_RUN`，fixture 仅证明协议形状。
- 独立 Secret Store 未验收：`PRODUCTION_SECRET_READY=PARTIAL`，env 交付与旧实例窗口继续记录。
- 不以 CI 绿色替代上述证据；B1 的 PASS 必须附运行命令、时间、堆栈/日志片段与 NOT_RUN 清单。
