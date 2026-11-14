# P001-C1.4 方案审查（定稿）：Node 状态目录单实例锁

**状态：审查定稿。未实现任何功能，未修改任何代码。**

| 项 | 值 |
|---|---|
| 文档性质 | 方案审查定稿 |
| 写作时基线 | 分支 `feat/p001-c13-lifecycle` @ `d1f4da0`，`origin/main` @ `d94f989` |
| **当前 `origin/main`** | **`89113ade63f286707781acc4a053bec1ab513f78`** |
| PR #96 | **`merged=true`，`merged_at=2026-11-14T04:51:16Z`**（REST API 核实） |
| 合入方式 | squash；树 `39ed7bc` 与分支 tip 完全一致 |
| 本轮改动 | 仅本文件 |

> 判断 PR 是否合入必须看 REST 的 `merged` 字段或 `git merge-base --is-ancestor`。
> `gh pr view --json mergeCommit` 对未合并 PR 返回的是 test-merge 引用，
> 不是合入记录。**不要用 `git branch -d` 的「not fully merged」判断**——本仓库只
> 允许 squash 合入，分支 tip 永远不是 main 的祖先，`-d` 必然拒绝。判定依据是
> 逐文件 blob 比对 + PR 的 `merged=true`。

本文档区分四类内容，全文一致：

- **【事实】** 已在当前代码上核实，附行号。
- **【决策】** 已确认的架构决定。
- **【要求】** 未来实现阶段必须满足，尚未实现。
- **【风险】** 已知且**未**被本轮设计消除的问题。

---

## 1. 问题

### 1.1 ADR-023 §2.2b 把这件事明确划在范围外

【事实】`docs/adr/ADR-023-installation-identity-binding.md` §2.2b 现文：

> Even with separate node ids, two nodes can be misconfigured onto one state
> directory. That is a different failure and **is not solved here**: it is the
> "concurrent processes sharing one directory" case §2.2 leaves out of scope.

本轮的设计目标就是把这条边界移进范围内。

### 1.2 两个进程同用一个目录会发生什么

它们读到同一个 `installation-id` 与同一个 `node-identity.json`（nodeId、
credential、dataToken、generation 全同）：

| 竞争面 | 后果 |
|---|---|
| 心跳 | 两个进程写同一 `kernel.nodes` 行，`generation` / `last_seen_at` / `data_endpoint` 互相覆盖 |
| desired workloads | 收到同一份列表，各自创建实例，同一 `instance_id` 可能被建两次 |
| 容器所有权 | installation-id 相同 → 双方都认为对方的容器是自己的，**C1.2 建立的隔离在此失效** |
| quarantine | 一个进程判定失联并清理，另一个仍在运行 |

【事实】这个后果已在 C1.2.2 实测过（`docs/acceptance/p001/03h-lifecycle-correctness.md` §4f：
克隆节点重写原节点的 `data_endpoint`）。

---

## 2. 启动序列与副作用边界

【事实】当前 `apps/node/src/main.rs` 的启动顺序（行号为当前代码）：

| 行 | 动作 | 副作用 |
|---|---|---|
| 21 | `dotenvy::dotenv()` | 读：加载 `.env` |
| 22 | `init_tracing()` | 写：初始化日志输出（不触及状态目录） |
| 23 | `Args::parse()` | 读 |
| **24** | **`create_dir_all(&args.state_dir)`** | **写：创建目录** |
| 25–29 | `reqwest::Client::builder()` | 无（仅构造，不发请求） |
| 30 | `DockerAdapter::new(...)` | 无（仅构造） |
| 31–34 | `docker.version()` | **Docker 只读探测**（不创建/停止/删除容器） |
| **42** | **`load_or_create_installation_id(&args)`** | **写：可能 mint `installation-id`、写 binding、写/删迁移标记、删身份文件** |
| 44 | `with_installation_id(...)` | 无（仅构造） |
| 55–61 | `set_aside_node_identity` | 写：移走 `node-identity.json`（仅 `discard_node_identity` 时） |
| 62 | `runtime::enroll(...)` | **网络**：兑换 enrolment token；写 `node-identity.json` |
| 70 | `commit_migration` | 写：删标记（仅 `discard_node_identity` 时） |
| 之后 | 心跳、reconcile、容器创建 | Docker 写 + 网络 |

