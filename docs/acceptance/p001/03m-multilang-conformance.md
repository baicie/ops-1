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

### 5.2 Java 对非法 JSON 返回 500，TS 与 Go 返回 400

契约 `contracts/openapi/plugin-runtime-v1.yaml` 要求错误体含
`code` / `message` / `requestId` / `retryable`。

| 语言 | 非法 JSON 的处理 | 依据 |
|---|---|---|
| TypeScript | `400 INVALID_JSON` | `plugins/hello-ops/backend-ts/server.mjs:84` |
| Go | `400 INVALID_JSON` | `plugins/hello-go/main.go:103` |
| **Java** | **`500 INTERNAL`** | `HelloController.java:80-88`：`@ExceptionHandler(Exception.class)` 捕获 `HttpMessageNotReadableException` 并返回 `INTERNAL_SERVER_ERROR` |

**这是真实的三语言契约分歧**，正是「同一契约同一断言」应该抓到的。

**本轮不修。** 修改插件错误映射属于产品行为变更，且需要先决定：是 Java 补齐
400，还是契约放宽到允许 5xx。这是一个 ADR 决策，不是本阶段的授权范围。
矩阵会把它报成 `java FAIL`，这正是它应该做的。

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
