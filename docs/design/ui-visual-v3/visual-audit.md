# OpsWeave UI 视觉审计 v3

> 审计对象：`feat/ui-visual-excellence-v3` @ `51e8eb7`（工作树 `ops-0.0.4-studio`）
> 被审产品：Staging `http://82.156.234.84:3000`，`/api/v1/version` 实测
> `{"version":"0.0.1","commitSha":"51e8eb73389d36e9779422de9542954368861b1a","buildTime":"2026-10-29T13:05:53Z","environment":"STAGING"}`
> 即：截图与源码是同一个 commit，不存在"截图是旧的"这类偏差。
> 审计日期：2026-10-29 · 本轮**只审计，未修改任何产品代码/CSS/测试**。

---

## 0. 方法与证据口径

### 0.1 三种证据，各自能证明什么

| 证据类型 | 采集方式 | 能证明 | 不能证明 |
|---|---|---|---|
| **像素审阅** | 对真实运行页面 `fullPage` 截图人工判读 | 层级、对齐、密度、色彩、文案 | 精确像素值 |
| **DOM 度量** | Playwright 在页面内 `getComputedStyle` / `getBoundingClientRect` 全量采样 | 精确字号分布、行高比、scrollWidth、裁切数量、卡片嵌套深度 | 视觉是否"好看" |
| **源码读** | 逐行读 `styles.css`(1276 行)、12 个 `ui/` 原语、12 个 `app/` 复合件、7 个 shell、20 个 page | 设计意图、令牌归属、状态映射 | 运行时最终外观 |

本报告里凡"我看到了 X"都同时给了截图路径；凡"X 是 N"都给了可复算的数字来源（`artifacts/ui/visual-v3/audit/_metrics_*.json`）。

### 0.2 截图矩阵：12 组全部度量，截图按优先级分配

**12 组（3 视口 x 2 主题 x 2 语言）全部完成"加载 + 度量"**；截图在每组内按页面优先级裁剪，共落盘 **105 张 PNG**：

| 视口 | Light/en | Light/zh | Dark/en | Dark/zh |
|---|---|---|---|---|
| **1440x900** | 26 张（全路由） | 26 张（全路由） | 6 张 | 10 张 |
| **1024x768** | 5 张 | 1 张 | 0 张 | 1 张 |
| **390x844** | 12 张 | 2 张 | 1 张 | 4 张 |

- **度量无缺口**：12 份 `_metrics_*.json` 覆盖 26 条路由 x 12 组，本报告的每个数字都来自它们。
- **截图有缺口**：1024 与 390 只对关键页落盘。对未落盘格，报告只写度量事实、不写像素判断（§5.1 汇总）。
- **入库 39 张**（见 §4），其余 66 张本地保留不入库——仓库已有 **934 张**被跟踪 PNG，本轮只加 39 张（+4.2%）。

### 0.3 Playwright 使用：6 次（上限 6，已用满）

1. 1440 Light/en 全量 23 路由 + 路由发现（有效）
2. 1440 Light/zh + 1024 Light/en（**作废**：见 §0.4）
3. 1440 Dark/en + Dark/zh + 1024 Light/zh（**作废**）
4. 12 组矩阵首跑（取消：队列把 390 排在最后）
5. 12 组矩阵重排（取消：主动作废，避免沿用有隐患的脚本）
6. **11 组实采**（有效，产出本报告全部数据）

### 0.4 一次真实的采集事故（记录下来，避免复读）

第一版脚本把 `/login` 放在路由列表**首位**，并对它执行 `context.clearCookies()`。结果该 context 之后的**每一个**页面都是未登录状态，27 个路由全部渲染成登录页——而 `docHeight` 恰好等于视口高度、`textEls`=15，看起来"很正常"。
如果我只检查"截图文件存在、Playwright 退出码 0"，这次审计会**整篇建立在登录页的截图上**。
教训：批量截图必须断言 `finalUrl` 不落在 `/login`。本报告所有数据在修正后才采信。

### 0.5 一项必须承认的覆盖缺口

20 页中有 **9 页做了逐像素审阅**（Overview / Jobs / Nodes / Plugins / Governance / Diagnostics / Pipeline Studio / `/app/home` / `/app/incidents`），并额外判读了暗色（1440 Dark/en、Dark/zh）与 390 窄屏（Light/en、Light/zh、Dark/zh）的关键页。其余 11 页的证据是 **DOM 度量 + 源码结构**，报告中对这些页面的判断限定在"可度量事实"和"结构事实"，不做纯审美评判，并在每页 `证据` 行注明。

---

## 1. 结论摘要

### 1.1 一句话结论

**这个界面在"语义诚实"上达到了相当高的水准，在"排版统一"上明显不及格。**
它守住了最难的底线（未知不显示为绿、NO_DATA 不显示 0、STALE 有独立外观、每页单一主 CTA、快捷说明写在页面里），却输在三条最容易修的地方：

1. **状态映射缺码**：`SUCCEEDED`/`ACCEPTED`/`RUNNING` 不在任何一张状态表里，于是"成功"被渲染成"未知"的虚线药丸——**最健康的状态看起来最不可信**。
2. **字号没有阶梯**：12px 承载了 54%–76% 的正文，8.5–10.5px 承担了 Studio 的语义标签，13px 只在 Jobs 一页占优。"13px 支配正文"这个说法**不成立**（§2.2 给出真实计数）。
3. **CSS 有两层主人**：`styles.css` 里 33 个选择器被定义两次、41 处属性被覆写、`.truncate`/`.block` 直接抢了 Tailwind 的工具类名。

### 1.2 20 页 8 维评分总表

分值：1=不可交付 2=明显缺陷 3=可交付但有瑕 4=良好 5=优秀。评分依据见 §3 每页。

| # | 页面 | 信息层级 | 排版 | 对齐与间距 | 组件一致性 | 色彩与对比 | 数据可读性 | 交互反馈 | 响应式 | 均分 |
|---|---|---|---|---|---|---|---|---|---|---|
| 01 | /admin/overview | 4 | 3 | 3 | 3 | 3 | 3 | 4 | 4 | **3.4** |
| 02 | /admin/plugins | 3 | 3 | 2 | 3 | 3 | 3 | 4 | 3 | **3.0** |
| 03 | /admin/plugins/:id | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | **3.0** |
| 04 | /admin/plugins/install | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | **3.0** |
| 05 | /admin/pipelines | 3 | 3 | 3 | 3 | 3 | 2 | 3 | 3 | **2.9** |
| 06 | /admin/pipelines/:id | 3 | 3 | 3 | 2 | 3 | 2 | 3 | 2 | **2.6** |
| 07 | /admin/pipelines/:id/editor | 2 | 1 | 2 | 2 | 3 | 2 | 4 | 2 | **2.3** |
| 08 | /admin/pipelines/:id/run | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | **3.0** |
| 09 | /admin/jobs | 4 | 3 | 3 | 2 | 3 | 3 | 4 | 3 | **3.1** |
| 10 | /admin/jobs/:id | 3 | 3 | 2 | 2 | 3 | 2 | 3 | 1 | **2.4** |
| 11 | /admin/nodes | 3 | 3 | 2 | 3 | 3 | 3 | 4 | 3 | **3.0** |
| 12 | /admin/nodes/:id | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 2 | **2.9** |
| 13 | /admin/governance | 3 | 3 | 2 | 3 | 3 | 2 | 3 | 3 | **2.8** |
| 14 | /admin/instances/:id/logs | 3 | 3 | 3 | 3 | 2 | 3 | 3 | 3 | **2.9** |
| 15 | /admin/activity | 2 | 2 | 3 | 3 | 3 | 2 | 3 | 2 | **2.5** |
| 16 | /admin/access | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | **3.0** |
| 17 | /admin/settings | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | **3.0** |
| 18 | /admin/settings/diagnostics | 2 | 2 | 2 | 3 | 3 | 3 | 3 | 3 | **2.6** |
| 19 | /admin/ops-center | 3 | 3 | 3 | 3 | 3 | 3 | 3 | 3 | **3.0** |
| 20 | /login | 4 | 3 | 4 | 3 | 4 | — | 3 | 4 | **3.6** |
| S1 | /admin/* 未匹配 (NotFound) | 3 | 3 | 3 | 3 | 3 | — | 3 | 3 | **3.0** |
| S2 | /app/home | 2 | 2 | 2 | 2 | 3 | 2 | 3 | 3 | **2.4** |
| S3 | /app/incidents | 2 | 2 | 3 | 2 | 3 | — | 2 | 3 | **2.4** |
| S4 | /app/{investigations,observability,resources,sources,reports} | 2 | 2 | 3 | 2 | 3 | — | 2 | 3 | **2.4** |
| — | **全站均分** | **2.9** | **2.8** | **2.7** | **2.8** | **3.1** | **2.7** | **3.3** | **2.9** | **2.9** |

**最高分**：/login 3.6（唯一一处把"品牌叙事 + 单一表单"做干净的页面）。
**最低分**：Pipeline Studio 2.3、Job Detail 2.4、/app/home 2.4、/app/incidents 2.4。

### 1.3 最该先改的 10 件事（按影响排序）

| # | 事项 | 影响页 | 为什么排这么前 | 证据 |
|---|---|---|---|---|
| 1 | **补全状态映射**：`SUCCEEDED`/`CANCELLED`/`QUEUED`/`RUNNING`/`CLAIMED`/`ACCEPTED` 缺失 → 落入 `unknown` 虚线药丸 | Jobs, Job Detail, Overview, Diagnostics, Activity, Governance（6 页） | 一处映射修好 6 页；当前**成功比失败更不像成功**，等于把产品的核心结论画成了问号 | §2.4；`status-tone.ts:20-47`；`r1440-light-en__admin_jobs.png` |
| 2 | **合并两张状态表**：`status-tone.ts` 与 `app/status-indicator.tsx` 各 23 码且互相矛盾（`VERIFIED` 一张判 ok 一张判 info；`STAGED` 一张 info 一张 attention） | 全站 | 同一码在表格里蓝色、在卡片里绿色，是"组件一致性"崩坏的根 | §2.4 |
| 3 | **建立字号阶梯并禁止 <11px** | 全站（Studio 最重） | 12px 占正文 54–76%；Studio 有 37 个 <11px 文本节点（8.5/9/9.5/10.5px） | §2.2 |
| 4 | **把 `.truncate` 还给 Tailwind** | Jobs, 全站截断处 | `styles.css:740` 重定义了 Tailwind 同名工具类并追加 `display:block`，让所有 `<span class="truncate">` 变块级 | §2.1 行 2 |
| 5 | **消除 body 字号双写**（`var(--ow-type-base)` 13px → 字面 13.5px）并处理 `--ow-type-xl` 被 `clamp()` 覆盖 | 全站 | 令牌层自我否定，任何"改令牌就看全局变化"的预期都失效 | §2.1 行 5–6 |
| 6 | **统一面板/卡片圆角与所有者**：`.panel` 8px→10px，shadcn `Card` 8px 但 **0 处引用** | 全站 | 12 个原语里 `card.tsx`/`separator.tsx` 无人 import，"shadcn 设计系统"实际只覆盖按钮/表格/徽章 | §2.1 行 9 |
| 7 | **表格单元格统一基线**：多行首列顶对齐、单行列垂直居中 → 同行文字不在一条线上 | Plugins, Nodes, Governance, Job Detail | 每张表都歪，用户读横排时眼睛需要上下跳 | §3 页 02/11/13 |
| 8 | **修 390 横向溢出**：Job Detail `scrollWidth=613` vs 内容宽 375（+238px），元凶是 `<code class="mono small">` 无 `overflow-wrap` | Job Detail | 唯一真正撑破视口的页面；且撑破后整页右侧留白 223px | §2.6 |
| 9 | **面包屑只截最后一段**：`.breadcrumbs{overflow:hidden}` 让每项 shrink 到 0，zh 4 字标签被压到 25px、`/` 分隔符压到 0–2px | 9 页在 390 下 | 28 个被裁节点，移动端首屏左上角就是残句 | §2.5、§2.6 |
| 10 | **清掉不该出现在 UI 上的原始字段名与开发者措辞**：`heartbeatIntervalSeconds`/`maintenancePerNode` 直接渲染；`(the domain ADR is still open)` 给终端用户看 | Diagnostics, /app/incidents, /app/home | 违反 rules/06"所有用户可见文案必须走 i18n 目录"，且是唯一一类"用户看不懂但一眼看出未完成"的文案 | §3 页 18、S2、S3 |

第 11–16 项（未列入前十但同样该改）：Studio 18 个草稿按钮墙；Studio 侧栏塌成 64px 后 brand 溢出；`Activity` 25,158px 高的无分页列表；`/app/*` 侧栏仍展示 Kernel Commit SHA；Governance 表格列宽失衡（Schema 列 300px 只放 `r1`）；Diagnostics 六张指标卡被拆成"2 张卡片 + 1 条分隔条"。

---

## 2. 横向问题（六个，逐个给实测）

### 2.1 Q1 · CSS 所有权现状

#### 2.1.1 根因：一个文件里有两层作者

`styles.css` 不是"一个设计系统"，是**两次设计系统的叠加物**：
- L1–L711 是 0.0.1 时代的手写设计系统（`.btn` / `.status` / `.data-table` / `.panel`）
- L712 起是 0.0.4 重设计追加的第二段（第二个 `:root`、第二个 `html[data-theme="dark"]`、`.ow-metric`、`.module-card`…）
- Tailwind 只承担 `border-solid`/`border` 这类补丁，因为 `preflight: false`（`tailwind.config.cjs:16`）关掉了归一化，原语必须自己带边框样式（`card.tsx:8`、`table.tsx:19`、`table.tsx:35` 都可作证）

**import 顺序决定了谁赢**：
```css
/* styles.css:1-2 */
/* Tailwind utilities load first so this hand-written design system keeps cascade priority. */
@import './tailwind.css';
```
同特异度（0-1-0）时手写层必胜。这不是"兼容策略"，这是**把 Tailwind 降级成了补丁表**。

#### 2.1.2 33 个选择器被定义两次（顶层、非媒体查询内）

用 brace-matching 解析 `styles.css`：922 个块，其中**顶层块里 33 个选择器出现 ≥2 次**。前 12 个：

| 选择器 | 行号 | 性质 |
|---|---|---|
| `html[data-theme="dark"]` | 54, 728 | 两套暗色令牌 |
| `body` | 87, 733 | **字号被改** |
| `.btn` | 116, 738 | 圆角/字重被改 |
| `.btn-small` | 135, 682 | 内边距被改 |
| `.page-header h1` | 248, 736 | **字号被 clamp 覆盖** |
| `.page-description` | 249, 737 | 字号被改 |
| `.panel` | 254, 735 | **圆角/阴影被改** |
| `.table-panel` | 258, 298, 773 | 定义 3 次 |
| `.data-table` | 299, 774 | 定义 2 次 |
| `.revision-list li` | 638, 657, 778 | 定义 3 次 |
| `.studio-shell` | 640, 792 | 定义 2 次 |
| `.studio-rf-node` | 659, 815 | 定义 2 次 |

其余 21 个集中在 Studio 区块（`.palette-item`/`.studio-canvas`/`.studio-note`/`.studio-rf-*`/`.preview-*`）。

#### 2.1.3 41 处"同一属性被写下第二个值"（append-then-patch）

完整清单可由 `/tmp/css5.mjs` 复算，这里给**最能说明问题的 15 条**：

| # | 选择器 · 属性 | 旧值@行 → 新值@行 | 后果 |
|---|---|---|---|
| 1 | `body {font-size}` | `var(--ow-type-base)`@87 → `13.5px`@733 | 令牌 13px 失效；"13px 正文"是假象 |
| 2 | `body {font-family}` | 内联字体栈@87 → `var(--ow-font-sans)`@733 | `--ow-font-sans` 声称 Inter 但 Inter 未加载 → 回落系统字体 |
| 3 | `.panel {border-radius}` | `--ow-radius-md`(8px)@254 → `--ow-radius-card`(10px)@735 | 圆角有两档，看哪个选择器先命中 |
| 4 | `.panel {box-shadow}` | `var(--ow-shadow)`@254 → 硬编码 `0 1px 1px rgba(18,26,40,.035)`@735 | 暗色主题下硬编码阴影不跟随 `--ow-shadow` |
| 5 | `.page-header h1 {font-size}` | `var(--ow-type-xl)`(24px)@248 → `clamp(22px,2.1vw,26px)`@736 | `--ow-type-xl` 全站仅 1 处引用且被覆盖 = 死令牌 |
| 6 | `.page-header h1 {letter-spacing}` | `-.015em`@248 → `-.03em`@736 | 26px×-0.03em = **-0.78px**，中文标题字挤字 |
| 7 | `.btn {font-weight}` | `520`@116 → `560`@738 | 变量字重（非标准档），回退时行为不可预期 |
| 8 | `.btn {border-radius}` | `6px`@116 → `var(--ow-radius-control)`(6px)@738 | 同值两写法，纯噪音 |
| 9 | `.btn-small {padding}` | `3px 9px`@135 → `4px 8px`@682 | 同一类两个密度 |
| 10 | `.table-panel {overflow}` | `hidden`@258 → `overflow-x:auto`@298 | 表格容器语义反转 |
| 11 | `.data-table {font-size}` | `var(--ow-type-base)`@299；`min-width:860px`@774 | 13px 表格 + 强制 860px 宽 |
| 12 | `.studio-rf-node {border}` | `1px solid var(--ow-accent)`@659 → `1px solid var(--ow-border-strong)`@815 | 画布节点默认描边从"强调"变"中性"，选中态靠 `.selected` 再补 |
| 13 | `.studio-rf-port {display}` | `block`@665 → `flex`@834 | 端口行布局反转 |
| 14 | `.studio-note {right}` | `14px`@652 → `190px`@811 | 底部提示被推离画布右下角 |
| 15 | `.studio-canvas {height}` | `520px`@647 → `100%`@809 | 需要父级有确定高度，否则塌陷 |

#### 2.1.4 两条真正"抢属性"的规则（与 Tailwind 工具类同名）

| 行 | 规则 | 冲突对象 | 说明 |
|---|---|---|---|
| **740** | `.truncate { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }` | Tailwind `.truncate` | Tailwind 版只有后 3 条。手写版**多出 `display:block`**，且因 import 顺序必胜。任何 `<span class="truncate">` 被强制块级化（`Jobs.tsx:114` 的 job id 链接即受此影响）。1440 下未观察到裁切（clip=0），说明目前靠 `min-width:0` 侥幸撑住，**一旦放进 flex 行就会换行错位** |
| **631** | `.block { display: block; }` | Tailwind `.block` | 完全是重复实现自己的工具类 |

其余"疑似同名"经核对**不成立**：`.muted`/`.small`/`.icon`/`.mono`/`.pad`/`.nav`/`.tabs`/`.status` 都不是 Tailwind 生成的类名。

#### 2.1.5 死规则（选择器在 `src/` 里已无匹配）

静态扫描（含模板字符串动态拼接的前缀白名单校正）得到 **84 个**类名在 `.tsx/.ts` 中无任何引用。按"整块死掉"归并，最该删的 8 组：

| 死规则 | 行 | 体量 | 说明 |
|---|---|---|---|
| `.status` + `.status-ok/warn/danger/info/neutral/unknown` + `.tag-ok` | 160–169 | 10 条 | 已被 `StatusPill/status-indicator` 取代，整套药丸词汇冗余 |
| `.kpi-grid` / `.kpi` / `.kpi-label` / `.kpi-value` / `.kpi-detail` / `.kpi-warn` | 335–340, 535, 566, 606, 1160 | 10 条 | Overview 改用 `.ow-metric` 后整块失效，**但仍活在 4 个媒体查询里** |
| `.jobs-table` (th/td ×8) | 965–972 | 8 条 | 已被 `table.tsx` 取代 |
| `.modal-small/medium/large` | 498–500 | 3 条 | Dialog 原语自带尺寸 |
| `.toast-ok`/`.toast-danger` | 511–514 | 4 条 | 无 toast 组件引用 |
| `.severity-dot`/`.severity-critical/warning/info` | 345–348 | 4 条 | 改用 `StatusIndicator` |
| `.btn-danger`/`.btn-warn`/`.btn-active`/`.btn-wide`/`.secret-row` | 131–136, 156 | 5 条 | Studio 只用 `btn-primary/secondary/small` |
| `.diff-added/removed/changed`、`.segmented`、`.clickable`、`.tab-count`、`.actions-cell`、`.pipeline-node-*`、`.port-row`、`.studio-canvas-grid` | 945–947, 317–320, 304, 377, 582, 632–636, 648 | 14 条 | 迁移残留 |

**注意**：`.status-indicator--{ready,degraded,…}`（14 条）与 `.value-token--unknown` 被扫描器判为"死"，实际是 `status-indicator.tsx:147` 的 `\`status-indicator--${state}\`` 动态拼接在用——这是**假阳性**，报告不计入死规则。
但同处有一个**真缺陷**：`status-indicator.tsx:167` 拼接的是 `value-token--${token === 'NO_DATA' ? 'no-data' : 'unknown'}`，而 CSS 只定义了 `.value-token--unknown`（L1095），**`.value-token--no-data` 根本不存在** → NO_DATA 与 UNKNOWN 只差一个 `dotted` vs `dashed` 边框。

