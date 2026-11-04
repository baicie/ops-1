# ADR-016：验收分层与 code_acceptance 归属

- 状态：Accepted
- 日期：2026-11-04
- 版本状态：本 ADR **不**改变 `0.0.5_PARTIAL`；**不**构成 G13 准入
- 前置：`AGENTS.md`、`rules/07-testing-release.md`、`rules/09-oci-supply-chain.md`、`docs/adr/ADR-014-staging-preview-deployment.md`、`docs/acceptance/g12-r4-release-readiness.md` §12
- 相关实现（后续变更，不在本 ADR 中执行）：`.github/workflows/staging-preview.yml`、`.github/workflows/g12-acceptance.yml`、`tests/ci/g12_acceptance_ci.sh`、`tests/ci/check-spec-coverage.mjs`

## 1. 目标与背景

G12 R4 的结论是：远端浏览器层间歇性失败的原因是 runner→host 传输（TTFB 440–840 ms、尾部 2.5 s），不是产品；确定性层同一套代码 53/53、内核 192/0。G13 准入第 2 条要求二选一：**更近的 runner**，或**明确远端浏览器层只作建议、`code_acceptance` 归确定性层**。

本 ADR 决定选后者，并写清语义、边界、两步实施与验收。它回答一个问题：**哪一层有权说「代码被接受」，以及另一层失败时读者应看到什么。**

一个必须先写下的现状：`staging-preview` 既在 `verdict_definition` 里写「deterministic acceptance ... is the g12-acceptance workflow; this one never certifies code on its own」（`.github/workflows/staging-preview.yml:2124-2127`），又把 `code_acceptance` 作为 `remote_browser` 的副本发出来（同文件 `:2058-2066`）。同一个字段同时声称不认证与认证，是本 ADR 要消除的记录层矛盾。

非目标：定义 G13 的范围、改变生产发布策略、改变 `deployment_environment` 的计算、为 staging 引入新基础设施。

## 2. 决定性约束（来自真实源码与实测）

| # | 约束 | 证据 |
|---|---|---|
| C1 | `staging-preview` **没有 `pull_request` 触发**：只在 push `main`/`feat/0.0.5-staging-preview` 与 `workflow_dispatch` 运行。PR #32 的 11 项检查不含它。本决策改变的是**记录语义与发布证据**，不是今天的 PR 门禁。 | `.github/workflows/staging-preview.yml:32-37,94-96`；`gh pr view 32` 的 checks 列表（2026-11-04） |
| C2 | 远端判决 `code_acceptance` 是 `remote_browser` 的复制，且被强制「不能强于」它。 | `.github/workflows/staging-preview.yml:2058-2066` |
| C3 | 同一 workflow 的 `verdict_definition` 明说确定性验收归 `g12-acceptance`，「this one never certifies code on its own」。 | 同文件 `:2124-2127` |
| C4 | 传输惩罚在本仓库内不可消除；带 in-job probe 的失败运行里 netprobe 0/4 失败，而 Playwright 仍 20 s 超时；180 s 卡顿成因未证明。 | `docs/acceptance/g12-r4-release-readiness.md:226`；`docs/acceptance/g12-staging-runner-measurement.md:254-267,282-288` |
| C5 | 确定性 per-PR job 今天只跑 **9 个 spec / 44 个 `test()` 声明**（2 个自跳过，42 个执行），覆盖 §6 的 11 个 spec / 53 个测试中的 **8 个 spec / 39 个测试**。`admin-shell`(7)、`staging-smoke`(5) 只在远端 core；`g11-viewer-write-entries`(2) 无任何 workflow。 | `tests/ci/g12_acceptance_ci.sh:149-158`；`.github/workflows/g12-acceptance.yml:18-33`；`tests/ci/check-spec-coverage.mjs:61` |
| C6 | 远端 full tier 还覆盖 11 个 surfaces spec、`ui-table-audit` + 几何门禁、`visual.spec.ts`；它们不在 53 之内，且多数只在 staging。 | `.github/workflows/staging-preview.yml:951-962,1062-1090,1681-1686` |
| C7 | `main` 当前**没有 branch protection**；`g12-acceptance` 是否为 required check 是 GitHub 设置，不能从仓库文件证明。 | `GET /repos/baicie/ops-1/branches/main/protection` → 404（2026-11-04，外部观察） |
| C8 | staging host 为 4 vCPU / 3.7 GB，与其他租户共享，且无法直连 github.com；compose 已把 4 个服务限额配到 4.0 vCPU / 2 GiB。 | `docs/adr/ADR-014-staging-preview-deployment.md:27-29`；`deployments/staging/compose.yaml:49-53,78-82,125-129,188-192` |
| C9 | `rules/07` 要求每个检查记录「是否真实运行」，未执行项为 `NOT_RUN`；`AGENTS.md` 禁止把 `UNKNOWN/PARTIAL/NO_DATA` 伪装成健康，禁止用组件存在/页面显示代替真实 E2E。 | `rules/07-testing-release.md:3,8`；`AGENTS.md` 绝对禁止章 |

