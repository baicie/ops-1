# P001 连续攻坚 — CI 真实结论与根因链

| 项 | 值 |
|---|---|
| 基线 `origin/main` | `6a72964cef9e3946d8b4de26e9fd3c793e9c7012` |
| 文档性质 | 过程记录 + **已确证的 CI 结论**，与 `03v` 并存 |
| 覆盖范围 | 仅在 CI 上真实跑出来的结果；本地反事实单独标注 |

本文件**只记录有 CI 日志支撑的结论**。本地验证的结果写在各自的 PR 里，
不在这里升格为 CI 结论。

---

## 1. 八次"runner lost communication"的真正原因

2026-11-14 09:43–11:35Z 之间，`runtime-golden-path` 连续八次在 55–60 分钟失败，
annotation 全部相同：

```
[failure] The hosted runner lost communication with the server.
```

**不是 timeout**（第一次在 58m01s 结束，未到 60 分钟上限），**不是断言失败**
（失败步骤列表为空），**不是 flake**。

### 1.1 根因

```bash
kill -9 "${WORKER_PID:-0}" 2>/dev/null || true
```

这一行在 `pipeline_long_heartbeat_negatives.sh` 里出现 **9 次**。两个缺陷在这里相遇：

1. **`WORKER_PID` 永远是空的。** 所有调用点都是
   `JOB1="$(start_long_job 40000)"`，命令替换让函数在**子壳**里运行，
   里面的 `WORKER_PID=$!` 到不了调用方。`:-0` 是为了躲开 `set -u` 的
   "unbound variable" 而加的——治的是症状。
2. **这个默认值是致命的。** `${WORKER_PID:-0}` 展开成**字符串 `0`**，
   而 `kill -9 0` 不是"什么都不杀"：`0` 表示**调用者自己的进程组**。

隔离进程组内实测：

```
script runs kill -9 "${EMPTY:-0}"
  -> 永远执行不到下一条语句
  -> exit 137 (SIGKILL)，无输出
  -> 后台子进程一并被杀
```

GitHub runner 上，step shell 的进程组包含 runner 的通讯进程——这正是
annotation 报告的 "lost communication"。

### 1.2 归属

该缺陷**在 main HEAD `6a72964` 上**，由 PR #101 引入（squash 合入，
所以 `cbfb9473` 不是 main 的祖先）。八个 PR 分支中七个仍带着它。

---

## 2. 该缺陷背后的三层遮蔽

修完第一层后，还有两层挡着，每一层都把下一层藏起来。**这条链本身就是结论**：
在测试基础设施有缺陷时，产品结论是不可信的。

| 层 | 缺陷 | 表现 | 修法 |
|---|---|---|---|
| 1 | `kill -9 0` 杀进程组 | runner 失联，脚本永不返回 | 去掉 `:-0`，改 `stop_worker()` 只认正整数 pid |
| 2 | 反事实换了 worker 二进制没换回 | 中断后 `target/debug/opsweave-pipeline-worker` 永久是 `exit 1` 的 stub | `trap EXIT/INT/TERM` 恢复 + case 自断言恢复成功 |
| 3 | 诊断写到了 stdout | job id 变成 `"      worker for job <uuid>: …"`，所有查询报 `invalid input syntax for type uuid` | 改 `>&2`，并说明该函数的 stdout 就是返回值 |
| 4 | `env` 收到 `40000` 当成命令 | `env: '40000': No such file or directory`，worker 从未启动 | 删掉从不该存在的 `"$@"` |

第 2 层的实测对照（同一 SIGTERM）：

| | 旧形状 | 新形状 |
|---|---|---|
| worker 二进制 | **17 字节 stub** | 15 062 184 字节真身 |
| `.real` 残留 | **有** | 无 |
| 退出码 | 143 | 143 |

第 4 层的实测对照：

```
before:  env: 40000: No such file or directory
after:   WORKER STARTED FOO=40000
```

**这四层里没有一层是产品缺陷。** 它们合起来让五次 negatives 失败看起来像
"产品拒绝认领 job"。

---

## 3. 已在 CI 上确证的结论

以下引用自 CI 日志，不是本地运行。

### 3.1 长心跳验收：PASS

```
PASS  a heartbeat request was observably BLOCKED on the lease row (pg_locks granted=false)
PASS  the heartbeat resumed after the outage: 2026-11-14 13:25:42.42931+00
PASS  the lease stayed ACTIVE across the outage
PASS  long-running job kept its Lease via the independent heartbeat across an outage
Long Heartbeat Golden Path: PASS
```

这是 #105 的核心主张，且在**三次不同的 run** 上重复通过
（43598745967 / 43601891712 / 43604452855）。

它证明的是：中断**可观测**（`pg_locks` 里有 `granted=false` 的等待者）、
心跳在中断期间**冻结**、恢复在**同一条 lease** 上被测量到。

### 3.2 反事实：8/8

```
== counterfactuals: PASS=8 FAIL=0 NOT_RUN=1 ==
```

从 `PASS=7` 提升到 `PASS=8` 的那一条，是第 2 层修复带来的：

```
PASS  6: the real worker binary is back in place with no .real left behind
```

`NOT_RUN` 的是 case 2（心跳未更新的比较形态不匹配，README 里写明"人工审阅"）。

### 3.3 `ci` 必需检查：success

在 head `e5b6f20b` 上 `ci` 首次真实跑完并成功。此前三个 head 上它都被
**我自己取消**——为了控制 runner 拥塞而取消整批 run，没有排除必需检查。
这是本轮我自己造成的损失，记录在此。

---

## 4. 尚未确证的（明确列出，不写成 PASS）

| 项 | 状态 | 原因 |
|---|---|---|
| negatives 的 5 个故障注入是否真能检出 | **NOT_RUN** | 四层遮蔽刚清完，尚未有一次跑在活着的 worker 上 |
| 其余 6 个 PR 的 CI 结论 | **NOT_RUN** | 修复有本地反事实，CI 被我取消 |
| C4 浏览器验收的真实运行 | **NOT_RUN** | 专用 fixture 刚交付，尚未跑 |
| Go/Java 生命周期矩阵 | **NOT_RUN** | 需要完整平台与三语言镜像 |
| 断电持久化 | **未验证，不声称** | 无法在 CI 模拟 |

---

## 5. 一条方法论结论

这轮四次根因定位，没有一次来自"读代码想一想"，全部来自**把日志读到最后一行**：

1. `The hosted runner lost communication` → 查 annotation 而非猜测超时；
2. `worker pid N already gone` → 加诊断把 worker 日志路径打出来；
3. `invalid input syntax for type uuid` → 看出是诊断自己污染了返回值；
4. `env: '40000': No such file or directory` → 那一行就是答案。

前三次的诊断输出都被下一层遮蔽解释掉了。**如果第二次就停下来说"环境 flake"，
真因永远不会出现。**
