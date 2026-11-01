# Zabbix 遥测源 + 证据认证：实现状态与风险清单

- 日期：2026-11-01
- 分支：`claude/zabbix-connector-attested-evidence-7106ce`（基线 `c6cb34f`）
- 相关：[ADR-015](../../adr/ADR-015-evidence-attestation-and-telemetry-sources.md)、`contracts/openapi/zabbix-source-v1.yaml`、`contracts/schema/zabbix-source.v1.schema.json`

本文件按 `AGENTS.md` 工作步骤第 4、6 条编写：**只记录真实运行过的命令与结果**，未运行的一律标注 `NOT_RUN`，不以 mock 冒充真实采集，不声明生产就绪。

---

## 1. 实现状态

| 能力 | 状态 | 位置 |
|---|---|---|
| 证据信任等级由 Kernel 判定（不可自报） | `IMPLEMENTED` | `apps/kernel/src/incidents.rs` |
| `claimed_trust` / `verified_trust` 列分离 + DB 层 CHECK | `IMPLEMENTED` | `apps/kernel/migrations/0017_g12_evidence_trust.sql` |
| Adapter 注册（`OPSWEAVE_EVIDENCE_ADAPTERS`，默认空） | `IMPLEMENTED` | `apps/kernel/src/config.rs` |
| HMAC-SHA256 签名信封 + 300s 时钟窗 + 常量时间比较 | `IMPLEMENTED` | `apps/kernel/src/incidents.rs` |
| Zabbix 契约（schema + OpenAPI + 示例 + 校验器接线） | `IMPLEMENTED` | `contracts/`、`tests/contract/validate_contracts.py` |
| Zabbix 插件：探活 / host / item / 按窗采集 | `IMPLEMENTED`（逻辑层已测，真实实例 `NOT_RUN`） | `plugins/zabbix-source/backend/zabbix.mjs` |
| 七态数据语义（OK/EMPTY/NO_DATA/PARTIAL/UNKNOWN/UNAVAILABLE/TIMEOUT） | `IMPLEMENTED` | 同上 |
| 采集预算上限（时间窗 / 条数 / 每项样本 / 超时 / 并发） | `IMPLEMENTED` | 同上 |
| 凭据引用化 + 日志脱敏 | `IMPLEMENTED` | 同上 |
| SSRF 防护（私网 / 回环 / 元数据 / userinfo / 重定向） | `IMPLEMENTED` | 同上 |
| 插件签名产出证据（与 Kernel 字节一致） | `IMPLEMENTED` | `signAttestation` / `attestationPayload` |
| ADR-015 | `IMPLEMENTED` | `docs/adr/` |
| 前端 | `NOT_STARTED`（本任务不碰 `apps/platform-web/`，manifest `frontend: null`） | — |
| OCI 镜像构建与 digest 固定 | `NOT_RUN`（无 Docker daemon） | `plugins/zabbix-source/backend/Dockerfile` |

### 1.1 证据信任：复用来源

第一件事**不是新造**，而是 cherry-pick `origin/feat/g12-trusted-evidence`（`e328bd7`）后剥离 UI 部分：

```
git cherry-pick -n e328bd7
git restore --staged --worktree apps/platform-web tests/ui/g12-incident-route-identity.spec.ts
```

保留：Kernel 实现、迁移、契约、设计文档、`tests/acceptance/g12_trusted_evidence.sh`。
剥离：`apps/platform-web/**`（9 个文件）、`tests/ui/g12-incident-route-identity.spec.ts`。

**剥离原因与后果**：三个并发会话正在改 `apps/platform-web/`，一起提交必然冲突。被剥离的 UI 补丁里有一处与后端语义相关：写入表单不再提供 `SOURCE_ATTESTED` 选项。**后端不依赖该表单**（服务端对 `trust`/`claimedTrust=SOURCE_ATTESTED` 一律 400），所以安全性不受影响；但在 UI 补齐之前，旧前端若仍发送 `trust` 字段，用户会看到一个 400 而不是一个被禁用的选项。这是**已知的 UI/后端暂时不一致**，见第 4 节 R-4。

