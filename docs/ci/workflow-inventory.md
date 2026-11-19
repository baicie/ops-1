# Workflow 清单

**采集时间 2026-11-19，基线 `ec7ff1f`。9 个文件，35 个 job。**

上一版本文件基于 `e3b3ce5`，列了 10 个 workflow 并包含 `typed-pipeline-runtime.yml`。
那个文件已从仓库移除；本文件不再引用它。任务书的清单同样包含它（历史观察），这一点在
`baseline.md` §4 已注明。

---

## ci.yml — 18 个 job

**触发**：`pull_request:`（无过滤）、`push:`

**权限**：workflow 级 `contents: read`；`ci-gate` 额外要 `checks: read` 与 `actions: read`。

| job | check | 性质 | 依赖 |
|---|---|---|---|
| `scope` | `scope` | 决定哪些重型 job 跑 | — |
| `rust` | **`rust`** | 必需 | 无（#146 起无 `if:` 也无 `needs`） |
| `web` | **`web`** | 必需 | 无 |
| `web-unit` | **`web-unit`** | 必需 | 无 |
| `contracts` | **`contracts`** | 必需 | — |
| `spec-coverage` | **`spec-coverage`** | 必需 | — |
| `platform-only` | **`platform-only`** | 必需 | — |
| `platform-image-build` | **`platform-image-build`** | 必需 | 无 |
| `runtime-image-build` | `runtime-image-build` | gate-only | `scope` |
| `zabbix-plugin` | `zabbix-plugin` | gate-only | — |
| `b2-plugin-identity` | `b2-plugin-identity` | gate-only | — |
| `g13a-roundtrip` | `g13a-roundtrip` | gate-only | `scope` |
| `g13a1-gateway` | `g13a1-gateway` | gate-only | `scope` |
| `g13b14-claim` | `g13b14-claim` | gate-only | `scope` |
| `g13b16-effect` | `g13b16-effect` | gate-only | `scope` |
| `g13b17-principal` | `g13b17-principal` | gate-only | `scope` |
| `artifact-budget` | `artifact-budget` | gate-only | — |
| `ci-gate` | `ci-gate` | **汇总门禁，本身非必需** | 17 个 job，全部 |

**关键事实**：`ci-gate` 读取全部 17 个 job 的结果，并用 check-run API 按
`check_suite.id ↔ workflow_runs[].check_suite_id` 归属其它 workflow 的产物。它有
35 分钟的有界等待（`GATE_BUDGET_MS`，最近才真正接线），超时即 FAIL。

**但 `ci-gate` 不在 ruleset 的九项里。** 所以它判红时合并仍可进行——见
`architecture-proposal.md` §2。

## data-foundation.yml — 2 个 job

**触发**：`workflow_dispatch:`、`push:`（带 paths）、`pull_request:`（带 paths）

| job | check | 性质 |
|---|---|---|
| `golden-path` | `golden-path` | gate-only，42 步 harness |
| `legacy-regression` | `legacy-regression` | gate-only |

`golden-path` 执行 `tests/ci/data_foundation_ci.sh`，45 个 `run_step`，间接调用 **39** 个
`tests/acceptance/*.sh`。含 4 个 Playwright spec（`RUN_BROWSER_SMOKE=1`）。

`legacy-regression` 跑 `e2e_platform.sh`，其中包含蓝绿断言
（`10/10 requests left v1 while v2 was not activated`）——ADR-027 第一版就是被这条抓住的。

## g12-acceptance.yml — 1 个 job

**触发**：`workflow_dispatch:`、`pull_request:`、`push:`

| job | check |
|---|---|
| `acceptance` | `acceptance`（gate-only） |

跑 `tests/ci/g12_acceptance_ci.sh`，含 Gateway/capability/evidence 验收与 Playwright。

## platform-linux-acceptance.yml — 1 个 job

**触发**：`pull_request:`（无过滤）、`push:`、`workflow_dispatch:`

| job | check |
|---|---|
| `linux-runtime` | **`linux-runtime`**（必需） |

**这是九个必需 check 里唯一不在 `ci.yml` 的两个之一**（另一个是 `quality-faults`）。
`ci.yml` 的 `platform-only` job 里有一道守卫，断言这个 workflow 的 `pull_request` 不得带
`paths:`——否则某些 PR 上这项必需检查永不出现，合并永远卡在 `Expected`。

## plugin-lifecycle.yml — 1 个 job

**触发**：`workflow_dispatch:`、`push:`（paths）、`pull_request:`（paths）

| job | check |
|---|---|
| `lifecycle` | **`full TypeScript lifecycle`**（gate-only） |

注意 **check 名与 job id 不同**：`lifecycle` 声明了 `name: full TypeScript lifecycle`。
`ci-gate` 的 `DELEGATED_CHECK_OWNERS` 记录的是这个名字。

