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

## 3. 受控失败：一个必需 check 变红，合并被拒

| 项 | 值 |
|---|---|
| 方式 | 待定 |
| 预期 | `mergeStateStatus: BLOCKED`，`gh pr merge` 失败 |
| 结论 | 待做 |

**做法**：在一个临时分支上让 `web-unit` 真失败（不是跳过、不是改 timeout），
尝试合入，记录 GitHub 的拒绝原文。这需要一次真实的反例，不能靠推断。

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

## 5. 取消与缺失：依赖被取消时 gate 不能 PASS

| 项 | 值 |
|---|---|
| 方式 | 待定 |
| 预期 | `ci-gate` FAIL，判决文本含 `delegated-…` |
| 结论 | 待做 |

Selftest 里有 `rust cancelled` → FAIL 的反例，但那是本地函数级证明。
**真实 GitHub 上取消一个运行中的 delegated suite，`ci-gate` 的行为没有观测过。**

这是五项里唯一还没有真实样本的一项，也是 TASK-13（rerun 竞态）要回答的同一类问题。

---

## 6. 结论

| # | 项 | 状态 |
|---|---|---|
| 1 | 普通 PR 全绿、可合并 | **VERIFIED** |
| 2 | L2 PR 上 gate 等待 delegated suite | **VERIFIED** |
| 3 | 必需 check 受控失败 → 合并被拒 | 待做 |
| 4 | Staging 失败不阻止合并 | **VERIFIED**（附一条观测缺口） |
| 5 | 依赖被取消 → 不能 PASS | 待做 |

**五项里三项 VERIFIED、两项未做。** Ruleset 从九项改成「仅 `ci-gate`」还需要第 3、5 两项。

第 3 项的做法已经明确：在一个临时分支上让一个必需 job 真失败，尝试合并，记录 GitHub
的拒绝原文。第 5 项需要一个真实被取消的 delegated suite。
