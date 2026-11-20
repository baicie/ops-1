# 并发隔离：取消矩阵与验证状态

**基线 `f26ed77`。本文记录 PR-A（普通 Workflow）的设计、真实缺陷、反事实与仍然存在的风险。**

---

## 1. #170 交付的配置是错的，错在两处

```yaml
# f26ed77 的八个 suite workflow
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' || github.event_name == 'push' }}
```

### 缺陷一：`cancel-in-progress` 由**到任的 run** 求值

GitHub 文档写的是「a new run joins a busy group」——判断取消与否的是**新来的那个**，
针对的是它要加入的 group。所以：

- 手动触发 `workflow_dispatch` A，运行中
- 随后同一 ref 来一个 `push` B，B 的 `cancel-in-progress` 求值为 `true`
- B 加入 `ci-refs/heads/main` 这个 group，**取消正在运行的 A**

B 的表达式里根本没提 dispatch。把它们放进彼此路上的不是表达式，是**共享的 group**。

### 缺陷二：即使 `cancel-in-progress: false`，pending 也会被顶替

文档原文：「any existing `pending` job or workflow run in the same concurrency group is
canceled」——新来者占那个 pending 位置（默认 `queue: single` 只允许一个 pending）。

所以：push P 在跑，手动 A 排队，手动 B 再来 —— **A 被顶掉**。与 flag 无关。

这一条我上一版连想都没想过。它比第一条更隐蔽，因为表达式里没有任何字面错误。

## 2. 修法：按事件类别隔离 group

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ (github.event_name == 'workflow_dispatch' || github.event_name == 'schedule') && format('protected-{0}', github.run_id) || format('auto-{0}', github.ref) }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' || github.event_name == 'push' }}
```

- 受保护 run（`workflow_dispatch`、`schedule`）→ group 含自己的 `run_id`，**任何自动 run 都无法与之同组**
- 自动 run → group 含 ref，同一分支的新 push 仍能取代旧 push，不同分支互不影响

`run_id` 而不是 `github.sha`：同一次手动触发的重跑要有相同语义，用 `run_id` 让每次手动触发
都是独立的。

### 为什么不 `queue: max`

`queue: max` 保留 pending run 而不顶替，本该是更直接的答案。但**当前环境不支持验证**：

```
$ actionlint --version
1.7.12
$ actionlint /tmp/q.yml
unexpected key "queue" for "concurrency" section. expected one of "cancel-in-progress", "group"
```

仓库 CI 固定的是 **1.7.7**，更旧。一个无法被 lint 的键不能被依赖——写进去只会在 CI 报错，
或者更糟：在能跑的 runner 上悄悄改变行为而无人验证。

## 3. 取消矩阵

守卫不匹配字符串。它**求值**真实的 `group` 与 `cancel-in-progress` 表达式，再模拟取消规则。

| # | 到达顺序 | 必须存活 | 状态 |
|---|---|---|---|
| 1 | push A → push B | `push#B` | **VERIFIED** |
| 2 | PR commit A → PR commit B | `pull_request#B` | **VERIFIED** |
| 3 | dispatch A → push B | `dispatch#A`、`push#B` | **VERIFIED** |
| 4 | push A → dispatch B | `push#A`、`dispatch#B` | **VERIFIED** |
| 5 | schedule A → push B | `schedule#A`、`push#B` | **VERIFIED** |
| 6 | push P → dispatch A → dispatch B | 三者全存活 | **VERIFIED** |
| 7 | 分支 a 的 push → 分支 b 的 push | 两者存活 | **VERIFIED** |

`AUTOMATIC_RUN_SUPERSESSION = VERIFIED`（1、2）
`MANUAL_RUN_ISOLATION = VERIFIED`（3、4、6）
`SCHEDULE_RUN_ISOLATION = VERIFIED`（5）

### 第 8 条：同组 running + pending 的替换语义

**没有放进矩阵**，因为新的 group 设计下它**无法构造**：受保护 run 永不与另一个 run 同组，
自动 run 同组时 pending 顶替是**期望行为**（那正是取代）。

守卫在 `simulate()` 里实现了这条规则，并通过第 1/2 条间接验证（新 push 顶替旧 push 的
pending）。但「手动 run 不被 pending 顶替」这一条只能靠 group 隔离保证，无法靠矩阵证明——
**这是设计论证，不是测试结论**。记为 **VERIFIED_BY_CONSTRUCTION**。

## 4. 反事实

| 改动 | 结果 |
|---|---|
| 把 `ci.yml` 的 group 换回 #170 的形状 | **exit 1**，三条：`dispatch#1 was cancelled`、`push#1 was cancelled`、`schedule#1 was cancelled` |
| 恢复 | exit 0 |
| `--selftest` | **6/6** |

值得注意的是第 4 条：`push A → dispatch B` 里 **push 也会被 dispatch 取消**。那不是我要找的
缺陷，是守卫顺带发现的——手动 run 的 `cancel-in-progress` 求值为 `false`，但它进组时仍会
顶掉 pending 的 push。

## 5. 仍然存在的风险

1. **`run_id` 让手动重跑不取代前一次手动运行。** 同一个人连点两次「Run workflow」会跑两遍。
   这是隔离的代价，不是疏漏。若某个 workflow 需要「手动也只能有一个」，它得单独设计。
2. **行为未被真实运行观测。** 表达式与模拟都基于文档语义，但合并后**还没有一次真实的
   「dispatch 期间来 push」发生**。第一次发生才是实测。记为 **NOT_OBSERVED_LIVE**。
3. **`ci-gate` 仍把 `cancelled` 当失败。** 在 PR 上安全（新 SHA 不会被合入），但 main 上
   快速连合会让前一个 commit 永远没有 CI 结论。这是 TASK 4 的题目，本轮未改
   `RED_CONCLUSIONS`。