#### 2.1.6 令牌层的自我否定

`:root` 定义了 **两个圆角尺度**：

| 语义 | 令牌 | 值 | 用在哪 |
|---|---|---|---|
| 小 | `--ow-radius-sm` | 4px | `.value-token`、code |
| 中 | `--ow-radius-md` | 8px | `.panel`(旧)、`.ow-metric`、`.module-card` |
| 控件 | `--ow-radius-control` | 6px | `.btn`@738 |
| 卡片 | `--ow-radius-card` | 10px | `.panel`@735 |
| 大 | `--ow-radius-lg` | 12px | — |
| 对话框 | `--ow-radius-dialog` | 12px | modal |

同一个"卡片"概念有 8px 与 10px 两个值、两种来源。而 `tailwind.config.cjs` 把 `rounded-md` 映射到 `--ow-radius-md`(8px)、`rounded-lg` 到 12px——**shadcn `Card` 原语用 `rounded-md`(8px)，`.panel` 实际渲染 10px**，同屏两种卡片圆角（`card.tsx:8` 实测，`r1440-light-en__admin_overview.png` 中"Availability"面板 10px vs 内部 `.module-card` 8px）。
ADR-UI-002 写着"所有令牌必须属于 OpsWeave（禁止并行第二套）"——现在是**同一个文件里并行了两套**。

### 2.2 Q2 · 字号真实分布

#### 2.2.1 声明的真实计数（`styles.css` 全量）

令牌型（可追踪）：

| 令牌 | 值 | 声明次数 |
|---|---|---|
| `--ow-type-sm` | **12px** | **107** |
| `--ow-type-base` | 13px | 18 |
| `--ow-type-lg` | 16px | 9 |
| `--ow-type-xs` | 11px | 5 |
| `--ow-type-xl` | 24px | 1（且被 clamp 覆盖） |
| `inherit`/`.94em` | — | 2 |

字面量型（绕过令牌）：**共 62 条**

| 值 | 次数 | 代表位置 |
|---|---|---|
| 10px | **22** | `.tag`168、`.nav-section-label`199、`.eyebrow`247、`.log-level`436、`.studio-rf-node>small`663、`.kbd`1022、`.capability-status-code`1225 |
| 11px | **18** | `.metric-label`754、`.value-token`1093、`.studio-inspector`区域 |
| 12px | 10 | `.studio-palette h2`804、`.studio-rf-node-head` |
| 21px | 4 | `.brand-large`、`.studio-page .page-header h1`789、`.studio-rf-node` |
| 9px / 9.5px / 8.5px / 10.5px | 3 / 2 / 1 / 1 | **全部在 Studio 画布**：`.node-category`831=9px、`.port-type`837=**8.5px**、`.node-title small`830=9.5px、`.node-summary`832=10.5px |
| 13px / 13.5px / 14px | 3 / 1 / 3 | `.page-description`737=13px、`body`733=13.5px |
| 15/22/24/26/34/36/44px | 2/2/1/2/1/1/1 | 标题与展示数字（`clamp()` 系列） |

#### 2.2.2 渲染后真实分布（DOM 实测，1440 Light/en）

对**每一个持有可见文本的元素**取 `getComputedStyle().fontSize`：

| 页面 | 文本节点 | 12px | 13px | 13.5px | 11px | 10px | 其他 | 12px 占比 |
|---|---|---|---|---|---|---|---|---|
| Overview | 128 | 69 | 10 | 20 | 12 | 6 | 16×5, 26×5, 15×1 | **54%** |
| Plugins | 106 | 37 | 33 | 11 | 13 | 7 | 24×3, 15, 26 | 35% |
| **Jobs** | 141 | 32 | **86** | 11 | 4 | 6 | 15, 26 | 23%（**唯一 13px 占优**） |
| Nodes | 84 | 38 | 17 | 11 | 5 | 6 | 24×5, 15, 26 | 45% |
| Governance | 101 | 39 | 15 | 15 | 20 | 6 | 16×4, 15, 26 | 39% |
| **Activity** | 1263 | **964** | 276 | 11 | 4 | 6 | 15, 26 | **76%** |
| Access | 92 | 49 | 12 | 15 | 4 | 6 | 16×4, 15, 26 | **53%** |
| **Diagnostics** | 198 | **122** | 16 | 31 | 4 | 13 | 16×10, 15, 26 | **62%** |
| Operators Center | 77 | 35 | 9 | 15 | 4 | 7 | 16×4, 15, 26 | 45% |
| **Pipeline Studio** | 119 | 51 | 10 | 3 | 7 | 10 | **9.5×16, 8.5×10, 10.5×6, 9×5**, 21 | 43% |

#### 2.2.3 结论

1. **"13px 支配正文"不成立。** 8 个采样页中 7 个由 **12px** 支配（54%–76%），只有 Jobs 由 13px 支配（61%）。全站正文的真实主尺寸是 `--ow-type-sm = 12px`。
2. **13.5px 是"孤儿尺寸"**：`body` 声明 13.5px（L733），但页面里 13.5px 的文本节点只有 7–31 个，集中在顶栏/侧栏等 shell 元素；正文元素多数被更小的类覆盖。也就是说 `body` 的 13.5px **几乎不影响任何正文**，它只是理论值。
3. **存在 3 个"低到不该出现在产品里"的尺寸**：8.5px（`.port-type`）、9px（`.node-category`、`.react-flow__edge-text`、`.diff-field em`）、9.5px（`.node-title small`）。Studio 一页就有 **37 个 <11px 的文本节点**（10+5+16+6）。
4. **字号档位共 19 个不同值**（8.5/9/9.5/10/10.5/11/12/13/13.5/14/15/16/21/22/24/26/34/36/44）。任何"调整全局字号"的尝试都会在这堆魔法数里失效。

### 2.3 Q3 · Card 密度

#### 2.3.1 什么算一张卡

统计选择器（DOM 实测）：`.panel, .ow-metric, .metric-card, .business-card, .task-panel, .module-card, .ow-summary-card, .investigation-region, .kpi, .async-panel, .health-strip-item, .deployment-card, .callout, .studio-banner`，并按父链计算**嵌套层数**。

#### 2.3.2 实测

| 页面 | 卡片总数 | 最大嵌套 | 层数分布 | 备注 |
|---|---|---|---|---|
| **Diagnostics** | **12** | 1 | 1层×11 + 2层×1 | 卡片最多的页 |
| **Overview** | **11** | **2** | 1层×7 + 2层×4 | 4 张 `.module-card` 嵌在 `.panel` 里 |
| **Job Detail** | **10** | 1 | 1层×10 | 9 张指标卡 + 结果面板 |
| **/app/home** | **9** | **2** | 1层×7 + 2层×2 | 3 张 task 卡 + "Available now" 里嵌 `.business-card` |
| Nodes | 8 | 1 | 1层×8 | 5 指标卡 + 表 + 2 callout |
| Governance | 8 | 1 | 1层×8 | 4 指标 + 3 面板 + 1 callout |
| **/app/incidents** | 6 | **2** | 1层×2 + **2层×4** | 3 个 region 卡各含 1 张内嵌槽卡 |
| Access | 5 | 2 | 1层×4 + 2层×1 | |
| Node Detail | 5 | 1 | 1层×5 | |
| Plugins / Settings / OpsCenter | 4 | 1 | 1层×4 | |
| Plugin Detail | 3 | 1 | 1层×3 | |
| Pipelines / Jobs / Activity | 1 | 1 | 1层×1 | 单面板 + 表格，密度最克制 |

#### 2.3.3 最严重的三个页面

