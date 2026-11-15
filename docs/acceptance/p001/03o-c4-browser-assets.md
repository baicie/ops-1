# P001-C4 / D4：插件前端资源的浏览器验收

| 项 | 值 |
|---|---|
| 基线 | `main` `89113ade63f286707781acc4a053bec1ab513f78` |
| Spec | `tests/ui/p001-c4-plugin-assets.spec.ts` |
| 接入 | `tests/ci/data_foundation_ci.sh`（浏览器段最后一步） |
| **本轮状态** | **NOT_RUN — 没有真实浏览器运行** |

## 1. 本轮实际完成的，与本轮没有完成的

| 项 | 状态 |
|---|---|
| 真实资源服务链路的代码审查 | **完成**（§2） |
| 浏览器验收 spec | **已写，未运行**（§3） |
| 在真实平台上跑一次 | **NOT_RUN**——本机没有可用的 Kernel，且 chromium 下载失败（`ECONNRESET`） |
| 资源保留策略的设计决策 | **未做**，见 §5 |

**不声称 C4 完成。** 简报允许「资源策略尚未确定时仅交付复现证据与设计审查」，
本轮就是这种情况。

## 2. 代码审查：资源服务的真实链路

`apps/kernel/src/assets.rs` 的 `serve_asset`：

| 检查 | 存在 | 说明 |
|---|---|---|
| 路径必须以 `frontend/` 开头 | 是 | `:13` |
| 拒绝 `..`、`\`、前导 `/` | 是 | `:13-16` |
| publisher 与 package 记录一致 | 是 | `:28-30` |
| 包未被 `REJECTED`、publisher 为 `TRUSTED` | 是 | `:21` |
| `canonicalize` 后仍在包根内（防符号链接逃逸） | 是 | `:39` |
| 响应头 `immutable, max-age=31536000` | 是 | `:57` |
| 响应头 `nosniff` | 是 | `:61` |
| **插件的启用 / 禁用 / 卸载状态** | **否** | 整个函数没有查询 lifecycle 状态 |

路由 `"/assets/{publisher}/{plugin_id}/{version}/{*path}"` 位于 `protected`
路由器（`routes.rs:156` 起），因此受 `auth_middleware` 保护——**会话是必需的，
但插件状态不是**。

### 这意味着什么

对于**已认证**的调用者，`serve_asset` 只关心「这个版本是否被一个受信任的
publisher 发布过、文件是否存在」。它不关心插件当前是 ACTIVE、DISABLED 还是
UNINSTALLED。

因此预期行为是：**卸载之后，资源的字节仍可被已认证调用者取到。**

这是**当前行为**，不是本文件认定的正确行为。它是否可接受是一个产品策略问题，
本轮不代为决定。

## 3. Spec 设计的核心：五个事实分开报告

「卸载后前端还能访问吗」不是一个布尔问题。这个 spec 把答案拆成五层，
每一层单独记录：

| # | 事实 | 观测方式 |
|---|---|---|
| 1 | 字节仍被服务？ | 已认证的 GET |
| 2 | **新**页面能加载？ | 新标签页 |
| 3 | **已加载**的页面还能执行？ | 原页面 |
| 4 | 它能获得授权？ | CSRF / 会话通路 |
| 5 | **后端 API** 还接受调用？ | 插件 API 自身的回答 |

「(1) 返回 200」与「(5) 返回 200」是两个完全不同的系统状态，而历史上一次绿色
勾选来自 (1)，就被读成「没问题」。

### 断言与记录的区别

| 断言（必须成立） | 记录（当前行为） |
|---|---|
| 未认证浏览器读不到插件资源（401/403），**任何插件状态下** | disable 后新页面取 index.html 的 HTTP 码 |
| 插件不是 ACTIVE 时 API 拒绝（503 `CAPABILITY_UNAVAILABLE`） | uninstall 后已认证取 index.html 的 HTTP 码 |
| 资源 URL 从 Kernel 读出的 publisher 构造，不猜测 | |

后两行写进 Playwright 的 annotation，不设为断言：**产品没有保留策略，
在测试里发明一个策略等于把决策伪装成断言。**

## 4. Spec 的可执行性验证（在没有平台的条件下）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit --strict` | **exit 0** |
| `npx playwright test --list` | **1 test in 1 file**，被发现 |
| 无平台时运行 | **exit 1（失败）**，不是 skip、不是 pass |

最后一条是刻意验证的：一个在没有产品时也能「通过」的浏览器测试是没有价值的。
它失败在 `browserType.launch`，因为本机的 chromium 版本与本仓库锁定的版本不匹配，
且下载被网络阻断——这本身也说明**它没有被静默跳过**。

## 5. 发现的一个既有缺陷（不属于本阶段范围）

`tests/ui/` 下有 **9 个 spec 在模块作用域读取 fixture 文件**，文件不存在时会让
Playwright 的整个收集阶段抛错，`Total: 0 tests in 0 files`：

```
g12d-probe.spec.ts        g11-viewer-write-entries.spec.ts
g12r2-states.spec.ts      g12r2-races.spec.ts
g12r2-compare.spec.ts     g12r2-matrix.spec.ts
overview-partial.spec.ts  observability-surface.spec.ts
v5-remediation.spec.ts
```

后果：**在这个目录里运行 `playwright test`（不带文件名）一个测试都收集不到**，
而退出码不一定是失败。这会影响任何依赖 `pnpm test` 的浏览器门禁。

本 PR **不修**它：修法有分歧（模块作用域改成 `test.beforeAll` / 加 `existsSync`
守卫 / 把 fixture 放进 `testIgnore` 的目录），且会改变那些 spec 的语义。
记录下来，作为独立的后续任务。D4 通过**显式文件名**接入，与仓库里其他浏览器
步骤的既有做法一致。

## 6. 需要的产品决策

| 问题 | 现状 |
|---|---|
| 卸载后是否应该继续提供旧版本静态资源？ | 代码选择「是」，且无保留窗口 |
| 保留多久？ | 无字段、无配置、无清理任务 |
| 未认证访问应当被拒绝吗？ | **是**，spec 已断言 |

这三条应当由一个 ADR 决定，再由测试固化。本轮只给出证据。

## 7. 依赖

- 不依赖任何未合并的 PR。
- D4 的真实运行需要：Data Foundation 平台 + 一个暴露 `frontend/index.html` 的插件。
  `dev.opsweave.hello` 是默认目标，可用 `OPSWEAVE_ASSET_PLUGIN` / `OPSWEAVE_ASSET_VERSION` 覆盖。
- 若产品日后决定卸载即删资源，这个 spec 的 annotation 会变成 404 而断言不变——
  它**不会**因此变绿，需要人来看。这是有意的。
