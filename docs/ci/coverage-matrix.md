# 覆盖矩阵

**采集时间 2026-11-19，基线 `ec7ff1f`。** 每一项都写明证据来源，不写「应该覆盖」。

判定用的不是「文件名出现在 workflow 里」，而是
`tests/ci/check-spec-coverage.mjs` 的判定——它会跟进
`tests/ci/run_step.sh <name> <timeout> -- tests/acceptance/<x>.sh` 这类间接调用
（该逻辑在 `:676-677`，并有针对性的反例测试在 `:594`）。

```bash
$ node tests/ci/check-spec-coverage.mjs
spec coverage: 41 covered, 24 explicit-skip, 0 unreferenced
shell coverage: 71 covered, 20 explicit-skip, 0 unreferenced
```

**为什么不能用「文件名匹配 workflow 文本」来判断**：那样算出来是 21 covered / 66
unreferenced。差额来自 `tests/ci/data_foundation_ci.sh`，它用 `run_step` 间接调用 **39**
个 acceptance 脚本、共 45 步。按名称匹配会把它们全部误判为未覆盖。

---

## 1. 状态词汇

| 词 | 含义 |
|---|---|
| `TESTED_CI` | 有脚本、被某个 workflow 实际执行、且该 check 出现在 commit 上 |
| `TESTED_CI_GATE_ONLY` | 同上，但该 check **不在 ruleset 的九项里**，只由 `ci-gate` 判决 |
| `EXPLICIT_SKIP` | 有脚本、有 owner、有到期日，但当前没有执行入口 |
| `REAL_INFRA_REQUIRED` | 需要的环境（双机、可分区 daemon、Rootless）本仓库的 CI 不具备 |

本文件**不使用** `TESTED_STAGING` / `TESTED_REAL_INFRA`：本轮的每一次 staging 部署都因容量
失败（见 `failure-analysis.md`），没有任何一项能在本次采集中被真实标记为该状态。

## 2. Rust 组件

| 组件 | 实现 | CI 执行 | 门禁 | 证据 |
|---|---|---|---|---|
| `apps/kernel` | 是 | `TESTED_CI` | **必需** | `ci.yml` job `rust`：`cargo test --locked --workspace`，且 `platform-only` 另跑 `--no-default-features` |
| `apps/node` | 是 | `TESTED_CI` | **必需** | 同上；另有 `migration_identity` / `migration_durability` / `container_ownership` 三个 `--test` 目标独立跑 |
| `apps/pipeline-worker` | 是 | `TESTED_CI` | **必需** | `rust` job；行为验收在 `data-foundation.yml` |
| `apps/opsctl` | 是 | `TESTED_CI` | **必需** | `rust` job；真实 CLI 路径在 `data-foundation.yml` 与 `plugin-lifecycle.yml` |
| `crates/contracts` | 是 | `TESTED_CI` | **必需** | `ci.yml` job `contracts` |
| `crates/bundle` | 是 | `TESTED_CI` | **必需** | `contracts` job（签名/校验）+ `plugin-lifecycle.yml`（真实 OCI） |
| `crates/http-body-guard` | 是 | `TESTED_CI` | **必需** | `rust` job |
| `crates/pipeline-transform` | 是 | `TESTED_CI` | **必需** | `rust` job |

数据库测试的真实性由 `OPSWEAVE_REQUIRE_TEST_DATABASE=1` 保证：未设置该变量时
`test_pool()` 返回 `None` 并打印 `skip:`，设置了却没有 URL 则 panic。CI 里两者都设置，
所以**缺库时是 FAIL 而不是 skip**。

## 3. Web

| 组件 | CI 执行 | 门禁 | 证据 |
|---|---|---|---|
| `apps/platform-console` | `TESTED_CI` | **必需** | `ci.yml` job `web`（typecheck+build）与 `web-unit`（vitest） |
| `apps/ops-web` | `TESTED_CI` | **必需** | 同上 |
| `packages/ui` | `TESTED_CI` | **必需** | 同上（workspace 级） |
| `packages/platform-client` | `TESTED_CI` | **必需** | 同上 |
| 插件 Web remote | `TESTED_CI` | **必需**（构建）／`GATE_ONLY`（浏览器） | 构建在 `platform-image-build`；`remoteEntry.js` 的存在性断言在两处 |
| i18n 目录 | `TESTED_CI` | `GATE_ONLY` | `spec-coverage` 的 i18n 检查 |
| Design tokens | `TESTED_CI` | `GATE_ONLY` | `scripts/check-ui-tokens.test.mjs` |
| Playwright（`tests/ui`） | `TESTED_CI` | `GATE_ONLY` | `spec-coverage` 断言 41 个 spec 有 workflow；实际执行在 `data-foundation.yml`、`g12-acceptance.yml`、`staging-preview.yml` |

41 个 spec 覆盖、24 个 `EXPLICIT_SKIP`（每条带 reason + owner + `2027-02-01` 到期）。

