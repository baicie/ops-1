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
| Zabbix 插件：探活 / host / item / 按窗采集 | `IMPLEMENTED`（26 个测试通过 + 真实 socket 端到端；真实实例 `NOT_RUN`，见 N-2） | `plugins/zabbix-source/backend/zabbix.mjs` |
| 七态数据语义（OK/EMPTY/NO_DATA/PARTIAL/UNKNOWN/UNAVAILABLE/TIMEOUT） | `IMPLEMENTED` | 同上 |
| 采集预算上限（时间窗 / 条数 / 每项样本 / 超时 / 并发） | `IMPLEMENTED` | 同上 |
| 凭据引用化 + 日志脱敏 | `IMPLEMENTED` | 同上 |
| SSRF 防护（私网 / 回环 / 元数据 / userinfo / 重定向） | `IMPLEMENTED` | 同上 |
| 插件 HTTP 服务可真实启动并服务全部端点 | `IMPLEMENTED`（真实 socket 验证，见 2.4） | `plugins/zabbix-source/backend/server.mjs` |
| 插件签名产出证据（与 Kernel 字节一致） | `IMPLEMENTED`（载荷字节一致已双向验证；跨进程提交 `NOT_RUN`，见 N-8） | `signAttestation` / `attestationPayload` |
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
node --test plugins/zabbix-source/backend/zabbix.test.mjs  -> EXIT=0  (26 pass; 0 fail; 0 skipped)
```

上表是**最终一次**（2026-11-01，真实库 + 真实 socket 修复之后）的复跑结果。`cargo` 两条命令的退出码用 `pipestatus` 取，不是 `$?`——`cmd | tail` 的 `$?` 是 `tail` 的退出码，恒为 0，那样报出来的「通过」是假的。

### 2.2 Kernel 测试：26 个，全部真实执行并通过（2026-11-01 补跑）

首次提交时这 26 个里只有 4 个真正跑了，其余 22 个因本机无法启动 PostgreSQL 而静默跳过（`test_pool()` 拿不到库时 `return None`，计为 passed）。那个状态**会误导**，已按要求标注为 `NOT_RUN`。

沙箱限制解除后，用本地 PostgreSQL 17 补跑，**26 / 26 真实执行并通过，0 跳过**：

```
initdb -D $TMPDIR/owpg2/data -U postgres --auth=trust -E UTF8          -> EXIT=0
pg_ctl ... -o "-p 54329 -c listen_addresses='127.0.0.1'" start         -> EXIT=0
psql ... -c "create database opsweave_test"                            -> CREATE DATABASE

OPSWEAVE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/opsweave_test \
OPSWEAVE_REQUIRE_TEST_DATABASE=1 \
  cargo test -p opsweave-kernel --bin opsweave-kernel incidents::        -> EXIT=0
```

结果：`26 passed; 0 failed; 0 ignored`，并且 `grep -c 'skip:'` 计数为 **0** —— `OPSWEAVE_REQUIRE_TEST_DATABASE=1` 保证缺库时 panic 而非跳过，所以这一次的「passed」没有水分。

本任务要求的负向测试**全部实际执行并通过**：

- `a_caller_cannot_claim_attested_trust`（人工写入不得获得 `SOURCE_ATTESTED`）
- `forged_and_stale_attestations_are_refused_and_write_nothing`（签名不匹配 + 签名过期）
- `a_body_trust_field_is_refused_and_writes_nothing`（旧 `trust` 字段被拒）
- `an_operator_submission_is_verified_as_operator_identity_only`
- `a_valid_adapter_attestation_is_the_only_path_to_attested_trust`
- `the_database_refuses_a_hand_written_attested_row`
- `a_replay_cannot_upgrade_a_settled_trust`

**为什么第一次跑不了**：当时会话 sandbox 禁止 System V 共享内存，`initdb` 报 `无法创建共享内存段: Operation not permitted`（`shmget(key=..., size=56, 03600) 执行失败`），`shared_memory_type=mmap` 同样失败，Docker daemon 也不可用。沙箱关闭后 `initdb` 直接成功。

**本地复跑命令**（任意可抛弃的库）：

```bash
OPSWEAVE_TEST_DATABASE_URL=postgres://localhost/opsweave_test OPSWEAVE_REQUIRE_TEST_DATABASE=1 \
  cargo test -p opsweave-kernel --bin opsweave-kernel incidents::
