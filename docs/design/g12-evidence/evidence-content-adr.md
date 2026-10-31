# ADR-G12-002 · Evidence Content：可验证的字节，而不是一句引用

- 状态：**Accepted（Phase B 随本 ADR 落地）**
- 范围：0.1.0 Gate G12 Phase B —— Evidence 的**内容**（bytes）与其读取路径
- 上游：`docs/design/g11-incident/incident-adr.md`（ADR-G11-001，Incident 事实权威）、Phase A PR #17（`0017_g12_evidence_trust.sql`，claimed/verified 分离）
- 契约：`contracts/openapi/incident-v1.yaml`
- 迁移：`apps/kernel/migrations/0018_g12_evidence_content.sql`
- 实现：`apps/kernel/src/incidents.rs`（`append_evidence` / `read_evidence_content`）
- 证据（验收）：`tests/acceptance/g12_evidence_content.sh`、`tests/ui/g12-evidence-content.spec.ts`

---

## 0. 这一版要修的缺陷

Phase A 之后，Kernel 能说清"这行证据的 trust 是谁给的"，但**说不清这行证据的内容在不在**。

`content_ref` 是一个 2..1000 字符的不透明字符串。它由客户端写，Kernel 从不解析、从不读取、从不校验，而 UI 把它渲染成"证据"。于是三种完全不同的东西长得一样：

1. 真的有字节、且字节没被改过；
2. 一个指向别处的引用（`s3://...`、`sha256:...`、一张局域网 URL），内容可能在、可能早没了；
3. 一句随手打的占位符（`probe-1`）。

**Phase B 的验收标准不是"引用被持久化了"，而是"内容真的在，且能证明它没变"。** 本 ADR 只回答这一件事：字节存在哪、谁算的摘要、谁能读、读完能证明什么。

---

## 1. 九项决策（逐项）

### 1.1 Evidence Metadata（元数据）

**决策**：元数据权威仍是 `kernel.incident_evidence`，**一列不改**。本 Phase 不往它加任何字段。

- "这行有没有内容"是**派生**的：读路径 `LEFT JOIN kernel.incident_evidence_content`，得到 `contentStatus`。
- **不新增 `has_content boolean` 列**。它会是同一事实的第二份拷贝，可以漂移：内容行被 DBA 手删之后，`has_content=true` 会让 UI 报"读取失败"而不是"这是 Legacy 引用"。派生字段没有这个失败模式。
- 元数据的其余形状（kind / source / collectedAt / claimedTrust / verifiedTrust / verificationMethod / verifiedAt / verifierIdentity / submittedBy / verificationNote / createdAt / afterVerdict）沿用 Phase A，不改语义。

**为什么最小**：0 个新列、0 个新索引在既有表上、0 次回填。既有 100% 行在 0018 之后自然变成 `contentStatus = LEGACY_REFERENCE`，这是它们的真实状态，不是降级。

### 1.2 Evidence Content（内容）

**决策**：一张新表，一行对应一行证据，存**有界字节**。

```
kernel.incident_evidence_content
  evidence_id   uuid  PK -> kernel.incident_evidence(evidence_id) ON DELETE RESTRICT
  content_type  text  CHECK (content_type IN ('text/plain','application/json'))
  body          bytea CHECK (octet_length(body) BETWEEN 1 AND 65536)
  octet_length  integer CHECK (octet_length BETWEEN 1 AND 65536 AND octet_length = octet_length(body))
  sha256        text  CHECK (^[0-9a-f]{64}$)          -- 服务端对自己存下的字节算的
  captured_at   timestamptz NOT NULL DEFAULT now()    -- 内容落库瞬间（服务端时钟）
  retention_expires_at timestamptz NOT NULL           -- captured_at + 365d
```

- **PostgreSQL `bytea`，不引对象存储**。理由见 §2。
- 只有纯文本与有界 JSON 两种 `content_type`；没有 charset 参数、没有 `text/html`、没有 `application/octet-stream`（§3.2）。
- 一个 evidence 最多一行内容，**没有版本**：内容要么被接受一次，要么从未存在。改内容 = 新证据行。
- 内容的读取是**单行单次**的独立端点（`GET .../evidence/{evidenceId}/content`），列表永远不内联字节（§3.3）。

