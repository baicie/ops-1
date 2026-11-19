# CI/CD 架构提案

**基线 `ec7ff1f`（2026-11-19）。本文件给结论，证据在 `baseline.md` /
`coverage-matrix.md` / `failure-analysis.md` / `workflow-inventory.md`。**

不重复那些文件已有的表格。这里只写：哪里坏了、为什么、以及建议怎么改。

---

## 1. 一句话结论

**这套 CI 的测试覆盖是好的，门禁的真实强制力是坏的。**

35 个 job 里 9 个被 ruleset 强制，其余 17 个只由 `ci-gate` 判决，而 `ci-gate` **本身不是
必需检查**。所以「插件生命周期」「多语言一致性」「分布式恢复」「安全负例」这些最贵的验收，
实际上**没有任何东西强制它们**——它们红了，合并照常。

这不是配置疏忽，是一个自我强化的结构：`ci-gate` 越准确（比如 #146 之后它会因 staging 部署
失败而判红），它被忽略得越多，因为红是常态。

## 2. 门禁结构：现状与断层

```
                    ┌─────────────────────────────┐
   pull_request ───▶│ 9 个 ruleset 必需 check      │─── 真正阻止合并
                    │ rust web web-unit contracts  │
                    │ spec-coverage platform-only  │
                    │ platform-image-build         │
                    │ quality-faults linux-runtime │
                    └─────────────────────────────┘

                    ┌─────────────────────────────┐
                    │ 17 个其它 check              │
                    │ golden-path acceptance       │
                    │ full TypeScript lifecycle    │
                    │ conformance zabbix-plugin    │
                    │ g13* b2-* artifact-budget    │
                    │ runtime-image-build          │
                    │ deploy to staging host ...   │
                    └──────────────┬──────────────┘
                                   │ 全部读入
                                   ▼
                    ┌─────────────────────────────┐
                    │ ci-gate                      │─── 判 FAIL
                    │ （不是必需 check）           │─── 但合并照常进行
                    └─────────────────────────────┘
```

**证据，以及一个我先写错、本轮纠正的断言。**

早先这份文件说：「PR #149 的 `ci-gate` 判 failure 而 PR 仍然合入，证明红色门禁可被绕过。」
**那是错的。** 两个不同的 SHA 被混为一谈：

```bash
$ gh pr view 149 --json headRefOid,mergeCommit
{"head":"621a12af09065fef586b54f97b5dc44bd80921ce",
 "merge":"9b4e4e145b0825e5e76f304cadd82c5e3dd9238b"}

$ gh api ".../commits/621a12af.../check-runs" --jq '..select(.name=="ci-gate")'
ci-gate: success          <- PR HEAD：合并时它是绿的

$ gh api ".../commits/9b4e4e14.../check-runs" --jq '...select(.name=="ci-gate")'
ci-gate: failure          <- 合并提交，来自合并后 main 上的 push
```

- `621a12af` 是 PR 的 head，它的 `ci-gate` 是 **success**。
- `9b4e4e14` 是 squash 后的 merge commit，`ci-gate` 是 **failure**——那次运行发生在**合并
  之后**，由 `main` 的 push 触发。
- **push 上的 workflow 无法阻止一个已经完成的合并。** 所以它证明的是「合并后验证失败」，
  不是「该 PR 绕过了失败的检查」。

**真正成立的事实，也是唯一需要的事实：** ruleset `26958761` 没有把 `ci-gate` 列为必需
context，所以它不具备独立的 GitHub 合并强制力。这个结论不依赖上面那组错误的对比——
它只需要读一次 ruleset：

```bash
$ gh api repos/baicie/ops-1/rulesets/26958761 \
    --jq '.rules[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context'
rust web web-unit contracts spec-coverage platform-only platform-image-build quality-faults linux-runtime
```

九项，没有 `ci-gate`。

**并且 `ci-gate` 目前的判决本身也需要修正**：它把 `staging-preview.yml` 的
`deploy to staging host` 失败算成了 merge-gate 失败（见 §2.1）。在修正之前，
把它设成必需检查会让**每一次 staging 故障都阻止所有代码合并**——这正是本轮的 TASK-02。

### 建议（需要人工授权，不得自行执行）

把 `ci-gate` 加入 ruleset 的必需 check 列表。已在 `ruleset-migration.md` 里写明完整
方案、前置检查与回滚。

**但前提是 §2.1 的修复先落地。** 这是 TASK-02 揭示的：在归属边界被修正之前，
`ci-gate` 会把 `staging-preview.yml` 的部署失败算成 merge 失败。把它设成必需检
查，等于让一次 staging 容量故障冻结**仓库上全部代码合并**。

修复后（#159）：