C1 + C5 是最强约束：**远端层今天并不是 PR 门禁，而确定性层又还没跑完整套件**。因此不存在「今天把代码验收交给确定性层就立刻有完整门禁」的选项；只能分两步，且第二步的前置是条件 1。

## 3. 候选方案

### A. 更近的 runner（否决，本轮）

三个具体形态：

- **A1 自托管 runner 装在 staging host**：被 C8 / ADR-014 C11 阻断——host 无法直连 `github.com`（实测 000），runner 无法注册或轮询控制面；仓库内没有代理/中继记录。安装 Node/Chromium 只是第二道成本。
- **A2 附近 VPS 注册为 runner**：新基础设施。无候选主机、无路径实测、无预算/所有者；「附近」是未测量的假设——唯一的好基线（TTFB 33–111 ms）来自 host 本机，不来自任何 VPS；放在能稳定访问 github.com 的位置可能又回到跨境路径。
- **A3 从现有 workflow 经 SSH 在 host 上跑 Playwright 容器**：唯一复用现有链路的形态（GitHub→host SSH、host→ghcr.io 都可用），但把浏览器搬到 host。需要新的 digest 固定/非 root/签名/SBOM/扫描镜像（`rules/09`）、host 级锁与 cgroup 限额，并让 smoke job 获得今天没有的 sudo 级 SSH 密钥，或改在持有该密钥与 `packages:write` 的 deploy job 里运行第三方测试代码——两种都扩大信任边界。并且该层不再是「公网远端」：真实入口/防火墙回归会失去唯一的外部浏览器覆盖。

即使 proximity 降低了每请求地板，它也**不解释 180 s 卡顿**：C4 的失败运行里 netprobe 正常而 Playwright 仍超时，记录本身说此时应查浏览器/进程侧（`docs/acceptance/g12-staging-runner-measurement.md:318-322`）。A 是缓解，不是已证明的修复；且不是仓库内可完成的变更。

**重新考虑的触发条件**（任一）：更细粒度 probe 在同一次失败中记录到同样的 stall；同 commit 的受控前后对比显示 20 s/180 s 等待消失（不是一次绿）；host headroom 实测通过；A3 配独立 ADR 与安全评审。

### B（选定）. 远端浏览器层 advisory，`code_acceptance` 归确定性层

分两步：先修正记录语义（今天即可做，只减少过度声明），再在条件 1 完成后转移所有权。理由：C1–C3 表明远端层今天的 `code_acceptance` 本来就是复制且自相矛盾；C4 表明它的红不是产品判决；C5 表明确定性层是唯一能在 PR 上重复的代码证据；C9 要求未执行项保持 `NOT_RUN` 而不是借用另一层的绿。

## 4. 决策

