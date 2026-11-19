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

**实测证据，这是整份提案的支点：**

```bash
$ gh api "repos/baicie/ops-1/commits/9b4e4e145b0825e5e76f304cadd82c5e3dd9238b/check-runs?per_page=100" \
    --jq '.check_runs[]|select(.name=="ci-gate")|"\(.name): \(.conclusion)"'
ci-gate: failure
$ gh pr view 149 --json state,mergedAt,mergeCommit --jq '"state=\(.state) merged=\(.mergedAt) commit=\(.mergeCommit.oid[0:7])"'
state=MERGED merged=2026-11-19T04:13:23Z commit=9b4e4e1
```

`ci-gate` 判 `failure`，同一棵树的 PR **合入了**。`ci-gate` 做对了它该做的每件事——
它读到了 `deploy to staging host` 的失败并如实报告——只是它的结论没有强制力。

这就是「测试覆盖好、门禁强制力坏」的一句话版本。

### 建议（需要人工授权，不得自行执行）

把 `ci-gate` 加入 ruleset 的必需 check 列表。这是一行改动，已在
`ruleset-migration.md` 里写明完整方案与回滚。

**代价必须一起接受**：`ci-gate` 现在会等 delegated suite 完成（有界，35 分钟）。所以
一个 PR 的最坏等待时间从「九项里最慢的」变成「它要求的所有 suite 里最慢的」，实测
`data-foundation` p95 是 34 分钟。这是用时间换真实性。

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
| L0 静态与策略 | `spec-coverage`（必需）、`artifact-budget`（gate-only）、`contracts`（必需） | 无 actionlint、无 shellcheck、无 workflow 安全扫描 |
| L1 核心 CI | `rust`、`web`、`web-unit`、`platform-only`、`platform-image-build`（全部必需） | — |
| L2 影响驱动验收 | `scope` 决定 `g13*` 与 `runtime-image-build`；但 `data-foundation`、`g12-acceptance`、`plugin-lifecycle`、`runtime-conformance` 由**各自 workflow 的 paths 过滤**决定，不经过 `scope` | 两套判定机制并存，`check-impact-consistency.mjs` 在比对它们（52 个 warning） |
| L3 全量 | 无 nightly 全量 workflow | `staging-preview` 有 `schedule`，但它部署，不是纯验证 |

**建议（按性价比排序）**：

1. **把 `ci-gate` 变成必需** —— 一行 ruleset 改动，让 17 个 check 的判决生效。最高杠杆。
2. **补 actionlint / shellcheck 到 L0** —— 便宜，能抓 YAML 与 Shell 的真错。
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