1. **Diagnostics（12 张 / 2542px 高）**：一屏内 6 个"指标块" + 3 个 `.panel` + 2 个 code 块 + 1 个 20 行审计列表。而且 6 个指标块被切成**两种形态**：左侧 2 张带圆角边框的卡片 + 右侧 1 条被竖线分隔的 4 列条带（`r1440-light-en__admin_settings_diagnostics.png` y≈150–230）。同一行里的 6 个同级信息，用两套容器装。
2. **Overview（11 张 / 最大 2 层）**："Availability" 面板内嵌 4 张 `.module-card`；下层 4 张 `.ow-metric`；再下层 2 个 `.panel`。三级容器层层包裹，导致同一屏出现 3 种卡片外观（0 阴影面板 / 带阴影指标卡 / 灰底内嵌卡）。
3. **/app/incidents（6 张 / 2 层 / 视觉 3 层）**：`.panel` → `.investigation-region`（有头有体）→ 虚线 `.investigation-slot`。DOM 只数到 2 层，视觉上是**三层边界**（实线 + 实线 + 虚线）围住一句"Empty slot – no data source"。

**反例（做得好）**：`/admin/jobs` 与 `/admin/pipelines` 只有 1 张卡（表格面板），信息靠表格本身承载，符合 rules/06 "SHOULD：表格、日志、画布使用专属高密度组件而非 Card 堆砌"。

### 2.4 Q4 · 状态语义

#### 2.4.1 三套并行的状态词汇

| 位置 | 覆盖码数 | 缺什么 |
|---|---|---|
| `components/status-tone.ts:20-47` `STATUS_MAP` | 23 | **SUCCEEDED / CANCELLED / QUEUED / RUNNING / CLAIMED / ACCEPTED / COMPLETED** |
| `components/app/status-indicator.tsx:88-114` `CODE_STATES` | 23 | 同上，且多了 `STOPPED` 语义 |
| `status-indicator.tsx:15-30` `IndicatorState` | 16 个状态枚举 | 与上面两张表不是同一维度 |

#### 2.4.2 直接后果：成功被画成"未知"

`table-kit.tsx:16-25` 的逻辑是 `const known = STATUS_MAP[code]; tone = known?.tone ?? 'unknown'; className={!known && 'border-dashed'}`。
`Jobs` 的筛选器自己列出了 `QUEUED/RUNNING/SUCCEEDED/FAILED/CANCELLED`（`Jobs.tsx:22`），但这些码**一个都不在 `STATUS_MAP` 里**（`FAILED` 除外）。

于是：

| 真实状态 | 渲染 | 用户读到的含义 |
|---|---|---|
| `SUCCEEDED` | 灰底虚线药丸 + 时钟图标 + 原文 "SUCCEEDED" | "这个状态我们不确定" |
| `RUNNING` | 同上，与 SUCCEEDED **完全无法区分** | "不确定" |
| `CANCELLED` | 同上 | "不确定" |
| `FAILED` | 红色实线药丸 + 警告三角 | **唯一清晰的状态** |
| `ACCEPTED`（审计事件） | 灰底虚线药丸，Overview/Diagnostics 里 9–20 个连续出现 | "一整屏都不确定" |

这条直接违反 rules/06 "MUST：主要状态不只靠颜色"的**反面更严重版本**：这里连颜色都没给，因为归到了 unknown 的视觉语言。而且它把"成功"和"未知"合并——**正是 AGENTS.md 明令禁止的"把 UNKNOWN 伪装成健康状态"的镜像错误：把健康伪装成 UNKNOWN**。

#### 2.4.3 状态之间的视觉可分性（`.status-indicator--*`，L1071–1084）

| 状态对 | 视觉是否可分 | 依据 |
|---|---|---|
| `degraded` ≡ `attention` | **完全不可分** | 两者都是 `color:warn; background:warn-soft; border:transparent` |
| `noData` ≡ `notConfigured` ≡ `loading` | **完全不可分** | 三者都是 `color:muted; background:surface-2; border:transparent` |
| `unknown` vs `stale` | 可分（都是虚线，但 stale 用 warn 色） | L1074 / L1077 |
| `forbidden` | 可分（透明底 + currentColor 边框） | L1082 |
| `NO_DATA` vs `UNKNOWN` 值令牌 | **几乎不可分**：只在边框 `dashed` vs `dotted` 上有差别，而 `.value-token--no-data` 不存在 | `status-indicator.tsx:167` vs `styles.css:1095` |

**结论**：16 个状态枚举里有 **5 个坍缩成 2 种外观**。"未观测"确实没有被画成绿色（这点做对了），但也**没有和"未配置""加载中"区分开**——用户无法回答"这是还没加载完，还是永远不会有数据？"

#### 2.4.4 反向证据（确实做对的地方，必须记下来）

1. `Overview` 的 Catalog 模块：无数据源时状态是 `unknown` 且底部写 "Never observed"，而不是 0（`r1440-light-en__admin_overview.png` 右上模块卡）。
2. `Plugins` 的 Ops Center 行：Digest、READY replicas、Recent health 三格全是 `NO_DATA` 令牌框，没有一格显示 0 或绿色（`r1440-light-en__admin_plugins.png` 第 4 行）。
3. `Governance`：所有数据集 `Quality=Unknown` + `Examined=NO_DATA` + `Failed=NO_DATA` + `Latest run=No runs`，并且页脚明写 "Empty datasets are UNKNOWN, not 100% healthy."（`r1440-light-en__admin_governance.png`）。
4. `AsyncBoundary` 对 403/409/error 三种错误给出**三套不同面板**（`async-boundary.tsx:95-136`），403 面板不打印任何资源细节。

这一层是这套 UI 最有价值的部分，也是为什么"补状态映射"排在第 1 位——它不该被一个缺码的表拖累。

### 2.5 Q5 · 中英文差异

#### 2.5.1 页面高度差（1440×900，同内容同视口）

| 页面 | en 高度 | zh 高度 | Δ | Δ% |
|---|---|---|---|---|
| **/app/home** | 1731 | 1567 | **-164** | **-9.5%** |
| /admin/ops-center | 965 | 900 | -65 | -6.7% |
| **/admin/access** | 1145 | 1073 | -72 | **-6.3%** |
| /admin/…/editor | 1094 | 1034 | -60 | -5.5% |
| /admin/settings | 1114 | 1078 | -36 | -3.2% |
| /admin/overview | 1315 | 1280 | -35 | -2.7% |
| /admin/settings/diagnostics | 2542 | 2496 | -46 | -1.8% |
| /admin/plugins/:id | 1077 | 1059 | -18 | -1.7% |
| 其余 14 页 | — | — | 0 | 0% |

**事实**：中文普遍更矮（少换行），但差异不是均匀的——从 0% 到 9.5%。**同一个卡片网格，中英文下高度不同**，导致视觉节奏只在英文下成立：/app/home 的"Your task space" 三张卡在 en 下需要更多行，zh 下留白变大，同一行内三张卡的行动链接（Open Incidents / Open Investigations / Open Resources）垂直位置相差 48px（`r1440-light-en__app_home.png` y≈497 / 497 / 545）。

#### 2.5.2 裁切：1440 下无差异，390 下差异明显

- 1440 下 en/zh 的 `clippedCount` **全部为 0** → 桌面端没有截断不一致问题。
- **390 下 zh 有 28 个被裁节点**，集中在面包屑：`引导诊断` scrollWidth 44px 被压到 25px、`流水线详情` 55px→23px、`任务详情` 44px→25px、分隔符 `/` 12px→0–2px。
- 英文同样被裁，但被裁的是 `dev.opsweave.hello`（106px→32px）、`install`（33px→22px）。

也就是说：**中英文在 390 下都坏，但坏的方式不同**——英文按词边界被砍，中文按字被砍（4 字标签剩 2 字），比英文更不可读。

#### 2.5.3 至少 3 处中文下的排版问题（实测）

**问题 1 · 标题负字距套在汉字上。**
`.page-header h1 { letter-spacing: -.03em }`（`styles.css:736`），26px 时 = **-0.78px**（DOM 实测 `ls:"-0.78px"`，20 个页面全部命中）。拉丁字母靠负字距收紧是常规手法，但汉字是满宽方块，负字距会让相邻笔画贴合。影响：全站 20 个 h1。

**问题 2 · 只有拉丁字母受益的 `text-transform: uppercase` + 宽字距，在中文里退化成"字被拉开"。**
`styles.css` 里 **14 条** `text-transform: uppercase` 与 **17 条** `letter-spacing: .04em–.09em`，命中 `.eyebrow`(10px/.09em)、`.nav-section-label`(10px/.09em)、`.tag`(10px/.04em)、`.metric-label`(11px/.055em)、`.capability-status-code`(10px/.04em)、`.user-copy small`(10px/.05em)。
中文没有 case，`uppercase` 完全失效，只剩字距：10px 的汉字被拉到 10.9px 间距。在 `/app/home` 的 `BUSINESS WORKSPACE`、`/app/incidents` 的 `INCIDENTS` 上可直视（`r1440-light-en__app_incidents.png` y≈88）——中文对应文案是"事件"两个字拉到 11px 间隔，视觉上"散"。

**问题 3 · 面包屑逐段 shrink，中文比英文更早碎掉。**
`.breadcrumbs { overflow:hidden; white-space:nowrap }`（L217）没有 `flex: none ` 保护，每段都可被压到 0。390 实测：zh `流水线详情` → 23px（3 字后被省略号吞掉 1 字），`/` 分隔符 → 0px（`.crumb-sep` scrollWidth 12 / clientWidth 0–2）。截图 `r390-light-zh__admin_jobs_1285fbe8-….png` 顶部显示 `任务` + 0px 分隔符。

**问题 4（附带）· 行高未按 CJK 调整。**
12px 正文的 `line-height` 比值实测 en 1.47–1.49、zh 1.47–1.49——**完全相同**。如果按拉丁字形设计（x-height 小、上下有留白），这套行高对满高方块汉字偏紧；页面高度差（-9.5%）证明换行数变了，但行高没有随之补偿。

### 2.6 Q6 · 390 宽横向溢出（真实 scrollWidth − clientWidth）

#### 2.6.1 基线说明

`html { scrollbar-gutter: stable }`（L86）让内容盒固定为 375px。因此**无溢出的页面 `documentElement.scrollWidth = 375` 而 `clientWidth = 390`，差值 −15 代表"没有溢出"**。判定溢出的正确口径是 `scrollWidth > 375`。

#### 2.6.2 实测（390×844，Light/en 与 Light/zh 双采）

| 页面 | scrollWidth (en / zh) | 内容盒 | 超出内容盒 | 结论 |
|---|---|---|---|---|
| **/admin/jobs/:id** | **613 / 565** | 375 | **+238 / +190** | ❌ **唯一真正撑破整页的页面** |
| /admin/settings | 383 / 376 | 375 | +8 / +1 | ⚠️ 轻微，比其他页宽 1–8px |
| /admin/plugins/:id | 375 / 375 | 375 | 0 | ✅ 页面不溢出，但**内部**有 3 个按钮跑到 right=472（超出 97px），被 `overflow-x:auto` 容器吃掉 → 出现二级横向滚动 |
| /admin/activity | 375 / 375 | 375 | 0 | ✅ 但 `.text-muted-foreground` 有 5 个节点 right=414（+39px），同一模式 |
| /admin/pipelines/:id | 375 / 375 | 375 | 0 | ✅ 但执行路径条 `.flow-index` right=466、`.flow-arrow` right=429（+91px），内部滚动 |
| 其余 19 个路由 | 375 / 375 | 375 | 0 | ✅ |
| /403 | 375 / 375 | 375 | 0 | ✅ 该页无 shell，天然安全 |

#### 2.6.3 溢出的元凶（定位到元素）

```
/admin/jobs/:id  en: {"tag":"code","cls":"mono small","left":88,"right":613,"n":1}   ← 525px 宽的 <code>
                      {"tag":"table","cls":"w-full border-collapse caption-bottom text-base","left":15,"right":490}
```

对应源码 `Jobs.tsx:207`：
```tsx
<code className="mono small">{checkpoint.stateDigest}</code>
```
`stateDigest` 是 `sha256:64043eff…` 64 位十六进制串，`<code>` 默认 `white-space: normal` 但 `code` 全局规则（`styles.css:102`）没有 `overflow-wrap`，而父级 `li` 是 `.detail-list` 的 `display:flex`，导致 `code` 撑开整行。
实测截图 **`r390-light-en__admin_jobs_1285fbe8-9bb8-459f-b073-af245d32b3ae.png` 的 PNG 尺寸就是 613×1755**——截图本身被撑宽，右侧 223px 是空白。

#### 2.6.4 390 的其他硬伤（不是溢出，但同样是移动端问题）

1. **面包屑被压成残句**：`Jo.` / `Jo..`（`r390-light-en__admin_jobs_1285fbe8….png` 顶部）。
2. **密度崩塌**：Job Detail 的 4 张指标卡（STATUS / EXECUTION / PIPELINE / REVISION）各占 ~90px，全屏堆成 400px 只承载 4 个单词。
3. **Attempts 表格**：390 下把 UUID 折成 4 行（`9b426d…/27c4-45…/9773-…/b51a3d`），没有省略号也没有 tooltip。
4. **Activity 页 25,158px 高**（1440 下是 8,507px）——无分页/无虚拟化。
5. **Recent events 的时间戳漂移**：1440 下 `3h ago` 在最右；390 下插在标题行中间（`r390-light-en__admin_overview.png` y≈1524 "capability.service_invoke  3h ago" 后接换行）。

---

## 3. 逐页审计（20 页 × 10 维 + 8 维评分）

每页格式：**证据**（截图路径 / 度量文件）→ **10 个必答维度** → **8 维评分表**。
证据标 `[像素]` = 人工判读截图；`[度量+源码]` = DOM 实测 + 源码结构，未逐像素审阅（§0.5 已披露）。

---

### 01 · /admin/overview — Overview

**证据**：[像素] `r1440-light-en__admin_overview.png`、`r1440-dark-en__admin_overview.png`、`r1440-light-zh__admin_overview.png`、`r390-light-en__admin_overview.png`；[度量] `_metrics_r1440-light-en.json`

