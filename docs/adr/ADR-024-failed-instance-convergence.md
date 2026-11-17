# ADR: 失败的插件实例如何收敛

状态：**提案，未实施**。需要人工决策的项在末尾单列。

日期：2026-11-17

## 背景

一次 image pull 失败会在 `plugin_instances` 留下一行：

```
state = UNHEALTHY
desired_action = START
container_id = NULL
```

这一行**永远不会消失**。本轮修了两件事：

1. 它不再占用节点容量（`#135`→`#137`）
2. 它不再占用 CPU 与内存（`#137`）

但**状态机本身没修**。这一行仍然在表里，而且会被 reconciliation 反复写回 `START`。

## 现状：三条路径，没有一条会处理它

`reconcile_deployment`（`apps/kernel/src/deployments.rs:1390-1410`）对每个 slot 的判断是：

```rust
row.desired_action == "START"
    && eligible_ids.contains(&row.node_id)
    && used_nodes.get(&row.node_id) <= max_per_node
```

**它不看 `state`。** 所以一个 `UNHEALTHY` 实例只要节点健康、容量够，就会被保持为 `START`——
既不重启，也不放弃。

另外两条相关事实：

| 事实 | 位置 | 含义 |
|---|---|---|
| `restart_count` 由 Node 上报，Kernel **从不读它做判断** | `nodes.rs:514` | 有字段，无用途 |
| Node 侧 `restart_count` 恒为 0 | `runtime.rs:71` | 没有重试计数 |
| 没有退避、没有上限、没有终态判定 | 全仓库搜索无匹配 | — |

实测确认：手工 `UPDATE ... SET desired_action='STOP'` 会**在同一秒内被 reconile 覆盖**
（`updated_at` 等于当前时间）。所以这不是「操作员忘了清理」，是**系统没有这个能力**。

## 问题陈述

需要回答四个问题，它们互相独立：

1. **重试吗？** 一个拉取失败的实例，应该自动重试几次？
2. **何时判定不可恢复？** 拉取失败和健康检查失败的可恢复性不同。
3. **谁来做这个判断？** 现在没人做。
4. **废弃的行怎么办？** 删除、归档、还是留着但标一个终态？

## 决策：本 ADR 主张的最小集

**主张 1：`desired_action` 与 `state` 是两件事，现在被混用了。**

`desired_action` 是意图（"这个 slot 应该有一个运行中的实例"），`state` 是观察
（"它现在是什么"）。当前代码用前者替代后者做判断，于是"意图仍是启动"就意味着"永远重试"。

**主张 2：需要一个终态，且必须区分两类失败。**

```
UNHEALTHY  (可重试)  -> 退避后重新 START
FAILED     (终态)    -> desired_action=STOP，不再重试，报告给操作员
```

区分依据必须是**失败的种类**，不是次数本身：

| 失败 | 可恢复性 | 理由 |
|---|---|---|
| Image pull（digest 不存在） | **终态** | 同一 digest 再拉一百次也不会出现；重试只会刷日志 |
| Image pull（网络/registry 抖动） | 可重试 | 换个时间会成功 |
| Health check 超时 | 可重试（有限次） | 冷启动慢是常见的 |
| Health check 持续失败 | 终态（N 次后） | 这个镜像在这个节点上起不来 |
| 节点不可达 | **不是实例的错** | 应保持意图，等节点回来；不要计入重试 |

**主张 3：终态必须是数据库里的一行，不能只存在内存。**

现在的 `restart_count` 由 Node 上报且恒为 0，Kernel 不读。要支持跨 Kernel 重启的退避，
计数必须落库——否则每次 Kernel 重启都重置，退避形同虚设。

**主张 4：不删除行。**

`last_error` 与 `restart_count` 是排查依据（`/tmp/neg-*.log` 那次故障就是靠它定位的）。
删除会破坏审计。终态用 `desired_action='STOP'` + `state='FAILED'` 表达，行保留。

## 为什么不是「自动删掉幽灵」

一个诱人但错误的方案：reconcile 时直接删除 `container_id IS NULL AND state='UNHEALTHY'` 的行。

它错在**分不清"从未启动"与"曾经运行过"**。后者可能代表着一次真实的运行、真实的
数据写入、真实的 evidence。删掉它就删掉了这段历史。而前者（从未启动）删掉是安全的——
但代码无法从当前字段区分两者，除非新增字段（如 `first_started_at`）。

所以删除需要先有区分能力，那是另一个改动。

## 需要人工决策的项

以下不是工程问题，是产品/运维策略：

| # | 问题 | 选项 | 本文倾向 |
|---|---|---|---|
| 1 | 可重试失败重试几次？ | 3 / 5 / 无限退避 | **3 次，指数退避**（1m/5m/25m） |
| 2 | 终态后是否告警？ | 无 / Deployment 事件 / 外部告警 | **Deployment Event Timeline + 状态字段**（TASK-21 的一部分） |
| 3 | 操作员如何重试一个终态实例？ | 无 / `opsctl retry` / 重新 deploy | **重新 deploy**——不新增命令，复用现有语义 |
| 4 | 节点不可达超过 N 分钟，实例算谁的？ | 计入重试 / 不计 | **不计**——不是实例的错 |

## 实施顺序（若批准）

1. 迁移：`plugin_instances` 增加 `failure_kind text`、`next_retry_at timestamptz`
2. Node 上报真实的 `restart_count` 与 `failure_kind`（现在恒为 0）
3. Kernel reconcile 读这两个字段：终态则 STOP，否则按 `next_retry_at` 决定是否重启
4. 集成测试：真实 PostgreSQL + 真实 Node 观察路径
5. 反事实：把判定改回「只看 desired_action」，测试必须捕获

**不做第 2 步，第 3 步没有输入。** 所以这不是一个能在一个 PR 里完成的改动。

## 本轮实际交付

| 项 | 状态 |
|---|---|
| 幽灵不占容量 | **FIXED**（#137） |
| 幽灵不占 CPU/内存 | **FIXED**（#137） |
| 幽灵的生命周期 | **NOT_RUN**，本 ADR |
| 重试计数落库 | **NOT_RUN** |
| 终态判定 | **NOT_RUN** |

本文不声称解决了 TASK-02。它是 TASK-02 的起点：把"缺什么"写清楚，而不是把一个
统计层面的修复说成状态机层面的修复。
