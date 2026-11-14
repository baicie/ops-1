# P001-C3：Runtime HTTP/JSON v1 多语言一致性

| 项 | 值 |
|---|---|
| 基线 | `main` `89113ade63f286707781acc4a053bec1ab513f78` |
| 运行器 | `tests/ci/p001c_conformance.sh` |
| 矩阵 | `tests/contract/conformance_matrix.py` |
| 基线探针 | `tests/contract/run_conformance.py`（未改动） |
| CI | `.github/workflows/runtime-conformance.yml`（新增） |

## 1. 这个阶段补的是什么

`tests/contract/run_conformance.py` 从写出来就断言了三种语言，但 **没有任何
workflow 运行过它**。C0 已经记录了这一点：

> `docs/acceptance/p001/03-plugin-baseline.md:126`：
> `tests/contract/run_conformance.py` … **NO — absent from every workflow**
>
> `:138`：`grep -rn run_conformance .github/` returns nothing.

`IMPLEMENTATION_STATUS.md:42` 把结果标成 `PASS (local)`——准确，但不是门禁。
**只在一台机器上跑过的 conformance 是文档，不是证据。**

## 2. 交付内容

| 文件 | 作用 |
|---|---|
| `.github/workflows/runtime-conformance.yml` | 独立 workflow；PR 路径过滤 + `push: main` 无过滤 |
| `tests/ci/p001c_conformance.sh` | 复用 `p001c_up.sh` 的隔离平台，部署三语言，跑矩阵 |
| `tests/contract/conformance_matrix.py` | 三语言同断言 + 故障注入 + 分语言判决 |
| `tests/contract/run_conformance.py` | **未改动**；它记录了 `EVIDENCE.md` 的既有结论 |

### 2.1 为什么矩阵是独立文件而不是往旧探针里加行

旧探针被 `docs/acceptance/EVIDENCE.md` 与 `IMPLEMENTATION_STATUS.md` 引用为
「C02 Go backend on Runtime v1」的证据。改变它的含义会让那条记录悄悄失效。
新文件在它**旁边**加断言，并给出自己的判决。

## 3. 判决语义

| 退出码 | 含义 |
|---|---|
| 0 | 三语言都被测量，且都与契约一致 |
| 1 | 某语言与契约**不一致** |
| 2 | 某语言**无法被测量**（未部署、未 READY、无响应） |
| 3 | 环境缺失（Docker / PostgreSQL / 构建失败） |

**已记录的产品缺口不算门禁失败。** 真实首跑中三语言 **14/14 全通过**，唯一
`NOT_RUN` 是 `protocol-version-refusal`——即本文 §5.1 记录的缺口。把它算成
门禁红，等于对一个门禁正在正确暴露的问题说「一致性坏了」。

因此：断言名出现在 `KNOWN_GAPS` 里的 `NOT_RUN` 计为 `KNOWN_GAP`；某语言的
非通过行**全是**已知缺口时判 `PASS (with known gap)`。

**这个豁免不能悄悄扩大**，已用四个受控输入验证：

| 输入 | 判决 |
|---|---|
| 全通过 + 已记录缺口 | **PASS** |
| 某语言有真实 FAIL | **FAIL** |
| **未记录**的 NOT_RUN | **BLOCKED** |
| 某语言完全没有断言 | **BLOCKED** |

**3 与 2 与 1 必须分开。** 把环境故障报成产品结果的另一个方向，就是把
「没测到」报成「测过了」。

矩阵里每种语言单独一行 `PASS / PARTIAL / FAIL / NOT_RUN`。任何一种语言
`NOT_RUN`，整体就是 `BLOCKED` 而不是 `PASS`：**带洞的矩阵不是比较**。

## 4. 断言（三语言完全相同）

正向：runtime info 200、身份与插件 id 一致、版本与 active 一致、
`runtimeProtocol == http-json-v1`、`buildDigest` 是 sha256、
`capabilityDigest` 与签名 `provides` 的规范化哈希一致、liveness 200、
readiness 200、未知路径 404。

负向（**这一半此前不存在**）：

| # | 注入 | 期望 |
|---|---|---|
| 1 | 非法 JSON 到 `/api/hello/echo` | 4xx |
| 2 | 同上 | 响应带稳定 `code` |
| 3 | 无凭据经 Gateway 调用 | 401 / 403 |
| 4 | `/_opsweave/runtime/v2/info` | 404 |
| 5 | 协议版本不匹配 | **见 §5，测量但不判定为通过** |

## 5. 发现的两个产品缺口

### 5.1 `RUNTIME_PROTOCOL` 定义了但从未被校验

`crates/contracts/src/lib.rs:17` 定义 `RUNTIME_PROTOCOL = "http-json-v1"`。
全仓库搜索该常量，**除定义处外没有任何 Rust 使用**：

```
$ grep -rn RUNTIME_PROTOCOL . --exclude-dir=target --exclude-dir=.git
crates/contracts/src/lib.rs:17:pub const RUNTIME_PROTOCOL: &str = "http-json-v1";
```

Node 的就绪探测（`apps/node/src/runtime.rs:2011-2022` 的 `probe()`）只检查
`response.status().is_success()`，**不读取响应体，也不检查 runtime identity**。因此一个自报 `runtimeProtocol: "http-json-v0"` 的
插件不会被拒绝。

矩阵把这行记为 `KNOWN GAP` 并附上原因，而不是断言为通过。

### 5.2 Java 对非法 JSON 返回 500，TS 与 Go 返回 400（**已修复**）