### 2.1 锁的唯一插入位置【决策】

```text
读取 CLI / 环境配置 / tracing           (main.rs:21-23)
        |
        v
创建 state_dir（create_dir_all）          (main.rs:24)
        |
        v
[锁] 获取 state directory 独占锁          <-- 唯一允许的插入点
        |
        v
构造 reqwest client / DockerAdapter       (main.rs:25-30)
        |
        v
Docker version 探测                       (main.rs:31-34)
        |
        v
读取或创建 installation-id                (main.rs:42)
        |
        v
reinitialize 时移走继承的 Kernel 身份      (main.rs:55-61)
        |
        v
Kernel Enrollment（写新身份 / 提交迁移）   (main.rs:62-70)
        |
        v
Node supervision
```

**这条顺序是硬约束，不是建议。** 具体要求：

| # | 要求 |
|---|---|
| 1 | `create_dir_all`（`:24`）是**唯一**允许在取得锁之前执行的状态目录操作 |
| 2 | `reqwest::Client::builder()`（`:25-29`）与 `DockerAdapter::new()`（`:30`）在锁之前**允许**执行——它们只构造对象，不读写状态目录、不连 Docker、不发请求 |
| 3 | 锁获取失败时**不得**访问 Docker（含只读的 `version()`） |
| 4 | 不得访问 Kernel |
| 5 | 不得读取、创建、删除或迁移任何身份文件 |
| 6 | 不得启动任何后台任务 |
| 7 | 不得创建、停止或删除容器 |
| 8 | 锁必须覆盖整个进程生命周期 |

> 这一条与上一版审查不同。上一版建议把锁放在 `docker.version()` **之后**，理由是
> 「只读探测不改变状态，且能让运维同时看到 Docker 是否可用」。**该建议已废弃**：
> 本轮决策要求失败路径的副作用面为零，只读探测也算访问。目录被占用时，
> 运维应先解决占用问题，Docker 状态在解决后自然会暴露。

### 2.2 持锁的写法【要求】

```rust
// 正确：具名变量，绑定到 main 的作用域
let _state_lock = runtime::lock_state_dir(&args)?;

// 错误：锁对象在语句结束时立即析构，互斥从未生效
runtime::lock_state_dir(&args)?;

// 错误：显式丢弃
let _ = runtime::lock_state_dir(&args)?;
```

这三种写法**在代码审查中几乎无法区分**，必须由并发测试挡住（§6.2 反事实 3）。

---

## 3. 五项决策

### 决策 1：非 Unix 平台严格拒绝

【决策】第一版采用强制锁策略，**不允许静默降级**。

#### 平台支持矩阵

| 平台 | 策略 | 依据 |
|---|---|---|
| **Linux** | 支持，`flock(2)` | 经 Linux CI 真实验证后才可声明支持 |
| **macOS** | 支持，`flock(2)` | `flock` 在 Darwin 上可用并已验证 |
| 其他 Unix（FreeBSD、OpenBSD、Solaris…） | **暂不纳入支持范围** | 未验证；不得仅凭 `cfg(unix)` 推断语义一致 |
| Windows | **明确拒绝启动** | 无 `flock`；不提供等价实现 |

【要求】实现时必须使用**明确的平台条件编译**，而不是 `#[cfg(unix)]`：

```rust
#[cfg(any(target_os = "linux", target_os = "macos"))]
// 实现：libc::flock

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
// 直接返回 NODE_STATE_LOCK_UNSUPPORTED，拒绝启动
```

理由：`cfg(unix)` 会把 FreeBSD、Solaris、illumos 等一并纳入「支持」，而它们的
`flock` 语义**没有在本仓库验证过**。用白名单而不是黑名单。

#### 稳定错误语义

