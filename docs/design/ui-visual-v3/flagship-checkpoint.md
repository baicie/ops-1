# V3 旗舰页基准复测：boxed / flat 分离计数

> **一句话**：标杆页的盒状区域确实从 12 降到 3（Overview）、4 降到 1（Plugins）、8 降到 3（Nodes）；
> 但**这三个数字旧工具一个都没给出**——旧口径报的是 12→11、4→4、8→8。"12 个盒状区域 → 3 层"里
> 上半句对、下半句不是被度量出来的属性（DOM 堆叠块数两侧都是 4）；并且旧工具从未同时产出这两个数字。
>
> 本文件是 `tests/ui/visual-v3-flagship.spec.ts` 度量修复后的复测记录。复测日期口径：分支
> `feat/ui-visual-excellence-v3`，HEAD `52272c1`，对照 `e449f3b` 与 `e449f3b^ = cf5f807`。

---

## 1. 旧度量为什么失真：三个机制

原度量是一张**类名清单**（旧 `visual-v3-flagship.spec.ts:74-80`）：

```ts
const SURFACES = ['.panel', '.ow-metric', '.ow-summary-card', '.module-card',
                  '.attention-banner', '.callout', '.async-panel'];
```

### 1.1 清单里的类已经不在页面上

`.attention-banner` 在 Overview 重构后只由 `OpsCenter.tsx:31` 输出。before 侧它确实存在（实测 1 个），
after 侧恒为 0——清单对一个已经不输出该类的页面继续"记账"，等于把一个删除项留在分子里。

### 1.2 清单对新引入的扁平区域完全失明

`.health-band` / `.stat-block` / `.stat-strip` / `.console-grid` / `.module-strip` 五个类全部
由 `e449f3b` 引入（`styles.css:1254, 1271, 1272, 1319, 1303`），一个都不在清单里。而设计意图恰好是
"把表面从盒状桶搬到扁平桶"——不数扁平桶，等于只测了搬家后变轻的那一半。

### 1.3 最致命：被 CSS 压平的元素仍被算作盒子

这条才是"数字失真"的真正来源。`styles.css` 有两条 reset：

| 规则 | 位置 | 作用 |
|---|---|---|
| `.stat-strip > *` | `styles.css:1279-1286` | `border: 0; border-radius: 0; background: transparent; box-shadow: none`——strip 的每个单元格不再是卡，只留 1px 分隔线 |
| `.module-card` | `styles.css:1304-1312` | `background: transparent; border: 0; border-radius: 0`——模块卡被压成 ledger 行 |

于是 after 侧 Overview 的 DOM 里仍有 4 个 `.ow-metric` 和 4 个 `.module-card`，但屏幕上它们是
**行与单元格**，不是盒子。类名普查把这 8 个元素继续算成盒子，报出 **11**。

### 1.4 "12 → 3" 是怎么来的：同一份输出里的两个字段

- `12` = before 的 `surfacesTotal`（3 panel + 4 ow-metric + 4 module-card + 1 attention-banner）
- `3` = after 的 `surfaces['.panel']`（**只有这一个字段**；它自己的 `surfacesTotal` 是 11）

即半边取总和、半边取单项，两个数字出自不同口径。**旧工具从来没有产出过 "3"。**

---

## 2. Overview 当前的结构容器清单（`apps/platform-web/src/pages/Overview.tsx`）

### 2.1 盒状（boxed = 四边描边 + 非透明底色，实测 3 个）

| 容器 | 角色 | 源码 | CSS |
|---|---|---|---|
| `.panel#attention` | 待处理队列（操作面） | `Overview.tsx:179` | `styles.css:282` |
| `.panel[data-testid=overview-modules]` | 模块来源台账的容器 | `Overview.tsx:199` | `styles.css:282` |
| `.panel[data-testid=overview-audit]` | 近期事件历史 | `Overview.tsx:222` | `styles.css:282` |

### 2.2 扁平（flat = 有意的无框结构区域，实测 5 个页面级 + 1 个 shell 级）

