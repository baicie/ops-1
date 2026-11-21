# 仓库结构与 CI 成本审计（PR-A）

测量日期：2026-11-21　基线 main：`25f3104`

本文件只记录**已测量**的数字。每一条都能用文末的命令重新得出，方法见
`tests/ci/check-path-integrity.mjs` 与 `scripts/ci/ci-cost.mjs` 的注释。

---

## 1. 资产盘点（TASK-01）

```text
tracked files            1452 条 (git ls-files)
tracked blobs            1436 个对象，78.58 MB
其中 PNG                 410 个文件，66.18 MB   ← 占全部跟踪内容的 84%
```

**PNG 占仓库跟踪内容的 84%**，这是本次治理最重要的一个数字。它不是「约 410 张、
71.55 MB 的预算」，而是实测 410 张 66.18 MB，预算余量只有 5.37 MB。

按目录：

| 目录 | 文件数 | 说明 |
|---|---|---|
| `artifacts/ui` | 426 | UI 视觉基线（部分未跟踪） |
| `artifacts/ui-admin-shell-v2` | 15 | 受跟踪 |
| `artifacts/ui-baseline` | 9 | 受跟踪 |
| `docs/assets/**` 下的 PNG | — | 文档截图 |

### 已撤回：所谓「28 个索引项没有对应对象」是测量错误

本文初版说 `docs/assets/0.0.4/**` 有 28 个索引项缺少对象，并建议
`git rm --cached`。**这个说法是错的，不要执行任何清理。**

2026-11-22 在两个干净 clone（浅克隆与完整克隆各一）里复核：

```
git ls-tree HEAD docs/assets/0.0.4/hardening/job-detail.png
  100644 blob faa9be10...  docs/assets/0.0.4/hardening/job-detail.png
git cat-file -t faa9be10...   -> blob            # 对象存在
工作树文件                      -> 148997 bytes   # 文件存在
```

全树扫描（1461 条路径，逐条 `git cat-file -e HEAD:<path>`）：**零缺失**，
且索引条目数与 tree 条目数一致（1461 = 1461）。

**原始错误的原因**：那条命令在 clone 内部用 `git ls-files` 的输出喂给
`git cat-file --batch-check`，而 `ls-files` 读的是本地索引；索引里的 mtime
与对象库状态在一棵刚克隆的树上并不保证同步，路径被当成「不是对象名」交给
batch-check，于是全部报 `missing`。**这是把「我查错了」写成了「仓库坏了」。**

教训与 §6 的其他条目同类：一个测量结论必须能在干净环境里复现，否则它只是
一次观察，不是事实。

### 一级目录

12 个受跟踪的一级条目（含 `.claude`、`.github`）：

```text
.claude .github apps artifacts contracts crates deployments docs
packages plugins rules scripts tests
```

外加根文件 `AGENTS.md CHANGELOG.md CONTRIBUTING.md Cargo.* LICENSE Makefile
README.md SECURITY.md package.json pnpm-*`。

`target/`、`dist/`、`data/`、`data-ci/`、`data-test/`、`keys/`、`test-results/`、
`.blueprint/` 在工作树里存在但**不被跟踪**（`.gitignore` 覆盖）。

---

## 2. CI 性能基线（TASK-13）

样本：最近 20 次成功 run 的 job 级耗时，按 job 名聚合。

| workflow | job | n | P50 | P90 | max |
|---|---|---:|---:|---:|---:|
| data-foundation | golden-path | 12 | **1417** | 1428 | 1477 |
| plugin-lifecycle | full TypeScript lifecycle | 19 | **998** | 1021 | 1063 |
| ci | ci-gate | 9 | 665 | 1167 | 1167 |
| platform-linux-acceptance | linux-runtime | 20 | 522 | 622 | 640 |
| data-foundation | legacy-regression | 12 | 396 | 430 | 451 |
| ci | platform-image-build | 9 | 337 | 351 | 351 |
| ci | runtime-image-build | 5 | 257 | 275 | 275 |
| ci | g13a1-gateway | 9 | 224 | 312 | 312 |
| ci | platform-only | 9 | 209 | 235 | 235 |
| ci | rust | 9 | 168 | 190 | 190 |

**PR 端到端**（一次 push 触发的全部 workflow，从最早创建到最晚结束）：

```text
n=4   P50=1983s   P90=2623s
```

这四个样本的 P50 远高于最大单 job 的 1417s，因为 `ci-gate` 必须等
`data-foundation` 与 `plugin-lifecycle` 都结束后才能判决——**关键路径是
`golden-path → ci-gate`**，不是任何单条 workflow。

### 为什么不能把 job 时长相加

一次 push 成功 job 的耗时之和约 4500–6000s，而真实端到端是 1470–2623s。
并行 job 重叠，相加得到的是一个比墙钟更大的数字。本文件的端到端数字全部来自
`createdAt`/`updatedAt` 的跨度，不是求和。

---

## 3. `golden-path` 内部拆解（TASK-14）

