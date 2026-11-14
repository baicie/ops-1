# P001 最新代码全面审查与连续攻坚 — 交付报告

| 项 | 值 |
|---|---|
| 基线 `origin/main` | `6a72964cef9e3946d8b4de26e9fd3c793e9c7012` |
| 产出 | **8 个 Draft PR（#102–#109），全部未合并** |
| 用户资产 | 主工作区仅 `03p` 台账未跟踪；原 `03h`/`03j` 内容已随 #97/#100 合入，备份在 `/tmp/user-03*.md` |
| 容器 | 用户 4 个完好；测试残留 **0** |
| Worktree | 8 个任务 worktree 全部 clean |

---

## 1. 阶段总表

| 阶段 | PR | 修改范围 | 实际测试 | CI | 状态 |
|---|---|---|---|---|---|
| 1 Heartbeat 假阳性 | **#105** | 2 个脚本 + harness | `bash -n`、shellcheck、无平台 BLOCKED=3 | 见 §11 | **完成** |
| 2 C2 安全负例 | **#103** | 脚本 + 2 文档 + harness | shellcheck；真实运行见 PR | 见 §11 | **完成** |
| 3 Conformance 真实性 | **#102** | 3 脚本 + 2 插件 + workflow | `go build`、`mvn compile`、五态判决受控验证 | 见 §11 | **完成** |
| 4 C4 浏览器验收 | **#104** | spec + 2 配置 + 文档 | `tsc` exit 0、`playwright --list` 1 test、无平台 exit 1 | 见 §11 | **完成（未跑完）** |
| 5 Node 锁加固 | **#106** | `state_lock.rs` + 文档 | 8 单元 + 6 真实多进程 + 2 反事实 | 见 §11 | **完成** |
| 6 Go/Java 生命周期 | **#107** | 构建脚本 + 矩阵 + 负例参数化 | shellcheck、BLOCKED=3 | 见 §11 | **完成（矩阵未实跑）** |
| 7 CI Gate 治理 | **#108** | 检查器 + 2 workflow + 脚本 | `0 unreferenced` + 2 反事实 | 见 §11 | **完成** |
| 8 身份持久化 | **#109** | `runtime.rs` + 新测试 + 文档 | 399 workspace + 3 反事实 | 见 §11 | **完成** |

---

## 2. P0/P1 问题与可复现证据

### 2.1 P0 — Heartbeat 验收在 CI 里是假阳性（#105）

```bash
if [ "${INCONCLUSIVE:-0}" = "1" ]; then
  echo "… INCONCLUSIVE …"
  exit 0          # <- 从未证明过恢复，却是绿灯
fi
```

且 `kill -STOP` **不是**一次真实的停机：实测心跳时间戳在窗口**期间**前进，
说明请求被排队、`CONT` 后成功——观测无法区分「没有尝试失败」与「尝试晚了」。

**修复**：以 PostgreSQL 行锁制造真实的 `UPDATE` 阻塞，用 `pg_locks.granted=false`
**证明**有请求被阻塞；`INCONCLUSIVE` 改为 **exit 2**；前置条件改为 `exit 3 BLOCKED`。

### 2.2 P0 — C2 套件会撤销任意 Grant（#103）

```python
for g in items:
    if g.get("status") in ("ACTIVE","") : print(...); break   # 第一个就删
```

**修复**：自建专属 grant（`RUN_TAG` = UTC 时间 + PID），只撤销自己记录的 id。

### 2.3 P1 — 我自己的一个假发现（#102，已撤回）

`KNOWN_GAPS` 曾断言「`RUNTIME_PROTOCOL` 从未被校验」。**错**：

```
runtime.rs:1848   verify_runtime_info(shared, &base, workload).await?;
runtime.rs:1909   || info.runtime_protocol != "http-json-v1"
```

依据的是一次**只搜常量名**的 grep，而产品比较的是**字面量**。已撤回，改为真断言。

### 2.4 P1 — P0 修复的回归测试从未在 CI 运行（#108）

```
FAIL tests/ci/p001_execstoppost_ownership.sh   NOT_REFERENCED
```

34 项断言，随 #98 合入，**没有任何 workflow 执行它**。已接线。

### 2.5 P1 — 锁文件符号链接被跟随（#106）

实测：`open()` 跟随符号链接，`flock` 落在**目标** inode 上。两个 Node 指向两个
目标即各自「持锁」。已用 `O_NOFOLLOW` + 非普通文件拒绝修复。