```

#### 2.2.1 测试确有鉴别力（变异验证）

「全部通过」本身不能证明测试有效，所以把关键防线故意改坏，确认测试会失败：

| 变异 | 结果 |
|---|---|
| 让签名比较恒真（`if false && !constant_time_eq(...)`） | `forged_and_stale_attestations_are_refused_and_write_nothing` **FAILED**，EXIT=101 |
| 把 `SOURCE_ATTESTED` 重新加进 `CLAIMABLE_TRUSTS` 并移除拒绝分支（还原原始缺陷） | `a_caller_cannot_claim_attested_trust`、`closed_sets_reject_unknown_values_and_normalize_case` **FAILED**，EXIT=101 |

两次变异后 `apps/kernel/src/incidents.rs` 均已还原，`git diff` 为空（与提交逐字节一致）。

#### 2.2.2 数据库层防线独立验证

绕过 Rust handler，直接对迁移后的库手写 SQL 插入一行自称 attested 的证据：

```sql
INSERT INTO kernel.incident_evidence (..., claimed_trust, verified_trust,
       verification_method, submitted_by, ...)
VALUES (..., 'SOURCE_ATTESTED','SOURCE_ATTESTED','NONE', <admin>, ...);
```

被数据库拒绝：

```
错误: 关系 "incident_evidence" 的新列违反了检查约束
      "incident_evidence_attestation_requires_adapter"
```

即 handler 之外的第二条防线成立：**手写 SQL 也无法凭空制造 attestation**。迁移在真实库上确认生效，`incident_evidence` 的约束与列：

```
约束: incident_evidence_attestation_requires_adapter, incident_evidence_verification_check,
      incident_evidence_verification_method_check, incident_evidence_verified_trust_check, ...
列  : evidence_id incident_id kind source collected_at content_ref claimed_trust created_at
      verified_trust verification_method verified_at verifier_identity submitted_by verification_note
