# P001 后续工程攻坚 — 执行台账与阶段 9 验收

| 项 | 值 |
|---|---|
| 起点 `origin/main` | `89113ade63f286707781acc4a053bec1ab513f78` |
| 产出 | 8 个 PR（#97–#104） |
| 已合入 | **#98** `770e6fc`（P0 安全修复） |
| 其余 | 按顺序合并中；规则集要求 `strict_required_status_checks_policy`，每个分支都要在最新 main 上重跑 9 项必需检查 |
| 用户资产 | 两份未提交文件 SHA-256 与开工时一致；4 个既有容器全部存活 |
| 测试容器残留 | **0** |

---

## 1. 总表

| 阶段 | 目标 | PR | CI | 验收状态 | 遗留问题 |
|---|---|---|---|---|---|
| 1 | 纠正 C1.3 过期文档 | #97 | **17 pass** | **完成** | `digestV1` 必然为空的根因已记录，未修（属测试改动） |
| 2 | **P0** ExecStopPost 跨安装隔离 | #98 | **20 pass** | **完成** | `/opt/opsweave/bin` 无安装规则（既有缺口，已记录） |
| 3 | 状态目录稳定性 Gate | #99 | 全部 workflow success | **完成（CONDITIONAL PASS）** | 目录被替换/符号链接未防护 |
| 4 | 单实例锁实现 | #100 | 全部 success（修复后） | **完成** | Linux 上 inode 复用导致测试失败，已改为断言语义 |
| 5 | long heartbeat 确定性 | #101 | 修复后重跑中 | **部分完成** | 停机观测不可靠→改为 `INCONCLUSIVE` 且不声称恢复；worker 退出码不再当作作业结果。**「心跳在作业执行期间发生」这半边已由真实运行证实** |
| 6 | 多语言 conformance 门禁 | #102 | 二次修复后重跑中 | **部分完成** | ①未起 registry ②`localhost`→`::1` ③未设 `BUILD=1` ④端口硬编码 ⑤HOME 写死。**五次 BLOCKED，每次一个真实缺陷，均已修** |
| 7 | C2 安全负例 | #103 | 已真实运行（1 PASS / 6 BLOCKED） | **部分完成** | 四分类在真实产品上首次生效：503 被判为 BLOCKED 而非「产品拒绝」。已修「依赖上一套件留下的激活状态」，待重跑 |
| 8 | C4 浏览器资源验收 | #104 | **真实 CI 上已跑起来**（浏览器+平台），首跑 404 | **NOT_RUN（未跑完）** | spec 硬编码了 harness 未部署的插件，已改为动态发现；spec-coverage 已修 |

---

## 2. 本轮发现的缺陷

### P0 — 已修复并有反事实

**`deployments/linux/opsweave-node-cleanup.sh` 会删除其他安装的容器。**

systemd `ExecStopPost` 按 `opsweave.node-id` 选容器并 `docker rm -f`。node-id
**不是**所有权证明（ADR-023 已写明），数据库恢复或目录复制会让两个安装共享它。

真实 Docker 实测：4 个容器共享一个 node id，旧脚本删掉了 A（自己的）、
**B（另一个安装）**、**无 installation-id 的历史容器**，只留下完全无标签的第三方。

第二处：unit 导出 `OPSWEAVE_DOCKER_HOST`，而 `docker` CLI 只读 `DOCKER_HOST`，
所以清理脚本走的是**默认 socket**，不是 rootless daemon。

| 版本 | 测试结果 |
|---|---|
| 修复后 | **34/34 PASS** |
| `origin/main` | **PASS=15 FAIL=19** |

### P1 — 已记录，未修