---

## 3. 修复前后的反事实

| 修复 | 反事实 | 结果 |
|---|---|---|
| 锁：符号链接 | 移除 `O_NOFOLLOW` | 对应用例 **FAILED** |
| 锁：非普通文件 | `if false` 替掉检查 | 对应用例 **FAILED** |
| 身份写入 | `rename` 失败被吞 | EISDIR 用例 **FAILED** |
| 身份写入（控件） | `write_atomic` 永远失败 | 控件 **FAILED** |
| 截断 marker | `pending_migration` 返回 `None` | 对应用例 **FAILED** |
| CI 覆盖 | 删掉 P0 套件的接线 | `NOT_REFERENCED` + **exit 1** |
| Docker 不可达 | 旧 `2>/dev/null` 写法 | 得 `0` → 误判「干净」；新写法 **exit 1** |

---

## 4. 已解决的 CI 假阳性

| # | 假阳性 | 所在 | 修法 |
|---|---|---|---|
| 1 | `INCONCLUSIVE` exit 0 | heartbeat | exit 2 |
| 2 | 停机未发生却算通过 | heartbeat | `pg_locks` 证据 + 硬失败 |
| 3 | DB 不可达返回空串 | heartbeat | `ON_ERROR_STOP` + exit 2 |
| 4 | worker 非零退出被当良性 | heartbeat | 要求 `JOB_ALREADY_CLAIMED` |
| 5 | 8/9 打印 `ok` 而未执行 | C2 | 真执行或 `NOT_RUN` + `COVERED_ELSEWHERE` |
| 6 | 401 通过 403 断言 | C2 | 状态码与错误码同时精确 |
| 7 | 3 与 7 同一请求计两次 | C2 | 改为读 query vs 写 body 两种机制 |
| 8 | shell 测试无人执行 | 全仓 | 检查器扩展，0 unreferenced |
| 9 | 前端 spec 无有效插件时 Skip | C4 | BLOCKED 必失败 |
| 10 | `KNOWN_GAPS` 白名单掩盖真行为 | conformance | 撤回假缺口，`KNOWN_GAPS` 现为空 |

---

## 5. 未解决的安全边界（如实记录）

| 项 | 状态 | 说明 |
|---|---|---|
| `state_dir` 是符号链接 | **ACCEPTED_RISK** | `03k` risk 5，运维契约 |
| 运行期目录被替换 | **ACCEPTED_RISK** | inode 语义，需父目录锁 |
| 旧版本 Node 不遵守 `flock` | **ACCEPTED_RISK** | advisory 锁固有 |
| NFS/SMB `flock` | **未验证**，明确排除 | 决策 5 |
| 管理员强制替换目录 | **运维风险**（需本地特权） | 未升级为远程漏洞 |
| 断电持久化 | **未验证，不声称** | 设计属性 |

---

## 6. 三语言矩阵

### 6.1 Runtime Conformance（#102）

| 维度 | TS | Go | Java |
|---|---|---|---|
| Runtime info / 身份 / 版本 / 协议 | 断言 | 断言 | 断言 |
| Capability digest（对签名 provides） | 断言 | 断言 | 断言 |
| 健康 / 就绪 / 未知路径 404 | 断言 | 断言 | 断言 |
| 非法 JSON → 4xx + 稳定 code | 断言 | 断言 | **断言（已修 500→400）** |
| 未认证 Gateway → 401 | 断言 | 断言 | 断言 |
| Gateway 剥离伪造角色头 + 投递签名上下文 | 断言 | **新增** | **新增** |

### 6.2 完整生命周期（#107）

14 步共享断言表，含「v2 部署但未激活时路由仍指向 v1」。**矩阵未实跑。**

---

## 7. C2 覆盖率（#103）

12 场景矩阵见 `03q-c2-security-matrix.md`：

| 判定 | 场景 |
|---|---|
| 精确断言 | 1、2、3、4、6、7、12a |
| 观测（非断言） | 12b（并发，记录哪一侧胜出） |
| `NOT_RUN` | 8、9（无 opt-in）、10（manifest 无该字段） |
| `COVERED_ELSEWHERE` | 11 → `capability_multi_provider.sh` |

---

## 8. C4 浏览器验收（#104）

