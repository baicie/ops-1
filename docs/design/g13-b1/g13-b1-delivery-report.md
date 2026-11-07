# OpsWeave G13 Automation Correctness & Reliability Closure — Delivery Report

- 日期：2026-11-08
- 任务来源：`/tmp/g13-task.md`
- 基线：`main` `0112f7e4c69d1b12e3cf8e9b30ecdd0becd64cfe`（fetch 后确认 origin/main 未移动；无未合并 PR；工作区 clean）
- 交付方式：4 个 Draft PR，stacked，不合并、不推 main
- 真实 Zabbix：**REAL_ZABBIX_VERIFIED = NOT_RUN**（本环境无真实 Zabbix；所有上游均为标注 Fixture）

## A. Git Baseline 与交付物

| 项 | 值 |
|---|---|
| 起始 SHA | `0112f7e4c69d1b12e3cf8e9b30ecdd0becd64cfe` |
| 最终 SHA（栈顶代码） | `4e37269`（`fix/g13-b1-event-principal-recovery`，含清理与跨切片 fixture 修复；本报告提交在其上） |
| 切片 SHA | B1.4 `93579dd` + 清理 `689c58e`；B1.5 `2b04a3a`；B1.6 `7daf2ac` + 清理 `6aedd0b` + fixture `2251df3`；B1.7 `a959150` + 清理 `4e37269` |
| Diff 总量 | 29 files, +6408 / −339（含 4 个迁移、3 个验收脚本、1 个 Playwright spec、2 个设计文档） |
| 工作区 | clean（`artifacts/g13b14/` 为未跟踪截图，CI artifact，不入库） |

### PR 列表与合并顺序

