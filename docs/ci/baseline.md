# CI/CD 基线

**采集时间：2026-11-19。每条数字都附了产生它的命令。**

上一版（2026-11-15，基线 `e3b3ce5`）已经过时：它列了 10 个 workflow，其中包括
`typed-pipeline-runtime.yml`，那个文件现在不存在。本文件取代它。

---

## 1. 仓库状态

```bash
$ git rev-parse HEAD
ec7ff1f6b502a98f59edde96592d044fc015e131
$ git status --short
(空)
$ gh pr list --state open --json number --jq 'length'
0
```

| 项 | 值 |
|---|---|
| repository | `baicie/ops-1` |
| default_branch | `main` |
| main_head_sha | `ec7ff1f` |
| open_pull_requests | 0 |
| 分支 | 只有 `main`（本地与远端各 1） |

## 2. 合并策略

```bash
$ gh api repos/baicie/ops-1 --jq '{allow_merge_commit,allow_squash_merge,allow_rebase_merge,delete_branch_on_merge}'
{"allow_merge_commit":false,"allow_rebase_merge":false,"allow_squash_merge":true,"delete_branch_on_merge":true}
```

只允许 **squash**。这一点影响分支清理：squash 之后分支永远显示 `ahead=0` 而树仍不同，
`git branch -d` 必然拒绝，必须逐文件比对 blob 才能判定已合入（见 `rules/08`）。

## 3. Ruleset

```bash
$ gh api repos/baicie/ops-1/rulesets/26958761 --jq '{name,target,enforcement}'
{"enforcement":"active","name":"main-protection","target":"branch"}
$ gh api repos/baicie/ops-1/rulesets/26958761 \
    --jq '.rules[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context'
rust
web
web-unit
contracts
spec-coverage
platform-only
platform-image-build
quality-faults
linux-runtime
```

**九项，`ci-gate` 不在其中。** 经典 branch-protection API 返回
`404 Branch not protected`（本仓库用 ruleset，不是 classic），REST merge 端点在同一次
失败的合并上返回 `405 ... 9 of 9 required status checks have not succeeded`。

## 4. Workflow 清单

```bash
$ ls -1 .github/workflows/
ci.yml
data-foundation.yml
g12-acceptance.yml
platform-linux-acceptance.yml
plugin-lifecycle.yml
reliability.yml
runtime-conformance.yml
staging-preview.yml
typed-pipeline-contracts.yml
```

**9 个文件，35 个 job。** 上一版文档写了 10 个并包含 `typed-pipeline-runtime.yml`——
那个 workflow 已被移除，本文档不再引用它。任务书里列出的清单同样包含它，属于历史观察。

## 5. Job 矩阵

由 `yaml.safe_load` 遍历 `.github/workflows/*.yml` 生成（`jobs:` 下每个 key，`name:` 存在时
以 `name:` 为 check 名）。

| workflow | job | check 名 | runner | timeout | needs |
|---|---|---|---|---|---|
| ci.yml | scope | scope | ubuntu-latest | 5 | — |
| ci.yml | rust | rust | ubuntu-24.04 | 默认 | — |
| ci.yml | web | web | ubuntu-latest | 默认 | — |
| ci.yml | web-unit | web-unit | ubuntu-latest | 默认 | — |
| ci.yml | zabbix-plugin | zabbix-plugin | ubuntu-latest | 默认 | — |
| ci.yml | b2-plugin-identity | b2-plugin-identity | ubuntu-latest | 默认 | — |
| ci.yml | g13a-roundtrip | g13a-roundtrip | ubuntu-24.04 | 默认 | scope |
| ci.yml | g13a1-gateway | g13a1-gateway | ubuntu-24.04 | 默认 | scope |
| ci.yml | g13b14-claim | g13b14-claim | ubuntu-24.04 | 默认 | scope |
| ci.yml | g13b16-effect | g13b16-effect | ubuntu-24.04 | 默认 | scope |
| ci.yml | g13b17-principal | g13b17-principal | ubuntu-24.04 | 默认 | scope |
| ci.yml | artifact-budget | artifact-budget | ubuntu-latest | 默认 | — |
| ci.yml | spec-coverage | spec-coverage | ubuntu-latest | 默认 | — |
| ci.yml | contracts | contracts | ubuntu-latest | 默认 | — |
| ci.yml | platform-only | platform-only | ubuntu-latest | 默认 | — |
| ci.yml | platform-image-build | platform-image-build | ubuntu-latest | 默认 | — |
| ci.yml | runtime-image-build | runtime-image-build | ubuntu-latest | 40 | scope |
| ci.yml | ci-gate | ci-gate | ubuntu-24.04 | 40 | 17 个 job |
| data-foundation.yml | golden-path | golden-path | ubuntu-24.04 | 45 | — |
| data-foundation.yml | legacy-regression | legacy-regression | ubuntu-24.04 | 45 | — |
| g12-acceptance.yml | acceptance | acceptance | ubuntu-24.04 | 45 | — |
| platform-linux-acceptance.yml | linux-runtime | linux-runtime | ubuntu-24.04 | 60 | — |
| plugin-lifecycle.yml | lifecycle | full TypeScript lifecycle | ubuntu-24.04 | 45 | — |
| reliability.yml | quality-faults | quality-faults | ubuntu-latest | 默认 | — |
| runtime-conformance.yml | conformance | conformance | ubuntu-24.04 | 40 | — |
| staging-preview.yml | plan | plan the run tier | ubuntu-24.04 | 5 | — |
| staging-preview.yml | build | build image | ubuntu-24.04 | 60 | — |
| staging-preview.yml | deploy | deploy to staging host | ubuntu-24.04 | 40 | plan, build |
| staging-preview.yml | smoke | smoke the preview | ubuntu-24.04 | 70 | deploy |
| staging-preview.yml | seeded_studio | seeded-data studio [known-flaky] | ubuntu-24.04 | 20 | deploy |
| staging-preview.yml | seeded_visual_layout | seeded-data visual layout [known-flaky] | ubuntu-24.04 | 20 | deploy |
| staging-preview.yml | seeded_visual | seeded-data visual [known-flaky] | ubuntu-24.04 | 30 | deploy |
| staging-preview.yml | record | record the acceptance evidence | ubuntu-24.04 | 10 | — |
| staging-preview.yml | report | report to pull request | ubuntu-24.04 | 10 | — |
| typed-pipeline-contracts.yml | typed-pipeline-contracts | typed-pipeline-contracts | ubuntu-latest | 默认 | — |