### 1.3 Source Provenance（来源）

**决策**：来源是元数据的事实，不是内容的事实。内容行**不**再存一份 source。

- 来源三件套仍是：`source`（`MANUAL`/`API`）+ `kind`（`METRIC_SNAPSHOT`/`LOG_EXCERPT`/`QUERY_RESULT`/`OPERATOR_NOTE`）+ Phase A 的 `verifiedTrust`/`verificationMethod`/`verifierIdentity`。
- 内容的来源在语义上只有一种：**它是调用者通过本 API 提交的字节**。Kernel 不会替它去别处取（§3.5），所以不存在第二种内容来源，也就不需要第二个来源字段。
- 因此"内容从哪来"的完整答案是：`source` 说通道，`verifierIdentity` 说谁担保，`captured_at` 说落库时刻，`sha256` 说字节是哪些字节。四者缺一，这条证据就不完整——但都不是本 Phase 新造的概念。

### 1.4 Capture Window（采集时间窗）

**决策**：时间窗就是元数据已有的两个时刻，闭区间 `[collectedAt, createdAt]`，不新增"窗口"表或列。

- `collectedAt`：来源声称的采集时刻（客户端给，**这是 claim**）。
- `createdAt`：Kernel 接受并持久化该行的时刻（服务端时钟，**这是 fact**）。
- `content.captured_at`：内容行落库的服务端时刻。它与 `createdAt` 在同一事务内取数据库 `now()`，用来证明"我手上的字节是哪一刻被接受的"。
- **写侧时间窗（拒绝条件）**：`collectedAt` 超前服务端时钟 300s 以上 → `400 EVIDENCE_COLLECTED_AT_IN_FUTURE`；早于 400 天前 → `400 EVIDENCE_COLLECTED_AT_TOO_OLD`。理由：一个未来时间戳会让"这条证据早于/晚于某结论"永远算错，而 400 天与保留期（§1.7）同量级——比保留期还老的采集时刻不可能对应一个还能读到的真实内容。
- **UI 义务**：详情页把两个时刻都显示，并明确标注哪个是 claim、哪个是 fact；不合并成一个"时间"。

### 1.5 Hash-Digest（摘要）

**决策**：摘要由**服务端对实际存储的字节**计算，在同一事务内、写入前后各一次，并只以它结果为准。

```
sha256 = hex(SHA256(body))        // body 就是 bytea 列里那串字节，没有规范化、没有 trim、没有转义
```

- **客户端传来的 `sha256` 字符串永远不是事实。** 若请求里带了 `content` 又带了一个摘要形状的 `contentRef`（`sha256:<64 hex>`）且与服务端算的不一致 → `400 EVIDENCE_CONTENT_DIGEST_MISMATCH`，整笔写入回滚。**不接受"以服务端为准、悄悄覆盖客户端说法"**：那会把一个客户端 bug 变成一个永远查不出的谜。
- 内容行的 `contentRef` 由服务端**派生**为 `sha256:<hex>`，不再接受调用者指定。于是 Phase A 的 `evidence_row_digest`（进 `incident_verdict_evidence`）**间接承诺了内容**：`contentRef` 就是内容摘要。
- **读侧校验**：`GET .../content` 先取 `body`，对**读出来的字节**重算 sha256，与存储的 `sha256` 和 `octet_length` 双向比对；不一致 → `500 EVIDENCE_CONTENT_INTEGRITY_FAILED`，**不返回字节**。选择 500 而不是 404/409/200：行还在（不是 404），没有与客户端状态冲突（不是 409），而把损坏的字节当正常内容返回等于让一次篡改静默通过（更不能是 200）。
- 摘要只承诺"字节没变"，**不承诺"内容为真"**。两者是不同轴，见 §1.6。

### 1.6 Trust-Verification（信任验证）

**决策**：两条轴分开显示，谁也不冒充谁。

