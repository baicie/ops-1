# P001-C1.4 实现落地记录：Node 状态目录单实例锁

| 项 | 值 |
|---|---|
| 设计输入 | `03j-single-instance-lock-review.md`（方案审查定稿，**原文未改动**） |
| 稳定性 Gate | `03k-state-dir-stability-gate.md`（CONDITIONAL PASS） |
| 实现 | `apps/node/src/state_lock.rs`，接入点 `apps/node/src/main.rs` |
| 契约 | ADR-023 §2.6 |
| 基线 | `main` `89113ade63f286707781acc4a053bec1ab513f78` |

本文档记录**实际实现了什么、验证了什么、没做到什么**。设计意图以 `03j` 为准，
部署前提以 `03k` 为准；本文与二者冲突时，冲突本身就是一个缺陷，应报告而不是自行择一。

---

## 1. 锁契约的最终形态

| 项 | 值 |
|---|---|
| 机制 | `flock(2)`，`LOCK_EX \| LOCK_NB`，advisory |
| 位置 | `<state_dir>/.node.lock`，`0600` |
| 取得时机 | `create_dir_all` 之后、`docker.version()` 之前 |
| 持有 | 整个进程生命周期，`let _state_lock = …` 具名绑定 |
| 释放 | 内核在进程终止时释放（含 `SIGKILL`）；**从不 `unlink`** |
| 平台 | Linux / macOS 白名单；其余 `NODE_STATE_LOCK_UNSUPPORTED` |
| 依赖 | `libc`（`apps/node/Cargo.toml:24` 已有），**零新增依赖** |

错误码：`NODE_STATE_DIR_IN_USE`（`EWOULDBLOCK`）、
`NODE_STATE_LOCK_UNSUPPORTED`（平台白名单外）、
`NODE_STATE_LOCK_FAILED`（其余 errno）。

`EINTR` **不**映射为占用：有界重试 8 次后报 `NODE_STATE_LOCK_FAILED`，
消息里带 `EINTR` 字样。把信号打断报成「已被占用」会让重启风暴伪装成配置错误。

---

## 2. 与 `03j` 的五项决策逐条对照

| 决策 | 落地情况 |
|---|---|
| **1. 非 Unix 严格拒绝** | 已实现。`#[cfg(any(target_os = "linux", target_os = "macos"))]` 白名单；其余返回 `Unsupported` 并拒绝启动。三个错误码在测试里断言互不相同 |
| **2. 锁先于 Docker 探测** | 已实现。`main.rs` 中锁在 `create_dir_all` 之后、`reqwest` client 与 `DockerAdapter` 构造之前。被拒进程的输出里**没有** Docker 错误 |
| **3. 运行期禁止替换目录** | 未实现监控（`03j` 要求第一版不实现）。已写入 ADR-023 §2.6 与运维契约 |
| **4. 旧版本不受保护** | 未实现也不可能实现（advisory）。已写入 ADR-023 §2.6 兼容性段 |
| **5. 仅本地文件系统** | 未实现检测。ADR-023 §2.6 明确排除 NFS/SMB |

---

## 3. 插入点

```text
Args::parse()                         main.rs:23
create_dir_all(&args.state_dir)       main.rs:24
[锁] lock_state_dir(&args.state_dir)  <-- 唯一插入点
reqwest client                        main.rs 紧随其后
DockerAdapter::new / version()
load_or_create_installation_id
```

被拒时下列操作数**全部为零**：Docker 调用、Kernel 请求、身份文件读写、
后台任务、容器操作。§5 给出实测。

---

## 4. 验证矩阵

### 4.1 真实多进程（`apps/node/tests/state_dir_lock.rs`）

全部启动**真实的 `opsweave-node` 二进制**。为了让第一个进程确实驻留，
测试起了一个「接受连接但永不响应」的 Kernel（`HangingKernel`）——用固定
`sleep` 的写法会让第二个进程撞上**已释放**的锁，测试会为了错误的原因通过。