```
GATE_OWNERSHIP = {
  'ci.yml': 'merge', 'data-foundation.yml': 'merge', 'g12-acceptance.yml': 'merge',
  'plugin-lifecycle.yml': 'merge', 'runtime-conformance.yml': 'merge',
  'reliability.yml': 'merge', 'platform-linux-acceptance.yml': 'merge',
  'typed-pipeline-contracts.yml': 'merge',
  'staging-preview.yml': 'deployment',      <- 报告，永不阻止合并
}
```

#### §2.1 归属边界（TASK-02）

三个不同的门，三个不同的所有者：

| 门 | 回答什么 | 谁拥有 |
|---|---|---|
| Merge Gate | 这份代码可以合吗？ | `ci-gate` |
| Release Gate | 这个制品是它声称的那个吗？ | 构建 + 签名 + digest |
| Deployment Gate | 它真的部署了并保持健康吗？ | `staging-preview.yml` |

`ci-gate` 是 **Merge Gate**。它必须决定第一个，**不得**决定后两个——一次失败的
staging 部署是关于环境的陈述，不是关于补丁的，部署在修的时候一个代码没问题的 PR
必须仍然可合并。

归属按**workflow 文件**判定，不是按 check 名：名字是作者选的字符串，两个 workflow
可以产生同一个，而 workflow 可以在无人察觉的情况下改 job 名。

**不是「未知的都忽略」**——那是另一种失效：

- 未登记 workflow 的红 check **fail closed**，并指名是哪个
- 完全无法归属的 check 也 fail closed
- `OWNERSHIP COMPLETENESS` 遍历 `.github/workflows/`，未登记或有陈旧条目就红

**代价必须一起接受**：`ci-gate` 会等 delegated suite 完成（有界）。一个 PR 的最坏等待
从「九项里最慢的」变成「它要求的 suite 里最慢的那个」——**是 max，不是 sum**。
实测 `data-foundation` p95 是 2040 s（34 分钟），`ci-gate` job 最长一次 1591 s。

**如果不接受这个代价**，替代方案是把 `golden-path`、`acceptance`、
`full TypeScript lifecycle`、`conformance` 加进 ruleset——但那样会在路径不匹配的 PR 上
制造永久 Pending（它们的 workflow 都带 `paths` 过滤），比现状更糟。两者相权，`ci-gate`
是唯一自洽的选择。

## 3. 测试重复：任务书担心的重复不存在，真正的问题是别的

任务书列了「三个 workflow 重复执行 `cargo fmt` / `cargo clippy` / `cargo test` /
`data_foundation_ci.sh`」。逐项核实（`workflow-inventory.md` 末尾有矩阵）：

| 任务书的判断 | 实测 |
|---|---|
| `data_foundation_ci.sh` 在三个 workflow 跑 | **只有一个**（`data-foundation.yml`） |
| `cargo test` 重复 | `rust` job 跑 `--workspace`；`platform-only` 跑两种 feature set。**这是三个不同的编译配置，不是重复** |
| `build-plugins.sh` 重复 | 两处，但 registry 端口不同（5002 vs 5015/5016），合并会直接撞端口 |

**真正的重复不在任务书列的地方。** 它在这里：

`ci.yml` 的 18 个 job 里，`rust`、`web`、`web-unit`、`contracts`、`platform-only`、
`platform-image-build` 各自独立 `pnpm install` / `cargo build`。`Swatinem/rust-cache` 与
pnpm store 缓存缓解了网络成本，但**编译本身仍然各做各的**。`ci.yml` 的 p50 是 1462s，
其中并行度已经很高，真正的改进空间在 suite 自身的运行时长（`data-foundation` 34 分钟），
不在 job 编排。

**建议：不合并这些 job。** 它们是不同 feature set / 不同断言面，合并会牺牲隔离换来的
诊断能力。若要省时间，应该优化 `data_foundation_ci.sh` 的 45 步本身——那是 TASK-24 的范围，
本轮不做。

## 4. 发布可信度：三个独立缺陷

### 4.1 发布链从不 `activate`（B-18）

```
bundle → install → deploy --wait
```

没有 `activate`。而 `route_candidates` 要求 `r.status = 'ACTIVE'`。所以这个脚本装好并部署
的插件**永远不会被 Gateway 路由**——即使实例健康、容量充足。

这是「点治理就退出登录」的第二个根因，与容量问题独立且更根本。

### 4.2 三个 browser suite 在常规部署里 `skipped`

`staging-preview.yml:52-58` 自己写明：三个 seeded-data suite 只在 `full` tier 运行，
而 `full` tier 只能通过 `workflow_dispatch` 到达，**没人 nightly dispatch**。所以它们在
常规 push 部署里是 `skipped`，名字里的 `[known-flaky]` 从未被任何数据点证实或推翻。

### 4.3 `verify_only` 手动运行不发布

`if: inputs.verify_only != true` 跳过发布。nightly（`schedule`）不受影响——`schedule`
没有 inputs，`verify_only` 取默认 `false`。但一次**手动**的 verify-only 运行无法发现插件
回归。

## 5. 供应链与权限：现状是健康的