| 轴 | 问题 | 事实来源 | 失败语义 |
|---|---|---|---|
| 来源信任 | 谁担保这行证据？ | Phase A：`verifiedTrust` + `verificationMethod` + `verifierIdentity` | `UNVERIFIED` |
| 字节完整性 | 我读到的字节还是当初接受的字节吗？ | 本 Phase：服务端 sha256 + 读侧重算 | `EVIDENCE_CONTENT_INTEGRITY_FAILED` |

- `contentStatus = STORED` **不等于** `verifiedTrust = SOURCE_ATTESTED`：一个操作员手写的笔记（OPERATOR_ASSERTED）其字节完整性同样可以被证明；一个已签名适配器提交的 METRIC_SNAPSHOT 如果内容行被删，完整性也没了。UI 必须并列渲染两者，不允许用"STORED"的绿色去暗示"可信"。
- 内容的存储**不提升**任何一行证据的 `verifiedTrust`。写入路径仍然只有 Phase A 的两个来源：操作员身份、适配器签名。

### 1.7 Retention（保留期）

**决策**：内容保留 **365 天**，到期后**停止提供读取**，但**本 Phase 不做删除**。

- `retention_expires_at = captured_at + interval '365 days'`，写入时由数据库算，不允许调用者指定。
- 到期后 `GET .../content` → `410 EVIDENCE_CONTENT_EXPIRED`，body 不返回。
- **不实现清理任务**，理由是可验证的：`incident_verdict_evidence` 是已签署结论的快照，`ON DELETE RESTRICT` 明确要求证据行不能被静默带走；一个会删内容的定时任务会在"签署后第 366 天"让签名结论指向不再可读的字节。所以本 Phase 用**读侧拒绝**兑现保留承诺（"这类内容最多对外提供 365 天"），把"物理删除"留给带审计与法务口径的独立 Phase。
- Legacy 引用**没有保留期**：Kernel 从未持有它的字节，也就不存在"到期"；它永远显示为 `LEGACY_REFERENCE`。
- 已知代价（诚实记录）：到期内容仍占磁盘；需要 DBA 层面的容量规划。这是 Phase B 的范围之外，写在这里而不是藏起来。

### 1.8 Immutability（不可变）

**决策**：内容写一次，之后**任何路径都不能改**，包括 Kernel 自己。

四道独立的锁，缺一不成立：

1. **无写端点**：没有 PUT/PATCH/DELETE 内容的路由。
2. **DB 触发器**：`BEFORE UPDATE OR DELETE`。`UPDATE` 一律 `RAISE EXCEPTION ... ERRCODE restrict_violation`；`DELETE` 只在**父证据行于同一语句内已消失**时放行（即级联），否则同样拒绝。这条锁在验收里被实际触发一次（§5 步骤 6 的前置）。
3. **外键 `ON DELETE CASCADE` + 上述删除守卫**：内容只能随证据行在同一语句里消失，**不能**被单独删掉——所以"证据还在、字节没了"不会由手工 SQL 造成；而证据行本身又被 `incident_verdict_evidence.evidence_id`（`ON DELETE RESTRICT`）钉住，一旦有已签署结论，连级联都发生不了。已签名结论指向的字节因此被两把锁同时保护。
4. **`INSERT ... ON CONFLICT DO NOTHING`** 语义：重放同一份证据返回既有行（Phase A 语义），不会用第二次提交的字节覆盖第一次。

- 损坏的处理是**检测**，不是**修复**：读到摘要不匹配时 Kernel 报错并把两个摘要写进日志；它不会"顺手用新的重算值覆盖存储的摘要"——那等于把 tamper 洗成正常。
- **拒绝的顺序**（验收实测证明的顺序，也是真实攻击者会依次撞到的顺序）：① 行级 CHECK `content_bytes = octet_length(body)` 先挡住"改了字节没改长度"的手工 UPDATE；② 长度也对上之后，写一次触发器挡住 UPDATE/DELETE；③ 触发器被 DBA 关掉、字节被改坏之后，读侧摘要重算把它变成 `EVIDENCE_CONTENT_INTEGRITY_FAILED`。三道锁各自独立，验收脚本对 ②③ 分别实测，而不是只测最容易的那一道。
- 触发器是运维也可以临时关掉的（`ALTER TABLE ... DISABLE TRIGGER`），这正是把 §5 步骤 6 设计成"先关触发器才能改坏"的原因：它同时证明了锁存在、且失效之后检测仍然生效。

