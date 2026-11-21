# 仓库结构与 CI 治理：交付报告

日期：2026-11-21　起点 main：`25f3104`　当前 main：`5ead248`

本文件的每个数字都可以用文末的命令重新得出。**没有测量的收益不写。**

---

## 1. 交付清单

| 项 | Before | After | 依据 |
|---|---:|---:|---|
| 一级目录 | 12（含 `.claude`） | **11** | `git ls-files` 的首段去重 |
| Tracked files | 1452 | **1455** | 增 2 个守卫、2 个自测、1 份报告；减 4 个运行产物 |
| PNG 数量 / 体积 | 410 / 66.18 MB | **410 / 66.18 MB** | **未变，见 §3** |
| Docker context | — | 未测量 | 未做 Docker 相关改动 |
| CI P50 / P95 | 端到端 P50 1983s（n=4） | **未变** | 见 §4 |
| Data Foundation | 1417s | **未变** | 见 §4 |
| Plugin Lifecycle | 998s | **未变** | 见 §4 |
| Runner Minutes | — | 未测量 | 无法在无队列数据时给出可信值 |
| 路径引用错误 | 未知 | **0** | `check-path-integrity`：1297 文件 |
| 测试覆盖 | — | **未下降** | 新增 2 个套件；一个原本不运行的测试被接进 CI |

---

## 2. 结构改善（真实且可验证）

**一级目录 12 → 11。** `rules/` 的十一个文件是文档，迁到 `docs/standards/`，
用 `git mv` 保留历史（git 记录为 R100 重命名）。

`.claude/artifacts/` 下四个 metrics JSON 是 `OBS_OUT` 指错目录的产物，
零引用，已移出索引并加入 `.gitignore`。`.claude/` 本身不再跟踪任何文件。

**这不减少任何 Git 历史体积。** `git mv` 不改变历史，删除四个小 JSON 减少
约 2 KB 的当前树。**结构改善与体积减量是两件事，不能混为一谈。**

---

## 3. 视觉资产：分类了，一个都没删

TASK-04 假设 `artifacts/ui*` 是「正式视觉回归基线」。**这个前提不成立**：
`tests/ui/g14-css-fix-evidence.spec.ts:12` 写明仓库有 **0 个 `toHaveScreenshot`**。

分类实测（`scripts/ci/classify-visual-assets.mjs`）：

| 类 | 含义 | 文件 | 体积 |
|---|---|---:|---:|
| A | spec 会写 | 82 | 11.73 MB |
| B | 文档引用 | 83 | 19.23 MB |
| C | 两者皆无 | 245 | 35.22 MB |

**C 类 245 个文件（35.22 MB）全部保留**，三个理由各自独立成立：

1. **删除不会让任何测试变红**——没有像素基线，所以常规的删除安全证明在这里不可用
2. **`before` 截图不可再生**——`before`/`after` 成对目录共 135 个文件 / 20.68 MB，
   记录的是修改之前那个控制台，那个控制台已经不存在
3. **仓库自己的先例**——`tracked-png-budget.json` 的四次清理都逐项列出了
   「谁引入、被谁取代」，那份清单是删除的前置条件

**所以断言「削减 45% 的仓库体积」是假的。** 没动过一张图。

---

## 4. CI 效率：测量结果与任务书假设相反

> **本节 2026-11-22 已更正。** 原文写「排队开销为零，因此 PR 端到端时间 ≡
> `golden-path` 时长」。前半句是错的，后半句只在 workflow 粒度成立。见下。

### Workflow 级：没有启动偏差（OBSERVED）

按 `headSha + event` 分组（原版按分钟分组，会把同一分钟的两次 push 混成一组）：

```text
span=1701s  longest=1701s  startSkew=0s
span=1426s  longest=1426s  startSkew=0s
span= 482s  longest= 482s  startSkew=0s
```

`startSkew` 是同一 push 内各 workflow 创建时间的跨度。**它测的不是 runner 队列**：
一个 job 在队列里等 90 秒，它的 workflow 的 `created_at` 仍然早于它，所以
`span - longest` 完全看不到排队。

### Job 级：排队是真实的，最长超过 10 分钟（OBSERVED）

`node scripts/ci/ci-cost.mjs queue --limit 40`（`started_at - created_at`）：

| job | n | p50 | p90 | max |
|---|---:|---:|---:|---:|
| `zabbix-plugin` | 8 | 41s | 627s | 627s |
| `web-unit` | 8 | 19s | 494s | 494s |
| `artifact-budget` | 9 | 12s | 480s | 480s |
| `spec-coverage` | 8 | 6s | 468s | 468s |

（这个区间还包含 `needs:` 等待，所以它是排队的**上界**。）

