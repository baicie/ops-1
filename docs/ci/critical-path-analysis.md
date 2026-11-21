# CI 关键路径测量与优化判定（重写版）

日期：2026-11-22　基线 main：`d5292ec`

工具：`node scripts/ci/ci-cost.mjs`

**本文件取代 2026-11-21 的版本。那一版的结论「Runner 排队为零」是错的**，
测量方法有缺陷。下面每一节标注 `OBSERVED` / `INFERRED` / `UNPROVEN`。

---

## 0. 前一版错在哪里（SUPERSEDED）

前一版用 `fanout span - longest workflow = 0` 推出「Runner 排队为零」。

**这个推导看不到任何排队。** 一个 job 在队列里等 90 秒，它的 workflow 的
`created_at` 仍然早于它，所以 `span` 和 `longest workflow` 都不会变化。那个
差值测的是**workflow 之间的创建时间差**，不是 runner 队列。

实测（`ci-cost.mjs queue`，40 个已完成 run）：

| job | n | min | p50 | p90 | **max** |
|---|---:|---:|---:|---:|---:|
| `zabbix-plugin` | 8 | 2s | 41s | **627s** | 627s |
| `web-unit` | 8 | 2s | 19s | **494s** | 494s |
| `artifact-budget` | 9 | 2s | 12s | **480s** | 480s |
| `spec-coverage` | 8 | 2s | 6s | **468s** | 468s |
| `platform-image-build` | 8 | 2s | 13s | **462s** | 462s |
| `b2-plugin-identity` | 8 | 2s | 45s | **465s** | 465s |
| `scope` | 8 | 2s | 43s | **455s** | 455s |

**排队最长可达 10 分钟以上。** `startSkew` 全为 0 只说明这些 workflow 是同时
被创建的，不说明它们的 job 立刻拿到了 runner。

> 这个差值里还包含 `needs:` 造成的等待。GitHub 对依赖 job 记的 `created_at`
> 早于其依赖完成的时刻，所以 `started_at - created_at` **不是纯粹的 runner
> 队列**。要分离两者需要 job 的依赖图，本轮没有做——**因此上表是排队的上界**。

---

## 1. Fanout 归属（已修正，OBSERVED）

前一版用 `createdAt.slice(0, 16)`（分钟）分组。它会把以下情况混在一起：
同一分钟的两次 push、同一分钟的 workflow_dispatch、以及重跑。

现在按 `headSha + event` 分组，缺失身份的 run 单独报为 `UNGROUPABLE`。

修正后（`ci-cost.mjs e2e --limit 60`）：

```text
fanout span: n=14  min=48s  p50=1426s  p90=1619s  p95=1701s  max=1701s
```

**结论没变**：每个 fanout 里 `span == longest workflow`，`startSkew == 0`。
所以**在 workflow 粒度上**，PR 完成时间由最长的那条 workflow 决定，
（OBSERVED）。

**但这不意味着「不可能更快」**：job 级排队是真实成本（§0），只是它被算在
workflow 自身的时长里。

---

## 2. `golden-path` 的构成（OBSERVED）

| step | 耗时 | 占 job |
|---|---:|---:|
| `data_foundation_ci.sh` | 1330s | 97% |
| 准备步骤合计 | 15s | 1% |

脚本内部前四项占 52%，等的是租约 TTL 60s 与节点租约 30s
（`INFERRED`：这是从脚本的睡眠时长和协议常量推出来的，不是从进程 trace 测的）。

---

## 3. 哪些提速是可能的（重分类）

| 方向 | 状态 | 依据 |
|---|---|---|
| 缩短系统 TTL | **BLOCKED** | 改产品行为，需 ADR |
| 缓存优化提速 | **UNPROVEN 为 0** | 缓存类步骤合计 24s，但那是在 `full TypeScript lifecycle` 一次采样里的；没有跨样本验证 |
| `golden-path` 内部并行 | **UNPROVEN** | 六个场景共享 worker 与数据库，干扰未测量 |
| 减少 job 排队 | **未研究** | 排队最大 627s，但队列由 GitHub 调度决定，仓库侧能做的是减少 job 数或缩短 job 时长 |

**前一版拒绝一切提速，依据不充分。** 「缓存上限 24 秒」只来自一次 step 采样；
「52% 压不下去」只在「不改产品 TTL」的前提下成立。这两条都写成了无条件结论，
现在降级为有条件结论。

---

## 4. 修正后的建议（不据此改代码，需单独评估）

1. **`artifact-budget` p90 排队 480 秒**——这个 job 只跑 `check-tracked-png-budget`，
   是秒级的活，却排在昂贵 job 后面。它和 `scope`、`spec-coverage`、`contracts`
   都是快速检查，可以合并或前置。
2. **`golden-path` 仍是唯一的关键路径**，任何提速必须动它。
3. **job 排队是 GitHub 侧行为**，仓库能做的是让昂贵的 job 尽早开始。

以上三条都**没有在本轮实施**，因为第 1 条需要重新组织 `ci.yml` 的 job 图，
属于 TASK-31 的范围，且必须保留 job name 与 check context。

---

## 复现

```bash
node scripts/ci/ci-cost.mjs e2e --limit 60
node scripts/ci/ci-cost.mjs queue --limit 40
node scripts/ci/ci-cost.mjs jobs --workflow data-foundation.yml --limit 20
node --test scripts/ci/ci-cost.test.mjs
```