- **信息架构**：三层顺序清晰且与设计文档一致——①平台健康横幅 ②四模块（Kernel/Nodes/Plugin runtime/Catalog，各带 observedAt）③KPI 条 + Attention/Recent events。这是全站唯一"越往下越具体"的页面。
- **视觉层级**：h1 26px/700 → 面板 h2 16px/650 → 正文 12px。问题是 **h1 与 page-description(13px) 只差半档**，标题下那句 "What needs attention now — not a wall of metrics." 读起来像正文首句而不是副标题。KPI 数字 26px 是页面上最强的视觉锚点，权重甚至高于 h1，合理（它才是用户要看的东西）。
- **排版问题**：全页 128 个文本节点里 12px 占 69（54%）、10px 占 6。**10px 出现在 `.eyebrow`** —— 11px 的 uppercase 标签在 1440 下已经偏小，10px 的 eyebrow 更像免责声明。h1 的 -0.78px 负字距在中文下压汉字。
- **卡片与边框**：同屏 3 种卡片：`.panel`(10px 圆角, 1px 边框, 0 阴影) / `.ow-metric`(8px, 有阴影) / `.module-card`(8px, 灰底, 在 panel 内部)。**"Availability" 面板内的 4 张卡圆角 8px 而外层面板 10px**，同屏两种卡片圆角（§2.1.6 根因）。11 张卡、最大嵌套 2 层。
- **栅格与对齐**：`.metric-grid` 4 列 + `.overview-grid` 2 列（1.25fr/1fr）。**左右两列底边严重不齐**：Attention 面板结束于 y≈890，Recent events 结束于 y≈1245（截图），右上角 "0 open" 与 "View all →" 同高但右侧内容长 60% 导致整行失衡。4 张模块卡内部 footer（Observed… / Open →）能对齐，这点做对了（`margin-top:auto`）。
- **空间密度**：过低。Attention 空态独占 250px 竖直空间去说 "Nothing needs action"，而右侧要塞 9 条事件。信息密度相差 5 倍的两个区域被赋予相同宽度的列。
- **交互细节**：Refresh（次要）+ Install plugin（主，蓝）符合"每页一个主 CTA"。4 张 KPI 卡右上有箭头且整卡是 `<Link>`（`metric-card.tsx:63`），hover 时边框变强调色 + 箭头变蓝（L1106/L1113）——这是全站最好的一个交互细节。模块卡里 "Open →" 是独立链接，与整卡可点击的 KPI 卡形成两套点击语义。
- **深浅色一致性**：暗色下布局零变化（实测 en dark/light 高度完全相同），令牌替换干净。但**暗色下卡片边界几乎消失**：`--ow-bg` #0d1015 vs `--ow-surface` #151a21 仅靠 1px #29323e 边框分隔，11 张卡在暗色下融成一整块（`r1440-dark-en__admin_overview.png`）。
- **中英文排版**：zh 高度 1280 vs en 1315（-2.7%）；模块卡 detail 在 zh 下少一行，"Observed at…" 随之上移 → 同行 4 卡 footer 仍对齐（`margin-top:auto` 生效），但卡片整体内高变化。
- **移动端**：390 下无溢出（scrollWidth 375），卡片正确堆叠为单列；**Recent events 的时间戳从最右漂到标题行中间**（`r390-light-en__admin_overview.png` y≈1524），三行块布局里 TimeAgo 与 event-title 同排而 event-copy 换行，导致 "3h ago" 夹在事件名和 subject id 之间。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 4 | 三层 IA 清晰、与设计文档一致；唯一问题是 h1 与描述几乎同档 |
| 排版 | 3 | 12px 占 54%、10px 标签、h1 负字距伤中文 |
| 对齐与间距 | 3 | 双列底边不齐；Attention 空态吃掉 250px |
| 组件一致性 | 3 | 同屏 3 种卡片、2 种圆角、2 套点击语义 |
| 色彩与对比 | 3 | 明色良好；暗色卡片边界消失 |
| 数据可读性 | 3 | 数字与 observedAt 齐全；但 9 条 ACCEPTED 全是虚线"未知"药丸 |
| 交互反馈 | 4 | KPI 整卡可点 + hover 变色 + 焦点可见，是全站范本 |
| 响应式 | 4 | 390 无溢出、单列堆叠正确；仅时间戳位置漂移 |

---

### 02 · /admin/plugins — Plugins

**证据**：[像素] `r1440-light-en__admin_plugins.png`、`r1440-light-zh__admin_plugins.png`、`r390-light-en__admin_plugins.png`；[度量] `_metrics_r1440-light-en.json`

- **信息架构**：3 张概览卡（Installed/Upgrade available/Needs attention）→ 搜索 + 5 段筛选（All/Installed/Staged/Disabled/Available）+ "4 of 4" → 表格（Plugin/Publisher/Version/Digest-trust/Activation/READY replicas/Recent health）→ 页脚说明 callout。结构合理，筛选维度与列头语义对应。
- **视觉层级**：3 张卡的 "4 / 0 / 1" 是页面上最强的数字，但**第 3 张卡的 1 用普通字色而非警告色**——"Needs attention = 1" 是本页最该被看见的数字，视觉上却和 "Installed = 4" 一样。而 Governance 同类卡在用 `.ow-summary-card.is-danger`。
- **排版问题**：106 节点中 12px 37 / 13px 33 / 11px 13 / 10px 7。表格用 13px（`.data-table`）、卡片说明用 12px、tag 用 10px——**同一行里三种字号**（Plugin 名 13px、publisher id 12px mono、版本 13px、SYSTEM tag 10px）。
- **卡片与边框**：4 张卡、深度 1。表格用 `.data-table` + `table.tsx` 混合：表头来自 TableHead（border-solid 补丁）、单元格来自 TableCell（px-3.5 py-2.5）+ 页面自定义 digest 单元格。边框来源不统一，但视觉上还成立。
- **栅格与对齐**：**本页最严重的问题**。Plugin/Digest/Recent health 三列是两行内容，Publisher/Version/Activation/READY replicas 是单行——单行内容垂直居中、多行内容顶对齐，导致同一行内 8 个单元格的基线分裂（截图 y=385 vs 402）。行高 80px，其中约 40% 是错位造成的空白。
- **空间密度**：4 行数据占 320px 表格高度，页面总高 660px 内容留 240px 空白——密度不差，但每一行的两行单元格把行高撑到 80px，本可 48px。
- **交互细节**：行整行可点（`Plugins.tsx:154`，tabIndex=0 + Enter 打开，焦点环 outline-offset -2px）+ 每行一个"更多"下拉（aria-label 带插件名，`Plugins.tsx:198`）。行内嵌套可点击元素用了 stopPropagation，正确。cursor-pointer 与 focus-visible 都在。
- **深浅色一致性**：`r1440-dark-zh__admin_plugins.png` 已采；令牌层与 Overview 同源，风险一致（卡片边界弱）。
- **中英文排版**：高度 900 = 900（0%），因为内容未超出视口；搜索占位符与筛选标签长度变化未导致换行。
- **移动端**：390 下表格转卡片（max-[760px] 变体），页面不溢出；但**首个控件 right=392（超出 17px）**，属于顶栏拥挤而非表格问题。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 概览卡→筛选→表格顺序对，但 "Needs attention=1" 没有任何视觉强调 |
| 排版 | 3 | 同一行三种字号（13/12/10px）；10px SYSTEM tag |
| 对齐与间距 | 2 | 多行单元格顶对齐、单行居中 → 同一行 8 个单元格基线分裂 |
| 组件一致性 | 3 | Badge 与 .tag 两种 chip；表头/单元格来自两套表格样式 |
| 色彩与对比 | 3 | Verified 绿、Ready 绿、NO_DATA 灰，可用；Needs attention 缺色彩承载 |
| 数据可读性 | 3 | 列齐全、digest 有截断但无 tooltip；NO_DATA 三连放对了位置 |
| 交互反馈 | 4 | 整行可点 + Enter + 焦点环 + 行内按钮 stopPropagation，规范 |
| 响应式 | 3 | 表格转卡片可用；顶栏控件在 390 超出 17px |

---

### 03 · /admin/plugins/:id — Plugin Detail

**证据**：[度量+源码] `r1440-light-en__admin_plugins_dev.opsweave.hello.png`、`r1440-light-zh__admin_plugins_dev.opsweave.hello.png`、`r390-light-en__admin_plugins_dev.opsweave.hello.png`；`PluginDetail.tsx`(469 行)

- **信息架构**：6 个 tab（Radix Tabs 原语）+ 部署/能力/权限/贡献四类信息。页面 h1 是插件显示名（"Hello Ops"），副标是 dev.opsweave.hello。
- **视觉层级**：h1 26px 与其他页一致；6 tab 的选中态依赖 tabs.tsx 的下划线+色差，本页 tab 数量最多，横向压力最大。
- **排版问题**：109 个文本节点，12px 37 + 13px 33 + 10px 8。deployment 卡里 kv 标签 12px / 值 13px，差值 1px 不足以形成层级，靠颜色（muted vs text）承担。
- **卡片与边框**：3 张卡、深度 1；deployment-card + kv-grid + capability-list 三套内部排版，每种都有自己的 padding。
- **栅格与对齐**：kv-grid 用 auto-fit minmax(190px,1fr)，1440 下排成 5–6 列；在 1024 下会掉到 4 列，键值对与列宽无关地重排。
- **空间密度**：1077px 高；每张 deployment 卡内 6–8 行 kv，行高受 kv 的 padding 控制，整体偏松。
- **交互细节**：5 个确认弹窗（安装/卸载/激活/回滚/删除）走同一 ConfirmAction 组件；危险操作是 destructive variant。Tab 用 Radix Tabs，键盘方向键可用。
- **深浅色一致性**：[度量+源码]，令牌同源，未见独立暗色规则。
- **中英文排版**：zh 1059 vs en 1077（-1.7%）。
- **移动端**：390 页高 1760；**3 个 tab 按钮 right=472（超出内容盒 97px）** → 出现二级横向滚动条（overflow-x:auto 兜住，页面本身不溢出）。tab 条在 390 下必须横滑，且无渐隐提示，用户不知道右边还有内容。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 6 tab 承载得当，但 tab 内二级分区没有子标题 |
| 排版 | 3 | kv 标签/值只差 1px，靠颜色分层 |
| 对齐与间距 | 3 | kv-grid auto-fit 在不同宽度重排，键值对会被拆到不同行 |
| 组件一致性 | 3 | 三套内部排版（kv-grid / deployment-title / capability-list） |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | 3 | 长 digest 与 id 有截断 |
| 交互反馈 | 3 | 5 个确认弹窗共用组件；tab 键盘可用 |
| 响应式 | 3 | 390 页面不溢出，但 tab 条溢出 97px 且无滚动提示 |

---

### 04 · /admin/plugins/install — Install Wizard

**证据**：[度量+源码] `r1440-light-en__admin_plugins_install.png`、`r390-light-en__admin_plugins_install.png`；`InstallWizard.tsx`(255 行)；stepper/dropzone/readiness 规则在 `styles.css:394-419`

- **信息架构**：4 步 stepper（上传 → 校验 → 复核 → 完成）+ 拖放区 + readiness 数字。单一路径，没有分叉，是本项目 IA 最直白的页面。
- **视觉层级**：stepper 用带序号的圆点 + 连线的经典形态；readiness-number 36px 是页面最强锚点。
- **排版问题**：55 个文本节点，12px 25 / 10px 6。step 标签 12px，在 4 步横向排列时每步可用宽度约 200px。
- **卡片与边框**：仅 1 张卡（wizard-panel），**是全站卡片密度最低的表单页**，符合"表单不要套卡"的取向。
- **栅格与对齐**：单列居中，无栅格风险。
- **空间密度**：900px 高（= 视口），说明内容一屏放下；dropzone 有 32px padding + 大图标，占用可观但合理（拖放目标需要大）。
- **交互细节**：has-file 状态切换边框样式；dialog-a11y.spec.ts 覆盖 Esc/焦点还原。
- **深浅色一致性**：令牌驱动，无独立暗色规则。
- **中英文排版**：900 = 900，无差异。
- **移动端**：390 页高 844（一屏），stepper 在 ≤760 转纵向、wizard-actions 改 column-reverse（L589–593）——**这是全站少数为 390 单独设计过的组件**。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 单路径清晰；step 内二级说明偏弱 |
| 排版 | 3 | 12px 为主，10px 用于 step 说明 |
| 对齐与间距 | 3 | 单列，风险低 |
| 组件一致性 | 3 | dropzone/stepper 是独有组件，无同类可对比 |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | 3 | readiness 数字有 36px 承载 |
| 交互反馈 | 3 | has-file / busy / error 三态齐 |
| 响应式 | 3 | stepper 专为 390 改造，但未采暗色 390 验证 |

---

### 05 · /admin/pipelines — Pipelines

**证据**：[度量+源码] `r1440-light-en__admin_pipelines.png`、`r1440-dark-en__admin_pipelines.png`；`Pipelines.tsx`(259 行)

- **信息架构**：概览卡（4 张 metric-card）+ 表格。与 Plugins 同构，但缺 Plugins 的搜索/筛选条——**同类的两个列表页 IA 不一致**（Plugins 有 5 段筛选，Pipelines 没有）。
- **视觉层级**：h1 26px → 4 张 26px 数字卡 → 表头 12px → 单元格 13px。数字卡与 h1 同尺寸，抢占标题权重。
- **排版问题**：53 个文本节点（全站最少之一），12px 17 / 13px 13 / 10px 6。信息量低，字号问题不明显。
- **卡片与边框**：仅 1 张卡（表格面板）；4 张 metric-card 在 pipeline-stats 里，属"指标条"而非卡片容器。
- **栅格与对齐**：summary-grid/pipeline-stats 4 列，`.data-table` min-width:860px（L774）——**在 768px 宽的平板竖屏下必然横向滚动**。
- **空间密度**：900px 高（一屏放完），说明当前只有 1 条流水线；空态/少量数据下的密度无从评价。
- **交互细节**：行可点进入详情；无搜索无筛选，超过 20 条后无法定位。
- **深浅色一致性**：r1440-dark-en 已采，布局零变化。
- **中英文排版**：900 = 900。
- **移动端**：390 高 844；min-width:860px 的表格被 .table-panel{overflow-x:auto} 兜住，页面不溢出但需要横滑。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 与 Plugins 结构类似但缺筛选，同类页不一致 |
| 排版 | 3 | 13px 表格 + 12px 表头，可读 |
| 对齐与间距 | 3 | 4 列指标条对齐正确（visual-layout.spec.ts 曾断言 label 在 value 之上） |
| 组件一致性 | 3 | 表格样式与 Plugins 不同源 |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | 2 | 无搜索/筛选/分页；min-width:860px 强迫小屏横滑 |
| 交互反馈 | 3 | 行可点，无批量操作 |
| 响应式 | 3 | 靠 overflow-x 兜底，未重排 |

