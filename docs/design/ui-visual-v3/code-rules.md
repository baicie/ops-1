# 代码质量规则清单 — apps/platform-web/src

范围：`apps/platform-web/src/**`（例外在 §5 单列）。来源四条：`AGENTS.md` 的绝对禁止项、`rules/01-…10-*.md`、
`docs/design/ui-visual-v3/spec/*`（token-table / page-template / table-spec / machine-language-rules / ui-debt.json），
以及这份代码里已经建立的约定（`status-tone.ts` 唯一状态表、`verify-after-write.ts` 写后回读、`facts-ledger.ts` 去重账本、
`installation-state.ts` 单一推导、`identity.ts`/`age.ts` 单一格式化、`table-kit.tsx` 表格原语）。

写法只有三段：**规则** / **违反** / **判定方法**。判定方法必须是能被下一个人重放的命令或测试名，
凡是写成"人工判断"的，判据必须写死（比"看情况"具体，比"符合规范"可反驳）。

每条规则都必须报数，**0 违规也要写"检查过，0 违规"**：沉默和通过不是一回事，
一份只列问题的清单无法区分"没查"和"查了没事"。

## 1. 规则总表

| # | 规则 | 闸门 | 本轮结果 |
|---|---|---|---|
| A1 | 状态码到 tone/state 的映射只有 `components/status-tone.ts` 一张表 | 【闸门】`status-tone.test.ts` + `code-rules.test.ts` | 检查过，0 违规（表 1 处、读取 4 处） |
| A2 | 读这张表必须 fail-closed：显式兜底，不许裸下标 | 【闸门】`code-rules.test.ts` | 修复前 2 违规，已修 |
| A3 | 安装状态只由 `lib/installation-state.ts` 推导 | 【闸门】`installation-state.test.ts` | 检查过，0 违规（4 处命中经复核为断言，非第二套词汇表） |
| A4 | 时间/年龄/身份/字节只有一套格式化器 | 【闸门】`check-ui-tokens.mjs` R6 | 4 处（棘轮已记账），另有 2 处未纳入闸门 |
| A5 | 写操作必须回读后才算成功 | 【闸门】`code-rules.test.ts` + `verify-after-write.test.ts` + `deploy-readback.test.ts` | 修复前 1 违规（InstallWizard.deploy() 渲染 POST 响应体），已修 |
| A6 | 去重账本只有 resolve 才算 settled | 【闸门】`facts-ledger.test.ts` | 检查过，0 违规 |
| A7 | 列表页只用 `pages/table-kit.tsx` 的表格原语 | 【人工】 | 检查过，0 违规 |
| A8 | 闸门本身不许放松；棘轮只许越拧越紧 | 【闸门】`ui-debt.json` | 0 违规；本轮 5 个旧桶同时拧紧 + 新增 2 个桶，见 §7 |
| B1 | 死代码：不可达 CSS、无引用导出、注释块、TODO | 【闸门】`code-rules.test.ts` + `/tmp` 脚本见 §4 | 修复前 24 处，已修 23 |
| B2 | 同一 selector 在同一层叠上下文里不许重复声明 | 【人工】+ 6 批像素验收 | 修复前 234 组（139 同值 / 95 覆盖）+ 9 整块重复 → **0 / 0** |
| B3 | 类型逃逸（`as any` / `: any` / `@ts-ignore`） | 【人工】 | 修复前 24 处，已修 4 |
| B4 | 每个 Promise 要么 await，要么处理 rejection | 【闸门】`code-rules.test.ts` | 修复前 1 违规，已修 |
| B5 | 命名与行为一致 | 【人工】 | 1 违规，已修 |
| B6 | 魔法数字：绕过 token 的字面值 | 【闸门】`check-ui-tokens.mjs` R1–R3 + R7 | R1–R3 无新增；R7 新增两个间距桶并各拧紧一格（435 → 52 / 115 → 108） |
| C1 | 隐式契约：插值必须真插值（选择器、testid、搜索串） | 【人工】+ 词法扫描 | 修复前 1 违规（`Plugins.tsx` 搜索串漏 $），已修；全仓 156 个源码文件复扫 0 命中 |
| C2 | 空真测试：断言必须在格式错误时也会失败 | 【人工】 | 2 违规，已修 |
| C3 | 用户可见文案与后端可见原因走消息目录 | 【闸门】`check-i18n.mjs` | 3 违规 |
| C4 | 颜色不得是唯一信号 | 【闸门】`status-tone.test.ts` | 检查过，0 违规 |
| C5 | `NO_DATA`/`UNKNOWN` 不得伪装成健康或数字 | 【闸门】`check-status-vocabulary.mjs` | 检查过，0 违规 |
| C6 | 破坏性颜色只给不可逆动词，且放在 `⋯` 里 | 【人工】 | 1 违规 |