| 项 | 状态 |
|---|---|
| workflow 级权限 | `contents: read` 为默认；`ci-gate` 额外 `checks: read` + `actions: read`，只读 |
| PR 是否接触部署密钥 | **否**：`STAGING_*` secrets 只在 `staging-preview.yml` 的 deploy job 里 |
| Action 固定方式 | 见 §5.1 |
| 制品 digest | 部署用 `docker manifest inspect` 取 digest（`deploy-staging.sh`），但**发布脚本只核对本地 `RepoDigests`**（B-19） |
| SBOM / provenance | 未见；`build` job 只推镜像 |

### 5.1 Action 版本固定的实测

```bash
$ grep -rhoE 'uses: [^ ]+' .github/workflows/ | sed 's/uses: //' | sort | uniq -c | sort -rn
  32 actions/checkout@v4
  21 actions/setup-node@v4
  15 pnpm/action-setup@v4
  14 dtolnay/rust-toolchain@stable
  14 actions/upload-artifact@v4
  13 Swatinem/rust-cache@v2
   3 actions/setup-java@v4
   3 actions/setup-go@v5
   2 actions/setup-python@v5
   1 docker/setup-buildx-action@v3
   1 docker/login-action@v3
   1 docker/build-push-action@v6
   1 actions/download-artifact@v4
```

13 个不同的 action，**全部按可变 tag 固定**（`@v4`、`@v5`、`@stable`），没有一个用完整
commit SHA。`dtolnay/rust-toolchain@stable` 尤其要提：`@stable` 是**移动目标**，它指向的
toolchain 会随上游变化，所以同一个 SHA 的仓库在不同时间可能用不同的 Rust 版本编译。

**这是未做的加固项，不是已完成的。** 按 SHA 固定需要为 13 个 action × 各自仓库解析一次
commit，并且此后由 Dependabot 或人工更新——工作量真实，收益是「上游 tag 被重指」这一类
供应链攻击不再可能。本轮不做，列在这里而不是写成「已加固」。

## 6. L0–L3 分层：现状与建议

任务书要求四层。现状是**两层半**：

| 层 | 现状 | 缺口 |
|---|---|---|
| L0 静态与策略 | `spec-coverage`（必需）、`artifact-budget`（gate-only）、`contracts`（必需）、**`lint`（actionlint + shellcheck，gate-only）** | 无 workflow 安全扫描（权限/注入类） |
| L1 核心 CI | `rust`、`web`、`web-unit`、`platform-only`、`platform-image-build`（全部必需） | — |
| L2 影响驱动验收 | `scope` 决定 `g13*` 与 `runtime-image-build`；但 `data-foundation`、`g12-acceptance`、`plugin-lifecycle`、`runtime-conformance` 由**各自 workflow 的 paths 过滤**决定，不经过 `scope` | 两套判定机制并存，`check-impact-consistency.mjs` 在比对它们（52 个 warning） |
| L3 全量 | 无 nightly 全量 workflow | `staging-preview` 有 `schedule`，但它部署，不是纯验证 |

**建议（按性价比排序）**：

1. **把 `ci-gate` 变成必需** —— 一行 ruleset 改动，让 17 个 check 的判决生效。最高杠杆。
2. ~~补 actionlint / shellcheck 到 L0~~ —— **已做**（#156）。第一次运行就抓到两个潜伏缺陷：
   `ci.yml` 里未加引号的 `DATABASE_URL=...?sslmode=disable`（SC2125）与
   `platform-linux-acceptance.yml:465` 的 `cat f | tail`（SC2002）。
   注意 pin 的是 actionlint **1.7.7**：本地 Homebrew 的 1.7.12 当时报 0 问题，
   CI 报 SC2002，**版本差是全部原因**。
3. **把 `check-impact-consistency.mjs` 的 52 个 warning 分类** —— 它们现在是噪音，
   降噪之后才能当门禁用。
4. **新增纯验证的 nightly** —— 复用现有 suite，只在 `schedule` 触发，不部署。

不做的：不为「四层」而拆文件。当前 9 个 workflow 的划分是按**触发条件与运行时长**分的，
这是对的划分依据；强行收敛成 6 个会牺牲诊断能力。

## 7. 本轮的边界

- **不修改 ruleset**（任务书 §12.6 / §13 禁止）。
- **不触发真实 staging 部署**。
- **不删除任何旧 workflow**：`typed-pipeline-runtime.yml` 已经在上一轮被移除，本轮不再动。
- 本轮实际改动：文档修正、`GATE_BUDGET_MS` 接线与预算修正、以及若干测试。

## 8. 复现

```bash
gh api repos/baicie/ops-1/rulesets/26958761 --jq '.rules[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context'
node tests/ci/check-spec-coverage.mjs
node tests/ci/check-impact-consistency.mjs
grep -rhoE 'uses: [^ ]+' .github/workflows/ | sort | uniq -c | sort -rn
```
