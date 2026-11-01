# ADR-015: 证据信任由 Kernel 校验 + 遥测源作为独立插件

- 状态：Accepted
- 日期：2026-11-01
- 版本状态：本 ADR **不**改变 `0.0.5_PARTIAL`；新增能力按 `0.0.5` 内增量记录
- 前置：`AGENTS.md`、`rules/01-architecture.md`、`rules/03-security.md`、`rules/05-data.md`、`docs/blueprint/adr/ADR-006-data-as-plugins.md`
- 相关实现：`apps/kernel/src/incidents.rs`、`apps/kernel/migrations/0017_g12_evidence_trust.sql`、`plugins/zabbix-source/`、`contracts/openapi/zabbix-source-v1.yaml`

## 1. 目标

两件事必须同时成立，否则都没有意义：

1. **证据的信任等级必须是 Kernel 自己得出的结论，不能是调用方的自报。**
2. **Zabbix 遥测接入必须是独立插件**，Kernel 不得获得任何 Zabbix 知识。

第二件产出的数据，只有在第一件成立时才可信：一个连接器说「这份指标来自 Zabbix」，如果 Kernel 只是把这句话存下来，那么这条证据的证明力等于零——任何过了同一道权限门的调用方都能说同样的话。

非目标：通用签名框架、PKI、密钥轮换服务、OTel/Prometheus 接入、跨租户证据共享。本 ADR 只解决「谁有资格让一行证据被标记为 `SOURCE_ATTESTED`」和「第一个真实遥测源如何在不污染 Kernel 的前提下接进来」。

## 2. 决定性约束（来自真实源码，非假设）

| # | 约束 | 证据 |
|---|---|---|
| C1 | 迁移前 `trust` 列直接取自请求体，`insert_evidence` 只做闭集词汇校验；任何过了 `require_operator` 的调用方都能写入 `SOURCE_ATTESTED` | 迁移前 `apps/kernel/src/incidents.rs:35` 的 `EVIDENCE_TRUSTS` + `closed_set` |
| C2 | `AGENTS.md` MUST NOT：「让用户、插件或模型自报的 tenant/subject/permissions 代替可信身份」——C1 正是这条的违反 | `AGENTS.md` 绝对禁止章 |
| C3 | 判决（verdict）引用证据集合；若证据信任等级可伪造，判决的证明链同样可伪造 | `kernel.incident_verdicts`、`0016_g11_incidents.sql:71-80` |
| C4 | Kernel 已有 `hmac`/`sha2`/`base64` 依赖，无需引入新密码学库 | `apps/kernel/Cargo.toml` |
| C5 | 业务插件不得作为 Rust dylib 注入 Kernel，后端插件只经跨进程版本化 API | `rules/01-architecture.md` MUST |
| C6 | 插件凭据必须是引用 + 短期访问许可，禁止进入日志/Manifest/URL/错误响应 | `rules/03-security.md` MUST |
| C7 | `EMPTY`/`NO_DATA`/`PARTIAL`/`UNKNOWN` 必须与成功区分，缺数据不能转为 0 | `rules/05-data.md` MUST |
| C8 | 平台当前**没有任何遥测数据源**：`zabbix` 仅出现在测试常量与「尚未接入」文案中；唯一真实遥测是 `kernel.node_resource_samples` | 全仓检索；`apps/kernel/migrations/0014_node_resource_samples.sql` |
| C9 | 校验必须发生在**写入事务之内**：先校验后落库，否则存在「已落库再降级」的窗口 | `insert_evidence` 事务边界 |

C1 + C3 是最强约束：**信任等级是判决的地基**。地基可自报，上面的一切结论都只是转述调用方的说法。

## 3. 第一件：为什么校验必须在 Kernel 内（而不是插件）

`rules/01-architecture.md` 的 Gate 要求新增 Kernel 能力必须说明「更轻的插件替代方案为何不可行」。逐个排除：

### 方案 A：由连接器插件自己声明信任等级
**被 C1/C2 否决，且这正是缺陷本身。** 插件自报 `SOURCE_ATTESTED` 与调用方自报没有区别——插件也是调用方。把判断权交给被判断者，不是校验。