| 用例 | 断言 |
|---|---|
| 同目录第二个进程 | 输出 `NODE_STATE_DIR_IN_USE` 且点名 `.node.lock`；**无** Docker 错误；**无**身份文件被读写 |
| 不同目录并行 | 两者都能拿到各自的锁并同时驻留 |
| `SIGKILL` 后接管 | 第三个进程越过锁、在 Docker 处失败；锁文件仍存在（未被 unlink） |
| 正常退出后接管 | 第二个进程不报 `DIR_IN_USE` |
| 锁文件权限 | `0600` |
| 克隆目录 | 仍报 `INSTALLATION_IDENTITY_CONFLICT`，**不是**锁错误 |

### 4.2 单元（`state_lock.rs`）

| 用例 | 断言 |
|---|---|
| 锁文件名 | `.node.lock`，不含路径分隔符（这样 `rm -rf dir/*` 不会删掉它） |
| 三个错误码 | 互不相同 |
| `EINTR` | 不映射为「占用」 |
| 同进程重复加锁 | 第二次仍失败（`flock` 按 open file description 计数） |
| 锁跟随 inode | `rm -rf` + `mkdir` 同路径⇒不同 inode，可再次加锁 |
| 运维文案 | 含稳定错误码与「先停掉正在运行的 Node」 |

### 4.3 反事实（每个都让真实进程测试变红）

| 破坏方式 | 结果 |
|---|---|
| 删除 `flock` 调用 | **3 个**真实进程用例失败 |
| 取得后立即 `LOCK_UN` | **3 个**失败 |
| 把具名绑定改成立即析构的临时表达式 | **3 个**失败 |
| `Drop` 里 `unlink` 锁文件 | **3 个**失败（含权限用例） |

第三项是 `03j` 特别要求的一项：`let _ =` 与 `let _state_lock =` 在代码审查里
几乎无法区分，只有并发测试能挡住。

### 4.4 被拒进程的副作用面（手工实测，已固化进 4.1 的断言）

持有锁的进程先运行 3 秒让写入落盘，取快照，再启动第二个：

```
installation-id sha256 UNCHANGED
node-identity sha256 UNCHANGED
binding UNCHANGED
installation-id inode UNCHANGED
files before: .node.lock installation-binding.json installation-id node-identity.json
files after : .node.lock installation-binding.json installation-id node-identity.json
```

只比内容不比 inode 会漏掉「删除后以相同内容重建」，所以两者都比。

---

## 5. 没有做到的事（不是缺陷，是边界）

| 项 | 状态 |
|---|---|
| 运行期目录被删除/替换的防护 | **未实现**。`03k` 风险 1，ADR-023 §2.6 列为 residual |
| `state_dir` 是符号链接时拒绝 | **未实现**。`create_dir_all` 静默接受符号链接 |
| 旧版本 Node 被阻止 | **不可能**。advisory 锁的固有边界 |
| NFS/SMB 上的正确性 | **未验证**，明确排除 |
| Linux 上的真实运行 | **本轮只在 macOS 跑过**。`linux-runtime` 需真跑，这是 `03k` 的条件 2 |
| 电源丢失下的持久性 | 与本锁无关；锁在内存中由内核持有 |

---

## 6. 运维影响

- 升级镜像/替换二进制时，**必须先停掉旧 Node 再启动新的**——旧进程不认这把锁。
- 状态目录被占用时，Node 不再尝试启动，`systemctl status` 会看到
  `NODE_STATE_DIR_IN_USE` 与占用文件的路径。
- `.node.lock` 永久保留，不要手工删除；删除本身不会造成损坏，但也没有必要，
  且会让「锁在 inode 上」这条性质暂时失去可观测性。
- `tests/ci/p001c_up.sh` 的 `rm -rf "$STATE"/node-a/*` 不会匹配点文件，
  锁文件会存活——这是设计需要的，不要把它「整理」成整目录删除。
