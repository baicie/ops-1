# CI 关键路径测量与优化判定（PR-E）

测量日期：2026-11-21　基线 main：`5ead248`

工具：`node scripts/ci/ci-cost.mjs`

---

## 1. 决定性的一个数字：排队开销是零

按 push 分组，比较「最早 workflow 开始 → 最晚结束」的跨度与其中最长单条 workflow：

```text
2026-11-21T10:08  span=1701s  longest=1701s  queue-overhead=0s
2026-11-21T10:37  span=1426s  longest=1426s  queue-overhead=0s
2026-11-21T11:14  span= 482s  longest= 482s  queue-overhead=0s
```

**六条 workflow 同时启动，没有任何一条在排队等 runner。**

由此得到一个能直接否决一大批优化提案的结论：

> **PR 端到端时间 ≡ `golden-path` 的时长。** 其他任何 workflow 快多少，对开发者等待的时间影响都是零。

这不是估算，是三次独立 push 的一致结果。

---

## 2. `golden-path` 内部：97% 是一个人写的脚本

| step | 耗时 | 占 job |
|---|---:|---:|
| `data_foundation_ci.sh` | **1330s** | **97%** |
| Initialize containers | 15s | 1.1% |
| postgresql-client | 12s | 0.9% |
| playwright install | 12s | 0.9% |
| 其余（checkout / rust-cache / setup-node / pnpm） | 各 1–4s | <1% |

**任务书假设「环境准备、下载依赖、Docker Registry」值得拆解。实测它们合计不到 15 秒。**

脚本内部（17 次运行聚合）：

| step | P50 | 占脚本 |
|---|---:|---:|
| `pipeline_long_heartbeat_negatives` | 196s | 18.2% |
| `pipeline_long_heartbeat` | 166s | 15.4% |
| `pipeline_orphan_worker` | 107s | 9.9% |
| `supervisor_lifecycle` | 96s | 8.9% |
| `pipeline_node_runtime_sigkill` | 81s | 7.5% |
| 其余 36 个 step | 各 <70s | 40% |

### 前四项为什么压不下去

它们等的是**系统的时间常数**：租约 TTL 60 秒、节点租约 30 秒、心跳间隔 2 秒。脚本自己的注释记录过一次失败的尝试：

> `sleep 75` → 快机器上任务提前完成 → 测试失败 → 把 batch delay 从 30s 提到 55s → **「抬高数字去跑赢竞态并没有消除竞态，只是把它挪走了」**

现在的实现改成有界轮询状态，这是正确做法，代价就是要真的等那些窗口。

**缩短它们只有两条路**：改产品的租约 TTL（改产品行为），或跳过这些场景（降覆盖）。**本轮两条都不做。**

---

## 3. `full TypeScript lifecycle`：同样不是缓存问题

| step | 耗时 |
|---|---:|
| The suite can fail – injected negatives | **403s** |
| Full TypeScript plugin lifecycle | **279s** |
| Go and Java get the same lifecycle | **202s** |
| Build the binaries | 41s |
| Initialize containers | 15s |
| **Install Maven** | **14s** |
| setup-node / rust-cache / setup-go | 4–5s each |

**测试占 884s / 998s（89%）。缓存与安装类步骤合计 24s（2.4%）。**

任务书 TASK-15 列出「Maven Dependencies Cache / Java Toolchain / Go Build Cache / Docker Layer Cache / Rust Cache / pnpm Cache」六项待办。**即使把这六项全做到完美，上限是 24 秒。** 而 403 秒那个 step 是**故意注入故障并等它失败**，压缩它就是关掉负数测试。

---

## 4. 重复安装确实存在，但不在任何关键路径上

| 安装 | 出现次数 | 单次耗时 |
|---|---:|---:|
| `postgresql-client` | 10 | 15–24s |
| `playwright install` | 8 | 15–21s |
| `maven` | 3 | 14s |

这些分布在**不同 workflow 的并行 job** 里。因为排队开销为零（§1），合并它们不会让任何一个 job 提前结束，也就不会让 PR 提前完成。

**合并它们唯一能省的是 Runner Minutes，不是墙钟时间。** 这仍然有价值——但必须在报告里说清是哪一种，而不是笼统地写成「CI 变快」。

---

## 5. 本轮实际改的东西

只有一个：**Maven Central 的 429 退避重试**（已在 #188 合入）。

它不是性能优化，是**可靠性**修复：`legacy-regression` 连续两次因 `status: 429` 失败，加上 `retryHandler.count=4` 后第三次通过（6m21s）。这个改动没有让 CI 更快，它让 CI 不再随机变红——而随机变红会触发重跑，重跑才是真正的 Runner Minutes 浪费。

---

## 6. 结论：没有提出提速方案，因为数据不支持

| 任务书的目标 | 实测结论 |
|---|---|
| PR 端到端 P50 改善 20% | 端到端 ≡ `golden-path`；其 52% 是系统时间常数 |
| Data Foundation 关键路径改善 15% | 1330s 中约 690s 是等超时窗口 |
| Plugin Lifecycle 改善 15% | 884s 是测试，缓存上限 24s |
| 同等覆盖下减少重复环境准备 | 重复安装真实存在，但不在关键路径 |

**要真正缩短端到端，只有三个选项，都需要产品决策：**

1. **缩短租约 TTL / 心跳窗口**——改产品行为，且会让真实环境的故障检测变慢
2. **把长时间常数测试移出 PR 门禁**，改为 main 上的定时运行——降覆盖，需 ADR
3. **并行化脚本内部的独立 step**——`pipeline_long_heartbeat_negatives` 的六个场景共享同一个 worker 和数据库，并行会引入新的干扰；**没有测量就不该做**

这三条我都没有执行。**编一个「优化了 20%」的数字比不优化更糟**——它会让下一次真正的性能回归失去基准。

---

## 复现

```bash
node scripts/ci/ci-cost.mjs jobs --workflow data-foundation.yml --limit 20
node scripts/ci/ci-cost.mjs jobs --workflow plugin-lifecycle.yml --limit 20
node scripts/ci/ci-cost.mjs e2e --limit 30

# golden-path 内部
gh run view <run> --log | grep -oE "STEP result=PASS name=[a-z0-9_]+ .*secs=[0-9]+"
```