## 2. 结构类：单一真相（A）

### A1 状态表唯一
- **规则**：wire code → `tone`/`state`/`labelKey`/`glyph` 的映射，只允许出现在 `components/status-tone.ts` 的 `STATUS_MAP` 里。别处只读不建。
- **违反**：任何其它文件出现 code→tone 的 `if`/`switch`/对象字面量；任何文件自定义一套 `READY/FAILED` 到颜色的映射。
- **判定**：`grep -rnE "tone: (ok|danger|warn)" apps/platform-web/src --include=*.ts | grep -v status-tone.ts` 为空；
  `grep -rn STATUS_MAP apps/platform-web/src --include=*.tsx` 只应命中读取点。

### A2 读表必须 fail-closed
- **规则**：`STATUS_MAP[code]` 之后允许 `.tone` 的前提是同一表达式已经声明了 code 缺失时的结果（`?.`、`??`、`? x : undefined`、`&&`）；否则必须走 `statusForCode()`。
- **违反**：`const tone = STATUS_MAP[code].tone;` —— code 不在表里时抛 TypeError，整块渲染消失。
  历史点：`Access.tsx:44`、`Diagnostics.tsx:45`（本轮修复前仍在）。
- **判定**：【闸门】`src/code-rules.test.ts` → "every index into STATUS_MAP states its fallback"。
  它按行断言：出现 `STATUS_MAP[` 的行必须同时出现兜底语法。

### A3 安装状态单一推导
- **规则**：插件安装结论只由 `lib/installation-state.ts` 的 `deriveInstallationState` 给出；`state`/`readiness` 不得各自再推一遍。
- **违反**：页面里出现第二套"什么算已安装"的判定，或同一字段在两个页面推出两个词。
- **判定**：`grep -rnE "state === (.)(INSTALLED|ACTIVE|STAGED)" apps/platform-web/src/pages` 命中后人工复核：
  命中必须是"某次写操作期待的目标状态"或"筛选条件"，不能是渲染用词。

### A4 格式化器唯一
- **规则**：时间 → `format.ts:formatDate` / `age.ts`；相对年龄 → `ageMessage`；身份缩写 → `identity.ts`；字节/时长 → `format.ts`。
  调用点不得自己拼单位，也不得 `toLocaleString()` 不带 locale。
- **违反**：`new Date(x).toLocaleString()`（跟浏览器语言走，不跟产品语言走）；`return ... + " s"` 这类硬编码单位；格式化函数返回状态文案（`"No data"`）。
- **判定**：`node scripts/check-ui-tokens.mjs` 的 `format-locale` 桶（今天 4/4，棘轮记账）＋
  `grep -rn "toLocaleString()" apps/platform-web/src` 必须为空。

### A5 写操作必须回读
- **规则**：动词成功 = 写完再 GET 同一个资源看到期望状态（`lib/verify-after-write.ts`）。写请求自己的响应体永远不算证据。
- **违反**：用 `api.post()` 的返回值直接 `setState` 并渲染成"已生效"。
- **判定**：`grep -rn "verifyAfterWrite" apps/platform-web/src/pages` 应为全部有写动词的页面；
  再 `grep -rn "const result = await api.post" apps/platform-web/src/pages` 复核例外。

### A6 去重账本
- **规则**：一个 key 只有在读**成功**之后才能记 settled；失败不记账，下一轮还要再问。
- **违反**：请求发出前就标记"问过"；或 effect 被替换后把答案丢掉。
- **判定**：【闸门】`src/lib/facts-ledger.test.ts`（含"一次失败的读不冻结该行"）。

