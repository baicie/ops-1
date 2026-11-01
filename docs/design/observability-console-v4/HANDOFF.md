# 可观测中台 V4 · 交接记录

- 日期：2026-11-01
- 分支：`feat/observability-console-v4`（已推送，跟踪 `origin`）
- PR：[baicie/ops-1#22](https://github.com/baicie/ops-1/pull/22)，base `main`
- 本文按 `AGENTS.md` 工作步骤第 4、6 条编写：**只写真实跑过的命令与结果**，未跑的一律 `NOT_RUN`。

> **先读这一条**：PR #22 起初是 **MERGEABLE / UNSTABLE**，11 项检查 **9 通过、2 失败**
> （`artifact-budget`、`golden-path`）。两个都已在 `e3d8ceb` / `132e7c0` 里修掉，本地门禁全绿，
> CI 复跑结果以 PR 页面为准。修的过程和证据见第 4 节，那是这份文档里信息量最大的部分。
> PR 描述里 "all five gate scripts pass" 这句话在写的时候只覆盖了 5 个脚本，
> **从来没有覆盖这两个 CI 作业**——这才是它们能红着进来的原因。

---

## 1. 这份分支做了什么

五个并行子会话各自的成果，加一个把前后端语义对齐的补丁，合并为一条分支。

| 提交 | 内容 |
|---|---|
| `eb58b5c` | admin V3 抛光（21 个提交，UI 债本地计数 327 → 169） |
| `e09fa8d` | `/app/sources` 连接器管理面 |
| `ea707c0` | `/app/observability` 机队总览 + 实体详情 |
| `7862070` | `/app/incidents` 事件工作区重做 |
| `205b879` | zabbix 连接器 + 可信证据（G12）后端 |
| `e895a7c` | 前端按 Kernel 判定读证据信任，不再读提交者自称 |
| `a73f85e` | N-8 关闭：把真正跑过的路径写进状态文档 |

### 1.1 修掉的业务缺陷

`insert_evidence` 原来把调用方传来的 `trust` 校验成一个闭集后**原样存库**：

```rust
let trust = closed_set(&payload.trust, EVIDENCE_TRUSTS, "trust")?;
```

任何 operator 都能自报 `SOURCE_ATTESTED`，于是那一列本来是用来区分“手打的一句话”和“机器核过的读数”，
实际不携带任何信息。G12 把它拆成：

- `claimedTrust` —— 提交方**可以声明**的，只有 `OPERATOR_ASSERTED` / `UNVERIFIED` 两值；
- `verifiedTrust` —— Kernel 自己**建立**的，三值，只有对已配置 adapter 验签通过的 HMAC-SHA256 信封才能拿到 `SOURCE_ATTESTED`。

迁移 `0017` 把历史上自报的 `SOURCE_ATTESTED` 降级为 `UNVERIFIED` 并留下说明。

### 1.2 N-8（跨进程契约）首次端到端跑通

`docs/design/zabbix-source/IMPLEMENTATION-STATUS.md` 原先记为从未验证：插件签名、Kernel 验签，
两半从没在同一个流程里跑过。用一次性数据库 `opsweave_g12_n8`（跑完已删）实测：

| 用例 | 结果 |
|---|---|
| 插件 `signAttestation` 产出 | `201`，`SOURCE_ATTESTED` / `SOURCE_ADAPTER` / `zabbix-main` |
| 已废弃的 `trust` 字段 | `400 EVIDENCE_TRUST_NOT_SELF_ASSERTABLE` |
| `claimedTrust=SOURCE_ATTESTED` | `400 EVIDENCE_TRUST_NOT_SELF_ASSERTABLE` |
| 错误密钥 | `400 EVIDENCE_ATTESTATION_INVALID` |
| 未知 adapter | `400 EVIDENCE_ADAPTER_UNKNOWN` |
| 600s 时钟偏移 | `401 EVIDENCE_ATTESTATION_STALE` |

**仍未验证**：插件的 `/collections/{id}/attestation` 与 `/runtime-info` 两个 HTTP 端点没有被直接调用过。
实测的是同一套签名代码的**输出**，不是这两个 HTTP 面。

---

## 2. 本地真实验证过的

在这台机器上跑过、且结果是记下来的：

| 项 | 命令 | 结果 |
|---|---|---|
| Rust | `cargo test --workspace` | 157 passed / 0 failed |
| 前端单测 | `pnpm --filter @opsweave/platform-web test` | 26 文件 / 332 test |
| Zabbix 插件 | `node --test plugins/zabbix-source/backend/zabbix.test.mjs` | 26 pass / 0 fail |
| 构建 | 4 个 `@opsweave/*-web` | 全通过 |
| Lint | `cargo clippy --workspace --all-targets` | 0 warning |
| 契约 | 16 schema / 6 example | 校验通过 |
| i18n 门禁 | `scripts/check-i18n.mjs` | PASS（1605 键，两语言零差异，0 未使用） |
| 状态词表 | `scripts/check-status-vocabulary.mjs` | PASS（41 码） |
| UI token 棘轮 | `scripts/check-ui-tokens.mjs --ratchet …` | PASS，只降不升 |
| UI 度量 | `scripts/check-ui-metrics.mjs artifacts/ui/incident-trust` | PASS（12 个页面测量） |
| UI 度量 | `scripts/check-ui-metrics.mjs artifacts/ui/observability/metrics` | PASS（24 个测量） |

债棘轮：`origin/main` `{118,14,7,5,19,4,52,108}` → 本分支 `{0,0,6,3,0,0,52,108}`。

### 2.1 环境里曾经骗过我们的三件事

1. **`PIPESTATUS` 在 zsh 里不存在**（正确写法是 `$pipestatus`）。早期所有 `| ...; echo PIPESTATUS` 得到的
   `EXIT=0` 都是假的——后台日志里 `TYPECHECK_EXIT=0` 紧接着 `ELIFECYCLE Command failed with exit code 2`。
   现在一律用 `cmd > /tmp/x.log 2>&1; echo "EXIT=$?"`。
2. **43 个 typecheck 报错不是代码缺陷**，是 `pnpm install` 没装全：`@radix-ui/*`、`clsx`、`tailwind-merge`、
   `tailwindcss` 在 `pnpm-lock.yaml` 里但磁盘上没有，于是 `typeof DialogPrimitive.Content` 退化成 `any`。
   `pnpm install --frozen-lockfile` 之后 `TSC_EXIT=0`、零输出。
3. **`check-ui-tokens.mjs` 不带 `--ratchet` 会把每个预算都报成 0 并 FAIL**。CI 的调用在
   `.github/workflows/ci.yml:80`。`check-ui-metrics.mjs` 必须要传目录或文件。

---

## 3. 合并时踩过的坑（下次合并同类分支会再遇到）

### 3.1 `styles.css` 的共用注释头陷阱

observability 与 incidents 两条分支**各自改写了同一段 `/* ─────` 注释头**，各自以自己的 `*/` 结尾，
并且各自停在一个没有闭合的 `@media` 里。直接拼接会把另一方的注释体变成裸 CSS，并让花括号失衡。

用过的修法（两次都用同一套）：

```python
RULE = '/* ' + '─' * 77
ours_fixed   = ours + ['}']             # 闭合我方尾部 @media
theirs_fixed = [RULE] + theirs + ['}']  # 重开对方注释头
out = lines[:s] + ours_fixed + [''] + theirs_fixed + lines[e+1:]
```

每次合并后都验：`braces 1445/1445 balanced=True`、`comments 292/292 balanced=True`、
0 个 `<<<<<<<`、非零深度内无嵌套 `@media`。

**不要用 `-X ours`**：它会静默丢掉另一方新增的 i18n 键。

### 3.2 其它三个

- **JSON 拼接缺逗号**：HEAD 的最后一个键原本是对象末键所以没有尾逗号，拼到中间后语法就断了。
- **CSS 缝合多一个 `}`**：`lines[:-1]` 删掉的是末尾空串而不是那个 `}`——1400/1401。要在 EOF 精确剥一个 `}` 并保留换行。
- **`SOURCE_ATTESTED` 改成 `ok` 之后没有对应 CSS**，chip 会裸渲染。已补 `.ow-trust[data-trust-tone="ok"]`。

---

## 4. 两个 CI 失败：根因、修法与证据

`gh pr checks 22`（修之前）：9 pass / 2 fail。

```
artifact-budget        fail    11s
golden-path            fail    11m22s
contracts              pass    (×3)
legacy-regression      pass
quality-faults         pass
runtime-golden-path    pass
rust                   pass
web                    pass
web-unit               pass
```

### 4.1 `artifact-budget` —— 追踪进 git 的 PNG 超预算

跑法：`node tests/ci/check-tracked-png-budget.mjs`（CI 在 `.github/workflows/ci.yml:107`）。
本地复现：**353 条违规**。

| 指标 | 值 |
|---|---|
| 分支追踪 PNG | **796** 个 / 120.49 MB |
| 上限（`tests/ci/tracked-png-budget.json`） | **379** 个 / 68.24 MB |
| `origin/main` 追踪 PNG | 379 个（正好等于上限） |
| 本分支相对 main 新增 | **417** 个 |

417 = 235（13 个未登记目录）+ 168（`g08-admin-polish` 超 11 的上限）+ 14（`visual-v3/b3b4/before` 17 对 3）。

细节：

- **`artifacts/ui/g08-admin-polish` 有 179 个，上限 11**。其中 **168 个以 commit SHA 命名**
  （形如 `g08-<7 位提交号>-<页面>-<宽度>-<主题>-<语言>.png`），来自提交 `d031762`
  “test(ui): real 1440/1024/390 light+dark screenshots, from a running browser”。
  门禁的 `[A per-run artifact]` 分类专门拦这个：按 SHA 命名的截图下次跑会**再写一份**而不是覆盖，
  应当作为 CI artifact 上传，不进索引。
- **13 个目录完全没登记**（未登记即违规，不是默认值）：`artifacts/ui/sources` 37、
  `artifacts/ui/visual-v3/b1` 32、`artifacts/ui/incidents-workspace` 27、
  `tests/ui/artifacts/g11-d3` 25、`artifacts/ui/visual-v3/audit-fresh` 25、
  `artifacts/ui/observability/shots` 24、`.claude/artifacts/ui/observability/shots` 24、
  `artifacts/ui/incident-trust` 12、`artifacts/ui/v5` 11、`artifacts/ui/visual-v3/b4-remaining/before` 8、
  `artifacts/ui-v7` 7、`artifacts/ui-verbs-v6` 2、`artifacts/ui/visual-v3/b2/before` 1。
- **`.claude/artifacts/` 下 28 个文件被提交进了 git**（24 张 PNG + 4 个 metrics JSON），
  `.gitignore` 里没有对应规则。这批 PNG 与 `artifacts/ui/observability/shots` **同名但内容不同**
  （是另一次抓取），属于重复证据。`.claude/` 下除这 28 个以外没有任何被追踪文件。
- **一条被绕过的清理**：提交 `a003374` “chore: bring the screenshot budget back under a ceiling that
  was being moved instead of met” 删掉了 `artifacts/ui/v5`、`ui-v7`、`ui-verbs-v6`、`visual-v4`、
  `table/{review7,after-fix,before-fix,final}` 等。它存在于 `feat/g11-incident-slice` 与
  `feat/ui-visual-excellence-v3` 上，**既不是 main 的祖先，也不是本分支的祖先**。
  本分支的 `df501d0` 又把其中的 `v5` / `ui-v7` / `ui-verbs-v6` 共 20 个文件加了回来。

**处理结果：选了“删”。** 见 `e3d8ceb`。移出索引 388 个文件后：

```
tracked PNG: 408 files, 65.97 MB (ceiling 408 files, 68.24 MB)
OK: tracked PNGs are the curated baseline and within budget.
```

留下的是 **408 / 65.97 MB**：两个新页面里被状态矩阵真正引用的 29 张
（`/app/incidents` 18 张、`/app/sources` 11 张，各建一个新桶），加上原有基线。
**字节上限一格没动**（68.24 MB），分支比它 fork 的那个提交还轻 2.3 MB；
文件上限 379 → 408 只因这两个新面原本没有桶而 main 又是零余量，**没有任何现有桶被抬高**，
相对本分支原本要合的 796 张仍然少了 388 张。

引用覆盖率是对全树 `.md` 做的，所以“留在磁盘上但不在索引里”的那些是**没有任何文档链接**的。
它们没有被删除，原地未动——改的只是索引。

### 4.2 `golden-path` —— 一个 Playwright 用例超时（根因已定位并修复）

作业 `data-foundation`，脚本 `RUN_BROWSER_SMOKE=1 tests/ci/data_foundation_ci.sh`。
16 个用例里 **15 通过、1 失败**：

```
✘ 11 [chromium] › studio.spec.ts:165:1 › draft conflict preserves local edits and offers resolution (1.0m)
  Test timeout of 60000ms exceeded.
  Error: locator.click: Test timeout of 60000ms exceeded.
    waiting for locator('.studio-rf-node').filter({ hasText: 'source' }).first()
      - locator resolved to <div class="studio-rf-node node-source ">…</div>
      - attempting click action
        - element is not visible
  at tests/ui/studio.spec.ts:189:79
```

**根因**：`@xyflow/react` 在 `nodeHasDimensions(node)` 为假时给节点写 `visibility: hidden`
（`@xyflow/react/dist/esm/index.js:2363`；判定在 `@xyflow/system` 的 `index.js:756`，
读 `measured.width ?? width ?? initialWidth`）。本项目的画布是**受控**的：
`PipelineEditor` 持有模型，`GraphCanvas` 每次渲染都新建一批用户节点对象。
而 `GraphCanvas.handleNodesChange` 只处理 `type === 'position'`，把 `dimensions` 丢了，
于是 `measured` 永远回不到模型；每次父组件重渲染，`adoptUserNodes`
（`@xyflow/system` `index.js:1692`）都用 `userNode.measured?.width` 重建内部节点，
测得的尺寸被清空 → 节点重新隐藏 → ResizeObserver 再测一次 → 下一次渲染又清空。
节点在可见/隐藏之间反复跳，Playwright 的点击随机落在一帧上，落进隐藏帧就重试到 60s 超时。

**证据**（同一段脚本、同一份构建产物的 A/B，12 次 Fit-all/Readable 切换）：

| 构建 | `style` 属性翻转 | 隐藏帧 | 点击 |
|---|---|---|---|
| 不含修复（= `origin/main`） | **288** | **24 / 约 90** | 29–107 ms |
| 含修复 | **0** | **0 / 约 88** | 50–57 ms |

注意：**用 `--repeat-each` 反复跑这个 spec，修复前后都是全绿**——本地那一帧窗口太窄，
点击基本躲得过去。能证明问题的只有上面这个逐帧计数，不要拿 spec 的通过率当证据。

修复分三处（`132e7c0`）：`GraphCanvas` 把 `measured` 传回 `flowNodes` 并在
`applyCanvasChanges` 里写回模型；`PipelineEditor` 让测量**绕过 undo 历史**（测量不是编辑，
走 `update` 会每次挂载推一条历史并清空 redo，而 dirty 是从 definition 算的，`measured` 不参与）；
`GraphNode` 加 `measured?` 字段并写明原因。折叠逻辑抽成纯函数 `studio/ir/canvas.ts`，
配 7 个单测（这个包没有组件测试设施，而这个缺陷对“节点存在”类断言完全不可见）。

三个必须知道的事实：

- **这个失败早于本分支**。`feat/g12-ai-investigator` 的两次失败是完全相同的样子：
  `8f52c61b`（2026-10-31 16:18，`studio.spec.ts:177` 同一个用例）与
  `4bd931b4`（2026-10-31 14:34，`studio.spec.ts:45`，同一 `.studio-rf-node` 不可见）。
  最近 12 次 `data-foundation` 运行里 3 次失败，失败点都落在 studio 的 `.studio-rf-node` 点击上。
  它是一个**潜伏在 main 上的产品缺陷**，不是本分支引入的。
- **`tests/ui/studio.spec.ts` 在本分支与 main 完全一致**（`git diff origin/main HEAD -- tests/ui/studio.spec.ts` 为空），
  即失败不是测试被改坏的。
- **CI artifact 里那张 `pipeline-conflict.png` 说明不了问题**：用例在写这张图（第 217 行）之前就超时了，
  上传的是仓库里已提交的旧文件（md5 与 `artifacts/ui/studio/pipeline-conflict.png` 相同）。
  那张图里还是 19 个按钮的“草稿墙”，是 `2fd85c2` 之前的样子——它是**过期证据**，不能当作本次渲染结果。

---

## 5. 未做 / `NOT_RUN`（不要当成已完成）

| 项 | 状态 |
|---|---|
| 真实 Zabbix 实例对接 | `NOT_RUN` |
| OCI 镜像构建 + digest 固定 + 签名验证 | `NOT_RUN`（本机无 Docker daemon 时） |
| `tests/acceptance/g12_trusted_evidence.sh` | `NOT_RUN` |
| 两物理节点 / mTLS / Fencing | `NOT_RUN` |
| 插件 `/collections/{id}/attestation`、`/runtime-info` HTTP 面 | 未直接调用 |
| 84 张 admin V3 截图的**人工审阅** | 未做（图在，审阅是另一件事；`artifacts/ui/admin-polish-v3/state-matrix.md` §7 列了该看什么） |
| 产品状态 | 仍是 `NOT_READY`（`docs/design/zabbix-source/IMPLEMENTATION-STATUS.md`） |
| 完整的 `studio.spec.ts`（8 个用例） | 本机只 5/8 通过，见 5.1，**不是**回归 |
| 修复后 CI 复跑 | 推送时未出结果，以 PR 页面为准 |

### 5.1 本机 studio 只 5/8 通过：那个一次性数据库里没有 catalog

为了复现 `golden-path`，本机起了一个一次性 Kernel（`opsweave_studio_repro`，端口 18291）。
这个库里**没有节点、没有插件实例**，所以 `POST /pipelines/validate` 永远走
`live_schema_catalog` 的 `503 CATALOG_UNAVAILABLE` 分支（`apps/kernel/src/jobs.rs:64`），
前端如实显示 “Server validation failed”；依赖 catalog 的 preview 同样是 `INVALID`。
失败的三个（validate+publish、submit revision、server preview）都是这一类，
真正与画布有关的两条（`draft conflict`、`studio renders published nodes`）都通过。

CI 的 `data_foundation_ci.sh` 会起两个真实 Node、装 data 插件、再跑这些用例，
所以那边的 catalog 是真的。**这里不能声称 studio 全套在本地通过过**。

---

## 6. 关键文件索引

| 关注点 | 文件 |
|---|---|
| 证据信任语义（ADR） | `docs/adr/ADR-015-evidence-attestation-and-telemetry-sources.md` |
| 证据信任实现 | `apps/kernel/src/incidents.rs`、`apps/kernel/migrations/0017_g12_evidence_trust.sql` |
| 前端信任渲染 | `apps/platform-web/src/pages/incident-trust.tsx`、`src/incidents.ts` |
| 事件详情页 | `apps/platform-web/src/pages/IncidentDetail.tsx` |
| Zabbix 插件 | `plugins/zabbix-source/backend/{zabbix,server}.mjs` |
| Zabbix 状态与风险 | `docs/design/zabbix-source/IMPLEMENTATION-STATUS.md` |
| V3 设计系统 | `docs/design/ui-visual-v3/spec/{token-table,page-template,table-spec,machine-language-rules}.md` |
| UI 债棘轮 | `docs/design/ui-visual-v3/spec/ui-debt.json` |
| 截图预算 | `tests/ci/tracked-png-budget.json`、`tests/ci/check-tracked-png-budget.mjs` |
| 本次新增截图度量脚本 | `tests/ui/run-incident-trust-capture.mjs` |
| 画布测量往返（本次修复） | `apps/platform-web/src/studio/ir/canvas.ts`、`canvas.test.ts` |

---

## 7. 前端对齐时做过的三处语义决定

留给后来的人，避免被“改回去”：

1. **`SOURCE_ATTESTED` 拿绿色（`ok` tone）**。在此之前它拿的是 `info`——因为那时这个值是调用方自己写的。
   G12 之后它是 Kernel 验过签的结论，是这套壳里唯一真正“服务端确立的事实”，所以它才有资格拿绿。
   `incidents.test.ts` 里有一条测试专门钉住“除 `SOURCE_ATTESTED` 以外任何等级都不许是 `ok`”。
2. **提交表单不再提供 `SOURCE_ATTESTED` 选项**。服务端对 `claimedTrust=SOURCE_ATTESTED` 一律 400，
   继续给选项等于给用户一个必败按钮。现在只提交 `claimedTrust`，取值来自 `EVIDENCE_TRUST_CLAIM_CODES`（两值）。
3. **自称与判定不一致时，渲染 Kernel 自己的 `verificationNote`**（`TrustGap` 组件），
   两者一致时不渲染——否则每一行都多一句“这两个一致”的噪音。

另外两处是**看截图才发现的、任何测试都没抓到**的问题，已修：

- 我一度在信任格里加了一行验证方法，截图显示它把信任文字挤进 Source 列（1440 明显、390 更糟）。已改为 chip 的 tooltip。
- 390 下证据表有 4 个事实，`table-spec.md` §2.2 规定卡片最多 3 个。`contentRef` 被降级到标识行，而不是直接删掉。

还有一次是**我自己的度量脚本**错了：数 `td[data-label]` 时没有像参考脚本那样过滤
`getComputedStyle(td).display !== 'none'`，把隐藏单元格也算成事实，于是把 3 事实卡片报成 4。
修的是工具，不是页面。

---

## 8. 复跑整套门禁的命令

```bash
cd apps/platform-web && pnpm install --frozen-lockfile && cd ../..
cargo test --workspace
cargo clippy --workspace --all-targets
pnpm --filter @opsweave/platform-web test
node --test plugins/zabbix-source/backend/zabbix.test.mjs
node scripts/check-i18n.mjs
node scripts/check-status-vocabulary.mjs
node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json
node scripts/check-ui-metrics.mjs artifacts/ui/incident-trust
node tests/ci/check-tracked-png-budget.mjs
```

最后一条就是当前红灯的那个。**它在本地从没跑过，是 CI 发现的**——这也是这份文档存在的原因之一。
