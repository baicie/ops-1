# P001：CI Gate 与测试基础设施治理

| 项 | 值 |
|---|---|
| 检查器 | `tests/ci/check-spec-coverage.mjs`（扩展） |
| 新增接线 | P0 所有权套件、响应体边界测试 |
| 修复的静默失败 | 1 处（`docker ps` 不可达被当成「没有容器」） |

## 1. 扩展后的覆盖映射

检查器原本只看 `tests/ui/*.spec.ts`。本阶段把它扩到 **`tests/acceptance/*.sh` 与
`tests/ci/*.sh`**，于是同一个问题第一次能对 shell 测试提出：

> 这个文件存在、被 commit、被 PR 描述引用——**但有哪个 workflow 会执行它？**

结果（修复后）：

```
spec coverage:  41 covered, 23 explicit-skip,  0 unreferenced
shell coverage: 58 covered, 20 explicit-skip,  0 unreferenced
```

### 1.1 它当场抓到的第一件事

```
FAIL tests/ci/p001_execstoppost_ownership.sh   NOT_REFERENCED
```

那是 **P0 容器所有权修复的回归套件（34 项断言）**，随 PR #98 合入，
**没有任何 workflow 运行过它**。PR 描述里的「34/34 PASS」是本地运行；
在 CI 里它从未存在。

已接入 `platform-linux-acceptance.yml`。**一个没人运行的回归测试是一段注释。**

### 1.2 20 个 EXPLICIT_SKIP 的分类

每一条都打开读过，分三组：

| 组 | 数量 | 说明 |
|---|---|---|
| A | 9 | 需要自己启动并 teardown 完整平台。`plugin-lifecycle.yml` 已经跑 ~20 分钟的 TS 生命周期，再加 8 次整平台启动会超时 |
| B | 7 | 需要专用 Docker daemon（会破坏本机 demo 状态，或主动植入外部容器攻击自己的 harness） |
| C | 4 | 需要数据库或 live 平台，但不需要 Docker |

**这些不是「不需要跑」，而是「当前没有 job 能给它们环境」。** 列表的用途是让缺口
可见，而不是让它消失。

## 2. 修复的静默失败（7.3 的一条）

`tests/ci/p001c13_lifecycle.sh:129`：

```sh
OURS_BEFORE="$(docker ps -aq --filter "label=opsweave.managed=true" 2>/dev/null | wc -l | tr -d ' ')"
```

daemon 不可达 ⇒ 空输出 ⇒ `wc -l` 得 **0** ⇒ 「daemon 上没有既有容器」⇒ 通过前置
检查。而紧接着的下一步（`:245` 的 `docker ps -a --no-trunc`）在同样情况下会
`fatal`——**两处对同一事实给出相反结论，且较弱的那一处先执行**。

实测对照：

```
旧写法: OURS_BEFORE='0'   → 判为「干净」，继续运行
新写法: exit=1, "BLOCKED: the Docker daemon is not reachable"
```

## 3. 收集期风险（7.2）

9 个 spec 在**模块作用域**读 fixture。文件不存在时 Playwright 的收集阶段抛错：

```
$ pnpm --filter @opsweave/ui-tests exec playwright test --list
Error: ENOENT: no such file or directory, open '/tmp/g12d/seed.json'
Total: 0 tests in 0 files      <- exit 1
```

**一个 spec 都收集不到。** 任何依赖「收集整个目录」的 job 会看到一个空套件，
而空套件不是通过的套件。

检查器现在检测**顶层语句**里的无守卫 `readFileSync`（import 行与函数体内的读取
不算）：

```
collection risk: 5 spec(s) … so a bare `playwright test` collects nothing:
  g12d-probe.spec.ts:16      const SEED = JSON.parse(fs.readFileSync('/tmp/g12d/seed.json', …
  g12r2-compare.spec.ts:17   …
  g12r2-matrix.spec.ts:26    …
  g12r2-races.spec.ts:20     …
  g12r2-states.spec.ts:26    …
```

这 5 个都已在 EXPLICIT_SKIP 里（手工运行），所以**报告但不重复阻断**。
修它们（把读取移进 `beforeAll`）是独立任务，不在本阶段。

## 4. 反事实（7.4）

| # | 注入 | 结果 |
|---|---|---|
| 1 | 删掉 `p001_execstoppost_ownership.sh` 的 workflow 调用 | **`NOT_REFERENCED` + exit 1** |
| 2 | Docker daemon 不可达 | **exit 1**，明说 daemon 不可达（旧写法判为「干净」） |

| # | 注入 | 状态 |
|---|---|---|
| 3 | PostgreSQL 不可达 | 由阶段 1 的 `q()` 覆盖（`ON_ERROR_STOP` + exit 2） |
| 4 | JSON 解析失败不变 PASS | 由各脚本的显式解析错误覆盖（阶段 1/3） |
| 5 | 清理失败不变完成 | 由各 trap 的 PASS/FAIL 双报覆盖（C1.3） |
| 6 | 某语言全 NOT_RUN 时 conformance 失败 | 由阶段 3 的五态判决覆盖 |
| 7 | Browser spec 未运行不能宣称 C4 | 由阶段 4 的 BLOCKED 覆盖 |

3–7 不在本阶段重复实现，因为它们已在对应阶段有独立的可执行证据。

## 5. 本阶段有意不做

- **不删任何 `|| true`**。`tests/` 下有 198 处，逐条分类需要知道每一处的意图；
  机械删除会破坏真正的容错（清理、超时探测、可选字段）。本阶段只修**已证明
  会改变判决**的那一处。
- **不改那 9 个 spec 的模块作用域读取**。那是 5 个具体文件的改动，属独立任务。
- **不把 20 个 EXPLICIT_SKIP 全部接线**。多数需要专用 daemon 或完整平台，
  为它们新建 job 是 CI 架构变更。