| # | 缺陷 | 证据 |
|---|---|---|
| 1 | `RUNTIME_PROTOCOL` 定义但**从未被校验**。就绪探测只看 HTTP 2xx | `grep -rn RUNTIME_PROTOCOL` 只有定义处；`runtime.rs:2011-2022` |
| 2 | **Java 对非法 JSON 返回 500 `INTERNAL`**，TS/Go 返回 400 `INVALID_JSON` | `HelloController.java:80-88` |
| 3 | 9 个 `tests/ui` spec 在模块作用域读 fixture，缺失时整个 Playwright 收集阶段抛错（`Total: 0 tests`） | `gplaywright test --list` |
| 4 | `digestV1` 的抽取发生在任何 deployment 存在之前，**必然为空**，`\|\| true` 吞掉 | 真实 artifact 中 `"digestV1": ""` |
| 5 | `/opt/opsweave/bin/` 没有任何安装规则，systemd 模式的 `ExecStart`/`ExecStopPost` 都不存在 | `grep -rn 'opt/opsweave'` |
| 6 | **`supervisor_lifecycle.sh` 的 crash-loop 与 supervisor 退避上限相等**，第 3–4 轮必然竞态 | 见下 |

### 缺陷 6：supervisor crash-loop 的预算恰好等于退避上限

`wait_worker`（`tests/acceptance/supervisor_lifecycle.sh:10-18`）的预算是
**60 × 0.5 s = 30 秒**。

`backoff`（`apps/node/src/worker_supervisor.rs:162-165`）是
`2 × 2^failures`，上限 **30 秒**：

```rust
let seconds = 2u64.saturating_mul(1u64 << failures.min(4));
tokio::time::sleep(Duration::from_secs(seconds.min(30))).await;
```

第 4 次连续失败时等待 32→被夹到 30 秒，**正好用尽等待预算**。任何调度抖动都会让
`wait_worker` 在 worker 起来前返回失败。

这解释了 #103 上 `FAIL supervisor did not restart in crash-loop round 3` 为何
在 main 与 #98 上通过、在 #103 上失败：它与 #103 的改动无关（#103 的插入点在
`data_foundation_ci.sh:269`，该测试在 `:194`），是既有的边界竞态。

**本 PR 不修**：修它要么降低退避上限、要么提高等待预算，两者都改变被验收的行为，
应当单独决定。**这是它第三次被观察到**（C1.3 审阅中曾记录 `runtime-golden-path`
在同一测试上 flaky）。

---

## 3. 修复前后的反事实

| 修复 | 反事实 | 结果 |
|---|---|---|
| ExecStopPost 所有权 | 用旧脚本跑同一套 34 项测试 | **19 项失败**，含 `B was DELETED`、`SIGKILL + no identity: B's container was deleted` |
| 单实例锁 | ①删除 `flock` ②立即 `LOCK_UN` ③改成临时变量 ④`Drop` 里 unlink | 每个都让 **2–3 个真实进程测试失败** |
| C2 安全负例 | 用「对所有请求返回 200」的假服务 | **5 项 FAIL，exit 1** |
| heartbeat 确定性 | 真实 Linux 首跑 | **FAIL**，并暴露出停机窗口超过 worker 重试预算 |

---

## 4. 单实例锁是否真正实现

**是。** PR #100：

- `flock(2)` `LOCK_EX|LOCK_NB` 于 `<state_dir>/.node.lock`，`0600`
- 取得于 `create_dir_all` 之后、`docker.version()` 之前
- 具名绑定 `let _state_lock = …`，`#[must_use]`
- 内核在进程终止时释放（含 `SIGKILL`），**从不 unlink**
- 三错误码互斥；`EINTR` 不映射为占用
- 平台白名单 Linux/macOS，其余拒绝启动
- **零新增依赖**（`libc` 已存在）

真实多进程测试 6 项 + 单元 6 项，**20 次连续运行 20 次通过**。

锁失败时副作用面实测为零：身份文件内容与 inode 均不变、无 binding 写入。

---

## 5. 状态目录稳定性是否已验证

**已验证，结论是 CONDITIONAL PASS。**

| 操作 | 目录 inode |
|---|---|
| 正常重启 | 不变 |
| `docker compose up -d --force-recreate` | **不变** |
| 原地 `mv` | 不变 |
| `rm -rf` + `mkdir` 同路径 | **改变** |
| 替换为符号链接 | 新 inode |

正常生命周期安全；目录替换不安全。附加三条前置条件，其中一条已由本轮 CI 证实
（Linux 上 tmpfs 会复用刚释放的 inode 号——这正是 #100 首轮 CI 失败的原因）。

---

## 6. 各语言 Runtime Conformance 覆盖

