# DS-V1-1c — PR #34 审查整改与视觉验收收口

- 日期：2026-11-05
- 状态：**PASS（Phase A–E、G 本地与 harness）**；最终 CI 与独立审查结论见 §10 / §11
- 基线：PR #34 head `d3d5955`（DS-V1-1b）
- 决策：[ADR-017](../adr/ADR-017-visual-system-v1.md) §D5 / §D7 / §D9
- PR：Draft [#34](https://github.com/baicie/ops-1/pull/34)，**不转 Ready**

本批不重做 DS-V1-1/1b，不引入新组件库，不改 Kernel、数据库或业务权限。目标是把上一批遗留的对话框正确性、Boundary 状态所有权、Sources 视觉矩阵与门禁缺口补齐，使 PR #34 达到可审查、可合并的状态。

## 1. 最新 HEAD

- 基线：`d3d5955`（DS-V1-1b）
- 本批提交：`f7c64e9`（代码）、`33202e3`（文档）、`78a3561`（KPI 以标题为上限）
- 工作树：实现、测试、文档；完整矩阵截图未跟踪

## 2. 实际修改文件

**组件 / 页面**
- `components/app/dialog-frame.tsx`：ARIA 关联交给 Radix 的描述注册；`dismissible` 忙碌态；head 关闭键禁用而非隐藏；body 仅在存在子节点时渲染。
- `components/app/confirm-action.tsx`：`description` 进入 `DialogDescription`；`dismissible={!pending}`。
- `components/app/async-boundary.tsx`：每个 boundary 用 `useId` 作为状态所有者，挂载报告、卸载撤销；`source="plugin"` 映射到 attention，不再冒充 Kernel unavailable。
- `lib/platform-status.ts`：`bodyReports: Map<owner, BodyState>`，最严重者获胜；`clearBodyState` 只撤自己的；`resetBodyState` 清空；`reportBodyState` 保留 owner 默认值兼容旧调用。
- `pages/Sources.tsx`：`totalInstances === null` 不再打印 `0`（三处：row status detail、card detail、detail sheet），改为 `NoData` token；sheet 关闭后焦点回到该行的 row-actions。
- `styles.css`：`ow-dialog-description` 使用 body/secondary；禁用关闭键的 `opacity/cursor`。

**门禁 / 工作流**
- `scripts/check-ui-metrics.mjs`：无条件要求 `config.theme` / `config.locale`；`--matrix` 执行清单（路由 × 视口 × 主题 × 语言），`matrix-missing` / `matrix-duplicate`；`measurement-format`；manifest/matrix JSON 损坏 exit 2；同时传 `--manifest` 与 `--matrix` 直接 exit 2（两套路由索引不可混用）。
- `scripts/check-ui-metrics.test.mjs`：14 条自测，含删除组合、重复组合、缺 theme/locale、缺 viewport、格式错误、损坏 manifest、同时传两个 flag。
- `docs/design/ui-visual-v3/spec/matrix-manifest.json`：observability fixture 的 2 路由 × 3 视口 × 2 主题 × 2 语言。
- `.github/workflows/ci.yml`：自测 + tracked visual-v3 route manifest + observability matrix。
- `.github/workflows/g12-acceptance.yml`、`tests/ci/g12_acceptance_ci.sh`：新 spec 进入确定性 job；`V3_CHANNEL=chromium`。
- `tests/ci/check-spec-coverage.mjs`：`sources-audit` 从 `KNOWN_UNRUN` 移除（已被 g12 引用）。

**测试**
- 新增 `dialog-contract.spec.ts`（4）、`dialog-geometry.spec.ts`（1 个 48 截图矩阵）、`boundary-ownership.spec.ts`（7）、`metric-card-matrix.spec.ts`（2，其中 48 截图矩阵）。
- `sources-audit.spec.ts`：viewport 修正；detail/config 全矩阵；sheet 契约（命名、焦点陷阱、Escape、焦点返回、长 ID、长错误、内部滚动、scroll lock）；选择器与文案断言更新。
- `ui-table-audit.spec.ts`：写出的 metrics 带 theme/locale。

## 3. Dialog ARIA 证据

真实 DOM（`dialog-contract.spec.ts`）：

- 有描述：`aria-labelledby` 指向标题 `h2`，文本等于标题；`aria-describedby` 指向实际的 `DialogDescription` 节点，文本等于可见描述；不存在悬空 id。
- 无描述：`aria-describedby` 为 `null`（属性不存在），没有指向未挂载节点的引用。
- 标题始终有有效 accessible name（`aria-labelledby` 解析非空）。
- 中心 Dialog（ConfirmAction、create-incident Modal）与左侧/右侧 Sheet（command palette 1024、Sources detail/config）均覆盖。

修复前：`ConfirmAction` 的描述是 body 里的普通 `div`，不是 `DialogDescription`，因此 Radix 没有可关联的描述节点；第一版修复又给 `DialogDescription` 传了自定义 id，同时 Radix 把内部 id 拼进属性，产生了指向不存在节点的 `"_r_t_ radix-_r_s_"`。最终实现不传第二个 id：有描述时由 Radix 同时设置元素 id 与 `aria-describedby`，无描述时属性缺席。

## 4. Pending 关闭行为

`ConfirmAction` 在 pending 时：

- head 关闭键保留但 `disabled` + `aria-disabled`，`data-dismissible="false"`，title 说明“操作进行中，暂时无法关闭”。
- Escape 与遮罩点击被 `onEscapeKeyDown` / `onPointerDownOutside` 阻止。
- Cancel/Submit 均禁用；双击 Submit 不产生第二个请求（`inFlight` ref + DOM 断言 `writes === 1`）。
- 失败后恢复 `dismissible=true`、关闭键可用、错误保留、Submit 变 Retry。
- 成功后 `onClose` 正常关闭。

反事实：修复前 close 键可点、Escape 只会被 `onOpenChange` 守卫忽略但控件仍表现为可关闭；测试会在 pending 阶段因 close 未禁用而失败。

## 5. Plugin 恢复后的 Chrome 状态

`boundary-ownership.spec.ts` 用真实 extension loader 服务一个远程 entry：

- Plugin render error → 页面插件错误面板 + chrome `attention`（不是 `unavailable`，`server-message` 带 `data-source="plugin"`）。
- Retry 成功 → `AsyncBoundary` 卸载，`clearBodyState(owner)` 撤销自己的报告，chrome 回到基础状态（测试固定 overview 为 READY，断言不再 attention）。
- Plugin load error（remote.js 404）→ 页面错误 + chrome attention。
- Kernel 503 → 页面 unavailable + chrome unavailable；路由切换后释放。
- Kernel 403 → 页面 permission wall + chrome forbidden。
- 登出再登录 → 不继承上一会话的 body verdict。
- InstallWizard 上传失败、Settings 策略面板 403、Access users/publishers 面板错误（`report={false}`）→ 页内错误，chrome 保持基础状态。

`platform-status.test.ts` 增加 4 条所有权单测：撤销自己的、不能撤别人的、最严重者获胜、reset 清空且迟到的 clear 不会复活。

## 6. Sources 12 组合视觉结果

`sources-audit.spec.ts`：**18/18 PASS**（12 组合矩阵 + 3 个状态 + 凭证安全 + 未知分母 + sheet 契约）。

- 12 组合：1440/1024/390 × light/dark × en/zh-CN；每个组合打开 detail 与 config，截图并断言 sheet 在视口内、无页面横向溢出、head 只有一个关闭键、关闭后无 scroll lock。另加：实例分母未知的 NO_DATA、registry-down 的真实 notice、长错误滚动到可见处再截图。
- Sheet 契约（390×600，强制内部滚动）：accessible name/description、焦点进入、Tab 8 次不离开、body `overflow-y:auto` 且 `scrollHeight > clientHeight`、Escape 关闭、焦点回到 row-actions、detail→config 时 detail 关闭、115 字符 plugin id 不越界、200 字符错误输入不造成溢出，且滚动后错误可见。
- 修复的预存在问题：
  - `browser.newContext({viewport})` 收到 `{w,h}`，14 个矩阵用例在页面加载前就抛错；改为 `{width,height}`。
  - 行菜单动作 id 是 `detail` 而不是 `inspect`；配置表单的 credential/submit testid 已更名；提交按钮按设计永久禁用，凭证校验在 blur 时显示，测试改为该真实路径。
  - grants-forbidden 断言固定英文 "Unknown"，实际文案是 "Reach unconfirmed"；改为断言 `data-reach="unknown"` 且不是 Granted。
  - **真实缺陷**：实例分母未知时打印 `0/0`（`totalInstances ?? 0`），违反 MISSING ≠ 0；三处改为 `NoData` token。
  - **真实缺陷**：sheet 从行菜单打开、菜单项随菜单卸载，关闭后焦点落到 body；现在回到该行 row-actions。

## 7. MetricCard 响应式矩阵

`metric-card-matrix.spec.ts`：**2/2 PASS**，48 张截图（4 surface × 3 视口 × 2 主题 × 2 语言）。

- IncidentDetail：真实 seed incident，4 卡，1024 及以下 1 列、1440 2 列。
- Jobs：3 卡，1440/1024 4 列，390 1 列；attempts 显示 `1 / 3`。
- Pipelines：4 卡，latestRevision `r2`、nodes、latest run、updated；列数与 Jobs 一致。
- Governance：4 卡，1440 4 列、1024 2 列、390 1 列；缺失 `datasetCount`/`lineageWindowCount` 时 `data-metric-state="unknown"`、`data-value="UNKNOWN"`，不打印 0。
- 每张卡：值非空、无 `NaN`/`undefined`、`data-metric-state` 合法、页面无横向溢出。
- **类型层级修正**：`.ow-metric-value` 从 title 26 改为 `min(metric, title)`（1440 为 21，390 与 20px 的 h1 同为 20），`.ow-metric-label` 从 meta 13 改为 label 11；与 Overview 的 stat-strip 一致，满足 ADR-017 §D5 的 title 26 > KPI 21 > body 15，且窄屏不会出现 KPI 大于 h1。修复前 15 个迁移卡片的 KPI 与 h1 同大。最终矩阵实测：1440 h1 26 / KPI 21 / label 11；390 h1 20 / KPI 20 / label 11。
- **手机 KPI 密度**：≤640 时 `.metric-grid`、`.pipeline-stats`、`.job-stats` 与 IncidentDetail 的 `.incident-kpis` 为 2×2，而不是 4 张全宽卡；表格卡仍按 1 列。390 上 Sources 首个连接器行从约 y=1000 提前到约 y=740。
- 未改动的可点击 KPI 卡（Overview/Observability/Sources/Incidents）已有 `[data-metric-card]` 链接；本批未改其目标。

## 8. UI Metrics 缺组合反事实

- `--matrix matrix-manifest.json`：2 路由 × 3 视口 × 2 主题 × 2 语言 = 24 组合；`artifacts/ui/observability/metrics` **24/24 PASS**。
- 删除一个组合 → `matrix-missing`（自测 6）；同一组合出现在两个 artifact → `matrix-duplicate`（自测 7）。
- 缺 `config.theme`/`config.locale` → `config-unmeasured`（现在无条件；视觉 v3 的 3 个 tracked artifact 已补 locale，`ui-table-audit` 写入端同步）。
- 缺 viewport → `viewport-unmeasured`（自测 12）。
- 空 pages → `page-map-empty`；格式错误 → `measurement-format`；manifest 损坏 → exit 2。
- 路由清单：`route-manifest.json` 30 measurements / 10 routes PASS；缺失/未知路由自测通过。
- 阈值未改。

## 9. 浏览器截图及 Artifact

未跟踪，均在 `artifacts/ui/`（`.gitignore` 已声明 `visual-v1/`）：

| 目录 | 内容 |
|---|---|
| `artifacts/ui/visual-v1/after-ds-v1-1c/` | 36 张 Overview / Observability / Incident 矩阵（当前构建） |
| `artifacts/ui/visual-v1/dialogs/` | 48 张 ConfirmAction / Modal / Palette（4 视口 × 2 主题 × 2 语言） |
| `artifacts/ui/visual-v1/metric-cards/` | 48 张 Incident/Jobs/Pipelines/Governance KPI |
| `artifacts/ui/visual-v1/sources/` | 12 组 Sources 列表 + detail + config，另含状态/长错误截图 |

CI 中对应截图作为 Playwright artifact；PNG 预算未增加（408 文件 / 65.97 MB）。

## 10. 最新 CI 结论

- 本地确定性 harness（本批代码）：`bash tests/ci/g12_acceptance_ci.sh` — **PASS**，**98 tests（96 passed / 2 skipped）**，7.7 min；acceptance **195/0**；exit 0。两条 skip 仍是 Docker/Studio 依赖（`g11-page-header-growth` 的 counterfactual 与 Studio 用例）。
- 最新 HEAD 的 GitHub Actions 结论：见 §12 推送后回填（必须亲自确认，不以本地替代）。

## 11. 独立审查与 P0 / P1 / P2

### 11.1 独立代码审查

**P0**：无。

**P1（已修复并留反事实）**
1. **路由切换 reset 顺序**：`resetBodyState()` 在 passive effect 中晚于新页面 boundary 的 report，会清掉刚到任的状态；插件错误缓存后离开再返回，页面报错而 chrome 显示 ready。修复为 `useLayoutEffect`；用 client-side link + `goBack()` 复现，反事实（改回 `useEffect`）下插件历史测试转红。
2. **KPI 类型层级**：15 个迁移卡片的 value 为 title 26、label 13，与 Overview 的 21/11 不一致，KPI 与 h1 同大。修复为 `.ow-metric-value: min(metric, title)` / `.ow-metric-label: label`；实测 1440 为 26/21/11，390 为 20/20/11（KPI 不再高于 h1）。重建 48 张矩阵。

**P2（已处理）**
- `--manifest` + `--matrix` 同时传入会混用两套路由索引 → 直接 exit 2，并加自测。
- CI 注释声称 `--manifest` 覆盖视口/主题/语言矩阵 → 改为只描述路由覆盖，矩阵由独立命令负责。
- registry-down 断言用 "No connectors installed" 匹配不到任何文案 → 改为断言 `[data-notice=noData]` 与 "did not answer"，并修正“registry 已回答但没有能力”的错误文案。
- `totalInstances === null` 分支无测试、cardFacts 仍用 `?? 0` → 新增 `nullInstances` fixture 测试（行/详情均显示 NO_DATA，无 0/0），cardFacts 不再把未知分母计入。
- 门禁在零证据时仍绿（modal 关闭、incident 为空）→ 三处改为硬失败；`dialog-contract` 的 modal 不再 skip。
- 路由切换测试原先用 `page.goto`（整页重载）→ 新增 client-side link + `goBack()` 用例。
- `page.unrouteAll` 会移除 `/auth/me` 的 access 覆盖 → 删除，保留精确路由。
- 忙碌关闭键无 `aria-busy`、切换会丢失焦点 → 单一 DialogClose/button，`disabled` 切换，`aria-busy` + 带原因的 `aria-label`。
- 插件 attention 压过 degraded kernel → `DEGRADED` 优先于 body attention，加单测。
- 文档计数/路径/ARIA 反事实与 CI 上传范围 → 已按实际树修正（见 §3、§9、§10）。

### 11.2 独立视觉审查

- 首轮覆盖 Overview / Observability / Incident / dialogs / metric bands；Sources 因目录在审查中途被清理而未看到。
- **P0（证据缺口，非产品缺陷）**：Sources 截图不可用 → 重新生成到 `artifacts/ui/visual-v1/sources` 并复审；复审 P0 为零。
- **P1（全部修复）**：
  1. KPI 26/13 vs Overview 21/11 → 已统一为 21/11，见 11.1。
  2. 390 KPI 带占满首屏 → KPI band 在 ≤768 为 2×2（表格卡仍 1 列）；Sources 首个连接器行从约 y=1000 提前到约 y=740。
  3. 390 Pipeline 修订行 PUBLISHED 与时间重叠 → 徽标独占一行，时间下一行；徽标不再拉伸整列。
  4. zh-CN 主句出现英文 `MULTIPLE_SOURCES Multiple entry nodes detected` → 拓扑状态本地化，原始分析器文本放入可折叠的 `data-source="analyzer"` 区块；`PUBLISHED` 徽标也走 `STATUS_MAP`。
  5. Sources config 的 NoticeBar 在 1440/1024/390 都裁切句子 → notice 内允许换行，`overflow-wrap:anywhere`；390 截图确认完整。
- **明确无缺陷**：对话框头部/正文/底部、焦点可见性、palette 三种形态、无 card 套 card、无对比度问题。
- **保留 P2（不在本轮）**：Overview 的重复 attention 内容、Availability 两列缩进、长机器 token 断行、zh 日期/时长/时间线词、Jobs 的 UA h2 22.5px、390 长连接器名孤字、1024 en 面板计数换行、Incident fullPage 内部滚动截断、虚拟键盘遮挡未模拟。

### 11.3 仍未完成

- `AVAILABLE` / `CANCELLED` 全局词汇改造（ADR-017 §D9 只记录决策）。
- CSS 模块化拆分、`.btn`（Studio Pattern D）、Observability/IncidentDetail 完整视觉重排、route→pattern registry。
- 对比度/触摸目标/axe、视觉 diff、`tests/ui` typecheck 仍是仓库级缺口（NOT_RUN）。
- `sources-audit` 的 `state-empty` 曾在一次 4-worker 运行中等待超时，单跑/全量复跑均通过；保留为潜在 flake 观察项。

## 12. 是否可将 PR #34 转 Ready

**READY_TO_MARK_READY（条件：最新 HEAD 的 GitHub Actions 全绿）**。本轮不自行转 Ready、不 merge、不 tag、不 release。

- 若 CI 出现与本批相关的红灯：回到本文件补修复与证据。
- 若 CI 仅有与本批无关的既有失败：记录为外部依赖，不擅自修改 staging。