单个 job 的 step 级耗时：**`data_foundation_ci.sh` 占 1330s / 整个 job 1345s（97%）**。
准备步骤（checkout、postgres client、playwright、rust-cache 各 1–15s）合计不到 15s。

所以优化只能发生在脚本内部。脚本自身在日志里输出 `STEP result=… secs=N`，
按此聚合 4 次运行：

| step | P50 | 占脚本总时长 |
|---|---:|---:|
| `pipeline_long_heartbeat_negatives` | 196s | 18.2% |
| `pipeline_long_heartbeat` | 166s | 15.4% |
| `pipeline_orphan_worker` | 107s | 9.9% |
| `supervisor_lifecycle` | 96s | 8.9% |
| `pipeline_node_runtime_sigkill` | 81s | 7.5% |
| `pipeline_heartbeat_ttl_takeover` | 76s | 7.0% |

**前四项合计 52%。** 其余 36 个 step 每个都在 70s 以下。

### 这些耗时的性质

含 `long`、`heartbeat`、`ttl`、`takeover` 的步骤是在等**真实的超时窗口**：
租约 TTL 是 60s，节点租约 30s。它们的注释明确写了「这里不能改成 sleep 75，
那只是把竞态挪了个位置」。这些时间**不是浪费**，是把系统的时间常数跑一遍。

因此本文件的结论是：**`golden-path` 的 52% 无法在不降低覆盖的前提下压缩。**
任何声称能把它砍掉一半的方案，要么缩短系统的 TTL（改产品行为），要么跳过这些
场景（降覆盖）。本轮**不提议**这两件事。

可压缩的部分在剩下的 48% 里，且多数 step 已在 10s 以下，收益上限有限。

---

## 4. 路径完整性（TASK-02 / TASK-32）

新增 `tests/ci/check-path-integrity.mjs`，解析九类引用：Cargo workspace 成员与
path 依赖、pnpm workspace 与 `--filter`、Dockerfile COPY（**按真实 build context**）、
Compose 构建路径与绑定挂载、workflow 的 `run:` 脚本调用与 `working-directory`、
Makefile 调用、Rust `include_str!/include_bytes!`、rules 索引。

**首次运行 38 条，全部是检查器自己的误报**，逐条修正后归零：

| 误报原因 | 修正 |
|---|---|
| 把 Dockerfile 所在目录当作 build context | 从 `docker build` 调用点解析 context |
| context 是 shell 变量（`"$dir"`）时猜成仓库根 | 未知即跳过并计数，不猜 |
| `--target platform` 的 `platform` 被当成 context | 成对剥离 `--flag value` |
| `\|\| { echo …; }` 的后半段被当成参数 | 在 `\|\|`/`&&`/`;` 处截断 |
| 续行 `\` 导致 context 在下一行 | 先拼接续行 |
| YAML 注释里的 `docker build` 被当成调用 | 跳过注释行 |
| `tests/ci/tracked-png-budget.json` 被截成 `.js` | 词边界匹配 |

**过程中发现一个真实缺陷并已修复**：`rules/README.md` 只索引了 `09`–`11`，
`01`–`08` 八个规则文件在根目录存在却不可达。一条没人能发现的规则等于没有规则，
所以检查器把它作为失败项，而不是警告。

### 检查器不是空的（变异测试）

| 变异 | 结果 |
|---|---|
| `Cargo.toml` 成员改成 `crates/contracts-DELETED` | 9 条（原 8），命中 |
| `data-foundation.yml` 调用的脚本改名 | 9 条，命中 |
| 插件 Dockerfile 的 `COPY server.mjs` 改错名 | 1 条，命中 |

最后一条是展开 `$name` 之后才可能做到的：**此前 12 个插件 Dockerfile 全部被
跳过**，等于没检查。

当前：**0 problem / 1290 文件 / 0 个无法解析的 Dockerfile context**。

---

## 5. 本 PR 未做的事

- **没有移动任何文件。** 迁移必须先有守卫，守卫现在有了（本 PR），迁移在后续 PR。
- ~~28 个悬空索引项~~ **已撤回**：见上，那是测量错误，仓库没有损坏。
- **没有提出任何 CI 提速方案**：`golden-path` 的 52% 是系统时间常数，其余 48% 里
  多数 step 已在 10s 以下。任何提速要先证明不降覆盖。
- **PNG 的 66.18 MB 未动。** 移动目录不会减少任何字节，删除基线会关掉 UI 断言，
  两者都不是优化。

---

## 复现方式

```bash
# 资产体积（按索引对象，不是按工作树）
git ls-files -s '*.png' | awk '{print $2}' | git cat-file --batch-check \
  | awk 'NF==3 {s+=$3; n++} END {printf "%d files %.2f MB\n", n, s/1048576}'

# CI 耗时基线
node scripts/ci/ci-cost.mjs jobs --workflow data-foundation.yml --limit 20
node scripts/ci/ci-cost.mjs e2e --limit 30

# golden-path 内部 step 耗时
gh run view <run> --log | grep -oE "STEP result=PASS name=[a-z0-9_]+ .*secs=[0-9]+"

# 路径完整性
node tests/ci/check-path-integrity.mjs
```
