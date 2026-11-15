# P001-C2 安全负例：12 场景覆盖矩阵

| 项 | 值 |
|---|---|
| 脚本 | `tests/acceptance/p001c2_security_negatives.sh` |
| 调用方 | `tests/ci/data_foundation_ci.sh`（data-foundation / typed-pipeline-runtime 两个 workflow） |
| 基线 | `main` `6a72964` |

本文档记录**每个场景实际发出的请求、预期与判定**。它随脚本一起更新；两者不一致时，
以脚本为准并把差异当作缺陷。

## 判定语义

每个场景只能落在其一：

| 判定 | 含义 | 退出码影响 |
|---|---|---|
| `PASS` | 产品以**契约规定的状态码与错误码**拒绝 | 计入 PASS |
| `FAIL` | 产品接受了本应拒绝的请求，或码不对 | exit 1 |
| `BLOCKED` | 夹具不在该场景需要的状态；行为**未被检验** | exit 2 |
| `NOT_RUN` | 本脚本不执行该场景 | 打印并记录 |
| `COVERED_ELSEWHERE` | 由另一个脚本覆盖，并给出可核对的命令 | 打印并记录 |
| `INCONCLUSIVE` | 观测到了，但无法区分两种可能 | 打印并记录 |

**状态码与错误码必须同时精确匹配。** 401 / 403 / 404 / 409 / 422 / 503 不能互相替代：
401 是「未认证」，403 是「已认证但不允许」，把两者混同就无法区分「夹具坏了」与
「授权规则坏了」。

## 矩阵

| # | 场景 | 请求 | 身份 | 预期 | 判定 |
|---|---|---|---|---|---|
| 1 | 无凭据 | `GET /api/v1/gateway/dev.opsweave.data-catalog/api/data-catalog/datasets` | 无 | **401 `UNAUTHENTICATED`** | 精确匹配 |
| 2 | 权限不足 | `POST /api/v1/users`（创建 admin） | viewer 会话 | **403 `FORBIDDEN`** | 精确匹配 |
| 3 | 跨 workspace 读取 | `GET …/datasets?workspaceId=<WS_B>` | admin，仅授 WS_A | **403 `WORKSPACE_FORBIDDEN`** | 精确匹配 |
| 4 | 未持有 capability | `GET /api/v1/capabilities/not.held.v1/1/resolve` | admin | **403 `CAPABILITY_FORBIDDEN`** | 精确匹配 |
| 5 | Grant 撤销后调用 | 见 12a | admin | 403 `CAPABILITY_FORBIDDEN` | 由 12a 覆盖 |
| 6 | 伪造调用者身份头 | 同 4，附加 `X-OpsWeave-User-Id/Role` | admin + 伪造头 | 仍 403 `CAPABILITY_FORBIDDEN`（伪造不产生授权） | 分类判定 |
| 7 | 写请求体里伪造 workspace | `POST …/datasets`，body 含 `workspaceId=<WS_B>` | admin | 写入**不**落到 WS_B | 观测归档 workspace |
| 8 | Disable 后调用 | `POST …/disable` → `GET …/datasets` | admin | **503 `CAPABILITY_UNAVAILABLE`** | opt-in，之后 re-enable |
| 9 | Uninstall 后调用 | `DELETE …` → `GET …/datasets` | admin | **503 `CAPABILITY_UNAVAILABLE`** | opt-in，**不恢复** |
| 10 | 不兼容版本升级 | — | — | — | **NOT_RUN**（见下） |
| 11 | 多 provider 切换的 Grant 语义 | 见 `capability_multi_provider.sh` | admin | `CAPABILITY_PROVIDER_MISMATCH` | **COVERED_ELSEWHERE** |
| 12a | 撤销确认后的新请求 | revoke → `GET …/datasets` | admin | 403 `CAPABILITY_FORBIDDEN` | 精确匹配 |
| 12b | 撤销时的在途请求 | 并发：请求 ‖ revoke | admin | 200 **或** 403（都是契约允许的） | 记录哪一侧胜出 |

### 场景 3 与 7 现在是不同的机制

上一版两者发出**同一个请求**，一个安全性质被计了两次。现在：

- **3** 用 query string 指名另一个 workspace，验证**读**被拒；
- **7** 在**写**请求体里指名另一个 workspace。插件完全忽略 body 里的 workspace
  （`server.mjs` POST handler：*"never one named in the body: a caller that could
  choose would be granting itself a workspace"*），所以可观测性质**不是 403**，
  而是「写入被归档到调用者自己的 workspace」。断言 403 反而是错的。

### 场景 10 为什么是 NOT_RUN

`contracts/` 的 manifest schema **没有表达「不兼容升级」的字段**。要测「不兼容升级
被拒」，必须先构造一个契约里不存在的输入——那测的是构造出来的东西，不是产品。
如实记为 NOT_RUN 并说明原因，而不是伪造一个输入再声称验证过。

### 场景 12b 只证明「发生过并发」，不证明「无竞态」

脚本并发发出请求与撤销，记录请求得到 200 还是 403。两种都是契约允许的结果，
所以这不是断言而是**观测**：它证明并发路径被走到过，不证明竞态不存在。
需要更强的保证时应使用可控同步点（例如让 Kernel 停在授权检查与执行之间），
本轮未做，如实记录。

## Fixture 归属

本脚本**只操作自己创建的资源**：

| 资源 | 标识 | 清理 |
|---|---|---|
| viewer 账号 | `c2-viewer-<随机>@opsweave.local` | 结束时 disable |
| Grant（12a） | `OWN_GRANT_ID`（创建返回值） | 12a 内 revoke |
| Grant（12b） | `OWN2`（创建返回值） | 12b 内 revoke |
| 数据集（7） | `datasetId = c2-forged-<RUN_TAG>` | 记录，不删 |

`RUN_TAG` 是 `date -u +%Y%m%dT%H%M%SZ` 加 PID，只有本 run 能生成。

**上一版会从所有 ACTIVE grant 里取第一个并撤销**——那可能是另一个套件的资源。
该路径已删除。

## 真实 CI 证据

| 项 | 状态 |
|---|---|
| 在真实 Kernel 上执行 | 是（`data-foundation` / `typed-pipeline-runtime`） |
| 首次真实运行结果 | **1 PASS / 6 BLOCKED**——分类器正确地把 503 判为环境故障而非产品拒绝 |
| 本轮修订后 | 见 PR #103 的最新 run |

**不在本文件里写「全部通过」。** 真实结论以 PR 检查为准。