---

### 06 · /admin/pipelines/:id — Pipeline Detail

**证据**：[度量+源码] `r1440-light-en__admin_pipelines_host-metrics-pipeline.png`、`r1440-light-zh__admin_pipelines_host-metrics-pipeline.png`；`Pipelines.tsx` 中 PipelineDetailPage

- **信息架构**：7 张卡——4 张指标卡（pipeline-stats 内的 metric-card）+ 执行路径条（pipeline-flow）+ 修订列表（revision-list）+ 运行入口。执行路径是全站唯一用"序号 + 箭头"表达顺序的地方。
- **视觉层级**：h1 26px → flow-step strong 13px → flow-step small **10px mono**。执行路径的核心信息（节点类型）落在 10px。
- **排版问题**：138 节点，12px 51 / 13px 22 / **10px 19**。10px 集中在 flow-step small 与 revision-list。
- **卡片与边框**：7 张卡、深度 1。指标卡用 `<div className="panel metric-card">`（与 Jobs 详情同构）→ **一个元素同时是 panel 和 metric-card**，两个类的 padding/圆角/阴影互相叠加，这是"卡片类可组合"的巧合而非设计。
- **栅格与对齐**：4 列指标 + 执行路径横排。**390 下执行路径溢出**：flow-index right=466、flow-arrow right=429（超出 375 内容盒 91px）。
- **空间密度**：1346px 高；revision-list li 在 ≤700px 变成 50px + 1fr 两行网格（L657），是少数为窄屏重排过的表格类组件。
- **交互细节**：修订列表每项可点；执行路径不可点（仅展示）。
- **深浅色一致性**：flow-index 用 --ow-accent-soft，暗色下会跟着变；metric-value 硬编码 clamp(20px,2vw,26px)。
- **中英文排版**：1346 = 1346（0%）。
- **移动端**：页面不溢出，但执行路径条内部溢出 91px，需要横滑才能看到整条链路——**读"执行顺序"却要横滑，等于失去了顺序表达**。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 指标→路径→修订的顺序合理；路径的类型标签只有 10px |
| 排版 | 3 | 10px 承担语义标签（节点类型） |
| 对齐与间距 | 3 | 4 列指标对齐正确 |
| 组件一致性 | 2 | panel + metric-card 双类叠加，padding/阴影来自两处 |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | 2 | 执行路径在 390 溢出 91px，顺序需横滑才能读完 |
| 交互反馈 | 3 | 修订项可点；路径不可点 |
| 响应式 | 2 | 路径条未做窄屏重排 |

---

### 07 · /admin/pipelines/:id/editor — Pipeline Studio ★最低分

**证据**：[像素] `r1440-light-en__admin_pipelines_host-metrics-pipeline_editor.png`、`r390-light-en__admin_pipelines_host-metrics-pipeline_editor.png`；[度量] 该页 47 个低于 11px 的文本节点（`_metrics_r1440-light-en.json`）

- **信息架构**：4 区——页头（路径 chips + 8 个工具按钮）、保存草稿墙、三栏工作区（节点面板 200px / 画布 / 检查器 300px）。**"保存草稿"这一操作被做成了 18 个按钮**（v3 · 10/29/2026, 7:09:01 PM 之类），每行 6 个、共 3 行，占据页头下方 130px。这是本页最大的 IA 问题：草稿是"历史"，被摆成了"主操作区"。
- **视觉层级**：h1 21px（**全站唯一不是 26px 的 h1**，.studio-page .page-header h1{font-size:21px} L789）+ 8 个同权重工具按钮 + 18 个草稿按钮。**页面上有 26 个等权重可点矩形**，用户找不到"下一步"。
- **排版问题**：**全站排版最差的一页**。119 个文本节点里：8.5px×10、9px×5、9.5px×16、10px×10、10.5px×6 = **47 个低于 11px（39%）**。8.5px 是 .port-type（端口类型标签），9px 是 .node-category（节点分类）。行高也异常：12px 行高比 **1.39**、13px **1.28**（其他页均为 1.47–1.5）——文本被压得比正文更紧。
- **卡片与边框**：4 张卡 + 画布节点卡（studio-rf-node 202px 宽、**9px 圆角**、padding 从 9px 11px@659 改成 0@815，导致内部 head/ports/summary 三段各自带 padding）。9px 是全站唯一奇数圆角。
- **栅格与对齐**：三栏 200px / 1fr / 300px（L792），≤1320px 变 184/1fr/292（L866）、≤1080px 变两栏（L870）。**1440 下侧栏塌成 64px 后 brand 溢出**：截图左上角品牌标记被 64px 轨道切掉一截（x≈18–32）。检查器 300px 只放了两行字（Select a node… + VALIDATION 0）。
- **空间密度**：画布给得够（约 800×620），这是本页唯一做对的空间决策。但画布底部的提示条 "Local edits are not persisted until Save draft. Publish requires server validation." 与 React Flow 的缩放控件（+ / − / ⤢）贴在一起，右下角还有被压住的 React Flow 水印。
- **交互细节**：undo/redo/auto-layout/横竖/readable/fit-all/preview/detail/save/validate/publish = **11 个工具 + 1 个主 CTA**。title 属性承担了全部解释。按钮全是旧 .btn btn-secondary，与全站 shadcn Button **圆角 6px vs 8px、字重 560 vs 500** 不同（§2.1.3 行 7–8）。键盘可达但无快捷键。
- **深浅色一致性**：画布用 --ow-canvas-bg（暗色 #10151c），节点卡在暗色下 border-strong 描边 + 硬编码阴影（L815 0 1px 2px rgba(...)）→ 暗色下阴影几乎不可见，节点失去浮起感。
- **中英文排版**：zh 1034 vs en 1094（-5.5%）。8.5px/9.5px 的 mono 标签在中文下换行单位从"词"变"字"，但 .node-category 的 uppercase + letter-spacing 对中文无效。
- **移动端**：390 页高 1636；三栏在 ≤700 变单列（L657），画布高度 520px 改 100%（L809–876 的多次覆写），**移动端画布无法同时看到节点与检查器**。缩放控件与提示条重叠风险最高。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 2 | 26 个等权按钮；"保存草稿"18 连排占据主操作区 |
| 排版 | 1 | 39% 文本节点低于 11px（最低 8.5px）；行高 1.28–1.39 全局最紧 |
| 对齐与间距 | 2 | 64px 轨道切掉 brand；检查器 300px 只放两行；提示条压在画布控件旁 |
| 组件一致性 | 2 | 全站唯一使用旧 .btn 的页面；节点圆角 9px 是唯一奇数 |
| 色彩与对比 | 3 | 暗色下硬编码阴影失效，节点浮起感丢失 |
| 数据可读性 | 2 | 端口类型 8.5px；节点摘要 10.5px |
| 交互反馈 | 4 | 11 个工具状态齐（disabled/busy/active），undo/redo 有禁用态 |
| 响应式 | 2 | 390 单列后画布与检查器无法同视；路径 overflow 未处理 |

---

### 08 · /admin/pipelines/:id/run — Job Submit

**证据**：[度量+源码] `r1440-light-en__admin_pipelines_host-metrics-pipeline_run.png`、`r390-light-en__admin_pipelines_host-metrics-pipeline_run.png`；run-panel 规则 `styles.css:688-691`

- **信息架构**：单卡表单（提交任务）+ 参数区。50 个文本节点，是全站信息量最低的表单页。
- **视觉层级**：h1 26px + 表单标签 12px。无主次冲突。
- **排版问题**：12px 25 / 10px 6；run-panel label 12px、select/textarea 用 font:inherit → 控件内文字 13.5px（body 级联），**标签 12px 与控件 13.5px 不同档**。
- **卡片与边框**：1 张卡。
- **栅格与对齐**：单列，无风险。
- **空间密度**：900px（= 视口），表单充足。
- **交互细节**：提交按钮为 primary；参数错误走 .inline-error。
- **深浅色一致性**：令牌驱动。
- **中英文排版**：900 = 900。
- **移动端**：390 页高 844（一屏），无溢出。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 单表单，清晰 |
| 排版 | 3 | 标签 12px vs 控件 13.5px 不同档 |
| 对齐与间距 | 3 | 单列 |
| 组件一致性 | 3 | 原生 label/select 而非 shadcn Label/Select |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | 3 | 参数表单，无表格 |
| 交互反馈 | 3 | busy/error 有态 |
| 响应式 | 3 | 一屏放下 |

---

### 09 · /admin/jobs — Jobs

**证据**：[像素] `r1440-light-en__admin_jobs.png`、`r1440-light-zh__admin_jobs.png`、`r1440-dark-en__admin_jobs.png`、`r390-light-en__admin_jobs.png`

- **信息架构**：单面板表格 + 顶部搜索 + Pipeline 下拉 + 6 段状态筛选 + "12 of 12 shown" + 分页。是全站筛选能力最完整的列表页。
- **视觉层级**：h1 26px → "12 of 12 shown" 12px 右对齐 → 表头 12px → 单元格 13px。层级干净，一屏只讲一件事。
- **排版问题**：141 节点里 **13px 86（61%）** —— 全站唯一 13px 占优的页面，因为 .data-table 用 var(--ow-type-base)。12px 只用于表头与 Duration/Attempts。12 行 UUID 在 13px mono 下单行显示，列宽 450px 恰好容下（job-id-cell 有 max-width）。
- **卡片与边框**：**只有 1 张卡**（表格面板）。是 §2.3 "别把表格套进卡片" 的正例。
- **栅格与对齐**：8 列，其中 Job 列自适应、其余定宽。**行的垂直对齐正确**（单元格全是单行）。唯一不齐处：表头 Duration 与 Created 之间夹了一个空 TableHead（给 chevron），导致最后一列 32px 空白。
- **空间密度**：行高 49px × 12 行 = 588px，加上筛选条 44px，一屏放下 12 条。对一个"任务历史"表格，49px 行高偏松（同类运维控制台 36–40px），但换来的是 UUID 不折行。
- **交互细节**：行可点进详情；搜索即时过滤；6 段状态筛选是 Tabs 形态，"All" 选中态是浅蓝底 + 蓝字。**分页按钮 "First page / Next page" 是两个未加视觉分组的次要按钮**，且都处于 disabled 态时几乎看不见（`r1440-light-en__admin_jobs.png` 右下）。
- **深浅色一致性**：r1440-dark-en 已采，布局零变化。
- **中英文排版**：955 = 955（0%），因为表格行数固定、每格单行。
- **移动端**：390 页高 3341；表格转卡片纵向堆叠，每行约 200px；12 行 → 3341px。状态药丸在卡片布局里与标签同行，读起来是 "Status  SUCCEEDED"，尚可。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 4 | 一屏一事，筛选完整，无卡片堆砌 |
| 排版 | 3 | 13px 表格单行 UUID 可读；表头 12px |
| 对齐与间距 | 3 | 行内对齐正确；多出的空表头列造成 32px 空洞 |
| 组件一致性 | 2 | **所有 SUCCEEDED/CANCELLED 是虚线"未知"药丸**，与 FAILED 的红实心不可比 |
| 色彩与对比 | 3 | 只有失败有颜色 |
| 数据可读性 | 3 | 列齐全、UUID 单行；但最重要的"成功"没有语义色 |
| 交互反馈 | 4 | 行可点、搜索即时、筛选分段清晰 |
| 响应式 | 3 | 卡片化后每行 200px，12 行 3341px，无分页回退 |

---

### 10 · /admin/jobs/:id — Job Detail

**证据**：[像素] `r390-light-en__admin_jobs_1285fbe8-9bb8-459f-b073-af245d32b3ae.png`（613px 宽，溢出实证）、`r1440-light-en__admin_jobs_1285fbe8-9bb8-459f-b073-af245d32b3ae.png`；[度量] 该路由 scrollWidth=613（§2.6）

- **信息架构**：页头（pipeline 名 + 状态药丸 + revision + run short id）→ 4 张指标卡 → Lifecycle → Timeline → Attempts → Checkpoints → Result → Result metadata。**8 个纵向区块**，顺序符合"结论→过程→明细"。
- **视觉层级**：h1 用 pipelineId 而不是 "Job Detail"（Jobs.tsx 里 title={job.pipelineId}），副标里塞了状态药丸 + revision + 短 id。**页面标题不是页面名**，用户从列表点进来后失去了"我在哪"的锚点（面包屑只有 Jobs）。
- **排版问题**：119 节点，12px 62 / 13.5px 18 / 10px 11 / 11px 8 / **20.3px×5**。20.3px 来自 .metric-value 的 clamp(20px,2vw,26px)，说明**指标数字尺寸随视口变化**，同行 5 张卡在不同宽度下数字大小会变。
- **卡片与边框**：10 张卡、深度 1。4 张指标卡是 panel + metric-card 双类叠加（同页 06 的问题）。
- **栅格与对齐**：summary-grid.job-stats 4 列；Lifecycle 是 kv 2 列；Timeline 是单列带圆点。**Attempts 表格列宽失控**：390 下 Node 列把 UUID 折成 4 行（无 ellipsis）。
- **空间密度**：1339px（1440）/ 1755px（390）；390 下 4 张指标卡各约 90px 承载 4 个短值 = 400px 换 4 个单词。
- **交互细节**：Advanced · full Job ID, fence and lease 用 details 收纳长 id（好）；Cancel 按钮只在对的状态出现（cancellable）；结果 JSON 在 pre.result-json 里可横向滚动。
- **深浅色一致性**：r1440-dark-zh 已采 → 布局零变化，未见暗色专属问题。
- **中英文排版**：1339 = 1339（0%）。
- **移动端**：**全站唯一整页横向溢出的路由**，scrollWidth 613 vs 内容盒 375 = +238px（en）/ +190px（zh）。元凶是 Jobs.tsx:207 的 `<code className="mono small">` 承载 64 位 hex digest。截图 PNG 本身就是 613px 宽。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 结论→过程→明细顺序对；但 h1 是 pipeline 名而非页面名 |
| 排版 | 3 | 指标数字尺寸随 vw 变化（clamp）；10px 标签 11 处 |
| 对齐与间距 | 2 | 指标卡 400px 换 4 个词；Attempts 列宽失控 |
| 组件一致性 | 2 | panel + metric-card 双类叠加；状态药丸仍是虚线"未知" |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | 2 | 64 位 digest 撑破整页；UUID 折 4 行无省略 |
| 交互反馈 | 3 | details 收纳长 id、Cancel 按状态出现 |
| 响应式 | 1 | **scrollWidth 613 / 内容盒 375，横向溢出 238px** |