### A7 表格原语
- **规则**：列表页的身份列、行菜单、卡片降级只用 `pages/table-kit.tsx` 的 `IdentityCell`/`RowActions`/`StackCell`/`cardCellClass`。
  `components/ui/table` 是原语层，页面可以直接用它拼非列表表格，但要复用 `table-kit` 的身份与菜单约定。
- **违反**：页面自己写一段 `data-testid` 行 id 或自己拼 `⋯` 菜单。
- **判定**：`grep -rn "copy-id" apps/platform-web/src/pages | grep -v table-kit` 必须为空（一行一个复制入口）。

### A8 闸门自身
- **规则**：`check-i18n` / `check-status-vocabulary` / `check-ui-tokens --ratchet ui-debt.json` / `check-ui-metrics` 必须全绿；
  `ui-debt.json` 的数字只许下调，下调后不许再上调。
- **违反**：改预算让红灯变绿；删规则；把闸门从 CI 摘掉。
- **判定**：`node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json` 输出 6 行 `ok` + `PASS`，
  且 `git diff docs/design/ui-visual-v3/spec/ui-debt.json` 里没有数字变大。

## 3. 代码卫生（B）

### B1 死代码
- **规则**：三种都算死代码：(a) `styles.css` 里的 class selector 没有任何源文件会渲染；
  (b) `export` 的符号在仓库里零引用（含测试）；(c) 被注释掉的代码块、`TODO/FIXME/XXX/HACK`。
- **违反**：(a) 删了组件留下的 `.sidebar-meta-details`；(b) 零引用的 `getCsrfToken`；(c) 注释里的旧实现。
- **判定**：【闸门】`src/code-rules.test.ts` → "every class selector is reachable from a source file"（模板拼接与 `react-flow__*` 白名单在内）；
  未引用导出用一次性脚本扫（§4），注释块用 `grep -rnE "^\s*//\s*(const|return|if |import )" apps/platform-web/src`。

### B2 重复定义
- **规则**：同一个 selector + 同一层叠上下文（同一组 at-rule 之内）里，同一个 property 只声明一次。
  允许的例外只有媒体查询的响应式覆盖——那是不同的上下文，不是重复。
- **违反**：`.nav-section-label` 在 271 行与 1536 行各写一次，后一次静默获胜；`.stat-provenance { display:none }` 相邻两行贴两遍。
  历史上打坏登录页 390 与三页两栏网格的就是这一类。
- **判定**：脚本见 §4：按 at-rule 栈切块，比较 (selector, context, property) 三元的重复；
  相邻（≤3 行）且声明体完全相同的两块由 `code-rules.test.ts` 闸门拦下。

### B3 类型逃逸
- **规则**：`any` 只允许出现在"外部世界边界"（`window` 上的第三方注册表、路由 state、来不及建模的 manifest），且必须当场收窄；
  禁止 `@ts-ignore`；禁止用 `as any` 绕过本仓库自己定义的类型。
- **违反**：`nodeTypes={nodeTypes as any}`、`(location.state as any)?.from`、`let body: any`。
- **判定**：`grep -rnE ": any\b|\bas any\b|<any>|any\[\]" apps/platform-web/src | grep -v "\.test\."` 逐条复核，
  当前 20 处（Nodes 7 / extensions 4 / types 2 / GraphCanvas 2 / Access 2 / Login 1 / InstallWizard 1 / Governance 1）。

### B4 Promise 必须有归属
- **规则**：每个返回 Promise 的调用要么 `await`，要么 `.catch()`/第二个参数，要么显式 `void` **并**在同一表达式里处理 rejection。
- **违反**：`onClick={() => void navigator.clipboard?.writeText(id)}` —— 剪贴板被拒时是 unhandled rejection（`Jobs.tsx:243` 历史点）。
- **判定**：【闸门】`code-rules.test.ts` → "never discards a clipboard write with void"；
  人工再扫 `grep -rn "void .*\.then\|void navigator\|void fetch" apps/platform-web/src`。

### B5 命名与行为一致
- **规则**：变量名描述它装的东西，函数名描述它返回的东西。一个叫 `code` 的变量里不能放本仓库映射出来的 code；
  一个叫 `formatBytes` 的函数不能返回"没有数据"这种状态文案。
