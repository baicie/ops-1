# 视觉资产分类（TASK-04）

测量日期：2026-11-21　基线 main：`25f3104`

工具：`node scripts/ci/classify-visual-assets.mjs`

---

## 0. 一个先决结论：这里没有像素基线

`tests/ui/g14-css-fix-evidence.spec.ts:12` 写得很明确：

> Both are asserted from the COMPUTED style rather than from a screenshot diff,
> because this repository has **no pixel baseline (0 `toHaveScreenshot`)**. The
> screenshots are the human-reviewable half; the assertions are the part that
> fails a build.

所以 TASK-04 预设的「A. 正式视觉回归基线」**在这个仓库里不存在**。410 张 PNG
没有一张被拿来和当前渲染做比较。它们全部是**证据**：某个时刻、某个版本的控制台长什么样。

这个区别决定了后续每一个动作。**没有任何一张图被删掉会让测试变红**——所以
「测试还是绿的」不能作为删除安全的证明。

分类工具的第一版把「被 spec 提到的 PNG」标成基线，实测后改为更准确的名字：
spec 是**写**这些文件的（`page.screenshot({ path })`），不是拿它们比对的。

---

## 1. 实测分类

| 类 | 含义 | 文件数 | 体积 |
|---|---|---:|---:|
| **A** emitted-by-test | spec / checker 会写这个路径 | 82 | 11.73 MB |
| **B** cited-by-doc | 文档链接它作为证据 | 83 | 19.23 MB |
| **C** orphan | 既不写也不引 | **245** | **35.22 MB** |
| | | **410** | **66.18 MB** |

C 类占 45% 的体积。**但 C 不等于可删**，见 §3。

按目录（按体积排序）：

| 目录 | A | B | C | 合计 | MB |
|---|---:|---:|---:|---:|---:|
| `artifacts/ui/visual-v3/audit` | 0 | 60 | 0 | 60 | 15.91 |
| `artifacts/ui/visual-v3/table/before` | 0 | 0 | 20 | 20 | 5.60 |
| `artifacts/ui/visual-v3/flagship/after` | 0 | 0 | 36 | 36 | 5.05 |
| `artifacts/ui/g07-business-shell` | 0 | 0 | 25 | 25 | 4.53 |
| `artifacts/ui/visual-v3/table/after` | 0 | 0 | 25 | 25 | 4.51 |
| `artifacts/ui/g03-admin-pages` | 0 | 0 | 36 | 36 | 3.29 |
| `artifacts/ui/visual-v3/flagship/before` | 0 | 0 | 36 | 36 | 2.94 |
| `artifacts/ui/incidents-workspace` | 6 | 0 | 12 | 18 | 2.84 |
| `artifacts/ui` | 7 | 11 | 0 | 18 | 2.77 |
| `artifacts/ui/studio` | 16 | 2 | 0 | 18 | 2.48 |

---

## 2. C 类里，哪些其实是「不可再生」的

`before` / `after` 成对目录合计 **135 个文件 / 20.68 MB**（实测，不是估算），全部落在 C 类：

```text
visual-v3/flagship/before   36
visual-v3/flagship/after    36
visual-v3/table/before      20
visual-v3/table/after       25
visual-v3/token-layer/before 6
visual-v3/token-layer/after  6
visual-v3/b3b4/before        3
visual-v3/b3b4/after         3
```

**`before` 截图在任何意义上都无法重新生成**——它记录的是修改之前那个控制台的
样子，而那个控制台已经不存在了。删掉它，就无法再证明「改之前确实是这样」。

这正是 TASK-04 的 E 类（重复 Before/After）需要小心的原因：它们看起来像重复，
实际是唯一的历史证据。**本报告不建议删除任何一张 `before`。**

同理，`g03-admin-pages`(36)、`g07-business-shell`(25) 这类以阶段名命名的目录，
在 `docs/` 里**零引用**——我用 `grep -rn "g03-admin-pages\|g07-business-shell" docs/`
验证过，只匹配到本文件自己的表格。它们的来源是某个阶段性 gate 的输出，
那次的验收结论有没有写进 `docs/acceptance/`、写的是不是别的路径，**本轮没有查证**。

在没有查清之前，这 61 个文件既不能证明可删，也不能证明该留。它们属于
TASK-04 的 NEEDS_REVIEW，而不是删除候选。

---

## 3. 为什么不直接删 C 类

三个理由，每一个都足以单独否决：

1. **测试不会因此变红。** 上文的「0 toHaveScreenshot」意味着删除任何一张图
   都不影响任何断言。绿灯不是安全证明，它只是没被检查。
2. **`before` 不可再生。** 见 §2。
3. **仓库没有删除视觉证据的先例可循。** `tracked-png-budget.json` 的 `$comment`
   记录了四次下调上限的历史，每次都是「只降不升」，且都列出了每一项的去向
   （哪次提交引入、被谁取代、为什么不再被引用）。**这份清单是删除的前置条件，
   不是删除的替代品。**

所以本轮**不删任何文件**。本 PR 交付的是**分类本身**——这是此前不存在的东西：
预算清单只管总数，不管一张图为什么在那里。

---

## 4. 建议的后续动作（需授权）

若要把 245 个 C 类里的某一部分真正移除，需要先完成：

1. 对 `artifacts/ui/visual-v3/` 的每个目录，确认对应阶段的验收文档是否已完成、
   是否仍在 `docs/acceptance/` 中被引用；
2. 对 `before`/`after` 对，确认对应的变更记录（PR/ADR）是否已经有文字结论——
   有文字结论的，截图才是冗余的；
3. 逐条写入 `tracked-png-budget.json` 的 `$comment`，格式沿用既有四次的做法；
4. 同步下调 `totals.maxFiles` 与 `maxBytes`（预算只降不升）；
5. 用 `check-tracked-png-budget.mjs` 验证文档引用仍然全部解析。

**这是一项需要人工逐目录判断的工作，不是一次 `git rm`。**

---

## 5. 本 PR 没有做的事

- 没有移动任何 PNG。`git mv` 不减少任何字节，而移动 410 张图会同时动到
  `tracked-png-budget.json` 的每一个目录键、文档链接、spec 的输出路径。
  收益（目录更整齐）与风险（三处同时失效）不成比例。
- 没有改 `.gitignore`。见 PR 内说明：现有预算机制已经在防止新增临时截图，
  而 TASK-11 要求的「更明确的生成目录约定」需要先确认 D 类（临时产物）真的
  进不了索引。
- 没有启用任何 `toHaveScreenshot`。给这个仓库引入像素基线是产品决策，
  不是治理任务，且会让全部 410 张图立刻需要重新生成。

---

## 复现

```bash
node scripts/ci/classify-visual-assets.mjs          # 按目录聚合
node scripts/ci/classify-visual-assets.mjs --json   # 逐文件
```
