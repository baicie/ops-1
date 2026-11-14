# P001-C3：Go / Java 完整 OCI 生命周期

| 项 | 值 |
|---|---|
| 矩阵脚本 | `tests/ci/p001c_multilang_lifecycle.sh` |
| 负例 | `tests/ci/p001c13_negatives.sh`（新增 `OPSWEAVE_NEG_PLUGIN` 参数） |
| 镜像构建 | `scripts/build-plugins.sh`（新增 Go/Java 的 0.0.2） |

## 1. 此前缺的是什么

`docs/acceptance/p001/03m-multilang-conformance.md` §6 的矩阵里，Go/Java 的
upgrade / rollback / disable / uninstall 全部是 **NOT_RUN**，且明确写了不能由
TypeScript 的结论代推。

根因：`scripts/build-plugins.sh` 只为 TS 构建了 0.0.2。没有第二个版本，
upgrade 和 rollback 无法被测——不是测试没写，是**被测对象不存在**。

## 2. 本阶段做的两件事

### 2.1 为 Go / Java 构建真实的 0.0.2

```sh
docker build --build-arg PLUGIN_VERSION=0.0.2 … -t "$REGISTRY/opsweave/hello-go:0.0.2"
docker build --build-arg PLUGIN_VERSION=0.0.2 … -t "$REGISTRY/opsweave/hello-java:0.0.2"
```

**必须是真镜像，不能是同一个镜像换个 tag。** `PLUGIN_VERSION` 是运行时在
`/_opsweave/runtime/v1/info` 自报的版本，而 Node 的 `verify_runtime_info`
（`runtime.rs:1909`）会拒绝自报版本与签名 manifest 不一致的实例。用 0.0.1 的
镜像冒充 0.0.2，会在部署阶段就被拒绝——这正是那个检查存在的意义。

### 2.2 语言无关的矩阵

`p001c_multilang_lifecycle.sh` 对三种语言跑**同一套断言**：

| # | 步骤 | 断言 |
|---|---|---|
| 1 | build + OCI image + 签名 bundle | bundle 存在于 `dist/plugins` |
| 2 | install | 签名验证通过 |
| 3 | deploy 2 replicas | `VERSION_ALREADY_ACTIVE` 不算失败 |
| 4 | activate + READY | 从 Kernel API 读回 READY 实例与不同 node |
| 5 | gateway serves | HTTP 200 |
| 6 | install 0.0.2 | 签名验证通过 |
| 7 | upgrade: deploy 0.0.2 | 部署成功 |
| 8 | v2 部署但未激活 | 路由**仍**是 0.0.1 |
| 9 | activate 0.0.2 | 路由切到 0.0.2 |
| 10 | rollback 0.0.1 | 路由回到 0.0.1 |
| 11 | disable | gateway 503 |
| 12 | enable | 成功 |
| 13 | uninstall | gateway 503 |
| 14 | 无残留容器 | 按两个 installation-id 计数为 0 |

第 4 步**不用** `opsctl plugins`：那条命令打印文本行
（`main.rs:392`，`"{} {} active=… state=…"`），对它做 JSON 解析会静默得到空，
于是每种语言都看起来没有 READY 实例。矩阵改为直接读 `/api/v1/plugins/{id}` 的 JSON。

第 14 步按**两个** installation-id 计数：两个 Node 的身份按设计不同
（ADR-023），只看第一个会把平台的一半当成干净的。

## 3. 负例参数化

`p001c13_negatives.sh` 原本硬编码 `dev.opsweave.hello` 与 `hello-ops-0.0.1`。
现改为：

```sh
PLUGIN="${OPSWEAVE_NEG_PLUGIN:-dev.opsweave.hello}"
PLUGIN_STEM="${OPSWEAVE_NEG_PLUGIN_STEM:-hello-ops}"
```

六项注入因此可以瞄准任一语言的插件。注入 2/3 自建的崩溃/挂起镜像本身就是
语言无关的（它们只服务 Runtime v1 契约）。

## 4. 明确不做的事

| 项 | 原因 |
|---|---|
| OCI **镜像**签名 | **未实现**。bundle 签名 ≠ 镜像签名，不能用一个的存在推断另一个 |
| 三主机、rootless、mTLS | P001-E |
| Go/Java 的**前端**资源 | 这两个插件不含 `frontend/`，D4 不适用 |
| 把 bundle 签名当作镜像签名 | 禁止 |

## 5. 验证边界

| 检查 | 状态 |
|---|---|
| `bash -n` + `shellcheck -S warning` | clean |
| 无 Docker ⇒ exit 3 `BLOCKED` | 实测 |
| 无 PostgreSQL ⇒ exit 3 `BLOCKED` | 实测 |
| 矩阵真实运行 | **NOT_RUN**——需要完整平台与三语言镜像构建 |

**本文件不声称 Go/Java 生命周期已通过。** 脚本与镜像已交付，真实结论以 CI 为准。