运行 `p001c13_lifecycle.sh`、`p001c13_negatives.sh`、`p001c_multilang_lifecycle.sh`——
真实 OCI：build → sign → install → deploy → upgrade → rollback → uninstall。

## reliability.yml — 1 个 job

**触发**：`pull_request:`（无过滤）、`push:`

| job | check |
|---|---|
| `quality-faults` | **`quality-faults`**（必需） |

## runtime-conformance.yml — 1 个 job

**触发**：`workflow_dispatch:`、`push:`（paths）、`pull_request:`（paths）

| job | check |
|---|---|
| `conformance` | `conformance`（gate-only） |

TypeScript / Go / Java 三种语言的同一个协议黑盒测试。**这是唯一能支撑「全语言 PASS」
这一说法的入口**——三种语言都在同一次 job 里跑。

## staging-preview.yml — 9 个 job

**触发**：`push:`（带 paths）、`schedule:`（`17 3 * * *` UTC）、`workflow_dispatch:`

| job | check | 依赖 |
|---|---|---|
| `plan` | `plan the run tier` | — |
| `build` | `build image` | — |
| `deploy` | `deploy to staging host` | plan, build |
| `smoke` | `smoke the preview` | deploy |
| `seeded_studio` | `seeded-data studio [known-flaky]` | deploy |
| `seeded_visual_layout` | `seeded-data visual layout [known-flaky]` | deploy |
| `seeded_visual` | `seeded-data visual [known-flaky]` | deploy |
| `record` | `record the acceptance evidence` | — |
| `report` | `report to pull request` | — |

**这 9 个 check 没有一个在 ruleset 里，也没有一个在 `ci-gate` 的 `needs` 里**——它们只被
`ci-gate` 的 PART 3（「任何红色 check 都不能只作 note」）看到。`deploy to staging host` 的
持续失败正是由此进入 gate 判决的。

三个 `[known-flaky]` job **只在 `full` tier 里运行**，并且运行步骤带
`continue-on-error: true`（`:519`、`:1526`、`:1594`）。

文件自己的说明（`:52-58`）比我的转述重要，直接引：

```
# The three seeded-data suites are labelled `[known-flaky]` and their run steps
# are `continue-on-error`. An audit of the last twenty staging runs found every
# one of them `skipped`: the `full` tier is reachable only through
# `workflow_dispatch`, and nobody dispatches it nightly. So the label has never
# been earned or disproven by a single data point, and "flaky" is a guess
# written into a job name.
```

**所以这三个 suite 在常规 push 触发的部署里根本没跑**——它们 `skipped`，不是「跑了但
被 `continue-on-error` 放过」。我在本文件上一版里写成了后者，那是错的。

`continue-on-error` 的代价仍然是真实的，只是范围更窄：在 **`full` tier**（nightly 或手动
dispatch）里，这三个 browser suite 的真实失败不会让 workflow 变红。`:1497` / `:1565`
让 `record` 步骤读「suite 自己的 outcome 而不是 job 的」，所以结果被**记录**下来了，
只是不阻断。这一点在 `architecture-proposal.md` §4 展开。

## typed-pipeline-contracts.yml — 1 个 job

**触发**：`push:`、`pull_request:`

| job | check |
|---|---|
| `typed-pipeline-contracts` | `typed-pipeline-contracts`（gate-only） |

## 交叉引用矩阵

哪个 workflow 会执行哪个重型脚本：

| 脚本 | 被几个 workflow 调用 |
|---|---|
| `tests/ci/data_foundation_ci.sh` | **1**（`data-foundation.yml`） |
| `tests/ci/g12_acceptance_ci.sh` | **1**（`g12-acceptance.yml`） |
| `tests/ci/p001c13_lifecycle.sh` | **1**（`plugin-lifecycle.yml`） |
| `scripts/build-plugins.sh` | **2** 次真正执行，且用**不同的 registry**：`data-foundation.yml` 设 `OPSWEAVE_REGISTRY=localhost:5002`；`plugin-lifecycle.yml` 用 `OPSWEAVE_TEST_REGISTRY_PORT`（5015 / 5016 两个不同端口）。`ci.yml` 只是注释里提到它，不执行 |

**任务书担心的「三个 workflow 重复跑 `data_foundation_ci.sh`」在当前代码上不成立**——
只有一个。

`build-plugins.sh` 的两处调用**不是冗余**，而且理由是硬的：它们指向不同的 registry 端口
（5002 vs 5015/5016）。`plugin-lifecycle.yml:123` 明说这个隔离是为了避免撞上
data-foundation 的 5002 registry：

```
# data-foundation's 5002 registry when both run on one host.
OPSWEAVE_TEST_REGISTRY_PORT: "5015"
```

合并它们会直接制造端口冲突。**这一条是「看起来重复、实际不同」的典型**，也是本文件存在的
理由之一。