### 1.2 信任判定的三条路径（语义）

| 请求 | `verified_trust` | `verification_method` |
|---|---|---|
| 带已注册 adapter 的有效签名 | `SOURCE_ATTESTED` | `SOURCE_ADAPTER` |
| 已认证 operator，无 attestation | `OPERATOR_ASSERTED` | `OPERATOR_IDENTITY` |
| `claimedTrust: UNVERIFIED` | `UNVERIFIED` | `NONE` |
| 请求体带旧 `trust` 字段 | 400 `EVIDENCE_TRUST_NOT_SELF_ASSERTABLE` | 不写入 |
| `claimedTrust: SOURCE_ATTESTED` | 400 `EVIDENCE_TRUST_NOT_SELF_ASSERTABLE` | 不写入 |
| 未知 adapter | 401 `EVIDENCE_ADAPTER_UNKNOWN` | 不写入 |
| 签名不匹配 | 401 `EVIDENCE_ATTESTATION_INVALID` | 不写入 |
| 签名超出 ±300s | 401 `EVIDENCE_ATTESTATION_STALE` | 不写入 |

签名覆盖 `v, adapterId, incidentId, kind, source, collectedAtUnix, contentRef, issuedAtUnix`。**不在签名内的字段不能影响信任等级**：信任等级只由上表决定，与任何未签名字段无关。

---

## 2. 真实运行过的命令与结果

全部在 `claude/zabbix-connector-attested-evidence-7106ce` 上执行，macOS 24.6.0 / Node 22.12.0。

### 2.1 验收门（四项，均 `EXIT=0`）

```
cargo check --workspace --all-targets                      -> EXIT=0
cargo clippy --workspace --all-targets -- -D warnings      -> EXIT=0
python3 tests/contract/validate_contracts.py               -> EXIT=0  (schemas: 16, examples: 6)
cargo test -p opsweave-kernel --bins incidents             -> EXIT=0  (26 passed; 0 failed)
node --test plugins/zabbix-source/backend/zabbix.test.mjs  -> EXIT=0  (19 pass; 0 fail)
```

### 2.2 Kernel 测试：26 通过，但其中 22 个实际被跳过（重要）

`cargo test` 报 `26 passed`，这个数字**会误导**。`incidents.rs` 的测试以 `test_pool()` 取数据库，未设 `OPSWEAVE_TEST_DATABASE_URL` 时 `return None` 直接返回，计为 passed。实测：

```
cargo test -p opsweave-kernel --bins incidents -- --nocapture \
  | grep -c 'skip: OPSWEAVE_TEST_DATABASE_URL is unset'
-> 22
```

**真正执行了断言的只有 4 个**（纯函数，无需数据库）：

- `attestation_payload_matches_the_published_golden_vector` ← 签名载荷字节
- `closed_sets_reject_unknown_values_and_normalize_case`
- `bounded_counts_characters_not_bytes`
- `cursor_round_trips_and_rejects_garbage`

**被跳过的 22 个里包含本任务要求的全部负向测试**：`a_caller_cannot_claim_attested_trust`、`forged_and_stale_attestations_are_refused_and_write_nothing`、`a_body_trust_field_is_refused_and_writes_nothing`、`an_operator_submission_is_verified_as_operator_identity_only`、`a_valid_adapter_attestation_is_the_only_path_to_attested_trust`、`the_database_refuses_a_hand_written_attested_row`、`a_replay_cannot_upgrade_a_settled_trust` 等。

这些测试**代码存在且随 cherry-pick 一并保留**，但**在本机从未运行**，状态是 `NOT_RUN`，不是 passed。

**为什么跑不了**：本会话 sandbox 禁止 System V 共享内存，Postgres 无法初始化：

```
initdb -D $TMPDIR/owpg/data
-> 致命错误: 无法创建共享内存段: Operation not permitted
-> 系统调用 shmget(key=..., size=56, 03600) 执行失败
```