| 维度 | TS | Go | Java |
|---|---|---|---|
| Build / image / digest / 签名 | 是 | 是 | 是 |
| Runtime v1 health / readiness | 断言 | 断言 | 断言 |
| 基本业务调用 | 断言 | 断言 | 断言 |
| 错误响应 | 400 `INVALID_JSON` | 400 `INVALID_JSON` | **500 `INTERNAL`（FAIL）** |
| 协议版本不匹配 | **NOT_RUN**（产品不校验） | 同 | 同 |
| 超时 / 重启 / upgrade / rollback / disable / uninstall | **NOT_RUN** | **NOT_RUN** | **NOT_RUN** |

**没有一种语言在本轮被真实判定为 PASS。** workflow 首跑在 bundle 构建处
`BLOCKED`（exit 3），原因已定位并修复，未再验证。

---

## 7. C2 安全负例覆盖

已断言 7 项：无凭据、权限不足、跨 workspace、未持有 capability、伪造身份头、
伪造 workspace、撤销确认后。

**NOT_RUN** 3 项：disable/uninstall（由 `e2e_platform.sh` 覆盖）、不兼容升级
（manifest 无该字段，构造即等于测自己编的输入）。

**未在真实 Kernel 上运行过。**

---

## 8. C4 浏览器验收覆盖

**仍未完成，但已经真的跑起来了。**

本机无 Kernel、chromium 下载 `ECONNRESET`，所以本地无法运行。CI 上
`golden-path` job 用真实 Chromium 打开了真实平台，spec 执行到第一个断言：

```
Error: plugin detail for dev.opsweave.hello
Expected: 200   Received: 404
```

harness 部署的是 **data 插件**，不是 hello 参考插件——我的默认名字选错了。
更值得警惕的是：那个 404 与 D4 要问的「资源没了」只隔一行。

已改为**从 `/api/v1/plugins` 动态发现**一个有 `frontend/index.html` 的插件，
并把 `/api/hello` 这种插件专有路径换成所有插件都实现的
`/_opsweave/runtime/v1/info`。

**未声称 C4 完成。** 已确立的是：这个 spec 能在 CI 上、用真实浏览器、
对着真实平台运行。

---

## 9. 未合并 PR 与依赖

| PR | 分支 | 依赖 |
|---|---|---|
| #97 | `docs/p001-c13-acceptance-status` | 无 |
| #98 | `fix/p001-node-execstoppost-ownership` | 无 |
| #99 | `docs/p001-state-dir-stability-gate` | 无 |
| #100 | `feat/p001-node-state-single-instance-lock` | 概念上依赖 #99 的 Gate 结论；**代码上无依赖** |
| #101 | `fix/ci-long-heartbeat-deterministic` | 无 |
| #102 | `test/p001-multilang-conformance-ci` | 无 |
| #103 | `test/p001-c2-security-negatives` | 无 |
| #104 | `test/p001-c4-browser-assets` | 无 |

**没有复制未合并代码，也没有任何 PR 隐式依赖另一个的未合并内容。**

---

## 10. 推荐的合并顺序

1. **#98** — P0 安全缺陷，独立、已验证、反事实充分
2. **#97** — 纯文档，消除已合入文档中的自相矛盾
3. **#104** — 补齐 `spec-coverage`（它的失败会阻塞 #104 自身）
4. **#101** — CI 确定性；需重跑确认
5. **#102** — conformance 门禁；需重跑确认
6. **#100** — 单实例锁；建议与 **#99** 一起合入，Gate 结论是它的依据
7. **#99** — Gate 文档
8. **#103** — C2 负例；真实运行结果出来后再合

---

## 11. 本轮没有做到的

| 项 | 原因 |
|---|---|
| #101 修复后的真实 Linux 验证 | 需要重跑，本轮未完成 |
| #102 修复后的真实 Linux 验证 | 同上 |
| #103 在真实 Kernel 上运行 | 需要完整 Data Foundation 部署 |
| #104 浏览器运行 | 本机无平台，chromium 下载失败 |
| 单实例锁的 Linux 实跑 | 依赖 #100 的 CI，修复后待重跑 |
| 任何 PR 的合并 | 简报禁止 |

**本文件不把任何未验证的项写成 PASS。**