| 错误码 | 含义 | 触发条件 |
|---|---|---|
| `NODE_STATE_LOCK_UNSUPPORTED` | 当前平台不支持锁机制 | 编译期白名单之外的目标 |
| `NODE_STATE_LOCK_FAILED` | 锁文件打开或锁操作本身出错 | `open` 失败、`flock` 返回非 `EWOULDBLOCK` 的 errno（如 `ENOLCK`、`EBADF`） |
| `NODE_STATE_DIR_IN_USE` | 状态目录已被其他 Node 进程持有 | `flock` 返回 `EWOULDBLOCK` |

【要求】这三个错误码必须**互不覆盖**。特别是：

- `EWOULDBLOCK` → `NODE_STATE_DIR_IN_USE`，不是 `NODE_STATE_LOCK_FAILED`。
- `EINTR` → 重试或 `NODE_STATE_LOCK_FAILED`，**不得**当作「已被占用」；把信号打断
  报成占用会让一次重启风暴伪装成配置错误。
- `ENOLCK`（文件系统不支持锁）→ `NODE_STATE_LOCK_FAILED`，**不得**降级为继续运行。

【要求】**不得**将任何锁失败转换为警告后继续运行。

#### 与 `directory_identity` 降级行为的区别

【事实】`apps/node/src/runtime.rs:503-513` 的 `directory_identity` 在非 Unix 上：

```rust
#[cfg(not(unix))]
fn directory_identity(dir: &Path) -> anyhow::Result<(u64, u64)> {
    tracing::warn!("… cannot detect a copied state directory …");
    Ok((0, 0))          // 继续运行
}
```

【决策】同一个 ADR 内对同一类平台问题采用两种强度，是**有意的**：

| | `directory_identity` | `state_dir` 单实例锁 |
|---|---|---|
| 性质 | 既有的**兼容性检测** | 新增的**强制运行前置条件** |
| 降级后果 | 无法检测克隆（ADR-023 §2.3 已记录为残余风险） | 两个进程同时污染 Kernel 状态与容器所有权 |
| 影响面 | 一个检测点失效 | 心跳、实例管理、容器所有权同时失效 |
| 策略 | 警告后继续 | **拒绝启动** |

必须把这段对比写入未来的 ADR 修订，避免后人把两处不一致当作疏漏「统一」掉。

### 决策 2：锁必须先于 Docker 探测

见 §2.1。要点：

- `create_dir_all` 是取得锁之前唯一允许的状态目录操作，因为锁文件本身在那个目录里。
- 锁失败时对 Docker、Kernel、身份文件、后台任务、容器的操作数**全部为零**。
- 锁的持有范围覆盖整个进程生命周期。

### 决策 3：运行期间禁止替换状态目录

【事实】**`flock` 锁住的是 inode，不是路径字符串。** 这一点决定了下列失效场景：

```text
1. 进程 A 打开 state_dir/.node.lock 并 flock        -> 锁在 inode#1
2. 外部进程 rm -rf state_dir
3. 外部进程重新 mkdir state_dir
4. 进程 B 打开新的 state_dir/.node.lock 并 flock    -> 锁在 inode#2，成功
5. A 与 B 同时运行，各自认为独占
```

【决策】第一版**不实现**目录 inode 的持续监控。但这必须成为明确的运维契约，
而不是被沉默地忽略：

| # | 运维契约 |
|---|---|
| 1 | Node 运行期间**禁止**删除、移动或替换 `state_dir` |
| 2 | 状态目录的迁移、恢复、替换**必须先停止 Node** |
| 3 | Node 服务账号**不得**具有随意删除、重建其状态目录的权限 |
| 4 | 锁文件永久保留；正常退出时**不得** `unlink` |
| 5 | 不得使用 PID 文件替代 `flock` |

关于第 4 条的【事实】：若退出时 `unlink` 锁文件，下一个进程会创建**新 inode** 并在其上
加锁，而仍持有旧 inode 锁的进程不受影响——这正是本节开头那个失效场景的另一种触发方式。
`flock` 的锁在进程终止时由内核释放，**不需要**任何用户态清理。

#### 设计阻断条件【要求】

**如果现有部署模型无法保证状态目录在 Node 运行期间稳定，则不能直接进入编码**，
必须先重新设计父目录级别的锁定机制。

具体需要在编码前核实：

