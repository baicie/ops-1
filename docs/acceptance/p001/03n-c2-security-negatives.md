# P001-C2：Capability / Grant / Workspace 安全负例

| 项 | 值 |
|---|---|
| 基线 | `main` `89113ade63f286707781acc4a053bec1ab513f78` |
| 脚本 | `tests/acceptance/p001c2_security_negatives.sh` |
| 既有覆盖 | `tests/acceptance/capability_multi_provider.sh`（多 provider 切换与撤销） |

## 1. 与既有测试的分工

`capability_multi_provider.sh` 覆盖：绑定到 A 的 Grant 在自然切换到 B 时被拒
（`CAPABILITY_PROVIDER_MISMATCH`）并审计、撤销立即生效、无 provider 时
`CAPABILITY_UNAVAILABLE`。

本脚本覆盖它**没有**的部分，且不复述：

| # | 用例 | 状态 |
|---|---|---|
| 1 | 完全无凭据 | 已断言 401 `UNAUTHENTICATED` |
| 2 | 已认证但权限不足（viewer 创建 admin） | 已断言 403 `FORBIDDEN` |
| 3 | 跨 workspace 读取 | 已断言 403 `WORKSPACE_FORBIDDEN` |
| 4 | 未持有的 capability | 已断言 403 `CAPABILITY_FORBIDDEN`（resolve 端点） |
| 5 | Grant 撤销后调用 | 见 `capability_multi_provider.sh`；本脚本用例 12 覆盖「撤销被确认之后」 |
| 6 | 伪造调用者身份头 | 已断言：伪造头不产生任何授权 |
| 7 | 伪造 workspace | 已断言 403 `WORKSPACE_FORBIDDEN` |
| 8 | Disable 后调用 | **NOT_RUN**，由 `e2e_platform.sh` 覆盖（503 `CAPABILITY_UNAVAILABLE`） |
| 9 | Uninstall 后调用 | **NOT_RUN**，同上 |
| 10 | 不兼容版本升级被拒 | **NOT_RUN**，见 §4 |
| 11 | 多 provider 切换的 Grant 语义 | 见 `capability_multi_provider.sh` |
| 12 | 撤销确认之后的请求 | 已断言 403 `CAPABILITY_FORBIDDEN` |

## 2. 四分类，这是本脚本的核心

每个用例只能落在其一：

| 分类 | 含义 | 判定 |
|---|---|---|
| `PRODUCT_REFUSED` | 产品返回了文档化的状态码与错误码 | **PASS** |
| `SESSION_FAILED` | 我们自己的凭据失效 | **BLOCKED**（不是 PASS） |
| `ENVIRONMENT` | 000 / 5xx，产品没有产生这个回答 | **BLOCKED** |
| `NOT_REFUSED` | 本应拒绝却返回 2xx | **FAIL** |

「非 200 就算拒绝」会让一个死掉的会话冒充正确的安全拒绝。这个脚本存在的
理由就是消除这种替换——以及它的镜像：**把 5xx 报成安全缺陷**。

用例 6 的第一版就写了 `5*) bad`，实测时一个返回 502 的不可达服务被报成
「伪造身份被相信」。已改为与其他用例同一套分类。

## 3. 路径与错误码来自代码，不是猜测

第一版有四处是猜的，每一处都会让断言在 404 上静默通过：

| 猜的 | 实际的 | 依据 |
|---|---|---|
| `/api/v1/catalog/datasets` | `/api/data-catalog/datasets` | `plugins/data-catalog/backend/server.mjs:701` |
| workspace 是路径段 | 是 **query 参数** `?workspaceId=` | `server.mjs:90-102` |
| 跨 workspace 是 `CAPABILITY_FORBIDDEN` | 是 `WORKSPACE_FORBIDDEN` | `server.mjs:96`（`WORKSPACE_FORBIDDEN` → 403 的映射） |
| 未持有 capability 走 plugin 路径 | 是 Kernel 的 `…/capabilities/{name}/{major}/resolve` | `apps/kernel/src/capabilities.rs:818-820` |

## 4. 为什么用例 10 是 NOT_RUN

`contracts/` 的 manifest schema **没有表达「不兼容升级」的字段**。要测「不兼容
升级被拒」，就得先构造一个契约里不存在的输入——那测的是我编的东西，不是产品。
如实记为 NOT_RUN，并说明原因。

## 5. 反事实：脚本能抓到真实的授权缺陷

用一个「对所有请求返回 200」的假服务替代 Kernel：

```
FAIL  1 unauthenticated gateway call: the product ACCEPTED the request (HTTP 200)
FAIL  3 cross-workspace dataset read: the product ACCEPTED the request (HTTP 200)
FAIL  4 unheld capability: the product ACCEPTED the request (HTTP 200)
FAIL  6 forged identity headers WERE believed (HTTP 200)
FAIL  7 forged workspace in the request: the product ACCEPTED the request (HTTP 200)
== C2 negatives: PASS=0 FAIL=5 BLOCKED=2 ==
exit=1
```

无平台时：`PASS=0 FAIL=0 BLOCKED=6`，**exit 2**——不确定不等于通过。

## 6. 本轮未验证的部分

**脚本没有在真实 Kernel 上运行过。** 它需要完整 Data Foundation 部署
（Kernel + PostgreSQL + Node + data-catalog 已激活 + admin 会话）。
本轮只验证了：语法、`shellcheck`、无平台时的 BLOCKED 语义、以及上面的反事实。

真实运行发生在 `tests/ci/data_foundation_ci.sh` 接入之后。

## 7. 顺序隔离

用例 12 撤销一个 grant。若不恢复，后面的 `data_token_revocation.sh` 等脚本会看到
一个被改过的夹具——一个测试套件污染另一个，是 flake 最常见的来源。

因此用例 12 在撤销前**读出该 grant 的完整字段**，断言完 403 后**重建一个等价
grant**；重建失败时记为 `BLOCKED` 而不是静默放过，因为它改变了后续脚本的前提。

## 8. 依赖

- 不依赖任何未合并的 PR。
- 与 #100（单实例锁）、#102（多语言 conformance）无代码交集。
- 若 §3 的路径随插件演进变化，失败会表现为 FAIL 而不是静默通过，
  因为每一处都断言了具体状态码与错误码。