---

### 11 · /admin/nodes — Nodes

**证据**：[像素] `r1440-light-en__admin_nodes.png`、`r1440-dark-en__admin_nodes.png`、`r390-light-en__admin_nodes.png`、`r1024-light-en__admin_nodes.png`

- **信息架构**：5 张指标卡（Nodes/Ready/Stale/Unreachable/Revoked）→ 5 段状态筛选 → 表格（Node/Status/Identity/Instances/CPU/Memory/Capacity/Sample time/Last heartbeat）→ 2 个说明 callout。**指标卡的分类与筛选器的分段一一对应**，这是全站 IA 做得最严谨的一处。
- **视觉层级**：第 1 张卡（Nodes 1 + 3 行说明）与第 2–5 张卡（药丸 + 数字，无说明）**内部结构不同**：卡片 1 是"标签→数字→说明"，卡片 2–5 是"药丸→数字"。同一行里两种信息配方，且卡片 1 的说明文字把它的内容基线压得比邻居低。
- **排版问题**：84 节点，12px 38 / 13px 17 / 10px 6 / 11px 5。表格 Status 单元格是"药丸 + Last observed just now"两行，第二行 12px。
- **卡片与边框**：8 张卡、深度 1。5 张指标卡 + 1 表格面板 + 2 个 callout。**5 张卡排成 5 列**，而 .metric-grid 定义的是 4 列（`styles.css:1098`）——说明本页用了另一套 grid，**同类指标卡在不同页用了不同网格**。
- **栅格与对齐**：表格 **首列（Node）与 Status 列是两行内容且顶对齐，其余列单行居中** → 同一行内基线分裂（截图 y=391 vs 402），与 Plugins 同病。
- **空间密度**：900px 一屏；1 行数据占 76px。2 个 callout 在表格下方并排，右侧文本更长导致高度不齐。
- **交互细节**：行可点（data-node-state 供测试）+ tabIndex=0 + Enter；Join node 是 primary 且非 admin 时 disabled **并带 title 解释原因**（`Nodes.tsx:138`）——这是"禁用态给出理由"的正面例子。
- **深浅色一致性**：r1440-dark-en 已采，布局零变化；暗色下 5 张卡的边界同样弱。
- **中英文排版**：zh 1251 vs en 1322（-5.4%）；指标卡说明行数变化导致卡片高度差变化。
- **移动端**：390 页高 1322；5 张指标卡单列堆叠 = 5×90px；表格卡片化。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 指标↔筛选↔表格语义一致（最佳）；但卡 1 与卡 2–5 配方不同 |
| 排版 | 3 | 12px 45%；表格两行单元格 |
| 对齐与间距 | 2 | 同行内顶对齐/居中混用，基线分裂；5 列网格与 .metric-grid 定义不符 |
| 组件一致性 | 3 | 指标卡用另一套网格；callout 两种高度 |
| 色彩与对比 | 3 | Stale 虚线橙、Unreachable 红、Revoked 灰，可分 |
| 数据可读性 | 3 | 列丰富；node id 截断到 13 字符仅靠 title |
| 交互反馈 | 4 | 行可点 + Enter；禁用按钮给出 title 理由 |
| 响应式 | 3 | 无溢出；5 张卡单列后纵向过长 |

---

### 12 · /admin/nodes/:id — Node Detail

**证据**：[度量+源码] `r1440-light-en__admin_nodes_9b426dab-27c4-45ce-9773-b51a3db4f246.png`、`r390-light-en__admin_nodes_9b426dab-27c4-45ce-9773-b51a3db4f246.png`；`Nodes.tsx:300-440`

- **信息架构**：5 张卡（身份/资源/实例/令牌/危险区）+ 实例表（含 Live logs 链接）。h1 是节点名。
- **视觉层级**：h1 26px → deployment-title h2 16px → kv 13px。
- **排版问题**：219 个文本节点（全站最多），12px 约 50%。kv-value.mono 13px。
- **卡片与边框**：5 张卡、深度 1；危险区（revoke）用 destructive 按钮。
- **栅格与对齐**：kv-grid auto-fit 190px；实例表与节点表列不同。
- **空间密度**：2434px（1440）/ 5220px（390）——**390 下 5220px，是全站最长的详情页**。
- **交互细节**：Join token 有 show/hide 切换；revoke 走 ConfirmAction；实例表每行有 Live logs 链接（`Nodes.tsx:415`）。
- **深浅色一致性**：r1440-dark-zh 已采 → 未见暗色专属问题。
- **中英文排版**：2434 = 2434（0%）。
- **移动端**：390 页高 5220，无溢出；但实例/令牌表在卡片化后每行约 220px。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 身份→资源→实例→危险区，顺序合理 |
| 排版 | 3 | 219 节点，12px 为主 |
| 对齐与间距 | 3 | kv-grid auto-fit 在窄屏重排 |
| 组件一致性 | 3 | 与列表页共享表格/药丸 |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | 3 | kv 齐全，长 id 有 mono + title |
| 交互反馈 | 3 | show/hide、确认弹窗齐 |
| 响应式 | 2 | 390 下 5220px，无锚点导航 |

---

### 13 · /admin/governance — Governance

**证据**：[像素] `r1440-light-en__admin_governance.png`、`r1440-light-zh__admin_governance.png`

- **信息架构**：4 张概览卡（DATASETS / QUALITY PASSED / LINEAGE BATCHES / NODES READY）→ Dataset quality status 面板（表格 + Open catalog 链接）→ 2 列（Recent quality failures / Node health）→ 底部 callout。
- **视觉层级**：卡标签是 11px uppercase（DATASETS），数字 26px；表格里 **6 列全部在说"不知道"**（Unknown 药丸 + 2×NO_DATA + No runs），页面整体读起来像"系统异常"而不是"暂无数据"。这不是实现错误（语义正确），但**视觉上缺少"这是正常的空态"这一层表达**——没有一条横幅说明"当前没有质量运行，这是预期状态"。
- **排版问题**：101 节点，12px 39 / **11px 20** / 13px 15。11px 集中在卡标签与 ow-summary-definition。数据集 id 是 12px mono 被截断到 14 字符。
- **卡片与边框**：8 张卡、深度 1。4 张概览卡用 ow-summary-card（12/14px padding）+ 3 个 panel（16/18px padding）+ 1 callout → **三种内部 padding 值**。
- **栅格与对齐**：governance-grid 1.25fr/1fr（L260）。**列宽严重失衡**：Schema 列宽 300px 只放 r1 两个字符，而 Dataset 列的 hash 被截断到 14 字符；Quality 列 215px 放一个药丸。右侧 Node health 面板只有 1 行数据却占满半屏。
- **空间密度**：910px；左列 Recent quality failures 空态占 230px，下方 callout 只占左列宽度（565px），**右列对应位置是空白**，形成 L 形空洞（截图 y≈795–855）。
- **交互细节**：Open catalog 是纯文本链接（**无箭头**），而 Overview 用 View all（**有箭头**）——同一类"跳转到关联列表"的入口两种形态。行不可点（与 Plugins/Nodes 相反）。
- **深浅色一致性**：r1440-dark-zh 未覆盖 Governance → 未验证。
- **中英文排版**：910 = 910（0%）。
- **移动端**：390 页高 1966，无溢出；governance-grid 在 ≤1100 变单列（L261）。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 结构清楚；但整屏"未知"缺一句"这是预期状态" |
| 排版 | 3 | 11px 标签 20 处；id 截断到 14 字符 |
| 对齐与间距 | 2 | Schema 列 300px 放 r1；右列 1 行数据占半屏；底部 L 形空洞 |
| 组件一致性 | 3 | 3 种卡片 padding；Open catalog 无箭头 vs Overview 有箭头 |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | 2 | 列宽与内容不匹配，关键 hash 被截 |
| 交互反馈 | 3 | 只有链接，行不可点 |
| 响应式 | 3 | 单列回退正确 |

---

### 14 · /admin/instances/:id/logs — Instance Logs

**证据**：[度量+源码] `r1440-light-en__admin_instances_531d794b-e26a-4772-aef5-ec15d88a75d6_logs.png`、`r390-light-en__admin_instances_531d794b-e26a-4772-aef5-ec15d88a75d6_logs.png`；terminal / log-line 规则 `styles.css:421-447`

- **信息架构**：页头 + 元信息行（连接态/来源/过滤）+ 工具条（搜索/级别下拉/计数）+ 终端区。**是全站唯一用深色终端块的页面**。
- **视觉层级**：终端 --ow-code-bg #11151c 反色块成为页面焦点，正确。log-line 三列网格（时间/级别/消息）。
- **排版问题**：67 节点；log-level 10px + log-channel 10px uppercase；log-time 11px。**日志正文没有独立字号**，继承 body 13.5px——与 10px 的级别标签落差 3.5px，尚可；但 ≤560 时整个 log-line 降到 **11px**（L622）——**日志正文在 390 下只有 11px**。
- **卡片与边框**：0 张 panel（cards=0），完全靠 terminal 一个块。这是"用专属高密度组件而非 Card"的正确做法。
- **栅格与对齐**：三列固定网格，等宽字体保证列对齐。级别用 level-* 系列着色（L437-441）+ 文字本身也打印级别，合规。
- **空间密度**：900px（一屏），terminal 内滚动——密度合适。
- **交互细节**：搜索框带图标与 padding-left；级别 select 用 ow-filter-select；截断行有 log-truncated 标记（"已截断"语义可见）。
- **深浅色一致性**：终端块在明暗两套下**都是深色**（--ow-code-bg 只在暗色里改值），明色下形成强对比块——有意的"代码区"处理，但也是明色下页面上唯一的高对比区域，抢了 h1 的注意力。
- **中英文排版**：900 = 900（0%）。
- **移动端**：390 页高 1090；log-channel 在 ≤760 display:none（L595），三列变 70/42/1fr。log-message 是 white-space:pre-wrap（L443），所以日志会换行而不是溢出。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 终端是唯一焦点，正确 |
| 排版 | 3 | 级别/通道 10px；日志正文 390 下 11px |
| 对齐与间距 | 3 | 等宽三列，对齐正确 |
| 组件一致性 | 3 | terminal 是独有组件，无同类对比 |
| 色彩与对比 | 2 | 级别靠颜色区分（虽也有文字），暗色下对比不足 |
| 数据可读性 | 3 | 时间/级别/消息齐全，截断有标记 |
| 交互反馈 | 3 | 搜索/过滤/计数齐 |
| 响应式 | 3 | 通道列隐藏、列宽收窄正确 |

---

### 15 · /admin/activity — Activity

**证据**：[度量+源码] `r1440-light-en__admin_activity.png`（2.1MB，8507px 高）、`r1440-light-zh__admin_activity.png`、`r390-light-en__admin_activity.png`（25,158px）

- **信息架构**：1 张卡（事件表格），无概览、无筛选栏。
- **视觉层级**：**几乎没有层级**。1 张面板 + 1263 个文本节点，全部 12px（964 个，76%）或 13px（276 个）。页面上没有第二级视觉锚点，用户无法快速定位。
- **排版问题**：**全站单页文本量最大的页面**，1263 节点 / 96% 是 12px。1440 下 8507px 高，390 下 **25,158px**。
- **卡片与边框**：1 张卡、深度 1（密度上正确），但"1 张卡装 1263 个节点"是另一个极端。
- **栅格与对齐**：沿用 data-table 时列在 1440 下对齐；但行数极多时每行只有一条底边框，横向追踪容易串行。
- **空间密度**：**密度过高**（与 Overview 的空态正好相反）。无分页、无虚拟化、无"加载更多"的迹象，整页一次性渲染。
- **交互细节**：展开行 expanded-row（L448）存在，说明行可展开看详情。
- **深浅色一致性**：r1440-dark-zh 未覆盖 Activity → 未验证。
- **中英文排版**：8507 = 8507（0%）。
- **移动端**：**25,158px 高**（390），且 text-muted-foreground 有 5 个节点 right=414（超出 39px），说明卡片化后的行内仍有溢出内容被容器吃掉。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 2 | 单面板 + 1263 节点，无二级锚点、无筛选 |
| 排版 | 2 | 964 个 12px 节点，96% 同档，无层级 |
| 对齐与间距 | 3 | 表格列对齐正确 |
| 组件一致性 | 3 | 复用表格/展开行 |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | 2 | 无分页/虚拟化；8507px → 390 下 25,158px |
| 交互反馈 | 3 | 行展开存在 |
| 响应式 | 2 | 25,158px 单页 + 行内 39px 溢出 |

---

### 16 · /admin/access — Access & trust

**证据**：[度量+源码] `r1440-light-en__admin_access.png`、`r1440-light-zh__admin_access.png`；role-list / trust-list 规则 `styles.css:453-466`

- **信息架构**：4 张卡（角色/信任/权限矩阵）+ 1 层嵌套。h1 "Access & trust"。
- **视觉层级**：role-pill 有 min-width（L458），形成对齐的角色列；trust-list 用 check 图标 + 两行文本。
- **排版问题**：92 节点，12px 49（53%）/ 16px 4。**role-list 与 trust-list 是两套列表排版**：前者是"药丸 + 段落"，后者是"图标 + strong + span"。
- **卡片与边框**：5 张卡、**深度 2**（1 张卡嵌在另一张里）。role-list 的条目之间有分隔线。
- **栅格与对齐**：summary-grid 2 列（L259）；role-pill 定宽使其纵向对齐。
- **空间密度**：1145px（1440）/ 1961px（390）。
- **交互细节**：本页以展示为主；role-pill 只读不点。
- **深浅色一致性**：暗色未覆盖 → 未验证。
- **中英文排版**：**zh 1073 vs en 1145（-6.3%）**，差异第三大；角色描述在中文下少 1–2 行，导致 role-list 行高在两种语言下不同。
- **移动端**：390 页高 1961，无溢出；summary-grid ≤1024 变单列（L544）。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 角色/信任/权限分区清楚 |
| 排版 | 3 | 两套列表排版并存 |
| 对齐与间距 | 3 | role-pill 定宽保证纵向对齐 |
| 组件一致性 | 3 | 与全站卡片/药丸同源 |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | 3 | 角色与权限一目了然 |
| 交互反馈 | 3 | 纯展示，无交互需求 |
| 响应式 | 3 | 单列回退正确 |

---

### 17 · /admin/settings — Settings