- systemd unit / Docker 编排是否会在重启时重建 `state_dir`（而非复用）；
- 是否有备份、恢复或迁移工具会移动该目录；
- 服务账号对该目录父级的写权限范围。

【风险】这条**未被本轮设计消除**。本轮的锁无法阻止「目录被整体替换」，只能通过
运维契约约束。不得把该风险描述成「已由 `flock` 解决」。

### 决策 4：旧版本 Node 不受新锁保护

【事实】`flock` 是**协作式（advisory）**文件锁。它只约束**主动请求锁**的进程。

【决策】必须明确：

| # | 说明 |
|---|---|
| 1 | 新锁只能保证**遵守该协议**的进程之间互斥 |
| 2 | **不能**声称可以阻止旧版本 Node 进程 |
| 3 | 升级时**必须先停止旧 Node**，再启动新版本 |
| 4 | 不得在新旧版本同时运行的情况下宣称具备完整单实例保护 |

【要求】此项必须纳入**升级验收**与**运维说明**，不能只写在 ADR 里。

【风险】升级窗口内没有保护。这是协作式锁的固有边界，不是实现缺陷。

### 决策 5：第一版只支持经过验证的本地文件系统

【决策】保证范围：

| 文件系统 | 状态 |
|---|---|
| Linux 本地文件系统 | **保证**（需 Linux CI 真实验证） |
| macOS 本地文件系统 | **保证**（需本机真实验证） |
| NFS | **不保证** |
| SMB / CIFS | **不保证** |
| 其他网络文件系统 | **不保证** |
| 未验证锁语义的特殊挂载、共享存储 | **不保证** |

【要求】必须注明：**文件系统提供普通文件读写能力，不能推断 `flock` 在该文件系统上具有
正确的跨进程或跨主机互斥语义。** NFS 上的 `flock` 行为随服务端实现与挂载参数变化，
本仓库未做任何验证。

【要求】未来如需支持网络文件系统，必须单独完成真实并发测试，不得以「本地通过」推断。

---

## 4. 锁契约摘要（供未来 ADR 使用）

| 项 | 值 |
|---|---|
| 机制 | `flock(2)`，`LOCK_EX \| LOCK_NB` |
| 依赖 | `libc`（**已在** `apps/node/Cargo.toml:24`，且 `worker_supervisor.rs:18` 已在用 `libc::kill`），**零新增依赖** |
| 锁文件位置 | `<state_dir>/.node.lock` |
| 文件权限 | `0600`，与身份文件一致 |
| 取得时机 | `create_dir_all` 之后、`docker.version()` 之前 |
| 持有范围 | 整个进程生命周期 |
| 释放 | 内核在进程终止时释放（含 `SIGKILL`）；**无用户态清理** |
| 拒绝语义 | `LOCK_NB` → 立即 `EWOULDBLOCK`，不阻塞、不重试 |
| 锁文件生命周期 | 永久保留；正常退出不 `unlink` |
| 归属判定 | 内核 fd 表，**不读文件内容**，不用 PID |

### 4.1 为什么不选 `fcntl` 记录锁

【事实/决策】`fcntl` POSIX 记录锁有一个与 Node 运行方式冲突的语义：
**关闭同一文件的任意文件描述符会释放该进程持有的锁**。Node 内部任何一处
`File::open(<state_dir>/.node.lock)`（日志、诊断、未来的备份代码）都会意外解锁，
而且不会报错。`flock` 的锁绑定在打开的文件描述上，没有这个问题。

---

## 5. ADR-023 的更新方案（本轮不执行）

【要求】**本轮不修改 ADR-023。** 未来实现阶段通过独立修订，将 §2.2b 从 out-of-scope
改为 in-scope，并新增单实例锁契约，至少覆盖：

| # | 内容 |
|---|---|
| 1 | 锁机制（`flock`，协作式，inode 语义） |
| 2 | 锁文件位置与权限 |
| 3 | 生命周期（进程全程，内核释放） |
| 4 | 支持平台（Linux、macOS 白名单） |
| 5 | 不支持平台的行为（明确拒绝） |
| 6 | 目录替换风险（§3 决策 3）与运维契约 |
| 7 | 旧版本兼容性（协作式锁的边界，§3 决策 4） |
| 8 | 文件系统支持边界（§3 决策 5） |
| 9 | 错误码与运维处理（§3 决策 1） |
| 10 | 与 `directory_identity` 降级强度差异的说明（§3 决策 1） |