- **违反**：`Diagnostics.tsx` 里 `const code = database === "connected" ? "READY" : "FAILED"`（真正的 wire 值是 `database`）；
  `format.ts:22` 的 `formatBytes` 返回 `"No data"`（spec M3 已点名）。
- **判定**：人工读 diff；对每个 `const x = <推断>`，问"上游传下来的那个字段叫什么"。

### B6 魔法数字
- **规则**：数值有四个来源，优先级从高到低：语义 token（`--ow-radius-card` / `--ow-control-md` / `--ow-type-*` / `--ow-row`）
  > 4/8 刻度（4/8/12/16/24/32）> 具名常量（`POLL_INTERVAL_MS`、`RECORD_BREAKPOINT`）> 字面 px。
  radius / 控件高度 / 字号三类必须走 token，其余允许刻度值。
- **违反**：`font-size: 13.5px`（绕过 type ladder，已由 `styles.token-contract.test.ts` 禁）；`border-radius: 5px`（不在三档内）。
- **判定**：【闸门】`check-ui-tokens.mjs` 的 R1/R2/R3（今天 119/14/7，全部等于预算，即零新增空间）。
  刻度外的间距字面值（`gap: 10px` 等 55 处）不在闸门内，属已知技术债，见 §4 说明。

## 4. 契约与测试（C）

### C1 隐式契约
- **规则**：凡是"字符串里嵌一个变量"的地方（CSS class、`data-testid`、搜索 haystack、选择器），插值必须真的发生；
  写下时就地验证一次"它到底会不会变"。
- **违反**（两种，都真发生过）：

      # 1. 属性里写死了一个模板字符串：所有行的 testid 完全相同（历史事故）
      data-testid="row-`{id}"

      # 2. 模板字符串里漏了 $：前一段是字面文本，按 id 永远搜不到（Plugins.tsx:184）
      const matchesQuery = `{plugin.id} ${plugin.name} ${plugin.publisher || ""}`.toLowerCase();

- **判定**：

      grep -rn --include=*.tsx -e '"`{' apps/platform-web/src   # 属性值里出现反引号+花括号 => 第 1 类
      grep -rn --include=*.tsx -e '`{'  apps/platform-web/src   # 花括号前没有 $         => 第 2 类


### C2 空真测试
- **规则**：一条断言必须在"被测格式错了"的时候失败。可选链 + 否定断言、循环体里 `if (!x) continue`、
  夹具为空时零次迭代，都是空真。
- **违反**：`expect(display?.title).not.toBe(reason)`（`display` 为 undefined 时通过——本轮实测 vitest 会放过它）；
  `for (const key of [...]) { if (!key) continue; ... }`（一个 key 都没有时整段跳过且通过）。
  （实测：`expect(undefined).not.toContain("a")` 会抛错，`expect(undefined).not.toBe("a")` 会通过。所以只否定 `toBe` 才是空真。）
- **判定**：`grep -rnE "expect\([^)]*\?\." apps/platform-web/src --include=*.test.ts` 逐条看否定式断言；
  `grep -rn "if (![a-z]*)\? continue\|continue;" apps/platform-web/src --include=*.test.ts`。

### C3 文案走消息目录
- **规则**：用户可见文案、以及会被审计/展示的后端可见原因串，都来自 `i18n/catalogs/*.json`；
  JSX 里不许出现裸英文词，也不许一个词只出现在一种语言里。
- **违反**：`Access.tsx:334-336` 的 `<SelectItem value="viewer">Viewer</SelectItem>`（角色标签硬编码，切换中文后仍是英文）；
  `PluginDetail.tsx:187` 把 `"Disabled from plugin detail"` 直接发给后端写审计（同页另处已走 `t()`）。
- **判定**：【闸门】`node scripts/check-i18n.mjs`（缺键/未用键，今天 1240 键 0 未用）；
  硬编码：`grep -rnE ">[A-Z][A-Za-z]+(<| )" apps/platform-web/src --include=*.tsx | grep -v "t("`。