## 4. 插件体系

| 能力 | CI 执行 | 门禁 | 证据 |
|---|---|---|---|
| TypeScript 插件（data-catalog / data-integration） | `TESTED_CI` | `GATE_ONLY` | `data-foundation.yml`、`plugin-lifecycle.yml` |
| Go 插件 | `TESTED_CI` | `GATE_ONLY` | `runtime-conformance.yml` job `conformance` |
| Java 插件 | `TESTED_CI` | `GATE_ONLY` | 同上 |
| Zabbix source | `TESTED_CI` | `GATE_ONLY` | `ci.yml` job `zabbix-plugin` |
| 真实 OCI 生命周期 | `TESTED_CI` | `GATE_ONLY` | `plugin-lifecycle.yml` job `full TypeScript lifecycle`：build→sign→install→deploy→upgrade→rollback→uninstall |
| 插件签名 / Publisher 信任 | `TESTED_CI` | `GATE_ONLY` | `plugin-lifecycle.yml` + `contracts` job |

**多语言一致性不得声称「全语言 PASS」除非三种语言都在同一次运行里通过。**
`conformance` 一个 job 里跑三种，这是当前唯一能支撑该声明的入口。

## 5. 分布式与安全

| 能力 | 状态 | 证据 |
|---|---|---|
| Workspace 隔离 | `TESTED_CI_GATE_ONLY` | `tests/ci/b2_workspace_isolation.test.mjs`（在 `ci.yml` job `b2-plugin-identity` 里跑） |
| 插件身份伪造 | `TESTED_CI_GATE_ONLY` | `tests/ci/b2_plugin_identity_attack.test.mjs` |
| 端点点策略 | `TESTED_CI_GATE_ONLY` | `tests/ci/g13a2_endpoint_attack.test.mjs` |
| Capability grants | `TESTED_CI_GATE_ONLY` | `g12-acceptance.yml` job `acceptance` |
| Credential binding | `TESTED_CI_GATE_ONLY` | `data-foundation.yml`（`data_token_*` 系列，39 个间接脚本之一） |
| Job claim / lease / fencing | `TESTED_CI_GATE_ONLY` | `data-foundation.yml`（`pipeline_heartbeat_ttl_takeover` 等） |
| Pipeline recovery | `TESTED_CI_GATE_ONLY` | `data-foundation.yml`（`pipeline_orphan_worker`、`kernel_restart_takeover`） |
| 容器所有权 | `TESTED_CI` | `rust` job 的 `container_ownership` 测试目标 + `p001_execstoppost_ownership.sh` |
| Node enrollment | `TESTED_CI_GATE_ONLY` | `tests/acceptance/data_foundation.sh` 与 `g13_b16_effect.sh` 都做 enrollment；前者由 `data_foundation_ci.sh` 的 39 个间接脚本之一执行，后者在 `ci.yml` job `g13b16-effect` |
| Node revocation | `EXPLICIT_SKIP` | `node_revocation.sh`，owner「a dedicated-daemon job」，到期 `2027-02-01` |
| Node quarantine | `EXPLICIT_SKIP` | `node_quarantine.sh`，同上 |
| Node lease | `EXPLICIT_SKIP` | `node_lease.sh`，同上 |
| 双机 failover | `REAL_INFRA_REQUIRED` | `two_node_failover.sh`，owner「a two-Node job with a partitionable daemon」 |
| Rootless Docker | `REAL_INFRA_REQUIRED` | 无脚本；本仓库所有 runner 是普通 Docker Engine |
| mTLS | `NOT_IMPLEMENTED` | — |

**这三条 `EXPLICIT_SKIP` 是有记录的缺口，不是静默漏洞**：`check-spec-coverage.mjs` 要求每条
带 `why` / `owner` / `expires`，到期后重新变成失败（`:958` 把 `entry.expires < TODAY` 判为过期）。
今天距到期还有 74 天。

**不能把这三个称为「已验收」**，也不能把在单机单 daemon 上跑通的双进程测试称为「双机验收」。

## 6. 与必需门禁的关系

九项必需 check 里，只有 `rust` / `web` / `web-unit` / `contracts` / `spec-coverage` /
`platform-only` / `platform-image-build` / `quality-faults` / `linux-runtime` 会真正阻止合并。

上表中标 `GATE_ONLY` 的能力——**包括全部插件生命周期、全部分布式与安全验收**——只在
`ci-gate` 判红时才阻止合并，而 `ci-gate` 本身不在 ruleset 里。这是本仓库最重要的覆盖缺口，
详见 `architecture-proposal.md` §2。

## 7. 复现

```bash
node tests/ci/check-spec-coverage.mjs
python3 -c "import yaml; [print(f, yaml.safe_load(open(f)).get('jobs').keys()) for f in __import__('glob').glob('.github/workflows/*.yml')]"
gh api repos/baicie/ops-1/rulesets/26958761 --jq '.rules[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context'
```