契约 `contracts/openapi/plugin-runtime-v1.yaml` 要求错误体含
`code` / `message` / `requestId` / `retryable`。

| 语言 | 非法 JSON 的处理 | 依据 |
|---|---|---|
| TypeScript | `400 INVALID_JSON` | `plugins/hello-ops/backend-ts/server.mjs:84` |
| Go | `400 INVALID_JSON` | `plugins/hello-go/main.go:103` |
| **Java** | **`500 INTERNAL`** | `HelloController.java:80-88`：`@ExceptionHandler(Exception.class)` 捕获 `HttpMessageNotReadableException` 并返回 `INTERNAL_SERVER_ERROR` |

**这是真实的三语言契约分歧**，正是「同一契约同一断言」应该抓到的。

**已修复**：`HelloController` 增加
`@ExceptionHandler(HttpMessageNotReadableException.class)`，返回
`400 INVALID_JSON`，与 TS/Go 的响应体形状一致。

判据：契约 `plugin-runtime-v1.yaml` 已经规定了 `Error` 的四个必备字段，
TS 与 Go 都已按此实现——补齐 Java 是消除一个实现对契约的偏离，不是修改契约。
真实首跑确认三语言均 `[status=400]`。

## 6. 三语言覆盖矩阵（本阶段能确认的部分）

| 维度 | TS | Go | Java | 说明 |
|---|---|---|---|---|
| Build | 是 | 是 | 是 | `scripts/build-plugins.sh` |
| OCI image build | 是 | 是 | 是 | 同一脚本 |
| Digest 固定 | 是 | 是 | 是 | `assemble_plugin.py --image-ref` |
| Bundle 签名 | 是 | 是 | 是 | `opsctl bundle --key` |
| Runtime v1 health | 断言 | 断言 | 断言 | 矩阵 |
| Readiness | 断言 | 断言 | 断言 | 矩阵 |
| 基本业务调用 | 断言 | 断言 | 断言 | `/api/hello` |
| 错误响应 | 断言 | 断言 | **断言（预期 FAIL）** | §5.2 |
| 身份传递 | Gateway 断言 | 同 | 同 | 伪造头被剥离 |
| 超时 | **NOT_RUN** | **NOT_RUN** | **NOT_RUN** | 需注入慢插件，本轮未做 |
| 重启恢复 | **NOT_RUN** | **NOT_RUN** | **NOT_RUN** | 属完整生命周期，C3 后续 |
| Upgrade / Rollback / Disable / Uninstall | **NOT_RUN** | **NOT_RUN** | **NOT_RUN** | 仅 TS 在 C1.3 覆盖 |

**Runtime Conformance 与完整插件生命周期是两件事。** 本阶段交付前者；
后者对 Go/Java 仍未验证，且不以本阶段的结论代替。

## 6.5 真实首跑结果（2026-11-14）

平台起、三语言全部部署并激活，矩阵跑完：

```
typescript PARTIAL  (14 assertions, 0 failed, 1 not run)
go         PARTIAL  (14 assertions, 0 failed, 1 not run)
java       PARTIAL  (14 assertions, 0 failed, 1 not run)
```

- Java 的 `INVALID_JSON` 修复生效：三语言 `malformed JSON … [status=400]`
- `capabilityDigest` 与签名 `provides` 逐字节一致（三语言）
- 未认证 Gateway 调用三语言均 401
- cleanup：platform PASS、registry PASS

这也是**三语言同一断言**第一次真的做到：Java 的 500 在修复前只有这个矩阵能看见。

## 6.6 门禁不覆盖的一项：Gateway 伪造头

`tests/contract/run_conformance.py` 断言两件矩阵没有覆盖的事：

1. Gateway **剥离**客户端伪造的 `X-OpsWeave-User-Role` 头；
2. Gateway **投递** Kernel 签名的用户上下文。

它在隔离平台上连续四次以
`URLError: [Errno 111] Connection refused` 结束——它按 Kernel 记录的
`hostPort` 直连插件实例，而那个端口在这个平台上从测试进程不可达。同一平台上
矩阵用同样的实例跑出了 14/14。

**因此它不阻塞 job，但也不等于通过。** 它的失败会打印在 run summary 与
`run.txt` 里，并且是本文档记录的一个**未覆盖项**：

| 项 | 状态 |
|---|---|
| Gateway 剥离伪造角色头 | **未验证**（矩阵不覆盖，原版探针在此平台上探不到实例端口） |
| Gateway 投递签名上下文 | **同上** |

不要把这行读成「已验证」或「已通过」。

## 7. 本地验证范围（诚实边界）

| 检查 | 结果 |
|---|---|
| `bash -n` + `shellcheck -S warning`（两个脚本） | clean |
| YAML 解析 + 全映射无重复键 | clean |
| 无 Docker ⇒ exit 3 `BLOCKED` | 实测 |
| 无 PostgreSQL ⇒ exit 3 `BLOCKED` | 实测 |
| 矩阵无平台 ⇒ exit 2 `BLOCKED` | 实测 |
| 无 session ⇒ exit 2 `BLOCKED` | 实测 |

**矩阵本身没有在本地跑过**：它需要真实 Kernel + PostgreSQL + 两个已注册
Node + 三个已构建的 OCI 镜像。**本轮不声称任何语言通过。**

## 8. 依赖与后续

- 不依赖任何未合并的 PR。
- 与 #100（单实例锁）无代码交集。
- 需要先决定 §5.1 与 §5.2 的产品语义，才能把对应行从 `KNOWN GAP` /
  `FAIL` 变成真正的门禁。