### C4 颜色不是唯一信号
- **规则**：每个 tone 有自己的 glyph，`READY/INSTALLED` 这类同色不同义的必须不同形。
- **违反**：两种状态共用同一形状+同一色（历史：`CONFIRMED` 与 `ACCEPTED` 测出同一对色值）。
- **判定**：【闸门】`src/components/status-tone.test.ts` → "gives every tone its own glyph"、`installation-state.test.ts` 的 glyph 互异断言。

### C5 NO_DATA / UNKNOWN 不伪装
- **规则**：取不到数据渲染 `NO_DATA`（虚线 token），不确定渲染 `UNKNOWN`（点线 token），答了 0 才渲染数字；
  协议码只作为 `title`/`data-*` 出现，不进文案目录，也不当正文。
- **违反**：目录消息里出现 `NO_DATA`/`UNKNOWN`；把 `UNKNOWN` 画成绿色；一个区域超过 1 个虚线 token。
- **判定**：【闸门】`node scripts/check-status-vocabulary.mjs`；`grep -rn "NO_DATA" apps/platform-web/src --include=*.tsx | grep -v status-indicator`。
  这条同时是 `AGENTS.md` 的绝对禁止项（把 UNKNOWN/PARTIAL/NO_DATA 伪装成健康状态）。

### C6 破坏性动词
- **规则**：`--ow-danger` / `variant="destructive"` 只给不可逆动词（uninstall、revoke、delete），并且放进行的 `⋯` 菜单 + `ConfirmAction`；
  可逆动词（disable、stop、restart、retry、rollback）不上红色。
- **违反**：`Jobs.tsx:236` 的 Cancel 用 `variant="destructive"`（取消属可逆类；`Plugins.tsx` 的 disable 保留红色是因为代码里写明"本版本 UI 无法恢复"，属于规则承认的例外）。
- **判定**：`grep -rnE "variant=.destructive.|danger: true" apps/platform-web/src --include=*.tsx` 逐条对照动词类别表。

## 5. 已知豁免（写清楚，不进违规表）

- **`components/ui/*` 的 copy-in 原语**：`DialogTrigger`、`SelectGroup`、`SheetClose` 等由 shadcn 模板整包落地，
  仓库暂时没有调用点也算正常——它们是"可用的零件"，不是"留下的残骸"。
- **`react-flow__*` 的 CSS**：这些 class 由 `@xyflow/react` 运行时生成，源码里搜不到，删除会导致画布没有边和手柄。
- **`RECORD_BREAKPOINT`**：零引用，但它与旁边 20 行注释一起是"768 只有一个断点"这条决定的唯一书面记录，保留并在此登记。
- **间距字面值**：`--ow-space-*` token 存在，但 spec 的四档（radius/type/control/header）没有把间距纳入闸门；
  344 处"字面值恰好等于某个 token"和 55 处"不在 4/8 刻度上"因此记为技术债，不记为违规。
- **`check-ui-tokens` 的 6 个桶**：`ui-debt.json` 是它们的预算，桶内数字不算违规，超过预算算。

## 6. 一次性扫描脚本（判定方法的实现）

B1(b)/B2 这类没有常驻闸门的检查，用两个一次性脚本实现，逻辑写在这里以便重放：

1. **未引用导出**：遍历 `src/**/*.ts{,x}` 收集 `^export (function|const|class|interface|type) NAME`，
   再对所有文件（含测试）做 `\bNAME\b` 计数，排除定义文件自身后为 0 即无引用。
2. **重复声明**：逐字符扫描 `styles.css`，用栈记录 at-rule 嵌套（每个声明块记住打开时的 at-rule 链），
   收集 (context, selector, property, value, line)，按三元分组：
   同 context 同 selector 同 property 出现两次即为重复；两者 value 相同是"纯重复"，不同是"静默覆盖"。

两条脚本都不进仓库：它们产出的是数字，数字进本文件与本轮报告，规则本身由 `src/code-rules.test.ts` 常驻兜底。

## 7. 变更记录

- 2026-11 首版（22 轮迭代后的一次全量代码质量审查）：20 条规则、23 处修复、`code-rules.test.ts` 4 条常驻断言、
  `ui-debt.json` 的 `uppercase-guard` 由 20 拧到 19。