### 1.9 Authorization（授权）

**决策**：内容读取**完全继承元数据的读取范围**，不新造第二条规则。

- 事实：`list_evidence` 的可见性谓词是 `sees_all OR owner = caller`（`incidents.rs` `incident_status`，与 job list 同源）。内容端点调用**同一个** `incident_status`，所以不可能出现"元数据能看、内容能看但范围不同"。
- 未认证 → `401 UNAUTHENTICATED`；越范围（操作员读别人 owner 的 incident）→ `404 INCIDENT_NOT_FOUND`（**不泄漏存在性**：`403` 会说"这条存在，只是不给你"，而 `404` 与"不存在"不可区分）。
- 写入仍是 `require_operator()`（viewer 不能写）。读取沿用既有 slice 的可见性：viewer/admin 读全部、operator 读自己的。**没有为内容单独加严**，理由是加严会制造第二个授权权威（同一个 incident 的两半用不同规则），比它想修的问题更危险。
- 内容**不进列表响应**：任何能读元数据的主体拿到的仍是常量大小的元数据；字节必须单独发一次请求，因此"列表泄漏内容"这个失败模式不存在。

---

## 2. 为什么这是最小可行方案

判据：**每一项新东西都必须能被一条验收问题逼出来，否则不进。**

| 没做 | 为什么不做（成本 vs 收益） |
|---|---|
| 对象存储（S3/MinIO/自建 blob 服务） | 新基础设施 + 新凭据 + 新网络面（正好是 SSRF/越权的高发区），而单份上限只有 64 KiB。第一阶段真实内容量是"值班时贴的日志片段"，PostgreSQL `bytea` 的 `TOAST` 本来就在做这件事。ADR 明确禁止为这次需求新建分布式存储平台。 |
| 写本地文件系统（`data/` 目录） | 两份权威（DB 行 + 文件），备份/恢复/迁移三条路径都要各自正确；`opsweave backup` 现在只搬 DB。 |
| 内容分块 / 断点续传 | 64 KiB 上限之内没有收益；分块会引入"部分内容"这个新状态（多了 3 个失败语义）。 |
| 全文检索（pg_trgm / tsvector / ES） | 需求是"读一份证据"，不是"搜证据"。索引会随内容增长，且会新增一个"内容可被批量枚举"的读取面。 |
| 内容加密（KMS / pgcrypto） | 没有密钥管理体系时不值得做；如果要做，必须与备份、审计、轮换一起做。记为风险而不是偷偷留白。 |
| 内容版本链（v1/v2/…） | 与"证据不可变"直接冲突：可变内容无法被签名结论承诺。改内容 = 新证据行，这是既有模型就能表达的。 |
| HTML/Markdown 渲染 + sanitizer | 渲染非可信 HTML 是 XSS 的唯一入口；引入 sanitizer 库就是引入新依赖 + 一个永远在打补丁的攻击面。纯文本 `textContent` 渲染在功能上够用（§1.9、§3.6）。 |
| 反病毒 / DLP 扫描 | 没有可用的扫描后端；且本版不执行、不渲染 HTML，扫描的收益主要是"下载后"的场景，不属于本 Phase。 |
| 内容去重（content-addressed） | 去重会把两份证据变成同一个 blob，"删除其中一份"变成跨证据的隐式删除风险。 |

**一句话**：这张表里唯一"必须新造"的东西是一张带 CHECK 约束的 `bytea` 表 + 一个有校验的读取端点。其余全部复用 Phase A 的元数据、授权谓词、审计与签名快照。

---

## 3. 必须明确的限制（含拒绝语义）

### 3.1 单份内容大小