| 容器 | 角色 | 源码 | CSS |
|---|---|---|---|
| `.health-band` | 第 1 层：判定，只有底部一条规则线 | `Overview.tsx:120-138` | `styles.css:1254-1262` |
| `.stat-block` | 第 2 层外层块 | `Overview.tsx:142` | `styles.css:1271` |
| `.stat-strip` | 第 2 层：4 个计数排成一条 hairline 带 | `Overview.tsx:143` | `styles.css:1272-1286` |
| `.console-grid` | 第 3 层：2 列工作区栅格（无框） | `Overview.tsx:178` | `styles.css:1319` |
| `.module-strip` | 模块 ledger（面板内部的扁平列表） | `Overview.tsx:203` | `styles.css:1303`（`.module-card` reset 见 1304-1312）|
| `.toolbar` | shell 侧 `VersionBadge`（挂载于 `AdminSidebar.tsx:61`），与页面无关且两侧恒定 | `VersionBadge.tsx:90` | `styles.css:339` |

### 2.3 类名还在、框已被 CSS 拿掉（flattened，实测 8 个）

`.ow-metric` ×4（`Overview.tsx:144-171`，被 `styles.css:1279` 压平）、`.module-card` ×4
（`Overview.tsx:205`，被 `styles.css:1304` 压平）。

`.page-header`（`page-header.tsx:32`）两侧相同，不计入任何一桶。

---

## 3. 工具改动（`tests/ui/visual-v3-flagship.spec.ts`）

三个原则：**类名是声明，绘制出的框才是事实**；**两桶分开、永不相加**；**每次度量自己记录来源**。

```ts
const BOX  = ['.panel', '.ow-metric', '.ow-summary-card', '.module-card', '.callout', '.async-panel', '.attention-banner', '.notice-bar'];
const FLAT = ['.health-band', '.stat-block', '.stat-strip', '.console-grid', '.module-strip', '.info-grid', '.toolbar'];

// 四边都有描边 + 非透明底色 = 一个盒子。类名匹配只是候选，绘制结果才是判据。
const paintsFrame = (el: Element) => {
  const cs = getComputedStyle(el);
  const sides = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map((v) => parseFloat(v) || 0);
  const bg = cs.backgroundColor;
  const filled = bg !== '' && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
  return sides.every((w) => w > 0) && filled;
};

// 每个类：matched（DOM 里有几个）/ boxed（其中还画着框的）/ flat（框已被 CSS 拿掉的）
const boxCensus = census(BOX);   // -> boxed.total / boxed.topLevel / boxed.flattened / boxed.byClass
const flatCensus = census(FLAT); // -> flat.total / flat.topLevel / flat.byClass
```

输出字段（`_metrics.json` 每行一份）：

| 字段 | 含义 |
|---|---|
| `boxed.total` | 画着四边框的盒状区域数（去重） |
| `boxed.topLevel` | 其中不被另一个盒子包裹的个数（"同一音量"的真实数量） |
| `boxed.flattened` | 类名在、框被 CSS 拿掉的元素数——这个数越大，旧口径高估越多 |
| `boxed.byClass` / `flat.byClass` | 逐类 matched / boxed / flat |
| `flat.total` / `flat.topLevel` | 扁平结构区域数；topLevel 排除嵌套在另一条扁平带里的（如 `.stat-strip` 在 `.stat-block` 内） |
| `layers` | 内容列真实堆叠的块（含 boxed 标记与高度）——旧 `regions` 停在 `AsyncBoundary` 的透明包裹层（`async-boundary.tsx:142`），每页只看到 2 个孩子，看不见层次变化 |
| `unlistedBoxes` | **漂移告警**：画着框却没在词汇表里的结构容器（这次就是清单失效的直接原因） |
| `origin` | 这一行取自哪个 origin——before/after 只可比当且仅当两侧都能自证来源 |
| `surfaces` / `surfacesTotal` | 旧口径原样保留，以便与已提交的 before/after 证据直接对照，也让失真本身可复现 |

另加 `V3_OUT` 环境变量：复测写临时目录，不覆盖 `artifacts/ui/visual-v3/flagship/{before,after}`
已提交的证据。

---

## 4. 本轮的局限（先写在前面）

1. **flat 词汇表是按 V3 的命名建立的**。before 侧的两个旧扁平容器 `.metric-grid` / `.overview-grid`
   不在表里（它们在 `layers` 实测里是 `boxed:false` 的块，见 §5.3），所以 before 的页面级扁平数
   被**低估**：Overview before 实际有 3 个页面级扁平容器，被计成 1 个。boxed 侧没有这个问题——
   两侧用同一条计算样式判据。