1. **`deployment_environment` 不变**，仍是唯一能否决「环境/部署」的判决：deploy job 成功、served SHA 等于 built SHA、deploy 脚本健康轮询通过；读不到事实则 `UNVERIFIED`，不猜。
2. **`remote_browser` 保留四个值** `PASSED / FAILED / UNVERIFIED / NOT_RUN` 与现有分类器，降为 **advisory**：
   - 不得单独接受代码；
   - 不得被复制进 `code_acceptance`；
   - `FAILED`（断言被反驳，或无法分类）仍必须产生 durable escalation（issue 或指定的手工升级路径），并带上同 SHA 的确定性结论；
   - `UNVERIFIED`（超时/重置/DNS/等待未到达）必须记录并告警，但不是产品失败，也不得渲染成 `FAIL`；
   - `NOT_RUN` 不得显示为绿。
3. **`staging-preview` 不再在 `verdicts` 中发 `code_acceptance`**。在 `verdicts` 之外增加非判决对象 `acceptance_evidence`：`{owner: "g12-acceptance", sha: <target>, status: "NOT_EVALUATED_HERE", lookup: <workflow url>}`。它不得携带从别处复制的 `PASSED/FAILED`。
4. **`code_acceptance` 的 owner 是确定性 per-PR job**（`g12-acceptance` 或其继任者）。只有当它（a）跑完整套件、（b）在 GitHub 上是 required check 时，记录才可称 `code_acceptance=PASSED`；在此之前正确值是 absent / `NOT_RUN`，永远不是 `PASSED`。
5. **`ok` 保持窄定义**（「每个实际运行的非 known-flaky check 没有失败」）；它不是发布判决，也不得被改写成健康/验收。
6. **「advisory」作用于所有人类可见表面**：`health.json`、PR 评论、job/workflow 结论。PR 评论必须逐字渲染 `deployment_environment` 与 `remote_browser`，并区分 `UNVERIFIED / FAILED / NOT_RUN`。
7. **不使用「tier」命名本决策**：仓库里的 `tier` 已固定指 core/full 套件范围（`.github/workflows/staging-preview.yml:23-30,85-98`）；本 ADR 用「层（layer）」。

## 5. 实施（两步；本 ADR 只定语义，不改 workflow）

### 第一步：记录语义（今天可做，安全，因为只删除过度声明）

- 删除 `:2058-2066` 的复制与键；保留 `deployment_environment` 与 `remote_browser`；增加 `acceptance_evidence`；重写 `verdict_definition`（`:2107-2127`）与层注释（`:2040-2057`）。
- PR 评论增加两个判决行，停止用 `Health (CI)` / `check_label` 把超时渲染成 `FAIL`（`:2242-2251,2317-2331`）。
- 远端 `FAILED` 增加 issue/手工升级路径（report job 已有 `issues:write`，`:2175-2179`；当前无关联 PR 时直接 exit 0，`:2364-2367`），并指定 owner 与响应时限。
- 用**执行过的**记录形状场景验收（不是读代码）：确定性 `PASSED` + 远端 `UNVERIFIED`；确定性 `FAILED` + 远端 `PASSED`；确定性 `NOT_RUN`；远端 `FAILED`；两者 `PASSED`。仓库已有「执行提取出的判决程序」先例（`docs/acceptance/g12-post-merge-hardening.md:174`）。
- 历史记录加 superseded-by 指针：`docs/acceptance/g12-staging-runner-measurement.md` §6、`docs/acceptance/g12-post-merge-hardening.md` §4/§7。

### 第二步：所有权转移的前置（= G13 条件 1）

- 确定性 job 跑完整集合：加入 `admin-shell`（7）、`g11-viewer-write-entries`（2，并删除 `tests/ci/check-spec-coverage.mjs:61` 的 `KNOWN_UNRUN`）、`staging-smoke` 的产品面用例；served-SHA 断言属于 `deployment_environment`，不搬。harness 需设置 `OPSWEAVE_BUILD_SHA`（`admin-shell.spec.ts:225` 需要非空 `commitSha`；`apps/kernel/src/config.rs:154`）。
- **连续两次全绿**（`docs/acceptance/g12-r4-release-readiness.md` §2 的标准：一次绿不构成修复），并修掉/显式排除 `g11-page-header-growth` 的 studio 已知失败（同文件 `:228`）。
- 触发器覆盖产品路径：`.github/workflows/g12-acceptance.yml:18-33` 目前缺 `apps/node/**`、`apps/pipeline-worker/**`、`apps/opsctl/**`、`crates/**`、`plugins/**`、`scripts/**`、`deployments/**`；并把它注册为 required check（GitHub 设置，不能从仓库证明）。
- 对 11 个 surfaces spec 与 `ui-table-audit`/几何门禁做**显式决定**：搬进确定性层，或逐个记录「降级为 advisory」及理由；不得静默消失。
- 覆盖门禁报告「确定性覆盖」与「远端覆盖」两类，不再把任何 workflow 的 COVERED 当作确定性覆盖（`tests/ci/check-spec-coverage.mjs:17-22`）。