加 `shared_memory_type=mmap` 同样失败（`initdb` 的 bootstrap 仍需一个 SysV 段）。Docker daemon 也不可用（`/Users/liuzhiwei/.docker/run/docker.sock` 不存在）。

**让它们真正运行的命令**（需要一个可抛弃的库）：

```bash
OPSWEAVE_REQUIRE_TEST_DATABASE=1 OPSWEAVE_TEST_DATABASE_URL=postgres://localhost/opsweave_test cargo test -p opsweave-kernel --bins incidents
```

设 `OPSWEAVE_REQUIRE_TEST_DATABASE=1` 时，缺 URL 会 panic 而不是静默跳过——用它可以防止「跳过被当成通过」。

### 2.3 插件测试：19 通过，全部真实执行

`node --test plugins/zabbix-source/backend/zabbix.test.mjs`，无跳过：

| # | 测试 | 覆盖 |
|---|---|---|
| 1 | 签名载荷与 Kernel golden vector 字节一致 | 跨语言一致性 |
| 2 | 签名在 Kernel 算法下可验证，任何改动即失效 | 签名覆盖面 |
| 3 | 未配置的 adapter 根本无法签名 | 负向 |
| 4 | 探活区分 unreachable / timeout / unauthorized / unknown | 失败语义 |
| 5 | 超时不等于宕机；心跳静默不提升 source 状态 | `AGENTS.md` MUST NOT |
| 6 | 已确证的「无」是 EMPTY，未确证的是 NO_DATA | `rules/05` |
| 7 | 缺失读数是 null + 原因，绝不为 0 | `rules/05` |
| 8 | 单项失败使整体 PARTIAL 且保留其余 | 部分失败 |
| 9 | 全部失败时报出「是哪一种无」 | 失败语义 |
| 10 | 请求 0 个 item 是 EMPTY，不是「零项成功」 | 分母诚实 |
| 11 | 有数据与确证无数据混合是 PARTIAL，不是 OK | `rules/05` |
| 12 | 超上限的预算被钳制且结果声明 clamped | 预算 |
| 13 | item 过多时 PARTIAL，分母是完整请求数 | 未知分母 |
| 14 | 过长时间窗被钳到最近一段并上报 | 预算 |
| 15 | 触及每项样本上限时 PARTIAL + 可解释的 null | 预算 |
| 16 | 内容摘要对 key 顺序稳定，随 outcome 改变 | 证据摘要 |
| 17 | 采集结果任何位置都不含密钥 | `rules/03` |
| 18 | 脱敏移除密钥与凭据形态文本，但保留普通诊断文本 | `rules/03` |
| 19 | SSRF 拦截回环/私网/元数据/userinfo/非法 scheme | `rules/03` |

测试 1 的字节一致性另有独立机器校验（分别运行 Rust 与 Node 实现并逐字节比对）：

```
JS  : {"v":"opsweave-evidence-attestation-v1","adapterId":"zabbix-main",...}
RUST: {"v":"opsweave-evidence-attestation-v1","adapterId":"zabbix-main",...}
IDENTICAL: yes
```

### 2.4 测试过程中发现并修掉的真实缺陷

测试 18 第一次运行时**失败**，暴露脱敏函数的真实漏洞：`authorization: Bearer abc123` 只被替换到头名，令牌 `abc123` 原样留在输出里（值在空格之后，而原模式停在空格）。修正后令牌被遮蔽。随后的中间版本过度贪婪（任何含 "secret" 的普通句子尾部被吞掉，会损害诊断可读性），最终模式要求出现真实的 key/value 分隔符，既遮蔽 `Bearer <token>` 又保留普通文本。实测：

```
"authorization: Bearer abc123"      -> "authorization: Bearer [redacted]"
"{\"password\":\"hunter2\"}"        -> "{\"password\":\"[redacted]\"}"
"token=abc123&x=1"                  -> "token=[redacted]&x=1"
"https://user:pw@zabbix.example/api"-> "https://[redacted]@zabbix.example/api"
"could not resolve the secret store"-> "could not resolve the secret store"   (普通文本保留)
```