### 方案 B：独立的「证据校验插件」，Kernel 调用它
**被 C5/C9 否决。** 三个问题：
1. Kernel 要信任这个插件的回答，就必须先有办法校验**它**的身份——问题被推迟一层而非解决，且推迟后的那一层仍然落在 Kernel 内（Kernel 必须知道「哪个插件有资格做裁决」）。
2. 信任根不可卸载。一个可以被 disable/uninstall 的插件若承担信任判定，停用它意味着要么证据全部降级（可用性断裂），要么回退到自报（安全断裂）。
3. C9 要求校验在写入事务内完成。跨进程调用引入网络失败、超时与 `UNKNOWN` 结果，而「校验结果未知」在安全语义上必须等同于拒绝——于是插件不可用就等于证据写入不可用。

### 方案 C：网关层按来源 IP / 容器身份判定
**否决。** 网络位置不是身份（`rules/03-security.md`）。容器 IP 可复用、可伪造、且 `rules/10` 明确要求「容器 Node/IP/port 永不成为稳定地址」。

### 方案 D（选定）：Kernel 持有已注册 adapter 凭据，校验签名覆盖证据内容摘要
- 信任等级拆成两列：`claimed_trust`（调用方说的，永不构成权威）与 `verified_trust`（Kernel 自己的结论，唯一可被读取方和判决依赖的字段）。
- `SOURCE_ATTESTED` 的唯一路径是：持有已注册 adapter 密钥、且 HMAC-SHA256 签名覆盖 `(adapterId, incidentId, kind, source, collectedAtUnix, contentRef, issuedAtUnix)` 的写入。
- 人工写入最高只能是 `OPERATOR_ASSERTED`——这是 Kernel 确实校验过的事实（通过了 `require_operator` 的已认证操作者）。
- 未知 adapter → `EVIDENCE_ADAPTER_UNKNOWN`（401）；签名不匹配 → `EVIDENCE_ATTESTATION_INVALID`；超出 ±300s 时钟窗 → `EVIDENCE_ATTESTATION_STALE`。
- 保留旧 `trust` 字段仅为给出稳定错误码 `EVIDENCE_TRUST_NOT_SELF_ASSERTABLE`（400），而**不是**把它重新解释为 claim——否则老客户端会保留一条「看起来成功了」的路径。

**为什么选 HMAC 而不是非对称签名**：C4 已有依赖，零新增供应链面；adapter 与 Kernel 同属一个部署控制面，不存在需要第三方独立验签的场景。代价是 Kernel 持有共享密钥——已登记为技术债，后续若出现跨组织 adapter 再升级为非对称（届时 `ATTESTATION_VERSION` 版本标签递增，见下）。

### 失败方向的选择（fail-safe）
- `verified_trust` 列默认 `UNVERIFIED`，因此**忘记设置该列的写入路径不可能意外获得 attestation**。
- 数据库 CHECK 约束要求 `verified_trust='SOURCE_ATTESTED'` 必须伴随 `verification_method='SOURCE_ADAPTER'` 且 `verifier_identity` 非空：attestation 的唯一路径写在 schema 里，而不只在 handler 里。手写 SQL 插入一行 attested 证据同样被拒绝。
- 未配置任何 adapter 时（默认空），**没有任何东西能被 attested**，Kernel 明确拒绝而不是接受声明。
- `OPSWEAVE_EVIDENCE_ADAPTERS` 条目格式错误时丢弃该条目并告警，而不是让进程启动失败：丢弃只会**减少** attestation 能力，永不授予。

### 签名不能覆盖的字段不得影响信任等级
签名覆盖的是证据元组本身。`claimed_trust` **不在**签名范围内，因此它无法影响 `verified_trust`——这是刻意的：若 claim 参与签名，一个被截获的签名就能在另一个 claim 下复用。同理，`ATTESTATION_VERSION` 作为 `v` 字段参与签名，新增字段必须递增版本标签，否则旧签名会在新字段语义下被接受。

## 4. 第二件：Zabbix 作为独立插件

按 ADR-006 与 C5/C8：新建 `plugins/zabbix-source/`（id `opsweave.zabbix-source`，capability `telemetry.source.v1`），**Kernel 不含任何 Zabbix 代码**。Kernel 侧新增的是「校验 adapter 签名」这一通用能力，它不知道 Zabbix 的存在——`zabbix-main` 只是一个配置出来的 adapter id，换成任何其他源都不需要改 Kernel。

能力闭环：配置连接 → 探活 → 拉取 host/item 清单 → 按窗口拉取指标 → 产出带签名的证据。

### 凭据（C6）
配置里只存 `secretref:` 句柄，不存密钥本身。schema 用 `^secretref:` 前缀约束，使「把真 token 粘进这个字段」直接校验失败，而不是被当作引用存下来。端点 URL 拒绝 userinfo 成分，避免 token 被塞进随后会被日志记录的 URL。所有出站错误经 `redact()` 后才进入日志或错误响应。