- 接受区间 **1 .. 65536 字节**（64 KiB），按**字节**计，不按字符：多字节文本按实际 UTF-8 长度算，避免"看起来 30k 字符其实 200KB"。
- 空内容 → `400 EVIDENCE_CONTENT_EMPTY`。超限 → `413 EVIDENCE_CONTENT_TOO_LARGE`（不截断：截断会静默改变证据）。
- 客户端传入的不是合法 UTF-8 → `400 EVIDENCE_CONTENT_NOT_UTF8`。本版只存文本，二进制证据请用 `contentRef`（它就是 Legacy 语义）。

### 3.2 可接受的 Content-Type

- 只接受 `text/plain` 与 `application/json`，**精确匹配**，不解析参数（`text/plain; charset=utf-16` 不是合法值）。
- 其它值 → `415 EVIDENCE_CONTENT_TYPE_UNSUPPORTED`。
- `application/json` 的内容**不要求**能被解析：不合法 JSON 与合法 JSON 一样按不可信文本存储与显示（Kernel 不因内容形状拒绝证据；它只拒绝大小、编码、类型）。

### 3.3 总量与分页

- **列表不内联内容**：`GET /incidents/{id}/evidence` 每条只有元数据 + `contentStatus`/`contentType`/`contentBytes`/`contentSha256`（常量大小）。内容必须逐条 `GET .../content`，单次一个 64 KiB 行。这就是本 Phase 的"分页"：**内容按 1 行一页读**。
- **每 incident 证据行上限 200**：写第 201 行 → `409 INCIDENT_EVIDENCE_LIMIT`。因此单个 incident 的内容上界 ≈ 200 × 64 KiB = 12.5 MiB。
- **没有全局配额**（诚实记录）：本 Phase 不实现"整库内容总量上限"。存在的两个界是行上限与 365 天保留期。并发写入者可能让计数瞬时超出 1（跨行约束无法在行级 CHECK 表达），这是已知的、有界的缺口。

### 3.4 读取权限

见 §1.9。补充两条必须写下的语义：

- `EVIDENCE_CONTENT_NOT_STORED`（**404**）：这行是 Legacy 引用，Kernel 从未持有字节。
- `EVIDENCE_CONTENT_INTEGRITY_FAILED`（**500**）：持有字节，但字节与记录的摘要不符。
- `EVIDENCE_CONTENT_EXPIRED`（**410**）：持有字节，但超过保留期。
- 三者与 `INCIDENT_NOT_FOUND`（越范围/不存在）**必须是不同响应**，否则 UI 无法区分"没有"、"坏了"、"过期了"、"不给你"。

### 3.5 恶意 URL 与 SSRF

**决策**：Kernel **从不**解引用 `contentRef`，因此不存在服务端请求伪造面。

- 代码路径上的证明：`incidents.rs` 里没有任何 `reqwest`/`http`/.get(url) 调用；内容只从 `bytea` 列读出。`state.http` 是 Kernel 全局的 outbound client，证据模块不碰它。
- `contentRef` 会被 `bounded(2..1000)` 收进文本列，**原样保存、原样显示**（`<code>` 文本节点），不解析 scheme、不渲染成链接、不发预览请求。
- `javascript:` / `data:` / `file:` / `http://169.254.169.254/…` 全部按普通字符串处理，**没有**"点击验证"或"取回远程内容"这类便利功能——它们是 SSRF 的经典入口，本版不提供。
- 验收方式不是"读代码得出"，而是**金丝雀实测**：在 18198 起一个本地监听器，提交 `contentRef = http://127.0.0.1:18198/canary`，断言监听器在整个验收期间收到 **0 个连接**（`tests/acceptance/g12_evidence_content.sh`）。

### 3.6 非可信 HTML 与日志内容的渲染方式

**决策**：一切内容按不可信文本处理；浏览器只会以**文本节点**看到它。