### 2.5 契约校验器的负向检查确有鉴别力

新增的检查不是摆设，实测会在违规时失败（突变测试）：

```
null 样本但缺 absenceReason   -> 被拒 (False)
缺失渲染成 0                  -> 被拒 (False)
原始 token 冒充 secretref     -> 被拒 (False)
非法 outcome 值               -> 被拒 (False)
合法样本 / 合法 source        -> 通过 (True)
```

契约与服务端路由的对应关系亦机器校验：6 条契约路径全部可被服务端路由命中（`ALL CONTRACT PATHS ROUTED: True`）。

---

## 3. NOT_RUN 清单（明确标注，不以 mock 冒充）

| # | 项 | 为什么没跑 | 怎么跑 |
|---|---|---|---|
| N-1 | **22 个 Kernel 数据库测试**（含全部签名负向测试） | sandbox 禁 SysV 共享内存，`initdb` 失败；无 Docker | 见 2.2 的命令 |
| N-2 | **真实 Zabbix 端到端采集** | 没有任何真实 Zabbix 实例。**未用 mock 冒充**：插件逻辑测试走注入的 transport，它证明的是状态机与预算，不是真实 Zabbix 的行为 | 指向真实实例跑 `POST /sources/{id}/probe` 与 `/collect` |
| N-3 | **真实 socket 上的 HTTP 服务** | sandbox 禁本地端口监听（`listen EPERM 127.0.0.1`）。路由仅做了解析与契约对应校验，未经过真实 socket | `node server.mjs` 后 curl 各端点 |
| N-4 | **OCI 镜像构建 / digest 固定 / 非 root 实测** | 无 Docker daemon。`rules/09` 要求以真实运行结果验收，不凭 Dockerfile 表面声明推断 | `docker build plugins/zabbix-source/backend` 后核对 digest 与 `USER` |
| N-5 | **迁移 0017 在真实库上的执行** | 同 N-1。包括历史 `SOURCE_ATTESTED` 行被降级为 `UNVERIFIED` 这一破坏性语义 | 在副本库上跑迁移并核对降级行数 |
| N-6 | **`tests/acceptance/g12_trusted_evidence.sh`** | 需运行中的 Kernel + 库 | 起 Kernel 后执行该脚本 |
| N-7 | **多语言 conformance / OCI Release Review** | `AGENTS.md` 要求发布到真实两节点前通过；本任务未发布 | 见对应 SKILL.md |

**产品状态：未就绪。** 实现状态 `IMPLEMENTED`、测试状态 `PARTIAL`（19 个插件测试真实通过，22 个 Kernel 测试 `NOT_RUN`）、产品状态 `NOT_READY`（无前端、无镜像、无真实数据源验证）。

---

## 4. 风险清单