| 顺序 | PR | 分支 → base | 内容 | 状态 |
|---|---|---|---|---|
| 1 | [#55](https://github.com/baicie/ops-1/pull/55) | `fix/g13-b1-operator-ownership` → `main` | B1.4 Operator 待认领队列 + Claim/Release + 前端 | Draft |
| 2 | [#56](https://github.com/baicie/ops-1/pull/56) | `fix/g13-b1-automation-fencing` → #55 | B1.5 Worker lease fencing | Draft |
| 3 | [#57](https://github.com/baicie/ops-1/pull/57) | `fix/g13-b1-evidence-exactly-once` → #56 | B1.6 每 Job 一条 Evidence effect + ADR | Draft |
| 4 | [#58](https://github.com/baicie/ops-1/pull/58) | `fix/g13-b1-event-principal-recovery` → #57 | B1.7 Event 并发去重 + Principal 生命周期 | Draft |

合并必须按 1→2→3→4 顺序；每个 PR 的 base 是前一个切片，不是 `main`。

## B. Core Review

审查文件：`apps/kernel/src/{automation,automation_flow,automation_worker,telemetry_events,telemetry_sources,incidents,scope,investigations,jobs,audit,capabilities,routes}.rs`；`apps/node/src/{runtime,worker_supervisor}.rs`；`plugins/zabbix-source/backend/`；`apps/platform-web/src/pages/{Incidents,IncidentDetail,incident-collect}.tsx`；迁移 `0016`–`0030`；契约与 CI；`tests/acceptance`、`tests/ui`。

核心调用链：

```
plugin EVENT_INGEST -> ingest -> store_event(tx: incident+event+job+audit)
  -> worker.claim(fenced) -> load_principal_for_execution
  -> collect_and_append -> plugin collect -> attestation -> evidence(job-bound)
  -> finish_success(fenced, receipt-first on retry)
Operator -> /incidents/claimable -> claim(CAS) -> evidence -> verdict -> close
```

### 已确认问题（全部有运行时复现）

1. **B1.4**：自动 Incident 归服务账号，Operator 行规则是 `owner=caller`；Operator 无法列出/读取/追加证据/裁决。运行时复现：`telemetry_events::tests::an_unclaimed_automation_incident_stays_invisible_to_the_operator_row_rule`。
2. **B1.5**：终态只按 `job_id` 写；旧 Worker 可覆盖新结果。运行时复现：`automation_worker::fencing_tests::a_stale_worker_cannot_overwrite_the_new_workers_result`（修复前版本 `repro_*` 显示 A 覆盖 B 的 evidence、并把 SUCCEEDED 改成 RETRY_WAIT）。
3. **B1.6**：Evidence 与 Job 成功分两个事务；重试产生第二条 Evidence。运行时状态复现 + 修复后 6 项 effect 测试 + 真实 worker 验收。
4. **B1.7A**：不同 Event Key 并发读后写，败者收到 SQLSTATE 23505 → INTERNAL 500，Event 回滚。复现：`the_pre_fix_insert_shape_gives_the_loser_a_raw_unique_violation`；修复后 64 路并发通过。
5. **B1.7B**：入队 token 的 300s TTL 被当作 Job 失败条件；合法任务因过期永久失败。修复：任务持久性与凭证时效分离。

### 被证伪的怀疑

- “自动 Incident 没有 owner”：不成立，有服务账号 owner。
- “自动化可给 CONCLUDED 追加证据”：不成立，已有显式拒绝。
- “Worker 无重试上限”：不成立，`max_attempts=3`。
- “相同 Idempotency-Key 会创建第二个 Incident”：不成立，既有测试已覆盖。

### 新发现

- B1.5 的 `let _ = audit::record(...)` 会静默忽略终态审计失败；已改为与终态同事务。
- 新增 DB 测试的清理顺序违反 0025 verdict 删除守卫，遗留 fixture 用户，导致共享数据库上下一次 Kernel 启动跳过 bootstrap admin（CI `runtime-golden-path` 登录失败）。已修复并用“同一 DB 先跑全量测试、再启动 Kernel 登录 200”验证。

## C. Correctness Matrix

| 不变量 | 原始问题 | 修复位置 | 测试 | 状态 |
|---|---|---|---|---|
| 合法 Operator 可闭环自动 Incident；不扩大普通读取 | 服务账号 owner 与 OwnedRows 不相交 | `incident_claims.rs`；迁移 0031；`Incidents.tsx`/`IncidentDetail.tsx` | 6 项 Rust + 35 项 HTTP 验收 + 4 项浏览器 | FIXED |
| 双人并发 Claim 仅一个成功 | 无 claim 概念 | `claim` FOR UPDATE + CAS | `two_operators_claiming_at_once_have_exactly_one_winner` | FIXED |
| 旧 Worker 不能覆盖新结果 | 终态按 job_id 写 | `automation_worker.rs`；迁移 0032 | 10 项 fencing/故障注入 | FIXED |
| 同一 Job 至多一条逻辑 Evidence | 唯一键只覆盖相同内容 | `incidents.rs` job 绑定；迁移 0033；`automation_flow.rs` receipt-first | 6 项 effect + 真实 worker 9/9 | FIXED |
| 不同 Job 相同内容不合并 | 旧 tuple 唯一键会合并 | 拆分部分唯一索引 | `different_jobs_with_identical_content_are_two_rows` | FIXED |
| Event 并发去重且不丢合法 Event | SELECT-then-INSERT 冲突 500 | `telemetry_events.rs` ON CONFLICT + 重读 | 64 并发 + 16 同 key + 乱序/复发/跨域 | FIXED |
| 持久 Job 不因凭证过期丢失；撤销阻断新执行 | TTL 当失败条件 | `automation.rs load_principal_for_execution` | 4 项 Rust + 真实 worker 10/10 | FIXED |
| 审计与终态一致 | `let _ =` 静默失败 | 同事务 `record_in_tx` | `a_failed_audit_rolls_the_terminal_state_back` | FIXED |
| Human Verdict 写一次、Evidence 不可篡改 | — | 未改既有规则 | 既有 G12 测试 + B1.6 结论用例 | UNCHANGED / PASS |

## D. Verification Matrix

| 检查项 | 命令 / Run | 真实结果 | 证据 |
|---|---|---|---|
| Kernel 全量（真实 PG 17） | `cargo test --locked -p opsweave-kernel` | **256 passed / 0 failed** | 本地隔离库 + CI `rust` |
| 全 Workspace 测试 | `cargo test --locked --workspace` | 全部 crate 通过（kernel 256） | 本地 + `runtime-golden-path` |
| 严格 lint | `cargo clippy --workspace --all-targets -- -D warnings` | PASS | 本地 + CI |
| 格式 | `cargo fmt --all -- --check` | PASS | 本地 + CI |
| Migration 空库 / 前向 | 隔离库从 0 迁移到 0033；旧库 6 条 historical evidence 保留 | PASS | `_sqlx_migrations` + 计数 |
| 契约 | `python3 tests/contract/validate_contracts.py` | PASS（17 schemas） | 本地 + CI |
| Web 类型 | `pnpm --filter @opsweave/platform-web typecheck` | PASS | 本地 + CI |
| Web 单测 | `pnpm --filter @opsweave/platform-web test` | **467 passed** | 本地 + CI `web-unit` |
| i18n / status / token / spec | 4 个脚本 | PASS；`41 covered, 0 unreferenced` | 本地 + CI |
| B1.4 真实 HTTP | `tests/acceptance/g13_b14_claim.sh` | **35 passed / 0 failed** | `g13b14-claim` job PASS |
| B1.4 真实浏览器 | `playwright test g13b14-claim.spec.ts` | **4 passed**；1440/1024/390 × light/dark | 截图 `artifacts/g13b14/`；job PASS |
| B1.6 真实 worker | `tests/acceptance/g13_b16_effect.sh` | **9 passed / 0 failed** | `g13b16-effect` job；同一 Kernel 上与 B1.4/B1.7 串行复跑 9/9 |
| B1.7 真实 worker | `tests/acceptance/g13_b17_principal.sh` | **10 passed / 0 failed** | `g13b17-principal` job |
| 真实 Node/OCI Gateway E2E | `tests/ci/g13a1_gateway_e2e.sh` | PASS（仓库既有 E2E，未含 Claim 步骤） | CI `g13a1-gateway` |
| G12 验收 / golden path | `acceptance`、`golden-path`、`legacy-regression`、`quality-faults` | PASS | CI |
| 运行时 golden path（共享 DB） | `cargo test --workspace` 后在同一 DB 启动 Kernel 并登录 | 登录 **200**，bootstrap admin created；CI 待复跑 | 本地同序模拟 |
| 单 Kernel 串行验收 | 同一 DB 依次运行 B1.4/B1.6/B1.7 脚本 | **35/35、9/9、10/10** | 本地 `opsweave_final` |
| 真实 Zabbix | — | **NOT_RUN** | 无真实 Zabbix |

### 故障注入/并发场景（全部真实 PostgreSQL，可重复）

Worker kill / crash：`a_restarted_worker_recovers_a_committed_effect_without_collecting_again`、`exhausted_jobs_are_reaped_instead_of_staying_running_forever`；
Kernel restart 等价：租约过期接管测试；
Lease expiry：`a_stale_worker_cannot_overwrite_the_new_workers_result`；
Lost lease stale completion：同上 + `a_retry_clears_the_lease_and_the_next_claim_advances_the_fence`；
PostgreSQL disconnect：`a_database_failure_does_not_report_a_terminal_state`；
Duplicate Event：`concurrent_same_key_retries_answer_with_one_event`、`concurrent_distinct_event_keys_create_one_incident_and_keep_every_event`；
Evidence committed/Job unconfirmed：B1.6 两项 + 真实 worker 验收；
Concurrent incident creation：64 路并发；
Audit failure：`a_failed_audit_rolls_the_terminal_state_back`；
Incident concluded during execution：`a_concluded_incident_still_returns_an_effect_that_already_committed`。

## E. Security Findings

| 级别 | 问题 | 前提/影响 | 修复 | 残余风险 |
|---|---|---|---|---|
| P0 | 无 | — | — | — |
| P1 | 旧 Worker 覆盖终态/证据 | 租约过期后旧进程恢复；审计与证据归因错误 | B1.5 fence + 同事务审计 | 极端时钟回拨；仍由数据库时钟仲裁 |
| P1 | 同一 Job 重复 Evidence | Evidence 提交后 Job 未确认 | B1.6 job 唯一绑定 + receipt-first | 外部 RPC 仍 at-least-once |
| P1 | Event 并发 500 / Event 丢失关联 | 两个不同 key 同 nativeId 并发 | ON CONFLICT + 重读 | HTTP 层 64 路未单独压测 |
| P1 | 合法 Job 因 token 过期永久失败 | 队列积压 >300s | 任务/凭证分离 + 120s 执行凭证 | 执行中撤销不取消在途 RPC |
| P1 | Operator 无法处理自动 Incident | owner=服务账号 | claim 队列 + CAS + 审计 | 队列无 cursor，单页 50 |
| P2 | 测试清理泄漏阻塞 bootstrap | 共享 DB 上 verdict RESTRICT | 清理顺序 + 0025 事务级例外 | 其他旧测试未逐一审计 |
| P2 | `let _ = audit::record` 静默失败 | 终态无审计 | 同事务 `record_in_tx` | — |
| P2 | 不同 job 相同内容两行 | 展示上可能出现两条相同证据 | ADR 明确接受（不同 effect） | 需 UI 以 job/来源区分（当前显示 source） |

## F. Delivery Decision

| 维度 | 判定 | 依据 |
|---|---|---|
| CODE_READY | **PASS** | 4 个 PR 可构建；Rust/Web/lint/format/contract/i18n 全绿；迁移前向可用 |
| CORRECTNESS_READY | **PASS** | 四类核心不变量均有真实 PG 复现与回归；64 路并发、10 项 fencing、6 项 effect、4 项 principal |
| INTEGRATION_READY | **PARTIAL** | 真实 PG + 真实 HTTP + 真实浏览器 + 既有 Gateway E2E 通过；但 Event→Job→Collect→Attestation→Evidence→Claim→Verdict 的**单条全链路**未在一次运行中串起；真实 Zabbix NOT_RUN |
| UI_READY | **PASS** | 真实浏览器 4/4，1440/1024/390 × light/dark，键盘/加载/空/403/409/网络失败 |
| PRODUCTION_READY | **BLOCKED** | PR 仍为 Draft、未合并；迁移未上生产；无真实 Zabbix/生产凭据；需人工评审与发布评审 |

## G. Next Recommended Work

1. **单条全链路 E2E（高）**：在 `tests/ci/g13a1_gateway_e2e.sh` 的真实 Node/OCI 插件后追加 Operator Claim → Investigation → Human Verdict，把当前分别验证的两半串成一条证据。范围：`tests/ci/g13a1_gateway_e2e.sh`、`tests/ui/g13b14-claim.spec.ts`、fixture seed。
2. **按序合并与 staging 迁移（高）**：#55→#56→#57→#58 合并；在 staging 空库/旧库各跑 0031–0033；用两个真实 Kernel 实例做租约接管与 Event 并发压测。范围：发布流程、`deployments/`、`tests/ci/`。
3. **Claim 队列分页与 HTTP 并发（中）**：队列 cursor；64 个真实 OWA2 principal 的 HTTP 并发。范围：`incident_claims.rs`、`telemetry_events.rs`、契约。