【要求】ADR 的实际修改留到编码阶段，与实现和测试契约一起提交——先改 ADR 再写代码，
但不要在只有设计时就把契约写成已落地。

---

## 6. 未来实现的验收要求（本轮不实现）

### 6.1 功能用例

全部使用**真实进程**（`std::process::Command` 启动真正的 `opsweave-node` 二进制）。
锁的语义在内核里，任何进程内模拟都不触及它。

| # | 用例 | 断言 |
|---|---|---|
| 1 | 同目录同时启动两个 | 一个成功，一个非零退出 |
| 2 | 第一个持锁期间第二个启动 | 第二个返回 **`NODE_STATE_DIR_IN_USE`**，且在 **2s** 内退出 |
| 3 | 第二个被拒后无副作用 | 不触发 Docker、不访问 Kernel、不写身份文件（见 §6.1.1） |
| 4 | 第一个正常退出后 | 第二个能获得锁 |
| 5 | 第一个 **`SIGKILL`** 后 | 第二个**立即**能获得锁 |
| 6 | 两个不同状态目录 | 并行运行，均成功（反向用例：锁按目录隔离） |
| 7 | 第二个被拒后 | 身份文件**内容与 inode** 均不变 |
| 8 | 第二个被拒后 | 无重复 Enrollment 或 Heartbeat |
| 9 | 第二个被拒后 | 不接管、不删除第一个进程的容器 |
| 10 | 克隆的状态目录 | 仍报 `INSTALLATION_IDENTITY_CONFLICT`（ADR-023），**不是**锁错误 |
| 11 | 旧版状态目录（无 binding） | 仍能启动（ADR-023 §2.3 路径不变） |
| 12 | 锁文件被删除 / 状态目录被替换 | 行为符合 §3 决策 3 的运维契约，且文档已说明 |

#### 6.1.1 用例 3 的判定方法

「无副作用」必须**可测量**，不能靠「看起来没发生」：

- Docker：比较运行前后 `docker ps -a` 的容器 ID 集合；
- Kernel：比较 `kernel.nodes` 行的 `generation` 与 `last_seen_at`；
- 身份文件：比较 `installation-id` / `installation-binding.json` /
  `node-identity.json` 三者的 sha256 **与 inode**（用例 7）。

只比较内容不比较 inode 会漏掉「文件被删除后以相同内容重建」。

### 6.2 反事实测试

每个反事实都必须通过**真实多进程测试**证明会破坏互斥保证，不得只写理论预期。

| # | 破坏方式 | 期望 |
|---|---|---|
| 1 | 删除 `flock` 调用（直接返回 `Ok`） | 「同目录同时启动两个」**必须失败** |
| 2 | 取得锁后立即 `LOCK_UN` | 同上，**必须失败** |
| 3 | 把具名变量改成立即析构的临时表达式 | 同上，**必须失败** |
| 4 | 进程退出时 `unlink` 锁文件 | 「`SIGKILL` 后接管」与「同时启动」中至少一个**必须暴露** |

【要求】反事实 4 需要专门构造才有稳定复现：一个进程退出并 `unlink` 后，另一个仍在运行的
进程持有的是旧 inode。测试必须让「退出」与「新进程启动」之间有一个确定的窗口。

### 6.3 本地 / CI 边界

| 环境 | 状态 |
|---|---|
| macOS 本机 | `flock` 可用，全部进程测试可跑 |
| Linux（GitHub Actions `linux-runtime`） | 必须真跑，不得以 macOS 通过代替 |

【要求】**不得**只凭 macOS 通过就声明 PASS。`flock` 在网络文件系统上的语义与本地盘不同，
而 CI 的 `/tmp` 是本地盘——这条限制必须写进 ADR 的残余风险。

---

## 7. 未解决的风险（本轮未消除）