**证据**：[度量+源码] `r1440-light-en__admin_settings.png`；`Settings.tsx`(76 行)；field/form-grid 规则 `styles.css:143-157`

- **信息架构**：4 张卡（工作区/语言/主题/关于）+ 表单。页面很薄（76 行源码）。
- **视觉层级**：field-label 12px/600 与 field-hint 12px/常规——**靠字重而非字号分主次**，是本项目里少见的正确做法。
- **排版问题**：82 节点，12px 33 / 13px 19 / **12.2px×1**（code 的 .94em 在 13px 上下文里算出 12.22px——**一个不该存在的尺寸，来自 code{font-size:.94em}**）。
- **卡片与边框**：4 张卡、深度 1。
- **栅格与对齐**：form-grid auto-fit minmax(210px,1fr)——在 1440 下排 4–5 列，在 390 下 1 列。
- **空间密度**：1114px。
- **交互细节**：语言切换是原生 select（ow-filter-select select），主题切换在顶栏（SurfaceChrome）；两处主题入口需保持一致。
- **深浅色一致性**：暗色未覆盖 → 未验证。
- **中英文排版**：zh 1078 vs en 1114（-3.2%）。
- **移动端**：390 页高 1771；**scrollWidth 383（en）/ 376（zh）> 内容盒 375 → 轻微横向溢出 1–8px**，是全站除 Job Detail 外唯一超出基线宽度的页面。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 卡分区清楚；字段靠字重分层（正确） |
| 排版 | 3 | code{font-size:.94em} 产生 12.2px 这类非法尺寸 |
| 对齐与间距 | 3 | auto-fit 栅格在宽屏列数过多 |
| 组件一致性 | 3 | 原生 select 与 shadcn Select 并存 |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | 3 | 表单，可读 |
| 交互反馈 | 3 | 保存态存在 |
| 响应式 | 3 | 390 下溢出 1–8px（轻微） |

---

### 18 · /admin/settings/diagnostics — Bootstrap Diagnostics

**证据**：[像素] `r1440-light-en__admin_settings_diagnostics.png`（2542px 高）；[度量] 12 张卡（全站最多）

- **信息架构**：6 个指标块 → 3 列（Kernel facts / Recovery commands / 空）→ Node observations → Runtime policies → Recent audit（20 行，无分页）。**第三列是空的**（截图 x≈835–1400、y≈180–500 完全空白）。
- **视觉层级**：6 个指标块被切成**两种形态**：左侧 2 张带圆角边框的卡片 + 右侧 1 条被竖线分隔的 4 列条带（截图 y≈150–230）。同一行的 6 个同级信息用两套容器装，视觉上像"两张卡 + 一张表"。
- **排版问题**：198 节点，12px 122（62%）/ 13.5px 31 / 10px 13。kv-label 12px / kv-value 13px。
- **卡片与边框**：**12 张卡（全站最多）**。Kernel facts 面板里有一个孤立的异常字形（截图 x≈291、y≈287，一个约 2px 宽的竖条）——疑似图标尺寸塌陷；**Recovery commands 面板内的深色代码块左缘 x=565，其下方说明块左缘 x=583，相差 18px**，同一张卡里两个子块没有共用左基线。
- **栅格与对齐**：3 列（实则 1fr/1fr/空）。Node observations 表格 3 列。Runtime policies 是 **5 列均分**，每列都是超长 camelCase 字段名 + 数字。
- **空间密度**：2542px；Recent audit 20 行 × 58px = 1160px，占页面 46%。
- **交互细节**：Raw JSON + Refresh 两个次要按钮；代码块有复制按钮（command-block 内的 icon-btn）。
- **深浅色一致性**：代码块在明色下已是深底（--ow-code-bg），暗色下会与页面融为一体 → 边界丢失风险。
- **中英文排版**：zh 2496 vs en 2542（-1.8%）。**Runtime policies 的字段名不翻译**，所以中英文下这一行完全相同。
- **移动端**：390 页高 4156；Runtime policies 5 列在 390 下的排布未在截图中验证，但 kv-grid 在 ≤560 变 1 列（L608）。

**本页最严重问题（违反 rules/06）**：Runtime policies 直接把后端字段名当 UI 文案渲染——heartbeatIntervalSeconds / maintenancePerNode / nodeStateSeconds / requestTimeoutSeconds / sessionHours。这些不在 i18n 目录中，也不该出现在面向用户的表格里。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 2 | 6 个同级指标块用 2 套容器；第三列为空 |
| 排版 | 2 | 12.2px/10px 混杂；camelCase 字段名当文案 |
| 对齐与间距 | 2 | 同一卡内两个子块左缘差 18px；孤立异常字形 |
| 组件一致性 | 3 | 卡片/代码块/表格三套组件都有 |
| 色彩与对比 | 3 | 明色下代码块对比强（正确） |
| 数据可读性 | 3 | 事实齐全；audit 20 行无分页 |
| 交互反馈 | 3 | 复制按钮、Raw JSON |
| 响应式 | 3 | 未采 390 截图验证 |

---

### 19 · /admin/ops-center — Ops Center

**证据**：[度量+源码] `r1440-light-en__admin_ops-center.png`、`r390-light-en__admin_ops-center.png`；`OpsCenter.tsx`(57 行)

- **信息架构**：3 张卡（节点列表/插件列表/就绪度）+ 资源条。页面很薄。
- **视觉层级**：ops-node-list / ops-plugin-list 是两套定制列表（L480–486），各自带 ops-node-name / ops-node-metric。
- **排版问题**：77 节点，12px 35 / 16px 4 / **11.3px×1**（又一个非整数尺寸，来自 .94em 作用在 12px 上）。
- **卡片与边框**：4 张卡、深度 1；resource-stack / resource-row / bar 是第四套进度条实现（progress 是第一套，L267–270）。
- **栅格与对齐**：两列列表 + 资源条；bar 高度硬编码（L490）。
- **空间密度**：965px。
- **交互细节**：以展示为主。
- **深浅色一致性**：暗色未覆盖 → 未验证。
- **中英文排版**：**zh 900 vs en 965（-6.7%）**，差异第二大。
- **移动端**：390 页高 1480，无溢出。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 两列列表清楚，页面薄 |
| 排版 | 3 | 11.3px 非整数尺寸；两套列表排版 |
| 对齐与间距 | 3 | 未见明显错位 |
| 组件一致性 | 3 | 进度条有 progress 与 bar 两套实现 |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | 3 | 指标在列表右侧 |
| 交互反馈 | 3 | 纯展示 |
| 响应式 | 3 | 无溢出 |

---

### 20 · /login — Login

**证据**：[度量+源码] `login-390.png`（隔离 context 采集，390 宽）；login-* 规则 `styles.css:518-532`

- **信息架构**：左右分栏——左：品牌叙事（h1 clamp(30px,4vw,44px) + 3 条要点 + 页脚）+ 右：表单（max-width 380px）+ 帮助文案。**唯一一处把"产品是什么"写清楚的页面**，也是唯一使用 44px 大标题的页面。
- **视觉层级**：login-copy h1 44px → 正文 15px → 要点 13.5px → 表单 h2 26px。**三档以上清晰落差**，是全站排版最好的页面。
- **排版问题**：1440 下仅 4 档字号（10px/13px/14px/26px）。login-footnote 12px。
- **卡片与边框**：login-panel 无卡片，表单直接铺在 --ow-bg 上（**不套卡**），符合"表单不需要卡片"的取向。
- **栅格与对齐**：grid-template-columns: minmax(0,1.15fr) minmax(380px,.85fr)（L519）→ 左右比例固定；≤1024 变单列并隐藏品牌区（L557–558）。
- **空间密度**：一屏，留白充足。
- **交互细节**：单一主 CTA（Sign in）；**E2E 用可见文案定位该按钮**（`visual-layout.spec.ts:11` getByRole('button', { name: 'Sign in' })）——违反 rules/06"E2E 禁止按本地化文案定位"，根因是按钮缺 data-testid。
- **深浅色一致性**：login-page 用 --ow-bg，login-brand 用 --ow-surface + border-right；暗色下品牌区与表单区靠 1px 边框分隔（与全站同病）。
- **中英文排版**：登录页在隔离 context 中只采到一种语言（390）→ 中英文对比**未验证**。
- **移动端**：≤1024 隐藏品牌区、单列表单 min-height 100vh（L557–559）——**决策正确**：手机上不该先让用户读一段营销文案。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 4 | 44px→15px→13.5px 三档落差，全站最清晰 |
| 排版 | 3 | 仅 4 档字号；10px 页脚偏小 |
| 对齐与间距 | 4 | 1.15fr/.85fr 分栏 + 380px 表单上限，稳定 |
| 组件一致性 | 3 | 表单不套卡（正确）但输入框来自原生 + shadcn 混合 |
| 色彩与对比 | 4 | 品牌区/表单区分明 |
| 数据可读性 | — | 无数据展示，不适用 |
| 交互反馈 | 3 | 单 CTA；按钮无 data-testid 逼 E2E 用文案 |
| 响应式 | 4 | ≤1024 隐藏品牌区是正确取舍 |

---

### S1 · NotFound（/admin/* 未匹配）

**证据**：[度量+源码] `r1440-light-en__admin_nope.png`；41 个文本节点

- **信息架构**：empty-state（图标 + h3 + p + action），在 AdminShell 内渲染，侧栏与顶栏保留。
- **视觉层级**：h3 16px，是全站唯一用 h3 承载页面级空态标题的地方（其余用 h2），标题层级跳档（页面无 h1）。
- **排版问题**：41 节点，12px 12 / 10px 6；空态描述 12px。
- **卡片与边框**：0 张卡，正确（空态不需要卡）。
- **栅格与对齐**：居中，无风险。
- **空间密度**：900px 一屏。
- **交互细节**：回首页按钮。
- **深浅色一致性**：令牌驱动。
- **中英文排版**：900 = 900。
- **移动端**：390 页高 844，无溢出。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 3 | 空态配方正确；但无 h1（标题层级跳档） |
| 排版 | 3 | 12px 描述 + 10px 辅助 |
| 对齐与间距 | 3 | 居中 |
| 组件一致性 | 3 | 复用 empty-state |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | — | 不适用 |
| 交互反馈 | 3 | 单一返回 CTA |
| 响应式 | 3 | 一屏 |

---

### S2 · /app/home — My workspace（业务工作台）

**证据**：[像素] `r1440-light-en__app_home.png`（1731px）、`r1440-light-zh__app_home.png`（1567px）；[度量] 9 张卡 / 最大嵌套 2

- **信息架构**：4 个区块——"Your task space"（3 张卡）→"Evidence status"（1 张卡）→"Available now"（1 个面板内 3 列）→"Current account"→"Capability status"（6 行表）。**区块的容器形态不一致**："Your task space" 的标题直接放在页面背景上，而 "Available now"/"Current account"/"Capability status" 是有边框的面板。同一页两种"区块"语法。
- **视觉层级**：h1 26px → 区块 h2 16px → 卡片 h3 13–14px → 12px 正文。层级齐全，但 **"Evidence status" 单独占一行只放 1 张卡**，右侧 2/3 是空白 → 视觉重心断裂。
- **排版问题**：104 节点，12px 53 / 13px 23 / 10px 11。**"Missing: An Incident domain model and its query API (the domain ADR is still open)" 这类开发者措辞重复出现 4 次**，括号里是项目内部状态（ADR 未定），终端用户无法理解。
- **卡片与边框**：9 张卡、最大嵌套 2 层（"Business plugin entries" 是有边框的子卡，嵌在面板里）。**"Available now" 面板内 3 个子块用竖线分隔，其中 1 个又自带边框** → 3 个子块的边界语法各不相同。
- **栅格与对齐**：3 列网格，**同行 3 张卡的行动链接垂直位置差 48px**（y≈497/497/545，因第三张卡文案多 2 行而没有 margin-top:auto）。这是本页最刺眼的对齐缺陷。
- **空间密度**：1731px 装 104 个文本节点——**全站密度最低的页面**（平均 1 个文本节点 16.6px 高度）。四个"没有数据"的区块占满一屏。
- **交互细节**：每张卡有 1 个 "Open X" 链接；"Business plugin entries" 有 Retry 按钮。链接是蓝色文字，与卡片整体无视觉关联，点击目标只有文字本身。
- **深浅色一致性**：暗色未覆盖 → 未验证。
- **中英文排版**：**zh 1567 vs en 1731（-9.5%，全站差异最大）**。
- **移动端**：390 页高 3124（zh 2765），无溢出；3 列变 1 列。

**IA 附带问题**：业务工作台的侧栏页脚仍然展示 Environment: STAGING / Commit: 51e8eb7 / Deployed At: 2026-10-29 13:05 UTC / Status: READY——**面向业务用户的 shell 里出现 Kernel 部署元数据**。同一信息在 /admin 下是合理的（运维视角），在 /app 下是概念泄漏。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 2 | 区块容器语法不一致；Evidence status 独占一行留 2/3 空白 |
| 排版 | 2 | 开发者措辞重复 4 次；12px 占 51% |
| 对齐与间距 | 2 | 同行卡片的行动链接垂直错位 48px；竖线分隔与边框混用 |
| 组件一致性 | 2 | 同样内容的"未就绪"块有 3 种外观（task 卡内、panel 内、子卡内） |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | 2 | 全站密度最低；4 个"无数据源"块无差异 |
| 交互反馈 | 3 | 每卡 1 个链接 + Retry；点击目标只有文字 |
| 响应式 | 3 | 390 单列，无溢出 |

---

### S3 · /app/incidents — Incident Workspace（占据位）

**证据**：[像素] `r1440-light-en__app_incidents.png`、`r1440-dark-zh__app_incidents.png`；[度量] 6 张卡 / **4 张在深度 2**

