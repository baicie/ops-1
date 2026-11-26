# ADR-030: reclaiming a failed candidate deployment

- **Status**: Proposed
- **Date**: 2026-11-26
- **Baseline**: `6c6100be`
- **Depends on**: ADR-024 (failed-instance convergence), ADR-025 (version identity), ADR-027 (upgrade releases old version)
- **Phase**: 9B, TASK-07

## 问题陈述

staging 的节点被四个实例占满，其中一个是 `opsweave.data-catalog@0.0.3590`：
`DEGRADED`，从未激活，`activatedAt` 为空，原因为 `0/2 replicas READY; 1 failed`
（`capacity.json`, run 45750074444）。

它占着一个槽位，而每个后续发布都因此失败。现有的回收规则
（`deployments.rs:1848`）只匹配 `d.status = 'READY'`，所以它永远不会被释放。

**但不能因此就把它加进那个集合。** Phase 9A 的审计（`docs/ci/phase9a-lifecycle-audit.md`）
确立了两个事实，它们否决了最直接的修法：

1. **Gateway 不读 deployment status。** `route_candidates`（`gateway.rs:349`）要求
   `activation_revisions.status='ACTIVE'` 加一个 `READY` 实例。一个 `DEGRADED` 的行
   可能正在服务流量，而一个 `ACTIVE` 的行可能什么都没在服务。
2. **`DEGRADED` 是两个状态共用一个标签。** `:2360` 是"已生效但副本不足"（TASK-04
   case A/B，可能仍在服务），`:2376` 是"副本失败、从未生效"（case C）。
   把 `READY` 机械改成 `IN ('READY','DEGRADED')` 会让 case A 进入候选集。
   实测：这个改动让 `staging_capacity_shape` 的三条测试失败。

## 决定

### D1 — 复用现有谓词，不新建机制

回收仍然由 `reconcile_once_locked` 中那一条 `UPDATE`（`:1848`）执行，仍然走
`DRAINING` → `DISABLED` → 现有的 `STOP` 写入。不新增删除路径，不新增旁路。

理由：那条路径已经保证了四件事——行在宽限期内仍然可见、reconciler 是状态转换的
唯一所有者、`DISABLED` 才会写 `STOP`、以及有一段测试断言宽限期两半
（`a_drained_version_frees_its_node_slots_after_the_grace_period`）。新建一条会把这四件
事各复制一遍，并且违反简报的「复用，不得新增旁路删除逻辑」。

### D2 — 资格判定必须由 Kernel 持有，且回答四件事

抽取一个 Kernel 内部可复用的判定（TASK-08），返回四种结果之一，并带稳定的 reason code：

| 结果 | 含义 |
|---|---|
| `RECLAIMABLE` | 全部条件成立，可以释放 |
| `PROTECTED(code)` | 有一条保护成立，明确不可回收 |
| `INSUFFICIENT_EVIDENCE(code)` | 缺决定性数据，**不回收**（fail-closed） |
| `CHANGED` | 判定与执行之间 generation 变了，本次操作作废 |

`opsctl`、staging 脚本、CI **不得**复制这套规则，只展示 Kernel 的结论。这延续
#229 的做法：`opsctl capacity` 已经不再自己算 verdict，而是读
`/api/v1/capacity/preflight`。

### D3 — 八条资格条件，逐条对应简报的清单

一个部署可回收，当且仅当**全部**成立：

| # | 条件 | 简报要求 | 依据 |
|---|---|---|---|
| E1 | 同 plugin 存在更晚的部署（`created_at` 更晚，不是 `version` 更大） | "与当前发布意图属于同一 plugin" + "是否应要求更晚的同插件部署" | `ReclaimCandidate.superseded_by` 的契约：「a candidate is only reclaimable because something is newer」。ADR-025：版本是内容指纹，无序 |
| E2 | 没有 `activation_revisions` 行以 `ACTIVE` 指向它 | "不属于 ACTIVE activation revision" | `is_effective` 的定义；`route_candidates` 只认这一行 |
| E3 | 没有 `READY` 实例（因此 Gateway 不会选它） | "不承载当前 Gateway 路由" | `route_candidates` 要求 `i.state='READY'`。**这是与 E2 独立的第二道**，因为一个已降级的 ACTIVE 部署可能仍有 READY 实例在服务。证据：`gateway::tests::a_degraded_deployment_with_a_ready_instance_still_routes`（本条 ADR 新增）。反事实：给 `route_candidates` 加上 `d.status='ACTIVE'` 后该测试失败 |
| E4 | `status` 属于 {`READY`, `DEGRADED`} **且** 若是 `DEGRADED` 则必须来自 `failed > 0` 分支，即 `is_effective` 为假 | 区分 case A 与 case C | Phase 9A TASK-04 |
| E5 | 同 plugin 至少有一个 `PENDING`/`PREPARING` 的部署在等待 | 现有谓词已有 | 防止回收回滚目标：`rollback` 会让目标停在 READY 等待激活 |
| E6 | `generation` 未变（判定时到执行时） | "generation 未变化" | TASK-13 的 fencing |
| E7 | 没有正在进行的重新部署或激活 | "没有正在发生的重新部署或激活" | 由 E5 + generation 覆盖：`redeploy`/`enable` 都 `generation+1` |
| E8 | 它自己的实例要么不存在，要么**全部** `desired_action='STOP'` 或 `container_id IS NULL` | "满足既有生命周期契约的停止条件" | 见 D4 |