| # | 风险 | 状态 |
|---|---|---|
| 1 | 运行期间状态目录被删除并重建 → 两个进程同时运行 | **未解决**。仅靠 §3 决策 3 的运维契约约束；是否需要在编码前改为父目录级锁，取决于 §3「设计阻断条件」的核实结果 |
| 2 | 旧版本 Node 不遵守锁 | **未解决**，协作式锁的固有边界（决策 4） |
| 3 | 网络文件系统上的 `flock` 语义 | **未验证**，明确排除在保证范围外（决策 5） |
| 4 | 非 Linux/macOS 的 Unix（FreeBSD 等） | **不支持**，白名单之外直接拒绝（决策 1） |
| 5 | 目录符号链接、挂载点替换 | **未解决**。Node 信任其 `--state-dir`，与信任 `installation-id` 同级；本轮不增加防护 |
| 6 | 锁文件权限被外部修改 | 仅靠 `0600` 创建时设置；运行期不复核 |

---

## 8. 进入编码的前置条件

1. ~~**PR #96 合入 `main`**~~ → **已满足**：`89113ad`，`merged=true`（2026-11-14T04:51:16Z）。
2. 重新 `git fetch`，以实际 `origin/main` 为基线，不沿用本文档记录的 SHA。
3. **核实 §3 决策 3 的「设计阻断条件」**：确认部署模型（systemd / Docker 编排）在
   Node 重启时复用而非重建 `state_dir`。若不能保证，需先重新设计父目录级锁定，
   不得直接编码。
4. 确认 §7 的风险 1 与风险 5 的处理方式：接受为文档化限制，还是在本阶段解决。
5. **在合并后的 `main` 上重新建立基线**：本文档的所有事实核对都是针对 `d1f4da0`
   完成的；`89113ad` 的树与它逐字节一致（`39ed7bc`），但契约性变更前仍必须重新
   核对行号，不得沿用。

满足后方可按顺序执行：**更新 ADR-023 → 实现 → 真实多进程测试 → 反事实 → 验收 → Draft PR**。

> **本轮仍然不进入编码。** 前置条件 1 的满足不构成开始实现的授权；
> 编码需要一个新指令。

---

## 附：本轮的事实核对记录

| 断言 | 核实方式 |
|---|---|
| `libc = "0.2"` 已在依赖中 | `grep -n '^libc' apps/node/Cargo.toml` → 第 24 行 |
| `libc` 已在代码中使用 | `grep -rn "libc::" apps/node/src/*.rs` → `worker_supervisor.rs:18` |
| 启动顺序与行号 | `grep -n` 于 `main.rs`，逐条核对 §2 表格 |
| 行号在合入后仍然有效 | 在 `main` @ `89113ad` 上重新 `awk` 打印 `main.rs:18-75` 与 `runtime.rs:494-516`，逐行核对，**不是沿用旧行号** |
| `init_tracing()` 在 `:22` | 上一条的打印结果；上一版 §2 表格漏列了它，已补 |
| `runtime.rs` 里有两个 `cfg(not(unix))` | `:411`（`sync_dir_of`，返回 `Ok(())`）与 `:503`（`directory_identity`，返回 `Ok((0,0))`）；本文引用的是后者，行号已从 `502-514` 更正为 `503-513` |
| `docker.version()` 是只读 | 读 `main.rs:31-34` 及其上下文注释 |
| `directory_identity` 非 Unix 降级 | 读 `runtime.rs:503-513`（`#[cfg(not(unix))]` 分支） |
| ADR-023 §2.2b 现文 | 读 `docs/adr/ADR-023-installation-identity-binding.md` |
| PR #96 未合并（写作时） | `gh api repos/baicie/ops-1/pulls/96 --jq .merged` → 当时 `false` |
| PR #96 已合入（2026-11-14） | `merged=true`，`merge_commit_sha=89113ad`；8 个改动文件逐个 blob 与 `origin/main` 一致；squash 树 `39ed7bc` 与分支 tip 相同 |

**本文档不声称已经实现任何锁功能。** 所有实现细节均为设计意图，需在编码阶段由真实
多进程测试验证。