```

（`claimed_trust` 与 `verified_trust` 确为两列 —— 这是「声明」与「结论」分离的物理证据。）

设 `OPSWEAVE_REQUIRE_TEST_DATABASE=1` 时，缺 URL 会 panic 而不是静默跳过——用它可以防止「跳过被当成通过」。

### 2.3 插件测试：26 通过，全部真实执行

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
| 19 | 清单保留 UNKNOWN 可用性，不与 UNAVAILABLE 合并 | `rules/05` |
| 20 | 清单多取一行以探测裁剪，裁剪时如实上报 `truncated: null` | 分母诚实 |
| 21 | 恰好等于上限是完整结果，不是裁剪 | 边界 |
| 22 | 空清单是 EMPTY；无法映射的响应是 NO_DATA | `rules/05` |
| 23 | 清单失败复用与采集相同的失败词汇 | 失败语义 |
| 24 | 按 host 列 item 并映射 value_type；缺失 unit 为 null | 清单 |
| 25 | 缺 hostId 被拒，而不是静默列出全站 item | 负向 |
| 26 | SSRF 拦截回环/私网/元数据/userinfo/非法 scheme | `rules/03` |

测试 1 的字节一致性另有独立机器校验（分别运行 Rust 与 Node 实现并逐字节比对）：

```
JS  : {"v":"opsweave-evidence-attestation-v1","adapterId":"zabbix-main",...}
RUST: {"v":"opsweave-evidence-attestation-v1","adapterId":"zabbix-main",...}
IDENTICAL: yes
```

#### 2.3.1 新增的清单测试确有鉴别力（变异验证）

第 19–25 条覆盖的是**新实现、此前零覆盖**的 `listHosts` / `listItems`，所以对它们逐条做变异：

| 变异 | 结果 |
|---|---|
| `availability()` 把 UNKNOWN 与 UNAVAILABLE 合并 | 测试 19 **FAILED** |
| `inventory()` 不再多取一行（`limit + 1` → `limit`），即静默截断 | 测试 20 **FAILED** |
| 裁剪时谎报 `truncated: 0` | 测试 20 **FAILED** |
| 移除 `ZABBIX_HOST_REQUIRED` 守卫 | 测试 25 **FAILED** |

四次变异后 `zabbix.mjs` 均从备份还原，`shasum` 与还原前一致、`diff` 为空。

### 2.4 真实 socket 端到端（N-3，2026-11-01 补跑）

沙箱解除后可以监听本地端口，于是首次**真正启动**插件（此前只做过路由解析与契约对应校验）。

#### 2.4.1 启动即暴露的严重缺陷

`node server.mjs` 直接失败：

```
SyntaxError: The requested module './zabbix.mjs' does not provide an export named 'clampBudget'
```

`server.mjs` **从未能启动过**。四个引用不存在：`clampBudget`（真名 `resolveBudget`）、`collectionDigest`（真名 `contentRef`）、以及**完全没实现**的 `listHosts` / `listItems`。修好导入后，调用处的签名也对不上（`probe(source, {secret})` 实际是 `probe({...source, secret})`；`collect(source, body, {secret})` 实际是 `collect({source, itemIds, window, budget})`）。

**为什么之前的检查没抓到**：`node --check` 只做语法分析，**不解析 import 绑定**；契约校验器只比对路径字符串；19 个单元测试各自 import 自己用到的符号，不 import `server.mjs`。四道门全部通过，而服务器一行都跑不起来。教训已写进第 4 节 R-12。

修复：实现 `inventory()` 及其 `availability()` / `valueType()` 投影、`listHosts()`、`listItems()`，并按模块真实签名改齐调用处。

#### 2.4.2 修复后真实跑通的闭环

假 Zabbix（`:18099`）+ 插件（`:18098`）+ 真实 PostgreSQL（`:54329`），全部经真实 socket：

```
无身份头                    -> 401 UNAUTHENTICATED
viewer 写                   -> 403 FORBIDDEN
凭据非 secretref            -> 400 CREDENTIAL_NOT_A_REFERENCE
凭据塞进 URL                -> 400 CREDENTIAL_IN_URL
创建 source                 -> 201, status "UNVERIFIED"（未探活就不自称就绪）
probe                       -> {"outcome":"OK","apiVersion":"7.0.0"}，status -> READY
hosts                       -> web-01 AVAILABLE / db-01 UNKNOWN（UNKNOWN 未被抹平）
items 缺 hostId             -> 400 ZABBIX_HOST_REQUIRED
```

七态数据语义（这是本任务的核心要求，逐条实测）：

| 场景 | 实测结果 |
|---|---|
| 正常样本 | `value: 17.5` |
| 源端空字符串 | `value: null` + `absenceReason: NOT_RECORDED` |
| 源端真实 0 | `value: 0` + `absenceReason: null`（**0 没有被当成缺失**） |
| 权威的空窗口 | `outcome: EMPTY`，`samples: []` |
| 响应形状不可映射 | `outcome: NO_DATA`，`errorCode: ZABBIX_RESPONSE_SHAPE` |
| item 挂起 | `outcome: TIMEOUT`，1.532s 返回（`requestTimeoutMs` 1500），`ZABBIX_TIMEOUT` |
| 一项成功一项超时 | `outcome: PARTIAL`，`requested: 2 / answered: 1`，成功项样本完整保留 |

预算裁剪（请求 999999 项 / 10 年窗口 / 并发 64）：

```
clamped: ["budget.maxWindowSeconds","budget.maxItems","budget.maxConcurrency","window"]
budget : maxWindowSeconds 86400, maxItems 500, maxSamplesPerItem 1000, requestTimeoutMs 10000, maxConcurrency 4
outcome: PARTIAL（裁剪过就不是 OK）
window : 2016-01-01..2026-11-01 被钳到最近 86400s
```

缺窗口 → `400 ZABBIX_WINDOW_REQUIRED`。

**仍未做**：探活时源端不可达与 `EVIDENCE_ADAPTER_NOT_CONFIGURED` 两个分支在本次 socket 测试中未单独触发（前者在单元测试 4 覆盖），见 N-8。

### 2.5 测试过程中发现并修掉的真实缺陷（脱敏）

测试 18 第一次运行时**失败**，暴露脱敏函数的真实漏洞：`authorization: Bearer abc123` 只被替换到头名，令牌 `abc123` 原样留在输出里（值在空格之后，而原模式停在空格）。修正后令牌被遮蔽。随后的中间版本过度贪婪（任何含 "secret" 的普通句子尾部被吞掉，会损害诊断可读性），最终模式要求出现真实的 key/value 分隔符，既遮蔽 `Bearer <token>` 又保留普通文本。实测：

```
"authorization: Bearer abc123"      -> "authorization: Bearer [redacted]"
"{\"password\":\"hunter2\"}"        -> "{\"password\":\"[redacted]\"}"
"token=abc123&x=1"                  -> "token=[redacted]&x=1"
"https://user:pw@zabbix.example/api"-> "https://[redacted]@zabbix.example/api"
"could not resolve the secret store"-> "could not resolve the secret store"   (普通文本保留)
```

### 2.6 契约校验器的负向检查确有鉴别力

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

## 3. 仍未运行的清单（明确标注，不以 mock 冒充）

原清单中的 N-1 / N-3 / N-5 已于 2026-11-01 在沙箱解除后**真实运行并通过**，详见 2.2 与 2.4。下表只列**当前**仍然没跑的：

| # | 项 | 为什么没跑 | 怎么跑 |
|---|---|---|---|
| N-2 | **真实 Zabbix 端到端采集** | 没有任何真实 Zabbix 实例。2.4 的 socket 测试用的是本地假 Zabbix，它证明的是插件自身的状态机、预算与 HTTP 层，**不证明真实 Zabbix 的响应形状** | 指向真实实例跑 `POST /sources/{id}/probe` 与 `/collect` |
| N-4 | **OCI 镜像构建 / digest 固定 / 非 root 实测** | 无 Docker daemon。`rules/09` 要求以真实运行结果验收，不凭 Dockerfile 表面声明推断 | `docker build plugins/zabbix-source/backend` 后核对 digest 与 `USER` |
| N-6 | **`tests/acceptance/g12_trusted_evidence.sh`** | 需运行中的 Kernel + 库。Kernel 已能在真实库上跑单测（2.2），但该脚本要求起完整 Kernel 进程 | 起 Kernel 后执行该脚本 |
| N-7 | **多语言 conformance / OCI Release Review** | `AGENTS.md` 要求发布到真实两节点前通过；本任务未发布 | 见对应 SKILL.md |
| N-8 | **`/collections/{id}/attestation` 与 `/runtime-info` 的真实 socket 调用** | 2.4 的假 Zabbix 会话未对这两个端点单独发请求。签名逻辑本身有单元测试 1/2/3 覆盖，Kernel 侧验签有 2.2 的 26 个真实库测试覆盖，但**「插件签出来的信封交给 Kernel 能否被接受」这条跨进程链路没有一次端到端实测** | 起 Kernel（配置 `OPSWEAVE_EVIDENCE_ADAPTERS=zabbix-main:<secret>`）与插件，取采集结果做 attestation 后 POST 到 Kernel 的证据接口 |
| N-9 | **插件重启后 source/collection 丢失** | 见 R-11，属已知取舍而非遗漏 | 需要时按 `rules/05` 落插件自有 schema |

**N-8 是当前最值得优先补的一项**：它是唯一同时跨越两个进程与两套语言实现的链路，而单元测试各自只验证了自己那一半。

**产品状态：未就绪。** 实现状态 `IMPLEMENTED`、测试状态 `PARTIAL`（26 个 Kernel 测试与 26 个插件测试全部真实通过，但无真实 Zabbix 实例、无镜像、无跨进程验签实测）、产品状态 `NOT_READY`。

---

## 4. 风险清单

| # | 风险 | 影响 | 缓解 / 现状 |
|---|---|---|---|
| R-1 | ~~签名负向测试从未在本机运行~~ **已关闭** | — | 2026-11-01 已在真实 PostgreSQL 上跑通 26/26，并用两次变异验证测试有鉴别力（2.2.1）；数据库 CHECK 约束另经手写 INSERT 独立验证（2.2.2） |
| R-2 | **Adapter 密钥是共享对称密钥**（HMAC） | 持有密钥者可为任意 incident 伪造任意内容的证据；密钥泄露即可冒充该 adapter | 默认空配置（无 adapter 则无人可认证）；密钥只存在于 Kernel 环境变量与插件密钥存储，不入库、不出接口、不入日志。**非对称签名留待后续**，见 ADR-015 第 7 节 |
| R-3 | **迁移 0017 会把历史 `SOURCE_ATTESTED` 行降级为 `UNVERIFIED`** | 既有「已认证」证据在 UI 上变为未验证；这是有意的（旧值本就是客户端自报），但对读者是可见的语义变化 | 迁移写入 `verification_note` 说明原因；逆向 DDL 已在 `docs/design/g11-incident/incident-adr.md` §11.7 记录为人工操作。**迁移只前向，不自动回滚**。已在真实库上执行确认（2.2.2） |
| R-4 | **UI 与后端暂时不一致**（见 1.1） | 旧前端若发送 `trust` 字段会得到 400，而非一个被禁用的选项 | 后端语义是安全的（拒绝而非接受）。需要 UI 会话补一个补丁：表单去掉 `SOURCE_ATTESTED` 选项、按错误码取本地化文案。被剥离的 UI 补丁可从 `origin/feat/g12-trusted-evidence` 取用 |
| R-5 | **±300s 时钟窗依赖双方时钟** | 时钟漂移超过 5 分钟会使合法签名被拒（表现为 `EVIDENCE_ATTESTATION_STALE`） | 窗口两侧对称，拒绝而非接受，失败方向安全。需要 NTP；排障时错误码已明确给出偏移秒数 |
| R-6 | **攻击者可重放 300s 内的签名** | 同一签名在窗口内可被重复提交 | 证据表 `UNIQUE (incident_id, kind, source, content_ref)` 使重放落到同一行而非产生第二条；`a_replay_cannot_upgrade_a_settled_trust` 已真实通过（2.2） |
| R-7 | **插件信任 Zabbix 返回的时间戳** | Zabbix 侧时钟错误会使 `occurredAt` 失真 | 契约明确 `occurredAt` 是源端测量时刻、`observedAt` 是本插件读取时刻，两者不混淆（`AGENTS.md` 文档约束）。未做源端时钟校正 |
| R-8 | **预算上限是硬编码常量** | 大规模采集需求可能触顶（`maxItems` 500、窗口 24h、每项 5000 样本） | 上限在 `BUDGET_CEILING` 集中声明，结果始终回报 `clamped` 与完整分母，不静默截断。调整需改代码并复核契约 |
| R-9 | **`verifyTls: false` 可被显式关闭** | 关闭后流量可被中间人读取 | 只能由操作者显式设置；此时 source 状态被强制为 `DEGRADED` 而非 `READY`，不能伪装成健康 |
| R-10 | **无前端** | 三个 UI 会话依赖本线的契约，但本线不提供页面 | 契约（schema + OpenAPI + 示例）已先行落地，UI 可据此开发。错误码稳定，UI 按码取文案 |
| R-11 | **插件的 source 与 collection 存在进程内存中**（`server.mjs` 的 `SOURCES` / `COLLECTIONS` 两个 `Map`） | 插件重启后已配置的 source 全部丢失，需重新配置；采集结果也随之丢失，因此重启后对旧 `collectionId` 调 `/attestation` 会得到 404 而非一个签名 | 这是有意的 0.0.1 取舍：丢失一份 source 配置是可见且安全的，而一份写坏/半迁移的凭据引用不是。`COLLECTIONS` 有 200 条上限，不会无界增长（`AGENTS.md`：存储要有上限）。**未做持久化**，落库是后续项（见第 5 节） |
| R-12 | **`server.mjs` 曾因导入不存在的符号而完全无法启动**，且四道验收门全部照常通过 | 交付物在真实运行前是死的。这不是理论风险：本任务首次 `node server.mjs` 即崩溃 | 已修复并补齐缺失的 `listHosts` / `listItems`（2.4.1）。**结构性教训**：`node --check` 不解析 import 绑定、契约校验器只看路径字符串、单测各自只 import 自己用的符号——三者合起来无法证明「服务能启动」。缓解措施：真实 socket 冒烟测试（2.4）现在是启动路径的唯一证据，后续应纳入 CI，而不是依赖人工记得跑 |

---

## 5. 未处理项（留给后续）

1. **N-8（跨进程验签）是最高优先项**：插件签名 → Kernel 验签这条链路至今没有一次端到端实测，而它是本任务两条线唯一的交汇点。其次 N-2（真实 Zabbix）与 N-4（镜像）。
2. R-4 的 UI 补丁（不属本任务范围，`apps/platform-web/` 由其他会话持有）。
3. 非对称签名（Ed25519）替代共享 HMAC 密钥，见 ADR-015 第 7 节。
4. Adapter 密钥轮换与吊销：当前改配置需重启 Kernel，无在线轮换。
5. 插件自身的持久化：当前 source 配置存于内存，重启即失。真实部署需按 `rules/05` 落到插件自有 schema（`requires` 已留 `plugin.storage.v1` 的接入位，但未实现）。
6. 采集结果的留存与按时间查询：当前 `/collect` 同步返回，结果只在内存中保留供 `/attestation` 取用，无历史查询。
7. **把 2.4 的真实 socket 冒烟测试固化为 CI 步骤**（见 R-12）：目前它是启动路径唯一证据，靠人工执行。
