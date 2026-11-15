# CI 架构提案与迁移计划（Phase 0）

本文件是提案，不是已完成的变更。规则集（Ruleset）的修改不在本轮执行范围内，
需要人工审批。

## 目标分层

```
L0  Static & Policy      每个 PR，< 1 分钟
L1  Core CI              每个 PR，5-10 分钟
L2  Impact-Based         按变更触发，10-30 分钟
L3  Full Verification    nightly / release / 手动
```

### L0 — Static & Policy

| 检查 | 现状 | 目标 |
|---|---|---|
| `artifact-budget` | `ci.yml` | 保持 |
| `spec-coverage` | `ci.yml` | 保持（fail-closed 机制不得削弱） |
| `contracts`（schema） | `ci.yml` | 保持 |
| actionlint | **无** | 新增 |
| shellcheck | 分散在 `run_step.sh` 等 | 收拢为一个 job |
| 影响分析器自测 | **无** | 已由 `impact.test.mjs` 提供，待接入 |

### L1 — Core CI

| 检查 | 现状 | 目标 |
|---|---|---|
| `rust` | `ci.yml`（含 DB 断言） | 保持 |
| `web` / `web-unit` | `ci.yml` | 保持 |
| `platform-only` | `ci.yml` | 保持 |
| `platform-image-build` | `ci.yml` | 保持 |
| `quality-faults` | `reliability.yml` | 见下方「门禁归属」 |
| `linux-runtime` | `platform-linux-acceptance.yml` | 见下方「门禁归属」 |

### L2 — Impact-Based

由 `tests/ci/impact.mjs` 决定。当前已有的 suite 全部保留，只是改为**按需触发**而非
「能跑就跑」。

关键要求：**高风险模块变更必须触发对应验收。** 已由 `impact.test.mjs` 的反例覆盖
（kernel gateway → g12-acceptance + data-foundation；node → linux-runtime；
contracts → runtime-conformance）。

### L3 — Nightly / Release

尚未建立。见「未完成」。

## 门禁归属（本轮的关键决策）

现状：9 个必需检查分布在 3 个 workflow。

| 检查 | 产出 workflow |
|---|---|
| rust, web, web-unit, contracts, spec-coverage, platform-only, platform-image-build | `ci.yml` |
| linux-runtime | `platform-linux-acceptance.yml` |
| quality-faults | `reliability.yml` |

`ci-gate` 只能看见 `ci.yml` 内的 job。**它明确声明这一点**，把另外两个标为
`delegated`，而不是假装覆盖。

三个可选方案：

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. 保持现状 + delegated 声明**（本轮采用） | 零风险；Ruleset 不用改；gate 诚实 | gate 不是唯一门禁，Ruleset 仍需单独强制两项 |
| B. 把两个 job 移进 `ci.yml` | gate 单一权威 | `linux-runtime` 429 行，`ci.yml` 会超过 2000 行；check 名不变但归属变了 |
| C. `workflow_run` 聚合 | 目录干净 | **无法检测「某 workflow 被 path filter 跳过」**，事件不会触发；brief 明确禁止 |

**选 A 的理由**：B 的收益是「单一权威」，代价是 `ci.yml` 膨胀成巨型文件，与 brief
「复杂逻辑放脚本」的要求冲突；C 有 brief 明令禁止的语义缺陷。

A 的代价是 Ruleset 仍需保留 `linux-runtime` 与 `quality-faults` 两项——但这正是**当前
状态**，所以 A 是零风险迁移。

## 迁移阶段

### 阶段 A（本轮已做）

- 新增 `ci-gate` job，**不是必需检查**。
- 保留全部 9 个旧必需检查，一个字不改。
- 在真实 PR 上观察 `ci-gate` 的判决。

### 阶段 B（需要人工）

在至少 3 个真实 PR 上同时运行新旧体系，比对：

| 维度 | 判据 |
|---|---|
| 检查覆盖 | `ci-gate` 的 `required` 集合 ⊇ Ruleset 的 9 项（除 delegated） |
| 失败一致性 | 任一必需检查红时，`ci-gate` 必须红 |
| 跳过策略 | 没有 `ci-gate` 绿而某必需检查 skipped 的情况 |
| 总耗时 | `ci-gate` 自身 < 1 分钟 |

### 阶段 C（需要人工批准）

提交 Ruleset 变更方案：

**新增**：`ci-gate`

**保留**：全部 9 项

**移除**：无

即 Ruleset 变成 10 项。`ci-gate` 是**附加**保护，不替代任何现有检查。

### 阶段 D（需要人工执行）

`gh api` 修改 Ruleset 需要管理员权限，本轮不执行。

### 阶段 E（需要人工验证）

- 一个普通 PR：`ci-gate` 绿，可合并。
- 一个高风险 PR（改 `apps/kernel/src/gateway.rs`）：`ci-gate` 列出 delegated 项，绿，可合并。
- 一个故意注入 `cargo fmt` 错误的 PR：`ci-gate` 红，不可合并。

## 回退方案

`ci-gate` 不在 Ruleset 中时，删除 `ci.yml` 里的该 job 即可，无副作用。

一旦加入 Ruleset：从 Ruleset 移除 `ci-gate` 即可回退，其它 9 项不受影响。

## 未完成项

| 项 | 状态 | 原因 |
|---|---|---|
| Nightly workflow | 未建立 | 需要先确定哪些 L3 套件在 nightly 有意义 |
| Release Gate | 未建立 | 依赖 staging 链重构，本轮未动 |
| `staging-preview.yml` 重构 | **未动** | 涉及真实主机与密钥，brief 要求人工批准 |
| Ruleset 修改 | **未做** | brief 明令禁止 |
| actionlint / shellcheck 接入 CI | 未做 | 需要先决定是否把 2 条既有警告清零 |
| Rust / pnpm / Docker 缓存 | 未做 | 需要实测收益，本轮无 Runner 可测 |
| SBOM / Provenance | 未做 | 需要 release 链先存在 |
| `contracts` 同名冲突 | **未修** | 修它需要重命名一个 check，而 Ruleset 里就有 `contracts`；改名会破坏门禁 |

## `contracts` 同名冲突的迁移建议

现状：`ci.yml` 与 `typed-pipeline-contracts.yml` 都产出 `contracts`。

风险：合并时无法知道是哪一个通过的。

建议（需要人工）：

1. 把 `typed-pipeline-contracts.yml` 的 job 名改为 `typed-pipeline-contracts`。
2. Ruleset 保留 `contracts`（schema 校验），**新增** `typed-pipeline-contracts`。
3. 观察一个 PR，确认两者都出现。
4. 之后可考虑把两者合并为一个 job，但那会改变语义，需要单独决定。

本轮不改：改名会让 Ruleset 里的 `contracts` 在新 workflow 上永久 Pending，直到
Ruleset 同步更新——而在没有人工批准的情况下不能动 Ruleset。