- 前端：`<pre className="...">{text}</pre>`——React 的文本子节点，等价于 `textContent`。**禁止 `dangerouslySetInnerHTML`**（已知 `grep dangerouslySetInnerHTML apps/platform-web/src` 必须为空；验收里作为断言跑）。
- JSON 同样按原文显示：不 `JSON.parse` 后拼 HTML，不 pretty-print 成 DOM 元素，不做语法高亮（高亮库就是一个渲染器）。
- 服务端：内容端点返回 `Content-Type: text/plain; charset=utf-8`（`application/json` 行返回 `application/json`），并且**恒带**：
  - `X-Content-Type-Options: nosniff`
  - `Content-Security-Policy: default-src 'none'; sandbox`
  - `Cache-Control: no-store`（内容不落浏览器缓存，避免"已过期/已撤权"之后还能从缓存读到）
- **路由级 CSP 优先于外壳 CSP**：Kernel 有一层全站 CSP 中间件（`routes.rs` `security_headers`，值以 `default-src 'self'` 起）。它现在只在响应**尚未**携带 CSP 时才写入，否则本端点声明的 `default-src 'none'; sandbox` 会被静默覆盖——那会让"这一条路由承载任意文本"这件事被一条为应用外壳设计的策略接管。验收对响应头逐字断言，不靠推断。
- 因此即使用户把内容 URL 直接粘进地址栏，浏览器也只会显示文本，不会执行其中任何标签或脚本（验收里真的导航过去一次，断言 `document.contentType === 'text/plain'`、DOM 里没有解析出的元素、`window.__xss` 仍为空）。
- 日志片段与 HTML 片段**同等对待**：没有"这段看起来像 HTML 所以渲染一下"的分支。

---

## 4. 契约与迁移

### 4.1 迁移 0018（additive / 非破坏）

- `CREATE TABLE kernel.incident_evidence_content`（新表）。
- `CREATE FUNCTION` + `CREATE TRIGGER`（不可变）。
- 不新增/不删除/不重命名任何既有表的列，不 UPDATE 任何既有行，不动 0017 及更早的文件（sqlx checksum）。
- 回滚：sqlx 是 forward-only。`DROP TABLE kernel.incident_evidence_content` 会**删除所有内容字节**，等价于把每一行退回 Legacy 语义；只有在明确接受"内容全部丢失"时才可执行。reverse DDL 写在该文件头部注释里，不自动运行。

### 4.2 API 增量（`contracts/openapi/incident-v1.yaml`）

- `POST /incidents/{id}/evidence`：`contentRef` 变为可选；新增可选 `content: { contentType, body }`；两者至少一个。有 `content` 时服务端派生 `contentRef`。
- `GET /incidents/{id}/evidence`：`Evidence` 新增只读字段 `contentStatus`/`contentType`/`contentBytes`/`contentSha256`/`contentCapturedAt`/`contentRetentionExpiresAt`；查询参数新增可选 `since`/`until`（见 §3.3 的查询时间窗）。`contentRef` 保留，语义收窄为"调用者声称的定位符"。
- 新增 `GET /incidents/{id}/evidence/{evidenceId}/content`：返回原始字节 + `X-Evidence-Digest`/`X-Evidence-Bytes`/`X-Evidence-Content-Type` 头；错误码见 §3.4。
- **查询时间窗限制**：`since`/`until` 必须是 RFC 3339 UTC；跨度上限 90 天；`since > until` 或无法解析 → `400 INCIDENT_EVIDENCE_WINDOW_INVALID`。缺省 = 全量（与既有行为一致）。

### 4.3 兼容性

- 既有调用方（只发 `contentRef`）**不需要改**：它们得到 `contentStatus = LEGACY_REFERENCE`，行为与 Phase A 相同，只是 UI 现在如实标注。
- `contentRef` 从"必填"变"可选"是放宽，不是破坏；旧客户端不会因此失败。
- 新增只读字段对旧客户端是忽略项。

---

## 5. 验收映射（B3 八步 → 实际命令）

`tests/acceptance/g12_evidence_content.sh` 逐步打印真实 curl 与断言：

