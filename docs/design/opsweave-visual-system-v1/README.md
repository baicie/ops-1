# OpsWeave Visual System V1 — 实施记录

- 状态：**Phase 0 完成；第一标杆 `/admin/overview` 已实现；后续阶段未开始**
- 设计输入：`opsweave-visual-system-v1` 设计包（PROPOSED / NOT IMPLEMENTED，基线 `main@b9a01db`）
- 复核基线：`origin/main@775a1e2`（2026-11-04）
- 决策记录：[ADR-017](../../adr/ADR-017-visual-system-v1.md)
- 关联：[ADR-016 验收分层](../../adr/ADR-016-acceptance-layers-and-code-acceptance-ownership.md)

设计包是提案，不是已实施声明。本目录只记录**本仓库实际做到什么、用什么证据证明、哪些没做**。所有结论按 `PASS / FAIL / NOT_RUN` 分类；没有执行证据的项不写成绿色。

## 权威与边界

冲突时的权威顺序：`AGENTS.md` → `rules/06-ui-ux.md` → `docs/design/ui-visual-v3/spec/*`（normative）→ 本目录的 ADR/记录 → 设计包与历史验收。

本 V1 **不**修改 Kernel/Gateway、数据库、权限、证据认证与 readback 语义；**不**引入第二套 UI 框架、第二套 Token、Storybook 或独立 npm UI 包；**不**自动 Ready/Merge/Release/Deploy。

## 本轮交付

| 交付 | 状态 | 入口 |
|---|---|---|
| 基线与设计决策（DS-V1-0） | PASS（见证据索引） | [phase-0-baseline.md](phase-0-baseline.md) |
| 组件所有权与调用点 | PASS（静态审计） | [component-ownership.md](component-ownership.md) |
| Token/字体冲突与决策 | PASS（决策）；迁移 NOT_RUN | [ADR-017 §D5](../../adr/ADR-017-visual-system-v1.md) |
| 第一标杆 `/admin/overview` | PASS（本地真实 Chromium + 矩阵） | 本文 §第一标杆 |
| Incident 证据 403 / 0-0 语义修复 | PASS（`g11-incident-state-gaps` 6/6 + lifecycle 1/1） | [report §1](report.md) |
| Observability 0/0 / DEGRADED 语义修复 | PASS（`observability-surface` 11/11 + 426 单测） | [report §1](report.md) |
| 三标杆矩阵接入 PR 门禁 | PASS（g12 harness 64 tests；`check-spec-coverage` 30 covered） | [report §2](report.md) |
| 第二/第三标杆（完整视觉重做） | NOT_RUN | 下一阶段 |
| 全局字体/PageHeader/Button 收敛 | NOT_RUN | DS-V1-1 |
| 门禁迁移（route→pattern、route coverage） | NOT_RUN | ADR-017 §D6 |
| 证据与命令 | PASS | [evidence-index.md](evidence-index.md) |
| 交付报告 | PASS（Draft PR 链接在 PR 创建后补） | [report.md](report.md) |

## 第一标杆：`/admin/overview`

保留原有信息架构（健康带 → KPI → 关注/可用性 → 审计），只做与"事实优先"直接相关的改动：

1. **健康判决与计数对账**：Kernel 的 `health` 只由 attention 列表推导，节点 `DEGRADED` 或副本未就绪时仍可能是 `READY`。页面现在只有在 `nodesReady == nodesTotal` 且 `instancesReady == instancesTotal` 时才显示 all-clear；否则 band 呈现 `DEGRADED`，headline 说明"关注列表为空，但模块未全部就绪"，detail 指向第一个不匹配的计数。Kernel 原始码保留在 `data-kernel-health`，不重写 API。
2. **来源与观测时间**：KPI 条下方新增一行来源戳（`Platform overview · observed …` 与 `Kernel diagnostics · observed …`），每个来源各自一次；慢 30s 的诊断不再继承 overview 的时间，`pending/missing` 有独立状态。
3. **事件词表**：incident 生命周期事件（`INCIDENT_CREATED`、`INCIDENT_EVIDENCE_ADDED`、`INCIDENT_VERDICT_RECORDED`、`INCIDENT_CLOSED`、owner 变更）从原始 UPPER_SNAKE 变为 en/zh-CN 句子；未知码仍按协议原样显示。
4. **INFO 严重度图形**：INFO 不再借用"未配置"的虚线圆，新增 `info` 状态（info 图标 + `--ow-info`），图形与文字一致。
5. **测试修正**：`overview-partial.spec.ts` 原先断言未本地化的 Kernel 标题（页面已按 `kernel-messages.ts` 本地化），修正为断言 catalog 文案 + 来源标签；新增 READY 与非就绪计数矛盾的回归测试。

未做：Overview 的 STALE 策略（失败刷新仍替换整页）、shell/页面双轮询合并、逐 KPI 观测时间、信息架构重排。它们需要产品/异步行为决策，记录在 ADR-017 §6。

## 复现

```bash
pnpm --filter @opsweave/platform-web typecheck
pnpm --filter @opsweave/platform-web test
pnpm --filter @opsweave/platform-web build
node scripts/check-i18n.mjs
node scripts/check-status-vocabulary.mjs
node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json
node tests/ci/check-tracked-png-budget.mjs
```

浏览器矩阵与证据路径见 [evidence-index.md](evidence-index.md)。完整矩阵在 `artifacts/ui/visual-v1/{before,after}/`（未跟踪；`.gitignore` 已声明），不进 PNG 预算。