### 所以「不可能更快」这个结论被撤回

原文说「任何不缩短 `golden-path` 的优化，对完成时间的影响都是零」。正确的说法是：

- `golden-path` 仍是**最长**的那条 workflow，所以它决定 PR 的完成时刻；
- 但**是 workflow 级别的结论**，不是「其他优化没用」；
- job 排队本身是真实成本，减少 job 数或缩短 job 时长都可能改变实际等待。

### `golden-path` 的构成

`data_foundation_ci.sh` 占 **1330s / 1345s（97%）**，其中前四个 step 占脚本 52%，
等的是**租约 TTL 60s、节点租约 30s**。脚本注释记录过一次用 `sleep 75` 提速的尝试
及它的失败：「抬高数字去跑赢竞态并没有消除竞态，只是把它挪走了」。

### `full TypeScript lifecycle` 的构成

测试 884s（89%），缓存与安装 24s（2.4%）。TASK-15 列的六项缓存优化**全做到上限是 24 秒**。

### 为什么没提提速方案

缩短关键路径只有三条路，都需要产品决策：改租约 TTL（改故障检测行为）、
把长时间常数测试移出门禁（降覆盖，需 ADR）、并行化脚本内部 step
（六个场景共用一个 worker 和数据库，未测量）。

**编一个「快 20%」比不优化更糟**——它会让下一次真正的性能回归失去基准。

### 唯一落地的 CI 改动

Maven Central **429 退避重试**（`#188`）。这不是提速，是可靠性：
`legacy-regression` 连续两次 `status: 429`，加 `retryHandler.count=4` 后第三次通过（6m21s）。
**随机变红会触发重跑，重跑才是真正的 Runner Minutes 浪费。**

---

## 5. 新增守卫（这是本轮最实在的产出）

| 守卫 | 抓什么 | 首次运行的成果 |
|---|---|---|
| `check-path-integrity.mjs` | 九类路径引用（含真实 Docker build context） | 38 条全是自己的 bug，逐条修掉后 0；顺带发现 `rules/README.md` 漏索引 8 个规则 |
| `check-paths-filters.mjs` | 134 条 `paths:` 条目是否匹配树 | **抓到 `tests/acceptance/g11_*.sh`——一个从未存在过的文件** |
| `check-standards-location.mjs` | 规则索引完整、入口文档指向新位置、无残留副本 | 三条失败模式各一条反事实 |
| `check-root-hygiene.mjs` | 未批准的顶层项、误入的构建产物、残留文件 | 7 条自测 |
| `scripts/ci/ci-cost.mjs` | CI 耗时统计 | 本报告全部性能数字的来源 |
| `scripts/ci/classify-visual-assets.mjs` | PNG 按用途分类 | §3 的表格 |

**每一个都做过变异测试**：故意破坏一处，检查器变红。

---

## 6. 发现但未修的问题

| 问题 | 为什么没修 |
|---|---|
| 28 个 `git ls-files` 索引项没有对象（`docs/assets/0.0.4/**`） | 需要单独确认后 `git rm --cached`，且要查清有无依赖 |
| 245 个 C 类 PNG（35.22 MB） | 见 §3 |
| `scripts/` 内部分层（TASK-06） | 每个脚本都有调用者，`plugin-lifecycle.yml` 用精确路径 filter；移动的失败形态是 workflow 静默停止触发。改为 `scripts/README.md` 文档化 |
| `check-*.mjs` 归入 `scripts/verify/` | 同上：8 处引用 + 4 条 filter 条目，收益只是目录整齐 |
| 剩余 CI 提速 | 见 §4 |

---

## 7. 需要授权才能做的

1. **删除 C 类 PNG**——需要逐目录确认对应阶段的验收文档已完成
2. **缩短租约 TTL**——产品行为变更
3. **把长时间常数测试移出 PR 门禁**——需要 ADR
4. **清理 28 个悬空索引项**

---

## 复现

```bash
# 结构
git ls-files | awk -F/ 'NF>1{print $1}' | sort -u | wc -l
git ls-files -s '*.png' | awk '{print $2}' | git cat-file --batch-check \
  | awk 'NF==3 {s+=$3;n++} END {printf "%d files %.2f MB\n", n, s/1048576}'

# 守卫
node tests/ci/check-path-integrity.mjs
node tests/ci/check-paths-filters.mjs
node tests/ci/check-standards-location.mjs
node tests/ci/check-root-hygiene.mjs

# CI 耗时
node scripts/ci/ci-cost.mjs jobs --workflow data-foundation.yml --limit 20
node scripts/ci/ci-cost.mjs e2e --limit 30

# 视觉资产
node scripts/ci/classify-visual-assets.mjs
```
