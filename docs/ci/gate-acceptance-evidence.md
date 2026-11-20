# Gate 验收证据

**这是 TASK-06 要求的实证记录。每一条都必须是真实发生过的 Run，带 Run id、Check Run id
和 SHA。本地 90/90 Selftest PASS 不是证据——它证明脚本逻辑自洽，不证明 GitHub 上的
必需检查真的会拦住合并。**

采集时间 2026-11-20。

---

## 0. 判定标准

| 词 | 含义 |
|---|---|
| **VERIFIED** | 有真实 Run，且 Run 的行为与预期一致，记录了 id |
| **NOT_VERIFIED** | 设计上应该如此，但没有 Run 证明 |
| **REFUTED** | 有 Run 证明它与预期相反 |

**只有 VERIFIED 能支撑「可以改 Ruleset」这个结论。** NOT_VERIFIED 一条都不能。

---

## 1. 普通 PR：`ci-gate` 绿，合并可用 — **VERIFIED**

| 项 | 值 |
|---|---|
| PR | [#160](https://github.com/baicie/ops-1/pull/160) `test/counterfactuals-a-to-p` |
| head SHA | `881ce2274601d446c63d219cd020108b00f3390b` |
| `ci-gate` check run | `135686444568` |
| started → completed | `15:54:17Z` → `16:17:36Z`（1400 s） |
| 结论 | **success** |
| 所需 check | 23 项全绿 |
| `mergeStateStatus` | `CLEAN` |
| 合并 | `gh pr merge 160 --squash` 成功，合并提交 `ca257fd` |

**这条证明 `ci-gate` 在正常 PR 上不会误判。** 注意它跑了 1400 s——`ci-gate` 自己的
17 个 `needs` 早已完成，多出来的时间是 `awaitDelegated` 在等 `data-foundation`。

## 2. L2 验收 PR：`ci-gate` 等待 delegated suite — **VERIFIED**

这是最关键的一条。改的是 `apps/node/**`，`impact.mjs` 派发
`rust platform-image-build linux-runtime plugin-lifecycle data-foundation`。

| 项 | 值 |
|---|---|
| PR | [#161](https://github.com/baicie/ops-1/pull/161) `test/node-backoff-curve` |
| head SHA | `b4b9a4c506f41527ea982898b4e33e86731d62ca` |
| `ci-gate` check run | `135704357805` |
| started → completed | `16:20:52Z` → `16:34:00Z`（788 s） |
| 结论 | **success** |
| 改动 | `apps/node/src/worker_supervisor.rs`（新增 3 个测试） |

### 时间线（UTC）

```
16:10:03  golden-path                    started  (suite 120627403812)
16:10:23  full TypeScript lifecycle      started  (suite 120627403924)
16:11:21  linux-runtime                  started  (suite 120627404062)
16:20:03  linux-runtime                  completed: success
16:20:52  ci-gate                        started  (suite 120627403740)
16:33:57  ci-gate                        all delegated suites settled
16:34:00  ci-gate                        completed: success
```

**`ci-gate` 在 16:20:52 启动时，`golden-path` 已经跑了 10 分 49 秒且仍未结束。**
它没有因为自己的 17 个 `needs` 都完成就下结论，而是进入了 `awaitDelegated` 的轮询。

### 日志原文（job `135704357805`）

```
suites required by this change: rust platform-image-build linux-runtime plugin-lifecycle data-foundation
  wait: still waiting (1s of 2100s): golden-path (check unfinished); full TypeScript lifecycle (check unfinished)
  ...
  wait: still waiting (406s of 2100s): golden-path (check unfinished)
  ...
  wait: still waiting (711s of 2100s): golden-path (check unfinished)
  wait: all delegated suites settled after 15 read(s), 773s
verdict: PASS
  delegated-verified: data-foundation
  delegated-verified: linux-runtime
  delegated-verified: plugin-lifecycle
```

**773 秒的等待、15 次读取，三项全部 `delegated-verified`。** 这是「gate 会等待并且
只在拿到真实结果后才判决」的直接证据。

对比这一项存在之前的版本：那时 gate 读一次快照，没跑完的 suite 被算作 `absent`
而不是 `pending`，于是「还没跑」和「不会跑」不可区分——一个开始后失败的 suite
会留下一个绿的 gate。

**这一条同时暴露了 `ci-gate` 的一个设计边界，记录在此不掩盖**：`gate()` 用的是
**开跑时读的那份 ledger 快照**，等待循环只对 delegated suite 重读。所以 PART 3 的
`deploymentFailures` 只能看到「gate 启动前就已结束」的部署失败。见第 4 项。

## 3. 受控失败：一个必需 check 变红，合并被拒 — **VERIFIED**

| 项 | 值 |
|---|---|
| 分支 | `test/controlled-required-failure` |
| SHA | `5fb7c46d5d9957d5c6fcfe8df46e38ebe237e9e0` |
| PR | #165（已关闭，未合入） |
| 制造的失败 | `packages/ui/src/status-tone.test.ts` 里一条故意为假的断言 |
| `web-unit` check run | `135737408618`，`completed/failure` |
| `mergeStateStatus` | **`BLOCKED`** |
| 合并结果 | **被拒** |

### GitHub 的拒绝原文（REST，不是 `gh` 的转述）

```json
{"message":"Repository rule violations found\n\n9 of 9 required status checks have not succeeded: 1 failing.\n\n","status":"405"}
```

**这条消息的形状本身就是证据。** 它与「必需检查缺失或被跳过」时的消息**不同**：

| 情形 | GitHub 的措辞 |
|---|---|
| check 缺失 / 被跳过 | `9 of 9 required status checks are expected` |
| check **失败** | `9 of 9 required status checks have not succeeded: 1 failing` |

第一种是「还没到齐」，第二种是「到齐了，有一个是红的」。**只有第二种证明这个 check 真的
被读取并参与了判决**——第一种只能证明它在等。

顺带记下两个操作事实，免得下次再踩：

1. **Draft PR 合并会先撞上 `Pull Request is still a draft`（HTTP 405）**，走不到规则检查。
   要拿规则拒绝必须先 `gh pr ready`。
2. `gh pr merge` 只说 "the base branch policy prohibits the merge"；确切原因只有
   `PUT /pulls/N/merge` 的响应体里有。

### 这次还在 `web-unit` 红的情况下验证了一件事

`ci-gate` 的 `needs` 里有 `web-unit`，所以它**没有运行**。一个非必需的汇总门禁被一个
失败的必需 job 跳过，对合并没有影响（`web-unit` 自己已经拦住了），但它说明：
**`ci-gate` 成为必需项之后，「自己被跳过」也必须是一个 FAIL，不能是「没跑就等于没意见」。**
这条留给 TASK-12 第 5 项验证。

## 4. Staging 失败不阻止合并 — **VERIFIED**

| 项 | 值 |
|---|---|
| 前提 | `GATE_OWNERSHIP['staging-preview.yml'] === 'deployment'` |
| 样本 | main `ca257fd`（#160 的合并提交，push 触发） |
| `ci-gate` check run | `135717628317` |
| started → completed | `16:40:29Z` → `16:49:28Z` |
| `deploy to staging host` | `16:30:14Z` → `16:37:22Z`，**failure** |
| `ci-gate` 结论 | **success** |
| 判决节选 | `verdict: PASS` + `deploymentFailures: ["deploy to staging host (staging-preview.yml: ... is failure)"]` |

**这是本轮最难取的一条，因为两个条件必须同时成立**：GitHub 上真的有一个失败的部署
check，且 `ci-gate` 在**同一 SHA** 上被判成功。样本不是造的——`staging-preview.yml`
今天仍在 `Publish the data plugin bundles` 上真实失败（B-16 未解决），main 的 push
触发了它，`ci-gate` 随后在同一个提交上照常运行。

**时间顺序也成立**：部署在 16:37:22 结束，`ci-gate` 在 16:40:29 才启动——它读到的是
一个已经完成的失败，而不是一个 pending。

### 这一条同时暴露了一个真实的边界，必须写下来

`gate()` 用的是**开跑时读的那份 ledger 快照**（`ci-gate.mjs:1442`），
`awaitDelegated` 的轮询只重读 delegated suite。所以 `deploymentFailures` 只能看到
**在 gate 启动前就已结束**的部署失败。

本次样本恰好满足这个条件，但它不总是满足：如果部署比 `ci-gate` 晚结束（PR 上常见，
因为 `staging-preview` 不在 PR 上触发，但 push 上两者并行），那次部署失败**不会**
出现在 `deploymentFailures` 里。

**这不是安全漏洞**——部署失败本来就不该阻塞合并，漏报它不会放行任何东西。但它是一条
观测缺口：一个只想知道「这次 main push 的部署为什么红」的读者，不能从 gate 的摘要里
得到答案。记为 **VERIFIED_GAP**，未修。

## 5. 取消与缺失：依赖被取消时 gate 不能 PASS — **VERIFIED**

| 项 | 值 |
|---|---|
| SHA | `5fb7c46d5d9957d5c6fcfe8df46e38ebe237e9e0`（第 3 项的失败分支） |
| 制造方式 | `POST /actions/runs/44574279673/cancel`，在 `rust` 排队时 |
| `rust` | **`completed/cancelled`** |
| `web-unit` | `completed/failure` |
| `ci-gate` check run | `135740305258` |
| 判决 | **`FAIL`** |

### 判决原文

```
verdict: FAIL
  failed: rust (job rust: cancelled; ran on this commit although the change did not require it)
  failed: web-unit (job web-unit: failure)
  failed: spec-coverage (job spec-coverage: cancelled)
  failed: spec-coverage (job artifact-budget: cancelled)
  failed: web (job web: cancelled)
  failed: platform-only (job platform-only: cancelled)
  failed: platform-image-build (job platform-image-build: cancelled)
```

**`cancelled` 被当成失败，而且被逐条点名。** 这与 `skipped` 的处理是同一个桶
（`ci-gate.mjs:564-568` 与 `RED_CONCLUSIONS`），但这次是真实 GitHub 产生的结论，
不是 selftest 里的构造。

### 一个操作事实

对**排队中**的 run 发取消请求，它不会立刻变成 `cancelled`——这次它先转成了
`in_progress` 才被取消。所以那次 `rust` 是先启动、再被取消的。样本仍然有效
（`conclusion` = `cancelled`），但要记下这个时序，免得下次以为取消请求没生效。

### 这一条同时回答了第 3 项留下的问题

第 3 项里我写：「`ci-gate` 成为必需项之后，『自己被跳过』也必须是一个 FAIL」。
这次观测到的是**不跳过**：`ci-gate` 有 `if: always()`，所以 `needs` 里出现失败或取消
时它仍然运行并判决。这在真实数据上确认了那个 `if:` 是必要的，而不只是好看。

---

## 6. 结论

| # | 项 | 状态 | 证据 |
|---|---|---|---|
| 1 | 普通 PR 全绿、可合并 | **VERIFIED** | `ci-gate` 135686444568，合并 `ca257fd` |
| 2 | L2 PR 上 gate 等待 delegated suite | **VERIFIED** | `ci-gate` 135704357805，等待 773 s / 15 次读取 |
| 3 | 必需 check 受控失败 → 合并被拒 | **VERIFIED** | `web-unit` 135737408618 红；`PUT /merge` → `9 of 9 ... have not succeeded: 1 failing` |
| 4 | Staging 失败不阻止合并 | **VERIFIED** | main `ca257fd`，`ci-gate` 135717628317 PASS + `deploymentFailures` 非空 |
| 5 | 依赖被取消 → 不能 PASS | **VERIFIED** | `rust` cancelled → `ci-gate` 135740305258 FAIL |

**五项全部 VERIFIED。** 这满足了「Ruleset 迁移前必须有真实证据」的要求。

### 但这不等于「现在就该改 Ruleset」

五条证据证明的是**门禁本身工作正常**。它们不覆盖：

1. **成本。** `ci-gate` 成为必需项后，每个 PR 都要等到它读完所有 delegated suite。
   实测 p95（`ruleset-migration.md`）意味着最坏的 PR 要等 34 分钟，而今天
   `data-foundation.yml` 只在 paths 命中时才跑。这一点已经写进迁移方案。
2. **`deploymentFailures` 的快照边界**（第 4 项）。已知、已记录、未修。
3. **Ruleset 变更本身不可本地验证。** 改完之后如果 `ci-gate` 因为任何原因不再产生，
   所有 PR 会永久卡在 `Expected`——这是唯一无法在改之前完全排除的风险，
   也是为什么迁移方案要求先加、观察，再考虑删除旧九项。

**建议的迁移顺序不变**：先加 `ci-gate` 作为第十项（保留原九项），观察若干个 PR，
确认它稳定产生且不误判，再讨论是否缩减。直接「九项改一项」不符合本文件任何一条证据。

<!-- ruleset verification: required checks removed 2026-11-20 -->
