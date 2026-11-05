# DS-V1-2.1 — Review Closure & Stacked PR Readiness

- 日期：2026-11-05
- 目标 PR：[#35](https://github.com/baicie/ops-1/pull/35)（Draft，base `design/opsweave-visual-system-v1`）
- 基线：#34 `e8d1cbf`（PR #34 Open / Ready / 未合并）
- 本文件所在分支：`design/opsweave-ds-v1-2`
- 结论：**READY_TO_MARK_READY**（PR #35 代码/文档 11/11；stack merge 仍待 #34 合并方式与 staging baseline 决策，见 §5）

## 1. 结论摘要

本轮只做审查收口，没有重新设计 Observability 或 IncidentDetail，也没有改变 Evidence Trust、Incident Lifecycle、AI Investigator、API、数据库或权限契约。

- A：403/503/网络失败（包括“成功空集后刷新失败”）时，Evidence 与 Kernel verified 两张 KPI 都读 UNKNOWN；成功空集仍是 Evidence 0 + Verified NO_DATA。旧代码已用真实浏览器复现为红。
- B：Workbench gate 已拒绝标签/页面/字段/overflow 的缩水，`--update` 与验证共用同一套要求；14 个反事实全部通过。
- C：axe 改为阻断目标 WCAG A/AA 规则的全部违规，并分别扫描 analysis / rail / decision；新增 rail 扫描抓到一个此前漏掉的 1.63:1 对比度缺陷，已修。
- D：#34 若 Merge Commit，retarget 后无需 rebase；若 Squash Merge，必须 `rebase --onto` 或等价重放，否则 PR 会显示 101 个文件。模拟 rebase 成功且树完全一致；本轮未改 base、未 force push。
- E：本地静态/单测/浏览器/确定性 harness 与 GitHub Actions 结果见 §6；NOT_RUN 见 §7。

## 2. A — Incident Evidence KPI 状态优先级

### 2.1 复现

旧代码 `apps/platform-web/src/pages/IncidentDetail.tsx` 中：

```tsx
state={evidence.length === 0 ? 'noData' : evidenceKpiState}
```

403/503 初始读取失败时，`view.evidence` 为 `null`，页面投影成 `evidence = []`；`evidenceKpiState` 本身是 `unknown`，但 `evidence.length === 0` 把它覆盖成 `noData`。同一行的 Evidence 卡读的是 `evidenceKpiState`，于是两张卡互相矛盾。

真实浏览器复现（旧代码，180 秒内）：

```text
a refused evidence read reports UNKNOWN on both KPI cards
Expected: "unknown"
Received: "noData"
```

复现用例：[`tests/ui/incident-evidence-kpi.spec.ts`](../../../tests/ui/incident-evidence-kpi.spec.ts)。

### 2.2 修复

新增 `incidentEvidenceKpiStates(panel, rows)`（[`apps/platform-web/src/incidents.ts`](../../../apps/platform-web/src/incidents.ts)），两张卡共用：

| evidence panel state | rows | Evidence KPI | Verified KPI |
|---|---:|---|---|
| `loading` | 0 | `noData` | `noData` |
| `missing`（kernel 成功回答空集） | 0 | `ready`，显示 0 | `noData`，无 denominator |
| `present` | >0 | `ready` | `ready`，count/total |
| `forbidden` | 0 或 stale rows | `unknown` | `unknown` |
| `unavailable` | 0（初始失败，或上次成功空集后刷新失败） | `unknown` | `unknown` |

`IncidentDetail.tsx` 的 verified 卡不再用行数覆盖状态；行数只决定 denominator 是否存在。成功空集仍按产品契约显示 Evidence 0、Verified NO_DATA（不显示 0/0）。

一个刻意保留的边界：一次失败刷新如果仍有上一次成功读取的行，`evidencePanelState` 仍是 `present`，页面继续显示这些行并在 `IncidentStale` 里写明最近一次读取失败。这不是 503 的空答案，而是“已知的旧快照”；KPI 显示该快照的计数，API 错误、DOM stale banner 与 KPI 三者一致。相反，如果上次成功快照本身就是空集，失败刷新没有可展示的行，`evidencePanelState` 现在返回 `unavailable`，KPI 返回 UNKNOWN，而不是继续显示 Evidence 0。

### 2.3 反事实与测试

- 单测：`apps/platform-web/src/incidents.test.ts` 增加 6 个状态用例；其中一个显式断言 `forbidden/0` 不能等于 `{evidence:'ready', verified:'noData'}`（旧表达式的 Verified 行为），另一个走“成功空集 → [] 保留 → 同 id 刷新 503”的真实路径，断言 `evidencePanelState([], true, 503) === 'unavailable'` 且两张 KPI 都 UNKNOWN。
- 浏览器：`incident-evidence-kpi.spec.ts` 7/7 PASS，覆盖 403、503、网络中断、in-flight、成功空集、空集后刷新失败、成功有行。成功有行用例同时断言 `data-kernel-verified-count` 与 KPI 的 `verified/total`，不再用空字符串匹配任何文本。
- `report.md` §6.1 的原“已处理”声明已更正：本轮之前的代码只修了 Evidence 卡，Verified 卡仍是旧表达式。

## 3. B — Workbench Metrics Gate 加固

`scripts/check-workbench-metrics.mjs` 在普通验证与 `--update` 之间现在共用同一套校验：

- 标签必须恰好是四个精选组合；缺一个或多一个都退出 2。
- `r1440-*` / `r1024-*` 只要求三个宽屏页面；`r768-*` / `r390-*` 还要求 `/app/incidents/:id detail-tab`。桌面不要求 Compact 页。
- 每个必需页面必须有：非空 `regions`（且包含该页面的必需区域）、`gridColumns`（Compact decision 为 null，其余为正整数）、精确的 KPI `cardIds`、精确的 tab 模型、正确的 `visiblePane`、数值 `overflow`、数值 `headerHeight`。
- `overflow: null`、缺字段、错误类型、坏 JSON、缺页面、收窄 baseline、before 模式 artifact 全部失败。
- `--update` 在每个标签都通过必需页面与字段校验后才写文件；失败不会留下收窄的 baseline。

反事实：[`scripts/check-workbench-metrics.test.mjs`](../../../scripts/check-workbench-metrics.test.mjs) **14/14 PASS**，包括：

- 删除一个标签 → 非零；
- 删除 768 的 Compact Decision 页 → 非零；
- artifact / baseline 的 overflow 改为 null → 非零；
- 缺 KPI cards、缺 regions/tabs/visiblePane、错误类型、坏 JSON → 非零；
- 基线收窄为一个页面 → 非零；
- `--update` 缺 Compact 页 → 非零且不写文件；
- before-mode artifact 进入 baseline → 非零；
- 完整四标签、桌面无 Compact 页的 fixture → 0；
- 把 390 dark en 的产物改名为 768 light zh-CN → 非零（config.viewport/theme/locale 与标签不符）；
- `--update` 遇到桌面端类型错误的 optional Detail 页 → 非零且不写文件。

真实 baseline/artifact：`check-workbench-metrics: PASS (4 labels x required pages)`。

## 4. C — Accessibility 证据语义

`tests/ui/workbench-a11y.spec.ts` 不再只阻断 serious/critical：

- axe 规则集仍是 `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`；**所有**返回的 violation 都阻断。
- 每个扫描打印 `violation(s) — critical/serious/moderate/minor` 计数，零也打印，避免“绿色但没扫到”的歧义。
- 1440 / 1024 扫描三栏全部可见的 incident（rail、KPI、timeline、evidence、AI、verdict、lifecycle、audit、identity）。
- 768 / 390 依次扫描 analysis、rail、decision 三个真实可见 tab；隐藏 pane 用 `toBeHidden()` 明确断言，不再只扫默认 tab。
- 键盘焦点环、24px 目标检查保留；目标清单加入 `investigation-rail-filter` 按钮。

新增 rail 扫描后抓到真实缺陷：390 dark 下 rail 过滤 chip 的计数 `#8390a0` on UA ButtonFace `#6b6b6b` = **1.63:1**（serious，8.3pt）。根因是 `.chip` 类只有名字没有 CSS，按钮落回浏览器默认背景。修复为现有 `--ow-chip-*` token pair，并让计数继承 chip ink；复扫 390/768 的 analysis、rail、decision 全部 **0 violations**。

## 5. D — Stack 合并兼容性预检

当前状态（只读核对）：

- #34：base `main`，head `e8d1cbf`，`OPEN`、Ready、`MERGEABLE`/`CLEAN`，18 个提交。
- #35：Draft，base `design/opsweave-visual-system-v1`，head 为本轮交付提交（代码 HEAD `8f4791c`，文档 HEAD `dea1c10`）；c04bc50 的 11/11 是旧提交结果。
- 本轮没有改 base、没有 merge、没有 force push。

### 5.1 #34 使用 Merge Commit

#34 合入 main 后，`e8d1cbf` 是 main 的祖先；把 #35 base 改为 main 即可，merge-base 仍是 `e8d1cbf`，PR 只显示本轮独有改动（最终树 33 个文件 / 2618 insertions / 155 deletions；c04bc50 时是 28 / 1646 / 154）。**不需要 rebase**，也不需要 force push。`git merge-tree --write-tree e8d1cbf c04bc50` 得到 `15c28b98`，正是 `c04bc50` 的树；但最终 HEAD 还有 DS-V1-2.1 的 3 个提交，树已不同，c04bc50 的 11/11 只覆盖 c04bc50。base retarget 和 ready_for_review 都不会触发 workflow，普通 rerun 也仍用旧 base；若流程要求在新 base 上留下 run，需要空提交或 close/reopen 才能触发。

### 5.2 #34 使用 Squash Merge

squash 后 main 的新提交不包含 `e8d1cbf` 祖先，merge-base 回到 `775a1e2`。若直接把 #35 retarget 到 main 而不重放，GitHub 三点 diff 会把 #34 的全部改动算进 #35（最终树 **105 个文件 / 7780 insertions / 1622 deletions**；c04bc50 时是 101 / 6808 / 1621）；GitHub 的 test merge 还会在 **15 个路径**上冲突（14 个 content conflict + `tests/ui/metric-card-matrix.spec.ts` 的 add/add，含 `IncidentDetail.tsx`、`Observability.tsx`、`styles.css`、两个 i18n catalog、observability metrics JSON、g12 workflow/script 等）。直接 retarget 不是可用的合并路径。

本地模拟（`git merge --squash e8d1cbf` 生成临时 squash commit，再 `git rebase --onto <squash> e8d1cbf`）：

- rebase **7/7 提交成功，无冲突**；
- rebase 后树与最终 HEAD **完全一致**（`git diff` 为空）；
- diff 回到本 PR 独有改动（最终树 33 个文件 / 2618 insertions / 155 deletions）；
- 7 个提交全部重放，SHA 全部更新。

因此 squash 场景需要 `rebase --onto main e8d1cbf`（或 cherry-pick 本 PR 的 7 个提交）。这会重写 7 个提交 SHA，推送需要 force push；**本轮未获授权，未执行**。

另一个“不 force push”的选择是把 squash 后的 main merge 进 #35，但它同样会在这 15 个路径冲突，需要手工解冲突并生成 merge commit；不能描述成干净的替代。

### 5.3 CI 与 Staging

- Merge Commit 场景的合并树就是最终 HEAD 的树，但 base retarget/ready_for_review 不触发 workflow，普通 rerun 仍用旧 base；若流程要求新 base 的 run，需空提交或 close/reopen。Squash+rebase 产生 7 个新 SHA，push 会自动触发 11 项 checks。c04bc50 的 11/11 只覆盖 c04bc50；必须等最终 HEAD 的 11 项完成。
- `staging-preview.yml` 在 push 到 `main` 时部署到单一 staging host。分别合并 #34、#35 会触发两次 main push/部署；concurrency group `deploy` 会取消在途的旧部署，但已完成的 #34 部署可能短暂成为线上版本。
- **当前 staging baseline 是红的**：main `775a1e2` 的最新 staging-preview run `41808971270` 结论 failure；deploy job 成功，`smoke the preview` 失败。另 #34 修改 `.github/workflows/staging-preview.yml:1093`，给 `check-ui-metrics` 加了 `--manifest docs/design/ui-visual-v3/spec/route-manifest.json`，这是 PR CI 不会执行的更严格 staging 门禁。合并 #34 前应先确认 staging metrics 基线，或用 `verify_only` 对当前 staging 做一次认证；不要把 PR 的 11/11 当成 staging readiness。
- 两个 PR 的 diff 都没有 `apps/kernel`、`contracts`、`.sql` 或 migration 文件；部署仍会变更共享 staging host 的镜像与进程，因此本轮**没有**触发它。
- PR #35 描述已按两种合并路径更新：Merge Commit 直接 retarget；Squash/Rebase Merge 按 §5.2 重放；并注明 retarget 不会自动触发 workflow。

### 5.4 独立复核回填

独立 reviewer 重新读取源码/测试/git 状态，而不是复述报告。A/B/D 三路在时限内返回，确认并已处理的发现如下；C 路（a11y）未在时限内返回，C 的结论只由实际 axe 运行、4 个宽度 × analysis/rail/decision 扫描和新增 rail 缺陷复现支撑，不声称该 reviewer 已签收。

| ID | 发现 | 处理 |
|---|---|---|
| A1 | 成功有行用例只用空字符串匹配 Verified，未断言分子 | 改为读取 `data-kernel-verified-count`，断言 KPI 的 `verified/total`；错误分子现在会失败 |
| A2 | “成功空集后刷新失败”仍被当成 `missing`，显示 Evidence 0；单测名不副实 | `evidencePanelState` 对 failed + 空快照返回 `unavailable`；新增单测与浏览器反事实，KPI 两张卡 UNKNOWN |
| B1 | 四个标签只校验文件名，未校验 viewport/theme/locale，可把 390 产物改名成 768 | `readArtifact` 从标签推导 width/theme/locale 并要求 config 匹配；新增 relabel 反事实 |
| B2 | `--update` 静默忽略桌面端类型错误的 optional Detail 页 | 改为按 key 存在性校验；新增反事实，失败不写 baseline |
| D1 | Squash 后直接 retarget 存在 15 个冲突路径（14 content + 1 add/add）；“merge main 进 #35”不是干净替代 | §5.2 已写明冲突路径，并保留 rebase --onto 为唯一干净路径（需 force-push 授权） |
| D2 | retarget/ready 不触发 workflow；plain rerun 仍用旧 base | §5.1/§5.3 已区分 Merge Commit 同树证据与 Squash 新 SHA 的 CI 要求 |
| D3 | main 当前 staging baseline 红；#34 给 staging metrics 加 `--manifest` | §5.3 已记录 run `41808971270` 的 smoke 失败与合并前 verify_only 建议 |
| D4 | PR #35 描述仍写 “no commits need to move” | 已更新 PR #35 描述，区分 Merge Commit 与 Squash/Rebase Merge 两条路径 |
| D5 | 预检数字绑定 c04bc50，最终 HEAD 已变化 | §5 已按最终 HEAD 重算（105/7780/1622 direct retarget；33/2618/155 rebase 后）；合并机制结论不变 |

## 6. E — 最终验证

| 检查 | 结果 |
|---|---|
| `pnpm --filter @opsweave/platform-web typecheck` | PASS |
| `pnpm --filter @opsweave/platform-web exec vitest run` | PASS — 31 files / 442 tests |
| `pnpm --filter @opsweave/platform-web build` | PASS |
| `node scripts/check-i18n.mjs` | PASS — 1,965 keys × 2，17 条既有 unused warning |
| `node scripts/check-status-vocabulary.mjs` | PASS — 43 codes |
| `node scripts/check-ui-tokens.mjs --ratchet …` | PASS — 0/0/0/0/0/0 |
| `node tests/ci/check-tracked-png-budget.mjs` | PASS — 408 files / 65.97 MB，预算未提高 |
| `node scripts/check-workbench-metrics.mjs …` | PASS — 4 labels × required pages |
| `node --test scripts/check-workbench-metrics.test.mjs` | PASS — 14/14 |
| `workbench-a11y.spec.ts` | PASS — 3/3，所有扫描 0 violations |
| `incident-evidence-kpi.spec.ts` | PASS — 7/7 |
| G11/G12 lifecycle | PASS（完整 harness 内） |
| `bash tests/ci/g12_acceptance_ci.sh` | PASS — 109 tests（107/2），9.8m；acceptance 195/0；exit 0 |
| GitHub Actions 最新 HEAD | **PASS — 11/11**（`dea1c10`） |

最终完整 harness（提交前的同一棵树）：

```text
PASS — 109 browser tests（107 passed / 2 skipped，9.8m）
acceptance 195 / 0；workbench regression gate -> PASS
workbench gate counterfactuals -> PASS（14/14）；exit 0
```

GitHub Actions（代码+文档 HEAD `dea1c10`）：

```text
PASS — 11/11 checks
acceptance 14m53s；golden-path 17m4s；runtime-golden-path 17m49s
legacy-regression 6m5s；rust 2m2s；web 47s；web-unit 48s
quality-faults 40s；contracts 12s；artifact-budget 9s；spec-coverage 10s
```

## 7. 剩余项

**P0**：无。

**P1**：无未关闭项。A 段的 KPI 矛盾、C 段的隐藏 rail 对比度均已有复现与回归用例。

**P2 / NOT_RUN**：

- 像素级 visual diff：NOT_RUN，仍用 JSON 结构基线替代（PNG 预算不增加）。
- Docker / 完整 staging 套件：NOT_RUN（本机 Docker 不可用；本轮未部署）。
- 虚拟键盘遮挡：NOT_RUN。
- `IncidentView v1` 仍无 per-incident workspace 字段；不伪造。
- 桌面端 Compact 页不要求存在，但若存在会被同规则校验；这是有意的。
- 完整 harness 的 Docker/Studio 两个 skip 与既有 acceptance skip 继续按原记录报告。
- #34 squash 场景的 force push 仍未获授权；本轮保持 #35 base 不变。

## 8. 结论

**READY_TO_MARK_READY**：实现、反事实、本地门禁、独立复核和最新 HEAD 的 11 项 checks 已完成。Stack merge 仍是 **PARTIAL**：需要先决定 #34 的合并方式（Squash 场景需 force-push 授权）、确认 staging baseline 转绿；本报告为文档更新提交，不改变代码。本轮**不**转 Ready、不 Merge、不 Tag、不 Release、不 Deploy。