2. `unlistedBoxes` 在 Plugins / Nodes 各命中 1 个 shadcn 按钮样式的 `<div>`（`inline-flex h-9 …`，
   宽 392/387px）。它不是页面区域，是本条告警的已知误报；保留它是因为"清单失效"正是本次要防的事故。
3. before 侧跑的是 `vite` 开发服务器（React 开发构建），after 侧跑的是本地栈上的生产构建。
   CSS 与 DOM 一致，React 渲染路径不同；数字在 12 组里全部一致（见 §5.4），可以认为不影响结论。
4. `flat` 计数含 1 个 shell 级 `.toolbar`（侧栏 `VersionBadge`，`AdminSidebar.tsx:61` → `VersionBadge.tsx:90`）。**两侧恒定**，不影响差值。

---

## 5. 实测数字

### 5.1 主表（1440×900 / light / en；其余 11 组数值完全相同，见 §5.4）

| 页面 | 旧口径 before | 旧口径 after | **boxed before** | **boxed after** | boxed 顶层 before→after | **flat before** | **flat after** | 被 CSS 压平的元素 before→after |
|---|---|---|---|---|---|---|---|---|
| /admin/overview | 12 | 11 | **12** | **3** | 8 → 3 | 2 | 6（顶层 4） | 0 → **8** |
| /admin/plugins | 4 | 4 | **4** | **1** | 4 → 1 | 2 | 4（顶层 3） | 0 → **3** |
| /admin/nodes | 8 | 8 | **8** | **3** | 8 → 3 | 3 | 5（顶层 4） | 0 → **5** |

旧口径这一列是本次失真的核心：它说 Plugins 和 Nodes **一点没变**（4→4、8→8），
而真实变化是 4→1 和 8→3。

### 5.2 逐类明细（before → after）

**/admin/overview**　boxed：`.panel` 3→3、`.ow-metric` 4→(0 boxed / 4 flattened)、
`.module-card` 4→(0 boxed / 4 flattened)、`.attention-banner` 1→0。
flat：`.module-strip` 1→1、`.toolbar` 1→1（shell）、新增 `.health-band` 1、`.stat-block` 1、
`.stat-strip` 1、`.console-grid` 1。

**/admin/plugins**　boxed：`.panel` 1→1、`.ow-summary-card` 3→(0 boxed / 3 flattened)。
flat：`.toolbar` 2→2、新增 `.stat-block` 1、`.stat-strip` 1。

**/admin/nodes**　boxed：`.panel` 1→1、`.ow-summary-card` 5→(0 boxed / 5 flattened)、
`.callout` 2→2。flat：`.toolbar` 2→2、`.info-grid` 1→1、新增 `.stat-block` 1、`.stat-strip` 1。

### 5.3 内容列堆叠块（`layers`，实测）

| 页面 | before | after |
|---|---|---|
| Overview | `attention-banner`(78, boxed) · `panel`(241, boxed) · `metric-grid`(152, flat) · `overview-grid`(518, flat) | `health-band`(66, flat) · `stat-block`(151, flat) · `console-grid`(464, flat) · `panel`(500, boxed) |
| Plugins | `ow-summary`(137, flat) · `toolbar`(36, flat) · `panel table-panel`(222, boxed) | `stat-block`(121, flat) · `toolbar`(36, flat) · `panel table-panel`(228, boxed) |
| Nodes | `ow-summary`(137, flat) · `toolbar`(36, flat) · `panel table-panel`(166, boxed) | `stat-block`(137, flat) · `toolbar`(36, flat) · `panel table-panel`(166, boxed) |

口径：`[data-async-state="ready"]` 的直接子块（`AsyncBoundary` 的成功分支，`async-boundary.tsx:142`）；
`PageHeader` 在边界外层，不计入。

**堆叠块数两侧都是 4 / 3 / 3**——变的是块的**框**，不是块的**数量**。

### 5.4 稳定性：12 组同值

两侧各 12 组（3 视口 × 2 主题 × 2 语言），每页的 `boxed`（total/topLevel/byClass）与 `flat`
在 12 组内**各只有 1 种取值**。即上面的数字对 1440/1024/390、明/暗、en/zh 都成立，不是某个视口的偶然。

---