### 数据语义（C7）—— 七个互不相同的结论
| outcome | 含义 |
|---|---|
| `OK` | 窗口被覆盖且返回了样本 |
| `EMPTY` | 服务端权威回答「此窗口内没有记录」——**缺失已被确立** |
| `NO_DATA` | 是否有记录**无法确立**（item 不支持/禁用、housekeeping 已裁剪到窗口之下、item 未知） |
| `PARTIAL` | 部分 item 有答案部分没有，或窗口被预算裁剪 |
| `UNKNOWN` | 结论本身未知（请求已发出后超时或传输失败） |
| `UNAVAILABLE` | 端点从未被连上，什么都没请求出去 |
| `TIMEOUT` | 截止时间先到 |

`EMPTY` 与 `NO_DATA` 的区分是重点：前者是「确实没有」，后者是「不知道有没有」。把后者显示成前者，就是把无知伪装成事实。

缺失的读数是 `value: null` **加一个 `absenceReason`**，永不是 0。这条由 contract 的 if/then 结构强制：schema 合法的样本不可能是「无解释的 null」，也不可能是「带缺失原因的数字」——`rules/05` 的「缺数据不能转为 0」由契约保证，而非仅在散文里声明。

超时与不可达是两个不同的 outcome：**端点可能完全健康只是慢**，而「不可达」是另一个运维事实。心跳沉默本身永不改变源状态（`AGENTS.md` MUST NOT）。

### 预算与上限
`maxWindowSeconds` 24h、`maxItems` 500、`maxSamplesPerItem` 5000、`requestTimeoutMs` 30s、`maxConcurrency` 8（均为天花板，请求只能更小）。超限请求被**裁剪**而非拒绝，结果带 `clamped` 与 `PARTIAL` 说明裁剪发生过——静默裁剪会让调用方以为看到了完整窗口。

### 分母保留（C7）
`requestedItems` 与 `answeredItems` 分别记录，`PARTIAL` 时分母是**完整的请求量**而非成功量，否则「10 个里成功 3 个」会被读成「3 个里成功 3 个」。

## 5. 与 incident 证据的衔接

采集结果经 `contentRef`（canonical JSON 的 sha256）摘要后签名，再写入 incident 证据。摘要在 key 顺序变化下稳定、在 outcome 变化时改变：**签名覆盖的是「这次采集得到了什么结论」，而不仅是「有一次采集」**。插件侧 `attestationPayload()` 与 Kernel 侧 `attestation_payload()` 产出逐字节相同的载荷，两侧各自硬编码同一条 golden vector 断言（`plugins/zabbix-source/backend/zabbix.test.mjs` 测试 1 与 `incidents.rs` 的 `attestation_payload_matches_the_published_golden_vector`）——任一侧改了键序、大小写或时间精度，都会有一个测试失败，而不是生产环境里所有签名静默失效。

## 6. 影响与风险

| 风险 | 处理 |
|---|---|
| 迁移前的 `SOURCE_ATTESTED` 行无签名可查 | 迁移 0017 将其降级为 `UNVERIFIED` 并写入 `verification_note` 说明原因。**这会改变历史行的显示信任等级**，是刻意的：无法支撑的 attestation 不应继续显示为 attested |
| Kernel 持有共享 HMAC 密钥 | 已登记技术债；跨组织场景需升级为非对称签名，届时递增 `ATTESTATION_VERSION` |
| 迁移不可逆 | sqlx 迁移只前向。反向 DDL 记录在 `docs/design/g11-incident/incident-adr.md` §11.7，不自动执行；回退会让被降级的行重新显示为 attested |
| 时钟偏移导致合法 adapter 被拒 | ±300s 窗口；超出返回 `EVIDENCE_ATTESTATION_STALE` 而非静默接受 |
| 无真实 Zabbix 实例 | 真实端到端采集为 `NOT_RUN`，如实标注，不以 mock 冒充（见实现状态清单） |

## 7. 验收

- `cargo check --workspace --all-targets`、`cargo clippy --workspace --all-targets -- -D warnings` 退出码 0
- `python3 tests/contract/validate_contracts.py` 通过
- 负向测试：未知 adapter、签名不匹配、签名过期、人工写入不得获得 `SOURCE_ATTESTED`、数据库拒绝手写 attested 行
- 采集失败语义测试：不可达、超时、部分失败、`EMPTY` 与 `NO_DATA` 的区分、缺失不为 0
- 跨语言：Node 签名载荷与 Rust 校验载荷逐字节一致
