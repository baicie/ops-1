
---

# 10. TASK-06 的前提不成立：实例行没有无限累积

任务书 TASK-06 说：

> PR #162 的真实 PostgreSQL 测试发现：在单节点、2 副本、每节点限 1 个实例时，
> Planner 能积累多个无法真正放置的实例行。

**这句话是错的，而且错在我自己写的 PR #162 里。**

## 10.1 真实的不变式

`deployments.rs:1551`：

```rust
for slot in 0..deployment.desired_replicas {
```

实例行的创建循环**以副本数为上界**。一个 `desired_replicas = 2` 的 deployment
最多有 slot 0 和 slot 1 两行，无论 reconcile 跑多少轮。

staging 上的实际数据印证了这一点：

```
opsweave.data-catalog@0.0.3  desired=2  slot=0  slot=1   ← 正好 2 行
```

**不是累积，是正好等于副本数。**

## 10.2 我为什么写错了

PR #162 的测试只跑了一次 reconcile，断言「BOTH slots get rows」。看到两个 slot 都有行，
我推断「planner 在超量创建」。但正确的解释更简单：**副本数就是 2，所以 slot 就是 2 个**。

我没有加一条「多轮 reconcile 后行数是否增长」的断言就下了结论。加上之后：

```
test unplaceable_slots_do_not_accumulate_rows_across_passes ... ok
```

5 轮 reconcile、3 副本，行数仍 ≤ 3。**反例不成立，因此没有缺陷，也没有修复。**

## 10.3 真正存在的缺陷（与 TASK-06 无关）

有一条**相邻**但不同的问题确实存在，而且 staging 上有实例：

### 幽灵行永不被重建

`existing_node_ok`（`deployments.rs:1556`）判断「这个 slot 的行是否可以保留」时用：

```rust
used_nodes.get(&row.node_id).copied().unwrap_or(0) <= max_per_node
```

而 `used_nodes` **排除了幽灵**。所以一行 `UNHEALTHY + 无容器` 的实例，在单节点上看到
`0 <= 1` 恒真，永远走 `continue` 分支，**永远到不了 `must_rebuild` 的重建路径**。

`must_rebuild` 的文档注释说幽灵应该被重建（"It is a row to RE-CREATE"），但那个分支
被 `existing_node_ok` 短路了。

staging 证据：

```
opsweave.data-catalog@0.0.3  status=PENDING  slot=0  state=UNHEALTHY  action=STOP  ctr=NULL
opsweave.data-catalog@0.0.3  status=PENDING  slot=1  state=UNHEALTHY  action=STOP  ctr=NULL
```

两行都是幽灵、都被置为 `STOP`，但都是 `UNHEALTHY` 而非 `STOPPED`——因为它们从未被真正
停止，也没有容器可停。

**影响**：这些行不占容量（正确），但它们让 `deployment_view` 报告
`0/2 replicas READY` 而不是「没有任何实例被放置」，也让运维看不出这两个 slot 是
「等待放置」还是「放置失败后残留」。

**这是可观测性问题，不是容量问题。** 与 TASK-07（部分放置的诊断）是同一类。

## 10.4 结论

| 任务书陈述 | 核实 |
|---|---|
| Planner 积累无限实例行 | **否**。上界 = `desired_replicas`，多轮 reconcile 不增长 |
| Ghost 排除规则导致超量创建 | **否**。它影响的是**保留/重建**，不是**创建数量** |
| Ghost 行永不重建 | **是**，但这是可观测性问题，不影响容量 |

TASK-06 记为 **NOT_A_DEFECT**（按任务书给出的因果），其相邻的真实问题并入 TASK-07。