## 6. 回答："12 个盒状区域 → 3 层"准确吗？

**不准确，需要改写。** 逐项：

| 说法 | 判定 | 依据 |
|---|---|---|
| before 是 12 个盒状区域 | **准确**（且可交叉验证：`visual-audit.md` §2.3.2 用另一套 14 选择器独立测得 Overview 11 张卡 = 本轮的 12 减去它没收录的 1 个 banner；顶层 7+1=8 也一致） | §5.1、§5.3 |
| after 是 3 个盒状区域 | **准确**，但旧工具没产出它（旧工具给 11） | §5.1 |
| after 是"3 层" | **不成立**：`layers` 实测内容列 4 块（before 也是 4 块）。"三层"是含义分层（判定/计数/处置与历史），不是 DOM 或视觉的层数 | §5.3 |
| "12 → 3"是一次 before/after 度量 | **不成立**：12 取自 `surfacesTotal`，3 取自 `surfaces['.panel']`，同一份输出里的两个不同字段 | §1.4 |

### 建议的正确说法（按证据强度排序）

1. **Overview 的盒状区域从 12 降到 3，另有 8 个元素（4 个 `.ow-metric`、4 个 `.module-card`）的框
   被 CSS 去掉，改为 5 个扁平结构区域（判定带、计数带、控制台栅格、模块 ledger）承载同样的信息。**
2. 三个标杆页面的盒状区域：Overview 12→3、Plugins 4→1、Nodes 8→3；内容列堆叠块数不变（4/3/3），
   变化在"每块的框"而不是"块的数量"。
3. 需要一句话时用：**"三个页面各少掉 9、3、5 个盒子，其中 Overview 的 8 个盒子是就地压平，不是删除。"**

### 需要撤回的说法

- "Overview 从 12 个盒状区域变成 3 层"——**撤回**；改为上列第 1 条。
- 任何以旧 `surfacesTotal` 为依据的"改动幅度不大/几乎没变"结论（旧口径给 12→11、4→4、8→8）
  ——**撤回**；失真方向是**低估**了改进，而不是高估。

---

## 7. 复现

```bash
# after 侧：本地栈（kernel 127.0.0.1:18181）+ 仓库 dist
#   （apps/platform-web/dist 的时间戳晚于 src 下每个文件，且 git status 对 src 为空 ⇒ dist 即当前源码的产物）
cd tests/ui
V3_MODE=after V3_OUT=/tmp/v3/after npx playwright test visual-v3-flagship.spec.ts

# before 侧：不 checkout、不碰工作树——把 cf5f807 的 platform-web 解到临时目录，
# 复用仓库 node_modules，用 vite dev 起在 18182（其 vite.config.ts 已把 /api 代理到 18181）
git archive cf5f807 apps/platform-web | tar -x -C /tmp/v3-before
ln -sfn "$PWD/node_modules" /tmp/v3-before/node_modules
ln -sfn "$PWD/apps/platform-web/node_modules" /tmp/v3-before/apps/platform-web/node_modules
(cd /tmp/v3-before/apps/platform-web && ../../node_modules/.bin/vite --host 127.0.0.1 --port 18182 --strictPort)

# 一个把 baseURL 硬钉到 18182 的临时配置（不写进仓库），避免环境变量没生效时静默回落到 18181
cd tests/ui && V3_MODE=before V3_OUT=/tmp/v3/before \
  npx playwright test visual-v3-flagship.spec.ts --config=/tmp/pwold/playwright.config.ts
```

`_metrics.json` 的每行都带 `origin`：before 侧全部为 `http://127.0.0.1:18182`，after 侧为
`http://127.0.0.1:18181`。**第一次尝试**用 `OPSOWEAVE_URL` 切换时，两侧每一页的数字、`pageHeight`
（1394）、字体普查都逐项相同，并且当时 `curl http://127.0.0.1:18182/src/pages/Overview.tsx` 里
`health-band` 命中 0——即那次运行**回落到默认 baseURL，把同一个构建量了两遍**，差点写成
"前后无变化"。因此 `measure()` 增加了 `origin` 字段自证来源，before 侧改用把 baseURL 硬钉到
18182 的临时配置（不写进仓库）。
**截图无法重测**：PNG 里没有 DOM，类名、计算样式、嵌套关系都取不回来，before 侧只能真跑一次。
