# Workflow 执行矩阵（Phase 0）

全部 10 个 workflow，逐 job。数据来自 `e3b3ce5` 时点的实际文件与最近一次运行的 job 耗时。

「必需」一列指该 job 的 check 名是否在 Ruleset `26958761` 的 required 列表中。

## ci.yml

触发：全部 `pull_request`，`push: main`。无路径过滤。

| Job | 必需 | 秒 | 主要命令 |
|---|---|---|---|
| `rust` | **是** | 189 | `cargo fmt --check`、`cargo clippy --locked --workspace --all-targets -- -D warnings`、`cargo test --locked --workspace`（带 postgres service，`OPSWEAVE_REQUIRE_TEST_DATABASE=1`） |
| `web` | **是** | 48 | `pnpm install --frozen-lockfile` + 每个 workspace `typecheck` + 两个 app `build` |
| `web-unit` | **是** | 15 | 每个 workspace `test`（vitest） |
| `zabbix-plugin` | 否 | 22 | `npm ci --prefix plugins/zabbix-source/backend` + `node --test` |
| `b2-plugin-identity` | 否 | 33 | `sync-plugin-identity.mjs --check` + `npm ci` ×2 + `b2_plugin_identity_attack` |
| `g13a-roundtrip` | 否 | 103 | `cargo build -p opsweave-kernel` + `g13a_evidence_roundtrip.mjs` |
| `g13a1-gateway` | 否 | 244 | 构建 kernel+node+opsctl + keygen + `npm ci` + gateway E2E |
| `g13b14-claim` | 否 | 171 | `pnpm install` + 两个 app build + claim 测试 |
| `g13b16-effect` | 否 | 111 | `cargo build -p opsweave-kernel` + `g13_b16_effect.sh` |
| `g13b17-principal` | 否 | 117 | `cargo build -p opsweave-kernel` + `g13_b17_principal.sh` |
| `artifact-budget` | 否 | 11 | `check-tracked-png-budget.mjs` |
| `spec-coverage` | **是** | 14 | `check-spec-coverage.mjs` |
| `contracts` | **是** | 15 | `validate_contracts.py` |
| `platform-only` | **是** | 239 | 11 步，`--no-default-features` 构建与测试边界 |
| `platform-image-build` | **是** | 345 | 4 步镜像构建 |

合计约 **1735 秒**（job 串并行混合；实际墙钟 304–1456 s）。

## platform-linux-acceptance.yml

触发：全部 `pull_request`，`push: main`，`workflow_dispatch`。无路径过滤。

| Job | 必需 | 秒 | 内容 |
|---|---|---|---|
| `linux-runtime` | **是** | ~400-900 | 16 步：记录环境、构建 platform-only 镜像、检查 state 目录可写、安装平台、断言无 node 重启循环、`container_ownership` 与 `migration_identity`/`migration_durability` 测试 |

**这个 job 对所有 PR 无条件运行**，包括只改文档的 PR。

## reliability.yml

触发：全部 `pull_request`，`push: main`。无路径过滤。

| Job | 必需 | 秒 |
|---|---|---|
| `quality-faults` | **是** | 131 |

`./tests/reliability/run.sh --all`。同样对所有 PR 无条件运行。

## typed-pipeline-contracts.yml

触发：`pull_request` 路径 2 条（`contracts/**`、`tests/contract/**`）。

| Job | 必需 | 秒 | 脚本 |
|---|---|---|---|
| `contracts` | **是（同名冲突）** | ~47 | `validate_typed_pipeline.py` |

**check 名 `contracts` 与 ci.yml 的 `contracts` 相同，但跑的是不同脚本。**

## data-foundation.yml

触发：`pull_request` 路径 11 条，`workflow_dispatch`。

| Job | 必需 | 秒 | 内容 |
|---|---|---|---|
| `golden-path` | 否 | **1051** | `RUN_BROWSER_SMOKE=1 tests/ci/data_foundation_ci.sh` |
| `legacy-regression` | 否 | 367 | maven + registry + `RESET=1 BUILD=0 scripts/demo_up.sh` |

## typed-pipeline-runtime.yml

触发：`pull_request` 路径 15 条，`workflow_dispatch`。

| Job | 必需 | 秒 | 内容 |
|---|---|---|---|
| `runtime-golden-path` | 否 | **1502** | `cargo fmt/clippy/test`（**无 `--locked`**）+ `tests/ci/data_foundation_ci.sh`（无 `RUN_BROWSER_SMOKE`） |

## plugin-lifecycle.yml

触发：`pull_request` 路径 19 条，`push: main`，`workflow_dispatch`。

| Job | 必需 | 秒 |
|---|---|---|
| `lifecycle`（显示名 `full TypeScript lifecycle`） | 否 | ~1000 |

## runtime-conformance.yml

触发：`pull_request` 路径 8 条，`push: main`，`workflow_dispatch`。

| Job | 必需 | 秒 |
|---|---|---|
| `conformance` | 否 | ~265 |

## g12-acceptance.yml

触发：`pull_request` 路径 29 条，`workflow_dispatch`。

| Job | 必需 | 秒 |
|---|---|---|
| `acceptance` | 否 | 未单独测量 |

## staging-preview.yml

触发：`push: main`，`push: feat/0.0.5-staging-preview`，`workflow_dispatch`（含 `sha`、`skip_image_transfer` 输入）。

**无 `pull_request` 触发。**

| Job | 秒 | 内容 |
|---|---|---|
| `plan` | — | 决定运行层级 |
| `build` | — | 构建镜像 |
| `deploy` | — | SSH 部署到 staging 主机 |
| `smoke` | — | `/livez`、`/readyz`、`/api/v1/version`、浏览器冒烟 |
| `seeded_studio`（`[known-flaky]`） | — | 种子数据 studio 验证 |
| `seeded_visual_layout`（`[known-flaky]`） | — | 种子数据视觉布局 |
| `seeded_visual`（`[known-flaky]`） | — | 种子数据视觉 |
| `record` | — | 记录验收证据 |
| `report` | — | 回报 PR |

权限：`contents: read`、`packages: write`、`pull-requests: write`（workflow 级）。

## 观察

1. **5 个 workflow 产出的 check 不是必需门禁**：`data-foundation`、`typed-pipeline-runtime`、
   `plugin-lifecycle`、`runtime-conformance`、`g12-acceptance`。它们失败时 PR 仍可合入。
2. **3 个必需门禁对所有 PR 无条件运行**（`platform-linux-acceptance`、`reliability` 加上
   `ci.yml` 的全部 15 个 job），即使只改了 `docs/`。
3. `data_foundation_ci.sh` 被执行两次，合计约 2553 秒。
4. `typed-pipeline-runtime.yml` 的三条 cargo 命令缺 `--locked`。

## 未测量项

- `staging-preview.yml` 各 job 的分项耗时（需要一次带 artifact 的运行）。
- `g12-acceptance.yml` 的 job 耗时（采样窗口内没有该 workflow 的运行）。
- 排队时间与执行时间的区分：`gh run view` 的 `createdAt` 到 `startedAt` 之差可测，
  本次未逐 run 采集。上表的 job 秒数为 `completedAt - startedAt`，已排除排队。