| # | 步骤 | 断言 |
|---|---|---|
| 1 | 提交带真实内容的人工证据 | `201` + 响应含 `contentStatus=STORED` |
| 2 | 服务端持久化并计算摘要 | 响应 `contentSha256` == 本地 `shasum -a 256` 结果，且 ≠ 客户端预置的错误摘要 |
| 3 | 返回唯一 Evidence ID | `id` 是 UUID 且再次列表能查到同一 id |
| 4 | 在 Incident 页面重新读取 | `GET .../evidence` 与 `GET .../content` 都返回同一字节 |
| 5 | 校验摘要匹配 | `X-Evidence-Digest` == 本地重算 == 列表里的 `contentSha256` |
| 6 | 内容被改坏能被检测 | 先证明 `UPDATE` 被触发器拒绝，再关触发器改坏 → `500 EVIDENCE_CONTENT_INTEGRITY_FAILED` |
| 7 | 未授权主体不能读 | 无 cookie → 401；另一个 operator 的 cookie → 404 |
| 8 | 已签署 Verdict 不因补充证据改写 | 追加证据后 verdict 的 `consideredEvidenceCount/Digest` 不变，新行 `afterVerdict=true` |

XSS 实测在 `tests/ui/g12-evidence-content.spec.ts`（真实浏览器 + 真实内核）：提交 `<script>`、`<img onerror>`、`<svg onload>` 载荷，断言页面文本包含原文、`window.__xss` 未被设置、DOM 中不存在注入的 `script/img/svg` 元素。

---

## 6. 实测结果（2026-10-31，scratch 库 + 127.0.0.1:18199）

- `tests/acceptance/g12_evidence_content.sh`：**84 条断言全部通过**（B3 八步 + 四类限制负向 + Legacy + SSRF 金丝雀 + XSS 载荷 + "Web 树里没有 HTML 注入通道"的 grep 断言）。摘要断言全部由 python3 对**响应体**重算后比较，从不读数据库里的 `sha256` 列来"验证"自己。
- `tests/ui/g12-evidence-content.spec.ts`（真实 Chromium + 真实内核）：通过。它证明的是浏览器侧的三件事——载荷以文本逐字显示且未构造任何元素、`window.__xss` 未被写、内核下发的摘要被浏览器重算并标记为已验证；以及直接导航到内容 URL 时 `document.contentType` 为 `text/plain`。
- 截图：`artifacts/g12b/r1440-light.png`、`r390-light.png`、`r1440-dark.png`。
- 门禁：`cargo test --workspace`（真库、`OPSWEAVE_REQUIRE_TEST_DATABASE=1`，无 skip）、`cargo fmt --check`、`cargo clippy --all-targets -D warnings`、`pnpm -r typecheck`、`vitest`、`check-i18n`、`validate_contracts.py` 全部通过。

---

## 7. 风险与未验证项（不藏）

1. **内容不加密**：任何能读 `kernel.incident_evidence_content` 的主体（DBA、备份文件）能读全部内容。缓解：DB 访问面即内容边界，与 incident 元数据相同；未在本 Phase 引入密钥体系。
2. **无物理删除**：365 天后拒绝读取，但字节仍在库里。磁盘容量需要运维规划。
3. **行上限存在并发缺口**：N 个并发写者最多超出 N-1 行（约 200 KiB）。不做分布式锁，因为代价远大于风险。
4. **摘要不证明真实性**：只有来源适配器签名（Phase A）能证明"谁说的"。本 Phase 只证明"字节没变"。
   进一步：如果有人同时改写 `body`、`content_bytes` 和 `sha256` 三列，读侧校验会通过——那时**没有剩余的证据可以检测**，因为摘要就是全部判据。真正挡住这条路径的是"没有写端点 + 写一次触发器"，而这两者都要求先拿到 DBA 权限并显式关锁。这一点写在 ADR 里，而不是留给读者以为"有摘要就等于不会丢"。
5. **不做内容去重**：同一份日志贴两次就是两份内容，磁盘随证据行线性增长。
6. **无全文检索**：按设计。需要检索时必须先重开 ADR（会引入"批量枚举内容"的新读取面）。