**没有任何一条单独充分。** 这是简报「不能根据它从未激活这一项条件就认定可安全停止」
的直接实现。

### D4 — 物理资源：区分"停止计划"与"实际停止"

E8 是这份 ADR 里唯一新增的资格条件，也是最重要的。

`0/2 replicas READY; 1 failed` 说明**至少有一行实例存在**。那一行可能：

- 是幽灵（`container_id IS NULL`）——从未有过容器，回收它不停止任何进程；
- 有容器且 `desired_action='START'`——**回收会停掉一个真实进程**。

ADR-024 已经指出「从未启动」与「曾经运行过」需要区分，并建议 `first_started_at`；
该字段**至今不存在**（实测 `information_schema.columns`）。所以本 ADR 用现有字段
能做到的最强判定是 `container_id`：

```
证据不足（INSUFFICIENT_EVIDENCE）：
  存在实例，desired_action='START'，且 container_id IS NOT NULL
  —— 说明一个容器可能真的在跑。不自动回收。
  reason code: RUNTIME_MAY_BE_RUNNING

可回收：
  所有实例 container_id IS NULL
  或 所有实例 desired_action='STOP'
```

这与简报「不能把 `desired_action=STOP` 单独当成物理资源回收成功」一致：`STOP` 只说明
**计划**停了，`container_id` 说明**曾经**有容器。两者都成立时仍需观察实际退出
（TASK-15），本 ADR 只决定能否**发起**回收。

### D5 — 无后继候选时不回收

简报问「是否允许无后继候选时回收」。答案：**不允许**。

理由不是保守，而是 `ReclaimCandidate.superseded_by` 已经是这个契约，且它有一个真实的
反面案例：一个插件的**唯一**版本即使 `DEGRADED` 也不该被自动回收，因为它没有替代品，
回收等于下线这个插件。staging 上 `dev.opsweave.hello@0.0.1` 和
`data-integration@0.0.2` 正是这种形状——它们是各自插件唯一被激活的版本。

### D6 — 不需要额外宽限期

`READY` 候选的 `drain_until = now()`（立即），`activate` 的旧版本是 15 秒。失败候选
沿用 0 秒，理由与现有代码一致：**它从未承载路由，没有需要保护的在途请求**。E3 已经
保证了这一点。给一个从未服务的部署加宽限期只会延迟必要的释放。

### D7 — 不新增列

本 ADR **不**引入 `first_started_at` 或 `failure_kind`。ADR-024 提出的那两个字段仍然
值得做，但它们是独立改动（TASK-21 的可观测性），不是回收的前置条件：D4 用
`container_id` 已经在现有 schema 上做到了 fail-closed，只是代价更保守——
有容器的失败候选不会被自动回收，需要人工处理。**保守方向的误判是可接受的，激进
方向的不是。**

## 结果与代价

**得到**：一个从未生效、有后继、非 ACTIVE、无人等待、无运行容器的失败候选，会在下一次
reconcile 被释放，走既有 `DRAINING → DISABLED → STOP` 路径，行保留、artifact 保留、
审计记录保留。

**付出**：

- staging 的 `0.0.3590` **可能不满足 E8**，如果那个 failed 实例还挂着容器。那么自动回收
  不会发生，正确的结果是**人工介入**，而不是放宽条件。这正是 TASK-05 记录的缺口。
- 有容器的失败候选会一直占槽位，直到有人处理。这是有意的：自动停掉一个可能正在写数据的
  进程，代价高于一个槽位。

## 被否决的方案

| 方案 | 否决理由 |
|---|---|
| `status IN ('READY','DEGRADED')` | 把 TASK-04 case A（已激活、可能仍在服务）放进候选集。实测：三条测试失败 |
| 按 `version` 字符串判断谁更新 | ADR-025：`0.0.N` 是内容指纹，`"0.0.9" > "0.0.10"` 为真 |
| 新增一条 `DELETE FROM plugin_deployments` | 简报禁止；且会丢掉行、artifact 引用和审计线索 |
| `docker rm` 代替生命周期 | 简报禁止；Kernel 会与 Node 的实际状态脱节 |
| 提高 `max_instances_per_node` | 简报禁止；掩盖问题而不解决 |
| 在 `opsctl` 里再实现一遍判定 | 简报禁止；#229 刚刚因为第二套容量计算吃过一次亏 |
| 无后继候选也回收 | D5；会让插件失去唯一可用版本 |

## 未决

| 项 | 状态 |
|---|---|
| staging `0.0.3590` 是否满足 E8 | **未知** —— 需要 TASK-05 列出的实例行查询，未获授权 |
| `0.0.3590` 是否为 data-catalog 的回滚材料 | **未知** —— 需要 `activation_revisions` 查询 |
| `first_started_at` / `failure_kind` | 仍然值得做（ADR-024），但不是本 ADR 的前置 |
| TASK-13 generation fencing 的具体实现 | 独立任务；D3/E6 只规定了判定必须带 generation |
| TASK-14 activate/reclaim 并发 | 独立任务；本 ADR 的 E6 是它的输入之一 |

**本 ADR 不授权任何 staging 操作。** 执行需要 TASK-17 的变更计划和 TASK-19 的明确授权。
