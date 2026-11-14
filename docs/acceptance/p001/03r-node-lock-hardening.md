# Node 单实例锁：安全加固与影响矩阵

| 项 | 值 |
|---|---|
| 实现 | PR #100（已合入 `d5b89c4`） |
| 本阶段 | 加固两个可复现的局部缺陷，其余按影响分级记录 |
| 脚本 | `apps/node/src/state_lock.rs` |

## 1. 本阶段修复的两个缺陷

### 1.1 符号链接的锁文件被跟随（P1）

`OpenOptions::open()` **跟随符号链接**。实测：

```
open() on a symlinked lock path succeeded and flock() returned 0
the path is a symlink: True
lock landed on inode: 176205016     <- the TARGET
the symlink's own inode: 176205017
```

后果：`.node.lock` 指向 `elsewhere` 时，锁加在 `elsewhere` 上。两个 Node 被
指向两个不同目标，就会各自「持锁」，而它们共享同一个状态目录——锁要强制的那条
约束被一个符号链接绕开。

**修复**：`O_NOFOLLOW`（失败为 `ELOOP` → `NODE_STATE_LOCK_FAILED`）。
Node 从不创建符号链接锁文件，拒绝它没有代价。

**反事实**：移除 `O_NOFOLLOW` ⇒ `a_symlinked_lock_file_is_refused_not_followed` 变红。

### 1.2 非普通文件可以被打开（P1）

`O_NOFOLLOW` 挡掉符号链接，但 FIFO 与设备节点仍可打开。FIFO 以写方式打开会
**阻塞到有读者出现**，于是启动不是被拒绝而是**挂起**；`flock` 在 FIFO 上的语义
也与互斥无关。

**修复**：打开后 `fstat`，`!is_file()` ⇒ `NotRegular`（`NODE_STATE_LOCK_FAILED`，
消息说明实际类型）。

**反事实**：把检查改成 `if false` ⇒ `a_non_regular_lock_file_is_refused` 变红。

### 1.3 附带：`O_CLOEXEC`

锁的描述符不带 `CLOEXEC` 时，子进程会继承它并让锁在父进程退出后继续存活。
Node 会 `spawn` docker 与 pipeline worker，所以这条是实际风险而不是理论风险。

## 2. 影响矩阵

每条给出：可复现性、影响、处置。

| # | 场景 | 可复现 | 影响 | 处置 |
|---|---|---|---|---|
| 1 | 锁文件是符号链接 | **是**（实测） | 两个 Node 各持一个「锁」 | **本阶段已修** |
| 2 | 锁文件是 FIFO / 设备节点 | **是**（mkfifo） | 启动挂起或锁语义错误 | **本阶段已修** |
| 3 | 子进程继承锁描述符 | 是（`spawn` 存在） | 父进程退出后锁仍被持有 | **本阶段已修**（`O_CLOEXEC`） |
| 4 | `state_dir` 本身是符号链接 | 是 | 两个进程给不同路径、同一真实目录 | **ACCEPTED_RISK**：`03k` risk 5，属运维契约。Node 信任 `--state-dir`，与信任 `installation-id` 同级 |
| 5 | 运行期目录被删除重建 | 是 | 新 inode，第二个进程可加锁 | **ACCEPTED_RISK**：`03k` risk 1。inode 语义的固有边界，需父目录级锁才能解决 |
| 6 | 旧版本 Node 不遵守 `flock` | 是 | 无保护 | **ACCEPTED_RISK**：advisory 锁的固有边界（决策 4） |
| 7 | NFS / SMB 上的 `flock` | **未验证** | 未知 | **ACCEPTED_RISK**：明确排除在保证范围外（决策 5） |
| 8 | 有权限 `rm -rf` 自己状态目录的进程 | 是 | 不需要锁的许可 | **ACCEPTED_RISK**：staging 里 Node 拥有自己的目录（`03k` §2.3） |
| 9 | 管理员强制替换目录 | 是 | 同上 | **不是远程安全漏洞**：需要本地特权，且与身份绑定同级。记录为运维风险，不升级为 P0 |
| 10 | 同一进程重复加锁 | 是 | 无（`flock` 按打开实例计数） | 已有测试覆盖 |

### 为什么 4–9 不在本阶段修

它们不是实现缺陷，而是**设计要求**：`flock` 锁 inode、advisory、只保证本地
文件系统。把它们「修掉」等于换成另一种机制（父目录级锁、强制锁、托管存储），
那是存储架构变更，不是加固。`03k` 已逐条测量并写入，`ADR-023 §2.6` 已列为
residual。

**任务包明确要求不要把管理员强制替换目录自动定性为远程安全漏洞**——本文件把它
列为 ACCEPTED_RISK，并说明它需要本地特权。

## 3. 验证

| 检查 | 结果 |
|---|---|
| `cargo fmt --all` | clean |
| `cargo clippy -p opsweave-node --all-targets -- -D warnings` | clean |
| `cargo test -p opsweave-node --lib state_lock` | **8 passed** |
| 反事实 1（去掉 `O_NOFOLLOW`） | 对应用例 **FAILED** |
| 反事实 2（`if false` 替掉类型检查） | 对应用例 **FAILED** |
| 真实多进程套件 `state_dir_lock.rs` | 未改动，行为不变 |

## 4. 未做

- **没有**在真实 Linux 上重跑多进程套件（依赖本 PR 的 CI）。
- **没有**为 `state_dir` 符号链接增加拒绝：那是 `03k` 已记录的产品决策，
  单方面收紧会让既有部署无法启动。
- **没有**引入父目录级锁：`03k` 的 Gate 结论是 CONDITIONAL PASS，
  父目录锁被明确推迟。