| # | 风险 | 影响 | 缓解 / 现状 |
|---|---|---|---|
| R-1 | **签名负向测试从未在本机运行** | 认证逻辑的正确性目前依赖代码审查与上游分支，而非本机实测 | 已如实标注 `NOT_RUN`（N-1）。缓解：DB 层 CHECK 约束使手写 INSERT 也无法伪造 `SOURCE_ATTESTED`，构成第二道防线；但该约束本身同样 `NOT_RUN` |
| R-2 | **Adapter 密钥是共享对称密钥**（HMAC） | 持有密钥者可为任意 incident 伪造任意内容的证据；密钥泄露即可冒充该 adapter | 默认空配置（无 adapter 则无人可认证）；密钥只存在于 Kernel 环境变量与插件密钥存储，不入库、不出接口、不入日志。**非对称签名留待后续**，见 ADR-015 第 7 节 |
| R-3 | **迁移 0017 会把历史 `SOURCE_ATTESTED` 行降级为 `UNVERIFIED`** | 既有「已认证」证据在 UI 上变为未验证；这是有意的（旧值本就是客户端自报），但对读者是可见的语义变化 | 迁移写入 `verification_note` 说明原因；逆向 DDL 已在 `docs/design/g11-incident/incident-adr.md` §11.7 记录为人工操作。**迁移只前向，不自动回滚** |
| R-4 | **UI 与后端暂时不一致**（见 1.1） | 旧前端若发送 `trust` 字段会得到 400，而非一个被禁用的选项 | 后端语义是安全的（拒绝而非接受）。需要 UI 会话补一个补丁：表单去掉 `SOURCE_ATTESTED` 选项、按错误码取本地化文案。被剥离的 UI 补丁可从 `origin/feat/g12-trusted-evidence` 取用 |
| R-5 | **±300s 时钟窗依赖双方时钟** | 时钟漂移超过 5 分钟会使合法签名被拒（表现为 `EVIDENCE_ATTESTATION_STALE`） | 窗口两侧对称，拒绝而非接受，失败方向安全。需要 NTP；排障时错误码已明确给出偏移秒数 |
| R-6 | **攻击者可重放 300s 内的签名** | 同一签名在窗口内可被重复提交 | 证据表 `UNIQUE (incident_id, kind, source, content_ref)` 使重放落到同一行而非产生第二条；`a_replay_cannot_upgrade_a_settled_trust` 覆盖此点，但该测试 `NOT_RUN` |
| R-7 | **插件信任 Zabbix 返回的时间戳** | Zabbix 侧时钟错误会使 `occurredAt` 失真 | 契约明确 `occurredAt` 是源端测量时刻、`observedAt` 是本插件读取时刻，两者不混淆（`AGENTS.md` 文档约束）。未做源端时钟校正 |
| R-8 | **预算上限是硬编码常量** | 大规模采集需求可能触顶（`maxItems` 500、窗口 24h、每项 5000 样本） | 上限在 `BUDGET_CEILING` 集中声明，结果始终回报 `clamped` 与完整分母，不静默截断。调整需改代码并复核契约 |
| R-9 | **`verifyTls: false` 可被显式关闭** | 关闭后流量可被中间人读取 | 只能由操作者显式设置；此时 source 状态被强制为 `DEGRADED` 而非 `READY`，不能伪装成健康 |
| R-10 | **无前端** | 三个 UI 会话依赖本线的契约，但本线不提供页面 | 契约（schema + OpenAPI + 示例）已先行落地，UI 可据此开发。错误码稳定，UI 按码取文案 |
| R-11 | **插件的 source 与 collection 存在进程内存中**（`server.mjs` 的 `SOURCES` / `COLLECTIONS` 两个 `Map`） | 插件重启后已配置的 source 全部丢失，需重新配置；采集结果也随之丢失，因此重启后对旧 `collectionId` 调 `/attestation` 会得到 404 而非一个签名 | 这是有意的 0.0.1 取舍：丢失一份 source 配置是可见且安全的，而一份写坏/半迁移的凭据引用不是。`COLLECTIONS` 有 200 条上限，不会无界增长（`AGENTS.md`：存储要有上限）。**未做持久化**，落库是后续项（见第 5 节） |

---

## 5. 未处理项（留给后续）

1. N-1..N-7 全部 NOT_RUN 项，尤其 N-1（签名负向测试）与 N-2（真实 Zabbix）。
2. R-4 的 UI 补丁（不属本任务范围，`apps/platform-web/` 由其他会话持有）。
3. 非对称签名（Ed25519）替代共享 HMAC 密钥，见 ADR-015 第 7 节。
4. Adapter 密钥轮换与吊销：当前改配置需重启 Kernel，无在线轮换。
5. 插件自身的持久化：当前 source 配置存于内存，重启即失。真实部署需按 `rules/05` 落到插件自有 schema（`requires` 已留 `plugin.storage.v1` 的接入位，但未实现）。
6. 采集结果的留存与按时间查询：当前 `/collect` 同步返回，结果只在内存中保留供 `/attestation` 取用，无历史查询。
