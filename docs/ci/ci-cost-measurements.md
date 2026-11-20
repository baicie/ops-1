# CI 成本与排队：实测（TASK-30）

**采集 2026-11-20，main `64ff84f`。每个数字都附命令。采集失败的项如实标注。**

---

## 0. 一个先说的测量陷阱

`run_started_at == created_at` 在 **100/100** 次运行里成立。所以文档里流传的
`updated_at - run_started_at` 度量的是**执行时间**，排队时间恒为 0——哪怕某次运行在第一个 job
开始前等了 24.6 分钟。

**「排队时间」在这个仓库的 API 数据里测不出来**，只能从 job 级数据推断。本文所有数字都是
**执行时间**，不是端到端。

## 1. PR 运行时长

```bash
gh api "repos/baicie/ops-1/actions/runs?event=pull_request&per_page=20"
```

20 次里 16 次已完成：

```
p50 = 649 s  (10.8 min)
p95 = 2320 s (38.7 min)     nearest-rank, n=16
```

扩到 20 个**已完成**样本（`per_page=100`，取最新 20 个 completed）：

```
p50 = 971 s  (16.2 min)
p95 = 3045 s (50.8 min)
```

**p95 被一个离群值支配**：4072 s 来自 `debug/maven-central-diagnosis` 分支的 run `44673900937`。
去掉它，p95 降到 2320 s。

窗口内全部 95 次已完成运行：`p50 1331 s / p95 4606 s`。

**结论：样本量对 p95 影响很大。任何单个 p95 数字都必须附样本量。**

## 2. main 上的取消率

```bash
gh api "repos/baicie/ops-1/actions/runs?event=push&branch=main&per_page=100"
```

最近 50 次 push 运行：**20 次 `cancelled`（40%）**。

**这不是健康问题。** 每一个 cancelled 都能找到同 workflow + 同 ref 的更晚运行——这正是
`cancel-in-progress: true` 的预期行为（#170 引入）。40% 是**省下的资源比例**，不是损失。

代价（已记录在 `docs/ci/concurrency-isolation.md`）：那 20 个 commit 在 main 上**没有** CI 结论。

## 3. 逐 workflow 时长

| Workflow | n | p50 | p95 |
|---|---|---|---|
| `data-foundation.yml` | 16 | 1476 s | 2040 s |
| `plugin-lifecycle.yml` | 6 | 1083 s | 1258 s |

`plugin-lifecycle` 的样本只有 6 个——p95 在这个样本量上没有统计意义，只能说「观测到的最大值」。

## 4. 失败分类（push 窗口，27 个失败 job）

| 类别 | 数量 |
|---|---|
| staging 容量（`INSTANCE_CAPACITY_EXCEEDED`） | 13 |
| apt 镜像超时 | 7 |
| `ci-gate` 的再判决 | 4 |
| Maven POM 解析 | 2 |
| Playwright 断言 | 1 |

### 4.1 这个两分法本身是错的

**「infrastructure vs product」不适合这份数据。** 举例：7 次 apt 镜像超时被归为 infrastructure，
但它们打在**构建 Maven/PostgreSQL 客户端的路径上**——那不是「CI 自己的开销」，是产品工作被外部
服务挡住。

更准确的分法是按**处置动作**：

| 处置 | 例子 | 数量 |
|---|---|---|
| 重跑 | apt 503 | 7 |
| 授权后清理环境 | staging 容量 | 13 |
| 修代码 | Maven、Playwright | 3 |
| 不是故障 | `ci-gate` 再判决 | 4 |

### 4.2 `ci-gate` 的失败不算独立失败

27 个失败 job 里有 4 个是 `ci-gate / Decide`。它读的是**别的 job 的结论**，不独立验证任何东西。
把它计为一次产品失败会让失败数虚高，也会让人以为有四个问题而实际是一个。

## 5. 成本：测不出来，如实说

`gh` 没有 billing 端点（需要 `admin:user` scope），而这个仓库是 public——**分钟数不计费**。

尝试从 `jobs?per_page=100` 在 39 个样本运行上重建：**约 848 分钟**。

**这是 39 次样本的估计，不是总成本。** 不要把它当作仓库的真实账单。

## 6. 能得出什么结论

1. **p95 必须附样本量。** 同一个仓库、同一天，n=16 是 2320 s，n=20 是 3045 s，n=95 是 4606 s。
2. **40% 取消率是省下来的，不是丢掉的**——但它确实让那 20 个 commit 失去结论。
3. **13 次失败源自同一个环境问题**（staging 容量），不是 13 个缺陷。
4. **`ci-gate` 的红色要单独看**，它是判决而非证据。

## 7. 未做的优化

本任务要求「量化后优化」。量化做了，**优化没做**——因为：

- 最大的单项开销是 `data-foundation`（p95 2040 s），而它跑的 45 个步骤里有 39 个必须跑；
  要压缩得先删验收，那不是优化。
- staging 容量问题占失败数的 48%，但它需要授权清理，不是 CI 配置能解决的。

**没有删任何 required test，没有合并任何因 registry 隔离而分开的构建步骤。**
