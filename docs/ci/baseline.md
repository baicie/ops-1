# CI/CD 基线（Phase 0）

本文件记录审计时的事实。所有数字来自 GitHub Actions API 与仓库实际文件，
采集时间 2026-11-15。

## 仓库状态

| 项 | 值 |
|---|---|
| repository | `baicie/ops-1` |
| default_branch | `main` |
| main_head_sha | `e3b3ce5b0892ce3e84fec3b72b17a8fbe29d5265` |
| 审计时本地 HEAD | 与 main 相同，工作树干净 |
| open_pull_requests | 0 |
| 本地/远端分支 | 各 1（`main`） |

## Ruleset

Ruleset `26958761`（`main-protection`，target: branch）：

| 规则 | 值 |
|---|---|
| `deletion` | 禁止删除 |
| `non_fast_forward` | 禁止强推 |
| `required_linear_history` | 只允许线性历史 |
| `pull_request` | 必须走 PR |
| `strict_required_status_checks_policy` | **true** — 每次 main 前进都使其它 PR 失去绿 |

必需检查（9 项）：

```
rust  web  web-unit  contracts  spec-coverage
platform-only  platform-image-build  quality-faults  linux-runtime
```

## Workflow 清单

| Workflow | PR 触发 | 路径过滤 | 产出必需检查 |
|---|---|---|---|
| `ci.yml` | 全部 PR | 无 | rust, web, web-unit, contracts, spec-coverage, platform-only, platform-image-build（+ 7 个非必需 job） |
| `platform-linux-acceptance.yml` | 全部 PR | 无 | **linux-runtime** |
| `reliability.yml` | 全部 PR | 无 | **quality-faults** |
| `typed-pipeline-contracts.yml` | 有 | 2 条 | `contracts`（**与 ci.yml 同名**） |
| `data-foundation.yml` | 有 | 11 条 | 无 |
| `typed-pipeline-runtime.yml` | 有 | 15 条 | 无 |
| `plugin-lifecycle.yml` | 有 | 19 条 | 无 |
| `runtime-conformance.yml` | 有 | 8 条 | 无 |
| `g12-acceptance.yml` | 有 | 29 条 | 无 |
| `staging-preview.yml` | 无（push main） | — | 无 |

**5 个 workflow 产出的 check 不是必需门禁**：`data-foundation`、`typed-pipeline-runtime`、
`plugin-lifecycle`、`runtime-conformance`、`g12-acceptance`。
它们失败时 PR 仍可合入。

## 实测耗时（main 上的成功运行，n=5 取中位数）

| Workflow | 中位墙钟 (s) | 最小 | 最大 |
|---|---|---|---|
| `staging-preview` | 1186 | 864 | 1279 |
| `plugin-lifecycle` | 1067 | 1029 | 1197 |
| `platform-linux-acceptance` | 590 | 490 | 912 |
| `ci` | 393 | 304 | 1456 |
| `runtime-conformance` | 265 | 232 | 487 |
| `reliability` | 131 | 126 | 247 |
| `typed-pipeline-contracts` | 47 | 16 | 481 |

单 job 耗时（最近一次运行，秒）：

| Workflow / Job | 秒 |
|---|---|
| `typed-pipeline-runtime` / runtime-golden-path | **1502** |
| `data-foundation` / golden-path | **1051** |
| `data-foundation` / legacy-regression | 367 |
| `ci` / platform-image-build | 345 |
| `ci` / g13a1-gateway | 244 |
| `ci` / platform-only | 239 |
| `ci` / rust | 189 |
| `ci` / web | 48 |

## 最近 100 次运行的结果分布

| Workflow | n | success | failure |
|---|---|---|---|
| `reliability` | 19 | 19 | 0 |
| `platform-linux-acceptance` | 18 | 18 | 0 |
| `ci` | 18 | 18 | 0 |
| `typed-pipeline-runtime` | 13 | 11 | 2 |
| `data-foundation` | 12 | 9 | 3 |
| `runtime-conformance` | 5 | 5 | 0 |
| `plugin-lifecycle` | 5 | 5 | 0 |
| `staging-preview` | 5 | 5 | 0 |
| `typed-pipeline-contracts` | 5 | 5 | 0 |

**观察到的失败全部集中在两个重型 acceptance workflow**，且同一 SHA 常常在两个
workflow 上同时失败——见 `failure-analysis.md`。

## 采集方式

```bash
gh run list --limit 100 --json databaseId,workflowName,conclusion,createdAt,updatedAt,headSha,event
gh run view <id> --json jobs --jq '.jobs[]|...'
```

Workflow 总耗时包含排队时间；上表的 job 级耗时为 `completedAt - startedAt`，
不含排队。两者不可混用——本文件已分开记录。
