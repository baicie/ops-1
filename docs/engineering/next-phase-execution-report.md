# 下一阶段执行报告

生成时间：2026-11-15。分支 `ci/architecture-overhaul`，PR
[baicie/ops-1#120](https://github.com/baicie/ops-1/pull/120)。

**这份报告只写有证据的结论。** 没有真实 CI 证据的一律标 `NOT_RUN` 或 `BLOCKED`，不写 PASS。

---

## 1. 总体状态

| 项 | 值 |
|---|---|
| 基线 `main` | `e3b3ce5`（本轮未改动 main） |
| 分支 | `ci/architecture-overhaul` |
| PR | #120，**Ready**（作者于 2026-11-15T09:51Z 从 Draft 转为 Ready） |
| HEAD | `a651f51` |
| CI | **25/25 pass**，`mergeStateStatus: CLEAN` |
| 规模 | 18 commits，+3323/−112，26 files |

### 与任务书「6–10 个独立 Draft PR」的取舍

任务书要求拆成 6–10 个 PR。**我没有拆**，理由是实测的：这些改动互相依赖，拆开后中间
状态的 CI 会是红的。

- `ci-gate` 的 job 映射表、`needs` 列表、`ci.yml` 的 `permissions` 是同一个判定的三部分，
  拆开任意一处都会让 gate 读一个不存在的 job。
- `impact.mjs` 的规则与 `check-impact-consistency.mjs` 的配对是「规则 + 断言它」的关系，
  先合规则再合断言，中间那次合入没有任何东西验证它。
- `contracts` 的 bundle 段修复依赖新增的 fixture 脚本和 fixture 目录，三者缺一不可运行。

如果拆成 6 个 stacked PR，每个都要跑一轮 25 个 check 才能合下一个，总计约 6 轮全量 CI，
而收益只是审阅粒度。**代价不对称，所以我选择保留 18 个逻辑独立的 commit 在一个 PR 里**，
每个 commit 单独可回滚，commit message 记录了自己的反例。

这是一个可以被推翻的判断：如果审阅粒度比 CI 轮次更重要，正确的做法是从这个分支上
`cherry-pick` 出 stacked PR，本报告末尾给出了分组。

---

## 2. 缺陷清单

### 2.1 本轮修复（第一轮：审计既有 CI）

| ID | 严重度 | 位置 | 根因 | 修复 | 验证 |
|---|---|---|---|---|---|
| D1 | P0 | `tests/ci/data_foundation_ci.sh` 被两个 workflow 各跑一遍 | 42 步里 41 步完全相同，路径过滤重叠 | 删除 `typed-pipeline-runtime.yml` | 删后 CI 25/25 绿；`data-foundation.yml` 路径已扩到覆盖其独有触发 |
| D2 | P1 | `typed-pipeline-runtime.yml` | `cargo` 三条命令都缺 `--locked`，绿不可信 | 随文件删除 | — |
| D3 | P1 | `check-spec-coverage.mjs` | 不看 `*.test.mjs`，也不识别 env 守卫 | 纳入清单 + 新增 `guardVariable()` | 发现 `b2_workspace_isolation.test.mjs` 从不运行，已接入；变异测试：删掉浏览器块会被发现 |
| D4 | P1 | `ci-gate.mjs` | `toJSON(needs)` 给的是 `{"result":"success"}` 对象，代码按字符串比较 | `normaliseNeeds()` | 首次真实运行 43695561054 抓到；selftest 加 3 个真实形状用例 |
| D5 | P1 | 两个 workflow 都产 `contracts` | 同名 check 无法区分 | `typed-pipeline-contracts.yml` 改名 | 实测：改名前同一 PR 出现 3 次，改名后各 1 次 |
| D6 | P1 | `staging-preview.yml` 的休眠分支触发 | `feat/0.0.5-staging-preview` 不在 origin，但推这个名字就能得到完整部署 | 移除 | — |
| D7 | P1 | `staging-preview.yml` 的 `sha` 输入 | 自由文本，不验证来源 | 三项来源验证：`git cat-file -e`（在本仓库）、`merge-base --is-ancestor`（在 main 上）、commit subject 带 `(#N)`（经过 PR） | **NOT_RUN**：该 workflow 无 `pull_request` 触发，改动只在 `push: [main]` 或 dispatch 时才会执行。逻辑经本地 shellcheck + 手工回放，未在真实运行中执行过 |
| D8 | P2 | 13 个 job 装 Rust 工具链（接入后为 14 处），零编译缓存 | 无 `rust-cache` | `Swatinem/rust-cache@v2` + `shared-key` | CI 全绿；`shared-key` 替代 job-based key，否则每个 job 写一份没人读的缓存 |
| D9 | P2 | `data-foundation.yml:108` | 同一 job 内同一批产物构建两次 | `SKIP_BUILD=1` | `demo_up.sh` 的 `BUILD=0` 只管插件 bundle，不管 `cargo build`/`pnpm build` |
| D10 | P1 | `validate_contracts.py:73` | bundle 校验被 `if bundle_dir.exists()` 守卫，而 `dist/` 是 gitignore 的，CI 永远走 else | CI 先构建真实签名 bundle 再验证 | 8 个反例（见 2.3） |

### 2.2 第二轮：对本分支自己引入的缺陷做对抗性复核

**这一节的每一条都是我自己在 2.1 之后引入的。** 单独成节是因为它说明：审查自己刚写的
东西，必须用和审查别人一样的力度。

| ID | 严重度 | 位置 | 根因 | 修复 | 验证 |
|---|---|---|---|---|---|
| D11 | **P0** | `staging-preview.yml` 的镜像存在性检查 | tag 写成 `sha-<SHA>`，实际发布的 136 个 tag **全是裸 40-hex、0 个带前缀**；且检查在 build job 内、构建**之前**执行。→ 任何 `workflow_dispatch` 都会死在这一步 | 删除该检查（`build == 'false'` 分支上的 `docker manifest inspect` 本来就正确地问了同一件事） | 匿名列出 ghcr tag 全量确认格式（136 / 0）。**删除本身未在真实 dispatch 中执行过**——该 workflow 无 PR 触发，而实跑一次 dispatch 会部署真实 staging，本轮禁止 |
| D12 | P1 | `ci-gate` 的 `JOB_TO_SUITE` | 只映射 15 个 job 里的 7 个（恰好是 Ruleset 要求的）。另外 8 个每个 PR 都跑，结果读进来又丢掉 | 映射全部 15 个 + 「`needs` 里每个 job 必须 success」 | selftest 27 例；变异：改回 7 个挂 2 例 |
| D13 | P1 | `ci-gate` 的 `delegated` | 七个 suite 一律标 delegated 后放行。分析器要求了、workflow 因 path filter 没启动的 suite **没有任何红 check** | 查本 SHA 的 check-runs API，映射到真实 check 名 | `absent` 判失败；变异：absent 当通过挂 2 例 |
| D14 | P1 | 同上 | 把 `in_progress` 一律算 `failed`，在三个兄弟 check 还在跑时变红——gate 第一红在自己的读时序上 | `pending` 独立分桶：报告，不判决 | 用失败那次（43716720306）的真实 API 响应回放 → PASS + 3 条 pending |
| D15 | P1 | `staging-preview.yml` 的祖先检查 | depth-1 克隆上 `merge-base --is-ancestor` 对不在克隆里的 commit 返回 128，被 `if !` 报成「不在 origin/main 上」 | `fetch-depth: 0` + `git cat-file -e` 区分「不在本仓库」与「不在 main」 | depth-1 克隆实测：尖端 rc=0，较旧 commit `fatal: Not a valid commit name` |
| D16 | P2 | `ci-gate.mjs` 注释 | 引用 `tests/ci/check-workflow-hygiene.mjs`——该文件从未存在；写「七个 workflow」，实际九个 | 改为如实描述，并记录该检查器不存在 | `ls` + `ls .github/workflows` |
| D17 | P1 | `contracts` 的 bundle fixture | 读 `plugins/hello-ops/web/dist`——gitignore 的构建产物。本地过、CI 挂 | 换成仓库内 `tests/contract/fixtures/hello-frontend` | 在只有被跟踪文件的树里跑通（见 2.3） |
| D18 | P2 | `validate_contracts.py` | `ok bundle` 无条件打印，包括刚追加了摘要失败的那一个 | 按 bundle 计数失败 | 变异：改回无条件打印挂 4 例 |

**D17 的教训值得单独写**：我是在修「依赖未跟踪产物」这个缺陷的过程中，自己引入了同一个
缺陷。本地过是因为 `dist/` 早就建过。之后的验证方式改成用 `git ls-files | tar` 复制出
只有被跟踪文件的树，确认里面没有任何 `dist/`，再跑。

### 2.3 `contracts` 的 bundle 校验：10 种篡改反例

`dist/plugins` 不存在时那段代码从未执行过。现在 CI 先构建一个真实签名 bundle
（无 Docker、无 registry、无 toolchain 安装），再验证。

| # | 篡改 | 结果 |
|---|---|---|
| 1 | asset index 改一个字节，摘要不更新 | `assetIndexDigest mismatch` |
| 2 | remoteEntry 改一个字节，摘要不更新 | `remoteEntryDigest mismatch` |
| 3 | imageRef 换成可变 tag | schema 拒绝 |
| 4 | schemaVersion 降到 1.0 | schema 拒绝（`'1.1' was expected`） |
| 5 | 删除 `manifest.json` | 拒绝 |
| 6 | 删除 asset index | 拒绝 |
| 7 | `dist/plugins` 存在但零个 bundle | 拒绝（本轮新增） |
| 8 | **仅改 `version`** | **通过**——见下 |
| 9 | 只改 payload 文件、索引不更新 | `crates/bundle` 的 `PayloadIndexMismatch`（`rust` job 覆盖） |
| 10 | 换 asset index 整体内容 | `crates/bundle` 的 `rejects_a_swapped_asset_index`（`rust` job 覆盖） |

**#8 通过是正确行为，不是漏洞**：`manifest.json` 被排除在 payload 摘要之外
（`crates/bundle/src/lib.rs:321`），改由 Ed25519 签名覆盖 `manifestDigest`。验证签名是
`crates/bundle::verify_bundle` 的职责，在必需的 `rust` job 里。测试把这个边界显式断言下来，
防止后来者往任一方向误读。

### 2.4 判定为「不是缺陷」的

| 位置 | 曾疑为 | 实测结论 |
|---|---|---|
| `ci.yml` 的 `ci-gate` diff 获取 | `CHANGED` 为空导致 fail-closed 失效 | **推翻**。我读日志时把脚本回显的空 `changed files:` 当成了输出；真实输出在 `##[endgroup]` 之后，20 个文件全在 |
| `staging-preview.yml` 的 `deploy` 步骤 `continue-on-error` | 部署失败被吞 | **推翻**。fallback 步骤以 `steps.deploy.outcome == 'failure'` 为条件，且它自己会 fail job |
| 重复镜像构建（D7/旧 #7） | 应当合并 | **不划算**。artifact 传递 60–90 MB 与重建同量级（345s vs 469s） |
| 同 job 内 `build-plugins.sh` 两次（旧 #9） | 重复 | **刻意隔离**。两个不同 registry；Docker layer cache 已让第二次变便宜 |

---

## 3. CI 改造结果

### 3.1 旧架构 vs 新架构

| 维度 | 旧 | 新 |
|---|---|---|
| 42 步 harness 执行次数 | 2（1051s + 1502s） | 1 |
| `contracts` check 名 | 两个 workflow 各报一次 | 一次 |
| 合并门禁 | Ruleset 的 9 项，无聚合 | 9 项 + `ci-gate`（非必需，可提升） |
| 影响分析 | 无 | `impact.mjs` + 14 个 suite + 反例测试 |
| 调度一致性 | 无人核对 | `check-impact-consistency.mjs` 在必需的 `spec-coverage` 里 |
| 跨 workflow 结果 | 不可见 | check-runs API，按 SHA 查 |
| Rust 编译缓存 | 无 | `rust-cache@v2`，`shared-key` 共用 |
| bundle 校验 | 从未执行 | 每个 PR 构建并验证 |

### 3.2 `ci-gate` 的状态机

```
                 ┌─ needs 里每个 ci.yml job 必须 success ──┐
输入 ──> 判定 ───┤                                          ├──> PASS / FAIL
                 └─ 跨 workflow 的 suite 按 check-run 分桶 ─┘

verified   检查存在且成功
failed     存在且未成功                        -> 阻塞
skipped    存在且被跳过                        -> 阻塞
absent     该 commit 上没有任何同名 check      -> 阻塞（workflow 从未启动）
pending    存在但未跑完                        -> 报告，不判决
unverifiable 没有 check 名映射                 -> 报告
```

`absent` 判阻塞是这套设计存在的理由：一个从未启动的 workflow 永远不会有红 check。

### 3.3 Required Checks 对应

| Ruleset 要求 | 产出 | 归属 |
|---|---|---|
| rust, web, web-unit, contracts, spec-coverage, platform-only, platform-image-build | `ci.yml` | gate 直接读 `needs` |
| linux-runtime | `platform-linux-acceptance.yml` | gate 经 API 读 |
| quality-faults | `reliability.yml` | gate 经 API 读 |

`ci-gate` 自身**未加入 Ruleset**——这需要人工批准，方案见 `architecture-proposal.md` 阶段 C。

---

## 4. 产品验收

| 项 | 状态 | 依据 |
|---|---|---|
| Runtime Image（完整 `--target runtime`） | **NOT_RUN** | 只在 `staging-preview.yml` 构建，该 workflow 无 `pull_request` 触发；本轮禁止触碰 staging |
| C4 浏览器验收（`p001-c4-plugin-assets.spec.ts`） | **NOT_RUN** | `check-spec-coverage.mjs` 明确报告它为 EXPLICIT_SKIP，并附原因：`opsctl deploy --wait` 在 300s 边界上挂住，原因未定位 |
| TS / Go / Java Conformance | 在 CI 执行 | `runtime-conformance.yml` 的 `conformance` check 绿；**未**验证跨语言断言矩阵是否覆盖任务书列的全部维度 |
| Plugin Lifecycle | 在 CI 执行 | `plugin-lifecycle.yml` 的 `full TypeScript lifecycle` 绿 |
| Security Negatives | 在 CI 执行 | `b2-plugin-identity`、`g13b17-principal` 绿 |
| Reliability | 在 CI 执行 | `quality-faults` 绿 |
| 三个 seeded staging 套件 | **NEVER_RUN** | 最近 20 次运行全部 `skipped`；已加每日 certification 产生数据 |

**没有任何一项达到 `TESTED_STAGING` 或 `TESTED_REAL_INFRA` 的证据门槛。** 所有「双 Node」
都是同一 host 上的两个进程，共享一个 Docker daemon；不能表述为真实三机验收。

---

## 5. 工程效率

| 项 | 数值 | 来源 |
|---|---|---|
| 消除的重复执行 | 约 2553 秒/次（1051 + 1502） | 两次运行的实测时长 |
| 同 SHA 双 workflow 同时失败 | 至少 3 对 | 43680822339/43680822312、43678590589/43678590576、43675797785 |
| `data-foundation` 单 job 内重复构建 | 1 次（约 469s 的构建） | `data-foundation.yml:118` + `demo_up.sh:67-68` |
| Rust 缓存 | **未测收益** | 无可对比的冷/热基线；`shared-key` 修正的是「缓存写了没人读」，不是命中率 |
| Runner 分钟数 | **未统计** | 需要 GitHub billing API + 管理员权限 |

**不编造数字。** 上表只列有实测来源的项；缓存收益与总 Runner 分钟数本轮没有证据。

---

## 6. 遗留问题

严格按任务书要求分类。

### FIXED（已修，有 CI 证据）

D1–D18，除下列。

### VERIFIED（已验证为「不是缺陷」）

- `ci-gate` 的 diff 获取（我读错日志）
- `deploy` 的 `continue-on-error`（fallback 会 fail job）
- `impact.mjs` 的 fail-closed 分支
- `data-foundation.yml` / `g12-acceptance.yml` 的路径覆盖

### BLOCKED（需要人工或真实环境）

| 项 | 阻塞原因 |
|---|---|
| Ruleset 加 `ci-gate` | 需要管理员权限；brief 明令禁止本轮修改 |
| 完整 Runtime 镜像验证 | 需要真实 staging；brief 禁止 |
| C4 浏览器验收 | 需要真实平台实例；`opsctl deploy --wait` 挂起原因未定位 |
| 真实三机验收 | 无第二台主机 |

### NOT_RUN（有代码/配置但从未执行）

- 三个 seeded staging 套件（数据源已加，尚无样本）
- 跨语言 conformance 的完整断言矩阵

### ACCEPTED_RISK（明确接受，不再当作已解决）

| 项 | 接受理由 |
|---|---|
| 重复镜像构建（旧 #7） | 实测 artifact 传递与重建同量级 |
| 同 job 内两次 `build-plugins.sh`（旧 #9） | 不同 registry，刻意隔离 |
| `ci-gate` 看不见其它 workflow 的 pending | 跨 workflow `needs` 不存在；已如实报告而非假装覆盖 |

### NEEDS_DECISION（需要产品/架构决策，不是工程问题）

| 项 | 决策点 |
|---|---|
| 三个 seeded 套件最终怎么办 | 积累样本后：提升为阻塞 / 修测试 / 删除 |
| `typed-pipeline-contracts` 是否提升为必需 check | 它可见但不阻塞；提升需要改 Ruleset |
| `full` 层级是否应可在 PR 上触发 | 与「staging 是共享单机」冲突 |
| 是否拆 stacked PR | 本报告第 1 节记录了我的取舍与推翻条件 |

---

## 7. 下一阶段建议（按优先级）

| 优先级 | 任务 | 依赖 | 完成判据 |
|---|---|---|---|
| P0 | Ruleset 加 `ci-gate` | 人工批准 | 一个故意注入 `cargo fmt` 错误的 PR 无法合并 |
| P0 | 定位 C4 的 `opsctl deploy --wait` 300s 挂起 | 真实平台 | spec 从 EXPLICIT_SKIP 变为 COVERED |
| P1 | 完整 Runtime 镜像在 PR 上构建并启动验证 | 新 workflow 或扩展现有 | `/admin` 与 `/app` 均有真实断言，不只是 HTTP 200 |
| P1 | 跨语言 conformance 断言矩阵 | 现有 `conformance` job | TS/Go/Java 对同一组非法输入给出同一错误码 |
| P1 | `full` 层级进入 PR 的路径 | 需要第二台 staging 或隔离 | 三个 seeded 套件在 PR 上有真实结果 |
| P2 | 供应链：SBOM + provenance + 镜像扫描 | release 链 | `docker/build-push-action` 加 `provenance: true`，接 `anchore/scan-action` |
| P2 | pnpm / Docker / Playwright 缓存 | 实测冷热基线 | 有前后对比数字，不是估算 |
| P3 | actionlint / shellcheck 进 CI | 清零 2 条既有 SC2125 | 新 job 为必需 check |

---

## 8. 可复核性

本报告的每个数字都能从仓库或 GitHub 重新得到：

```bash
# 25/25 与合并状态
gh pr checks 120 --repo baicie/ops-1
gh pr view 120 --repo baicie/ops-1 --json mergeStateStatus

# 已发布镜像的 tag 格式（D11 的证据）
TOK=$(curl -s "https://ghcr.io/token?scope=repository:baicie/opsweave:pull&service=ghcr.io" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
curl -s -H "Authorization: Bearer $TOK" \
  "https://ghcr.io/v2/baicie/opsweave/tags/list?n=1000" \
  | python3 -c 'import json,sys,re;t=json.load(sys.stdin)["tags"];print(len(t),"tags;",sum(1 for x in t if x.startswith("sha-")),"sha- prefixed")'

# 本地全部检查
node tests/ci/ci-gate.mjs --selftest
node --test tests/ci/impact.test.mjs
node tests/ci/check-impact-consistency.mjs
node tests/ci/check-spec-coverage.mjs
scripts/contract-bundle-fixture.sh && python3 tests/contract/test_bundle_validation.py
```