## 6. `code_acceptance` 的边界（必须写进记录，防止过度声明）

`code_acceptance` 只覆盖确定性套件实际执行的 surface，**不**覆盖：

- release OCI 镜像以非 root（uid 10001）运行（`deployments/staging/Dockerfile:38-42,78-88`）；
- host cgroup 限额下的资源行为（`deployments/staging/compose.yaml:49-53` 等）；
- 持久数据库上的迁移/升级（harness 每次 DROP/CREATE，`tests/ci/g12_acceptance_ci.sh:55-58`）；
- node readiness、插件 bridge、真实公网入口/TLS。

这些由 `deployment_environment`（身份/健康）或独立的 release gate（`rules/07`、`rules/09`）负责。任何 `code_acceptance=PASSED` 都不得被读成对上述项的接受。

## 7. 后果与风险

| 风险 | 处置 |
|---|---|
| 远端红不再声称代码验收；若确定性 job 不是 required，会出现「无人拥有代码验收」的真空 | 第二步前，记录只发 absent/`NOT_RUN`；`acceptance_evidence` 明说 `NOT_EVALUATED_HERE`；不得默认 `PASSED` |
| 远端 `FAILED` 被忽视 | durable escalation + named owner + 响应时限；`FAILED` 与 `UNVERIFIED` 分开处置 |
| 分类器是闭集，novel transport message → `FAILED` | 保留保守默认；advisory 下给 triage 预算，并把新 shape 补进分类器 |
| 远端 `FAILED` + 确定性 `PASSED` | 视为环境特有缺陷或确定性覆盖缺口的信号，必须分派，不得互相覆盖 |
| 传输 P1 仍开放，staging 仍可能 flaky | 本 ADR 改变 authority，不改变延迟；P1 保持 open，另行处理（更近 runner 或更小 bundle） |
| 覆盖范围被悄悄缩小 | §6 边界 + 第二步的显式 demotion 记录；`docs/acceptance/g12-r4-release-readiness.md` §12.1 记录当前 39/53 |

## 8. 验收

- 记录形状：`health.json` 无 `verdicts.code_acceptance`；有 `deployment_environment`、`remote_browser`、`acceptance_evidence`；`verdict_definition` 与新语义一致。
- 场景执行：见 §5 第一步的五组。
- 覆盖：第二步完成后，`g12_acceptance_ci.sh` 的 spec 列表包含 §6 的 11 个 spec（served-SHA 用例归 `deployment_environment`），且 `check-spec-coverage.mjs` 不再有产品 spec 的 `KNOWN_UNRUN`。
- 触发：`g12-acceptance.yml` 的 paths 覆盖产品路径；GitHub required check 已核验（外部设置，记录证据）。
- 人类表面：PR 评论逐字显示两个判决，`UNVERIFIED` 不显示为 `FAIL`。

## 9. 未决与重新评估

- **G13 准入仍未满足**：条件 1（本 ADR §5 第二步）与条件 2（本 ADR 的决策）都完成后才算。本 ADR 不构成 G13 准入，也不定义 G13 范围（仓库内 G13 只出现在 `docs/acceptance/g12-r4-release-readiness.md` §12）。
- 若未来重新考虑 A：必须满足 §3 的触发条件，并为 A3 另立 ADR；不得以「runner 更近」作为未测量的前提。
- 本 ADR 不改变 `0.0.5_PARTIAL`、不改变生产发布策略、不改变 `deployment_environment` 的计算。