`needs: scope` 的五项都是 **non-required** 的 acceptance job；四个必需 job（`rust`、`web`、
`web-unit`、`platform-image-build`）在 #146 里被改成无条件——它们既无 `if:` 也无 `needs`，
因为「`needs` 里有一项失败则本 job 被跳过」是同一个缺陷的另一条路径。

## 6. 必需性归属

九项必需 check 由谁产出：

| check | workflow | 触发条件 |
|---|---|---|
| `rust` | ci.yml | `pull_request:` 无过滤 → 每个 PR |
| `web` | ci.yml | 同上 |
| `web-unit` | ci.yml | 同上 |
| `contracts` | ci.yml | 同上 |
| `spec-coverage` | ci.yml | 同上 |
| `platform-only` | ci.yml | 同上 |
| `platform-image-build` | ci.yml | 同上 |
| `quality-faults` | reliability.yml | `pull_request:` 无过滤 → 每个 PR |
| `linux-runtime` | platform-linux-acceptance.yml | `pull_request:` 无过滤 → 每个 PR |

（用 `yaml.safe_load` 读出的 `on.pull_request` 对两者都是 `None`，即无 `paths`/`branches`
过滤。这一点必须实测而不能从文档推断：如果其中任何一个带了 `paths`，它的必需检查就会在
不匹配的 PR 上永远不出现，而 GitHub 会以 `9 of 9 required status checks are expected` 拒绝合并。）

**其余 17 个 check 只由 `ci-gate` 的判决约束，而 `ci-gate` 本身不是必需 context。**
这是本仓库当前最重要的结构性事实，展开见 `architecture-proposal.md` 第 2 节与
`ruleset-migration.md`。

## 7. 耗时

```bash
$ gh api "repos/baicie/ops-1/actions/runs?per_page=100" --jq '
  [.workflow_runs[]|select(.status=="completed" and .run_started_at!=null)
   | {p:.path, s:((.updated_at|fromdate)-(.run_started_at|fromdate))}]
  | group_by(.p) | map({wf:(.[0].p|sub("\\.github/workflows/";"")), n:length,
      p50:(map(.s)|sort|.[length/2|floor]),
      p95:(map(.s)|sort|.[(length*95/100)|floor]), max:(map(.s)|max)})'
```

结果（2026-11-19，最近 100 次运行中已完成的）：

| workflow | n | p50 | p95 | max |
|---|---|---|---|---|
| ci.yml | 24 | 1462s | 1826s | 2095s |
| data-foundation.yml | 16 | 1476s | **2040s** | 2040s |
| g12-acceptance.yml | 10 | 965s | 1124s | 1124s |
| platform-linux-acceptance.yml | 19 | 526s | 623s | 623s |
| plugin-lifecycle.yml | 6 | 1083s | 1258s | 1258s |
| reliability.yml | 14 | 135s | 258s | 258s |
| staging-preview.yml | 11 | 811s | 2537s | 2537s |

**这是 `updated_at - run_started_at`，即执行时间，不含排队。** workflow 总耗时包含排队，
把它当代码执行时间会得出错误结论。

`data-foundation` 的 p95 是 **34 分钟**。`ci-gate` 的等待预算原为 30 分钟（`GATE_BUDGET_MS`
从未被赋值，见 B-20），2026-11-19 改为 35 分钟并接上 `vars.OPSWEAVE_GATE_BUDGET_MS`。