**仍未跑完。** 已确立：spec 能在 CI 上用真实 Chromium 打开真实平台。
`serve_asset` 不检查 lifecycle 状态，卸载后字节对已认证调用者仍可达——记录为当前
行为，不断言为正确。

五层分离：字节可下载 / 新页面可加载 / 已加载脚本仍运行 / 能取得授权 / 后端接受请求。

---

## 9. 建议的合并顺序

| 顺序 | PR | 理由 |
|---|---|---|
| 1 | **#108** | 它接线的 P0 套件保护其余所有改动 |
| 2 | **#106** | 独立安全修复，反事实充分 |
| 3 | **#109** | 独立，无产品行为变更 |
| 4 | **#105** | CI 确定性；需重跑确认 |
| 5 | **#102** | conformance 门禁 |
| 6 | **#103** | C2 负例 |
| 7 | **#104** | C4 |
| 8 | **#107** | 最大改动；矩阵实跑后 |

**每个都需在最新 main 上重跑 9 项必需检查**（规则集 `strict_required_status_checks_policy`）。

---

## 10. 本轮没做到的

| 项 | 原因 |
|---|---|
| #102/#104/#105/#106/#107 的真实 CI 结果 | 依赖各 PR 的检查，本轮未等 |
| #103 在真实 Kernel 上重跑 | 同上 |
| #107 的三语言生命周期矩阵 | 需要完整平台 + 6 个新镜像 |
| #104 的浏览器完整运行 | 需要有效插件与可下载的 Chromium |
| 断电持久化 | 无法模拟，不声称 |
| 合并任何 PR | 任务包禁止 |

---

## 11. CI 结果：超时，不是断言失败

八个 PR 并行触发重型 workflow 后，`golden-path` 与 `runtime-golden-path`
出现失败。逐个核对：

```
#102 golden-path            fail 55m0s   conclusion=cancelled, 0 failed steps
#103 runtime-golden-path    fail 55m2s
#103 golden-path            fail 55m0s
#104 runtime-golden-path    fail 55m1s
#105 runtime-golden-path    fail 59m0s
#105 golden-path            fail 55m0s
```

Job API 显示 `conclusion: cancelled`、失败步骤列表为空——**没有任何断言失败**。
`data_foundation_ci.sh` 这一步在 55 分钟后仍在 `in_progress` 时被取消。

对照基线：`main` 上同一 workflow 最近一次成功是 **17 分钟**。

| 事实 | 值 |
|---|---|
| main 基线 | 17 分钟 |
| 本轮 | 55+ 分钟被取消 |
| 同时运行的重型 job | 10（4 × data-foundation + 6 × typed-pipeline-runtime） |

**这是队列拥塞，不是产品回归**，但我不能只写「flaky」了事：

- 每个重型 job 都要起完整平台 + Chromium + Docker，10 个并发把它们互相拖慢；
- 我自己在 `#105` 里给 harness 增加了 counterfactuals 步骤（会完整跑一次 SUT），
  这确实增加了单个 job 的耗时——但没有测量到它单独就能超过 45 分钟；
- **未验证**的是：单个 PR 独占运行 CI 时是否仍在预算内。这需要把 PR 串行重跑，
  本轮没有做。

因此本轮**不报告任何 PR 的 CI 为通过**，也不把它归因为已知 flake。

**这个拥塞是本轮我自己造成的**：八个 PR 同时活跃，每个都触发两套重型 workflow。
`#108` 里新增的检查器本来就是为了让这类问题可见，而这次的问题恰好是「并行度」而
不是「覆盖缺失」。

下一次运行应当只保留一个 PR 活跃，或者按 §9 的顺序逐个推进。

### 11.1 决定性实验：串行重跑 #103

时间线证实了并发假设：

| 时间 (UTC) | 事件 |
|---|---|
| 10:15 起 | 八个 PR 各触发 `data-foundation` + `typed-pipeline-runtime`，共 16 个重型 run |
| 10:32–11:01 | 7 个 `data-foundation` 被取消（我取消的），`typed-pipeline-runtime` 全部超时 |
| 11:31–11:52 | 三个 job 在 55 分钟处被判 `failure`，`data_foundation_ci.sh` 仍在 `in_progress` |

随后取消其余七个 PR 的所有重型 run，**只重跑 #103**，使其独占 runner。
结果见本节末尾的更新——这是判断「超时是否只由拥塞造成」的唯一干净测量。

**本报告不把任何未验证项写成 PASS。**