- **信息架构**："Not shipped yet" 面板（含一条警告条）→"Investigation workspace" 面板（3 个 region：Timeline & evidence / Hypothesis & tools / Detail）。**每个 region 内是虚线空槽**——DOM 数 2 层卡片，**视觉上 3 层边界**（实线 panel → 实线 region → 虚线 slot）。
- **视觉层级**：h1 26px → panel h2 16px → region h3 13px → slot 标题 12px bold → 12px 说明。**5 档但在最需要区分的地方（region vs slot）只差 1px**。
- **排版问题**：49 节点，12px 22 / 11px 10 / 10px 5。**"Empty slot - no data source" 用 ASCII 连字符而非 en dash**；三处 "Missing: … (the domain ADR is still open)" 完全相同地重复。
- **卡片与边框**：6 张卡、深度 2；**虚线槽卡**是第三种边界（dashed），与 status-indicator--unknown 的虚线语义撞车——用户会以为"这个槽本身状态未知"，而实际是"能力未上线"。
- **栅格与对齐**：3 列 region 等宽；**三个空槽框的顶边对齐（y≈547）、底边对齐（y≈750）**，这点做对了。但 region 头部描述行数不同（2/2/3 行）导致槽的起始位置靠 auto-margin 兜住，文本一长就会破。
- **空间密度**：900px 页面用掉约 700px 去画 3 个空框 + 1 句"没上线"。
- **交互细节**：**没有任何可点元素**（无 CTA、无链接）。用户被困在"这里将来会有东西"的页面上，没有返回入口（除侧栏）。
- **深浅色一致性**：`r1440-dark-zh__app_incidents.png` 已采，暗色下虚线槽在深底上几乎不可见（dashed 1px + --ow-border）。
- **中英文排版**：900 = 900（0%）。
- **移动端**：390 页高 1508（zh 1345），无溢出；3 列变 1 列。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 2 | region 与 slot 只差 1px 字号；虚线槽与 unknown 状态语义撞车 |
| 排版 | 2 | ASCII 连字符；同一句 Missing 重复 3 次；11px/10px 承担说明 |
| 对齐与间距 | 3 | 三个空槽顶/底边对齐（做对了）但靠 auto-margin 兜 |
| 组件一致性 | 2 | 第三种边界语言（dashed）与状态语义冲突 |
| 色彩与对比 | 3 | 明色可读；暗色下虚线槽近不可见 |
| 数据可读性 | — | 无真实数据（设计如此） |
| 交互反馈 | 2 | 页面零可点元素 |
| 响应式 | 3 | 单列回退正确 |

---

### S4 · /app/{investigations,observability,resources,sources,reports} — 占据位

**证据**：[度量+源码] `r1440-light-en__app_investigations.png` 与 `r1440-light-en__app_reports.png`（两页 35 个文本节点完全相同）；`pages/workspace.tsx` 的 SurfaceNotYetPage

- **信息架构**：5 个路由共用同一个组件，内容仅 capability 名不同（2 张卡：说明面板 + 缺失能力条）。
- **视觉层级**：h1 26px + 面板 h2 16px + 12px 说明。层级够，但**5 个页面完全同构**，用户点哪都一样。
- **排版问题**：35 节点，12px 12 / 13.5px 8 / 10px 5 / 11px 4 / 13px 2 / 16px 2。
- **卡片与边框**：2 张卡、**深度 2**（1 张嵌在另一张里）——一个只有两段文字的页面也套了两层卡。
- **栅格与对齐**：单列。
- **空间密度**：900px 装 35 个节点，留白超过 70%。
- **交互细节**：无 CTA。
- **深浅色一致性**：令牌驱动。
- **中英文排版**：900 = 900。
- **移动端**：390 页高 844（一屏）。

| 维度 | 分 | 理由 |
|---|---|---|
| 信息层级 | 2 | 5 页同构，无差异化信息 |
| 排版 | 2 | 两层卡装两段话 |
| 对齐与间距 | 3 | 单列，无风险 |
| 组件一致性 | 2 | 占据位套卡，与全站"空态不套卡"的取向相反 |
| 色彩与对比 | 3 | 未见问题 |
| 数据可读性 | — | 无数据 |
| 交互反馈 | 2 | 零可点元素 |
| 响应式 | 3 | 一屏 |

---

## 4. 截图清单

### 4.1 入库：39 张（上限 40）

全部位于 `artifacts/ui/visual-v3/audit/`。文件名格式 `<组合>__<路由 slug>.png`。

| # | 文件 | 用途（对应报告章节） |
|---|---|---|
| 1 | `r1440-light-en__admin_overview.png` | 全站基准；§3-01；§2.4.2（ACCEPTED 虚线药丸） |
| 2 | `r1440-light-en__admin_jobs.png` | §3-09；§2.4.2（SUCCEEDED 虚线） |
| 3 | `r1440-light-en__admin_nodes.png` | §3-11；§2.3（5 张指标卡配方不同） |
| 4 | `r1440-light-en__admin_plugins.png` | §3-02；§2.4.4（NO_DATA 三连） |
| 5 | `r1440-light-en__admin_governance.png` | §3-13；§2.3.3（列宽失衡 + L 形空洞） |
| 6 | `r1440-light-en__admin_settings_diagnostics.png` | §3-18；§2.2（camelCase 字段名当文案） |
| 7 | `r1440-light-en__admin_pipelines.png` | §3-05 |
| 8 | `r1440-light-en__admin_pipelines_host-metrics-pipeline.png` | §3-06 |
| 9 | `r1440-light-en__admin_pipelines_host-metrics-pipeline_editor.png` | §3-07；§2.2.2（8.5–10.5px） |
| 10 | `r1440-light-en__admin_jobs_1285fbe8-9bb8-459f-b073-af245d32b3ae.png` | §3-10 |
| 11 | `r1440-light-en__admin_plugins_dev.opsweave.hello.png` | §3-03 |
| 12 | `r1440-light-en__admin_plugins_install.png` | §3-04 |
| 13 | `r1440-light-en__admin_nodes_9b426dab-27c4-45ce-9773-b51a3db4f246.png` | §3-12 |
| 14 | `r1440-light-en__admin_instances_531d794b-e26a-4772-aef5-ec15d88a75d6_logs.png` | §3-14 |
| 15 | `r1440-light-en__admin_access.png` | §3-16 |
| 16 | `r1440-light-en__admin_activity.png` | §3-15（8507px） |
| 17 | `r1440-light-en__admin_ops-center.png` | §3-19 |
| 18 | `r1440-light-en__admin_settings.png` | §3-17 |
| 19 | `r1440-light-en__app_home.png` | §3-S2；§2.5.1（-9.5%） |
| 20 | `r1440-light-en__app_incidents.png` | §3-S3；§2.3.3（2 层嵌套 / 3 层边界） |
| 21 | `r1440-light-en__admin_nope.png` | §3-S1 |
| 22 | `r1440-light-zh__admin_overview.png` | §2.5.1 |
| 23 | `r1440-light-zh__admin_jobs.png` | §2.5.1 |
| 24 | `r1440-light-zh__admin_governance.png` | §2.5 |
| 25 | `r1440-light-zh__app_home.png` | §2.5.1（-9.5% 实证） |
| 26 | `r1440-light-zh__admin_settings_diagnostics.png` | §2.5 |
| 27 | `r1440-dark-en__admin_overview.png` | §2.1.6（暗色卡片边界消失） |
| 28 | `r1440-dark-zh__admin_overview.png` | 暗色 × 中文 |
| 29 | `r1440-dark-en__admin_jobs.png` | 暗色表格 |
| 30 | `r1440-dark-zh__app_incidents.png` | 暗色下虚线槽不可见（§3-S3） |
| 31 | `r1024-light-en__admin_overview.png` | 1024 断点 |
| 32 | `r1024-light-en__admin_nodes.png` | 1024 + 表格 |
| 33 | `r1024-dark-zh__admin_overview.png` | 1024 暗色 |
| 34 | `r390-light-en__admin_overview.png` | §2.6（无溢出 / 时间戳漂移） |
| 35 | `r390-light-en__admin_jobs_1285fbe8-9bb8-459f-b073-af245d32b3ae.png` | **§2.6 溢出证据（PNG 本身 613px 宽）** |
| 36 | `r390-light-en__admin_nodes.png` | 390 指标卡堆叠 |
| 37 | `r390-dark-zh__admin_overview.png` | 390 暗色 × 中文 |
| 38 | `r390-light-zh__admin_jobs_1285fbe8-9bb8-459f-b073-af245d32b3ae.png` | §2.6 溢出（zh 175px） |
| 39 | `login-390.png` | §3-20 |

### 4.2 未入库（本地保留，约 66 张 + 12 份度量 JSON）

未入库的是**同一批矩阵的其余组合**，全部在 `artifacts/ui/visual-v3/audit/` 但**不提交**：

- `r1440-light-en__403.png`、`r1440-light-en__app_investigations.png`、`..._app_reports.png`、`..._app_observability.png`、`..._app_resources.png`、`..._app_sources.png`
- `r1440-light-zh__403.png`、`..._admin_access.png`、`..._admin_activity.png`、`..._admin_instances_*.png`、`..._admin_jobs_*.png`、`..._admin_nodes.png`、`..._admin_nodes_*.png`、`..._admin_nope.png`、`..._admin_ops-center.png`、`..._admin_pipelines.png`、`..._admin_pipelines_*.png`、`..._admin_plugins.png`、`..._admin_plugins_dev.*.png`、`..._admin_plugins_install.png`、`..._admin_settings.png`、`..._app_incidents.png`、`..._app_investigations.png`、`..._app_reports.png`
- `r1440-dark-en__admin_nodes.png`、`..._admin_pipelines.png`、`..._admin_plugins.png`、`..._admin_pipelines_*_editor.png`
- `r1440-dark-zh__admin_jobs.png`、`..._admin_jobs_*.png`、`..._admin_nodes.png`、`..._admin_nodes_*.png`、`..._admin_plugins.png`、`..._admin_plugins_dev.*.png`、`..._admin_plugins_install.png`、`..._admin_settings_diagnostics.png`
- `r1024-light-en__admin_jobs.png`、`..._admin_jobs_*.png`、`..._admin_nodes_*.png`、`r1024-light-zh__admin_overview.png`
- `r390-light-en__admin_access.png`、`..._admin_activity.png`、`..._admin_governance.png`、`..._admin_instances_*.png`、`..._admin_jobs.png`、`..._admin_nodes_*.png`、`..._admin_ops-center.png`、`..._admin_pipelines.png`、`..._admin_pipelines_*.png`、`..._admin_plugins.png`、`..._admin_plugins_*.png`、`..._admin_settings_diagnostics.png`
- `r390-dark-en__admin_overview.png`、`r390-dark-zh__admin_jobs.png`、`..._admin_jobs_*.png`
- `r390-light-zh__admin_overview.png`、`..._admin_jobs.png`
- 度量 JSON：`_metrics_{login,r1024-*,r1440-*,r390-*}.json` 共 12 份（**建议入库**：它们是本报告所有数字的可复算来源，体积 < 2MB）

> 仓库当前已有 **934 张**被跟踪 PNG；本轮新增 **39 张**（+4.2%），未越过 40 张上限。

---

## 5. 未验证项与风险（我注意到但没有处理的）

### 5.1 本轮未验证（明确标注，不做推断）

| 项 | 原因 | 影响 |
|---|---|---|
| 1440 Light/zh 下的暗色 390 覆盖 | 12 组矩阵中 1024 与 390 只对部分页面截图（度量全覆盖） | "暗色 × 中文 × 窄屏"三重叠的排版未逐像素确认 |
| `/login` 的中英文对比 | 登录页必须在无 cookie 的隔离 context 采集，只采到 390×1 种 | 登录页 zh 的行高/换行未验证 |
| `/403` 页视觉 | 只在 1440 采到，未纳入逐像素审阅 | 该页无 shell，`.forbidden-page` 规则（L1263–1276）未评审 |
| 键盘可达性的完整 Tab 序 | 本轮只核查了 `data-testid`/`tabIndex`/`focus-visible` 是否存在，未跑完整 Tab 遍历 | "键盘可用"只有代码证据，没有端到端证据 |
| 对比度比值 | 未计算 WCAG 对比度数值 | "色彩与对比"评分基于视觉判断，不是测量 |

### 5.2 我发现但本轮没有修的问题（按 §2 顺序已全部写进"最该先改"或"第 11–16 项"）

1. `.value-token--no-data` 在 CSS 中不存在（`status-indicator.tsx:167` 拼出的类名无对应规则）→ NO_DATA 与 UNKNOWN 只差 dotted/dashed。
2. `status-indicator--degraded` ≡ `--attention`、`--noData` ≡ `--notConfigured` ≡ `--loading`（像素级相同）。
3. `.main-content:has(.studio-page)` 把 Studio 的内边距清零（L786），使 Studio 成为唯一没有页面留白的页面。
4. `Activity` 25,158px 无分页；`Diagnostics` 审计列表 20 行无分页。
5. `/app/*` 侧栏复用 Admin 的版本徽标（Environment/Commit/Deployed At）。
6. `kpi-grid` 等 10 条死规则仍活在 4 个媒体查询里（删规则会连带删查询）。
7. E2E 依赖可见文案（`visual-layout.spec.ts:11`），违反 rules/06。
8. `tailwind.config.cjs` 的 `fontSize` 映射只有 5 档，而 `styles.css` 用了 19 个字号值——即使全站改用 Tailwind 类也无法覆盖现有排版。

### 5.3 我认为**做得好、不应在后续重构中被破坏**的部分

1. `AsyncBoundary` 的 5 态分离（loading / forbidden / conflict / error / empty），403 面板不泄漏资源细节。
2. `StatusIndicator` 的"颜色 + 字形 + 文字"三重编码（`status-indicator.tsx:1-14` 的注释写明了这条约束）。
3. `MetricCard` "无数据时打印 NO_DATA/UNKNOWN 而不是 0"（`metric-card.tsx:41-51`）。
4. `PageHeader` 用 API 而不是评审来保证"每页一个主 CTA"（`page-header.tsx:4-11`）。
5. 表格在 760px 转卡片时保留 `data-label`，并修过"标签被挤成'任/务'"的问题（`table-kit.tsx:33-36` 的注释）。
6. 暗色是纯令牌替换，布局零位移（实测 26 个路由的 dark/light 高度完全相同）。

---

## 6. 复算方式

```bash
# 全部度量（12 份 JSON，含每页字号直方图、行高比、卡片嵌套、scrollWidth、裁切清单）
ls artifacts/ui/visual-v3/audit/_metrics_*.json

# CSS 重复选择器 / 属性覆写（§2.1.2 / §2.1.3）
node /tmp/css5.mjs apps/platform-web/src/styles.css

# 字号分布（§2.2.1）
grep -oE 'font-size: *[^;]+' apps/platform-web/src/styles.css | sort | uniq -c | sort -rn

# 390 溢出（§2.6）
node -e 'const j=require("./artifacts/ui/visual-v3/audit/_metrics_r390-light-en.json");for(const[r,p]of Object.entries(j.pages))if(p.overflow>-15)console.log(r,p.docScrollW,p.docClientW)'
```

审计结束。本报告未修改任何产品代码、CSS 或测试。
