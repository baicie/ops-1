# P001-C1.4 后续：Node 身份持久化与异常恢复

| 项 | 值 |
|---|---|
| 单元测试 | `apps/node/src/runtime.rs`（`write_atomic` 故障注入，5 项） |
| 集成测试 | `apps/node/tests/identity_persistence_faults.rs`（3 项） |
| 既有覆盖 | `migration_durability.rs`（4 项，状态机）、`state_dir_clone.rs`（10 项） |
| `cargo test -p opsweave-node` | **70 passed, 0 failed** |

## 1. 本轮修的产品缺陷

`write_atomic` 的 publish 阶段没有清理：

```rust
std::fs::rename(&temporary, path)
    .with_context(|| format!("publish {}", path.display()))?;   // ← ?
sync_dir_of(path)
```

`?` 直接返回，`$temporary` 留在磁盘上。**write 阶段有清理，publish 阶段没有**——
这是同一个函数里两个阶段的处理不一致，不是设计取舍。

后果：每次失败的 publish 都在状态目录里留下一个 `*.tmp.<uuid>`。目录里逐渐堆积
既不是有效状态、也没有任何东西说明它们是碎片还是数据的文件。

修复后的行为：

| 情形 | 行为 |
|---|---|
| rename 失败、tmp 删除成功 | 返回原始错误，附 `temporary file removed` |
| rename 失败、tmp 删除也失败 | **两个错误都报**（第二个决定碎片是否还在） |
| 目标目录 | **绝不删除**——把「拒绝写入」变成数据丢失 |
| 旧文件 | **绝不破坏** |

## 2. 单元：直接攻击 `write_atomic`

| 注入 | 真实条件 | 断言 |
|---|---|---|
| 临时文件创建失败 | 父目录 `chmod 0555` | `Err`；目标不存在；无 tmp 残留 |
| publish 失败 | 目标是**目录**（`rename` → EISDIR） | `Err`；目录未被替换；内容未损；**无 tmp 残留**；错误文本含清理结果 |
| publish 失败时的旧值 | 父目录 `chmod 0555` 后写入已有文件 | `Err`；**旧内容完好**；无 tmp 残留 |
| 并发写入 | 8 线程同时写同一目标 | 全部成功（临时名不冲突）；无 tmp 残留；**权限 0600** |
| 控件 | —— | 字节精确；无 tmp 残留 |

### 为什么这些必须放在 `runtime.rs` 里

`write_atomic` 是私有的，更重要的是：**从公开入口到不了它。**
`load_or_create_installation_id` 只读与铸新 id，`write_atomic` 由
`save_identity` 在 enrolment 之后调用。

**实测**：把 `rename` 的错误处理改成 `let _ =`（吞掉），集成测试里那三个
「写路径」用例**全部仍然通过**——因为它们走的是更早的失败分支。这是「测试因
错误的原因通过」，已删除并改为直接测函数。

## 3. 集成：状态目录的异常形态

| 用例 | 断言 |
|---|---|
| `state_dir` 是一个普通文件 | 拒绝启动；该文件不被删除 |
| marker 被外部截断（非法 JSON） | **拒绝启动**，不当成「没有 marker」 |
| binding 指向另一个 installation-id | 拒绝；不猜测哪一半为真 |

第三条对应 ADR-023 §2.2a 的「不猜测」原则。

## 4. 反事实（每条都真实执行）

| 注入 | 结果 |
|---|---|
| 移除 rename 的清理分支 | `a_target_that_is_a_directory_…` **FAILED** |
| 把 rename 错误吞成 `let _ =` | `a_target_that_is_a_directory_…` **FAILED** |
| `write_atomic` 永远返回 `Err` | 控件与并发用例 **FAILED**（证明另两条不是空过） |
| `pending_migration` 强制作废 marker | `a_partially_written_marker_…` **FAILED** |
| 恢复后 | **5 passed** |

第三条是控件：没有它，一个永远失败的 `write_atomic` 也能满足前两条。

## 5. 五个 syscall：验证到什么程度（如实）

简报要求逐个注入。**做不到的都写在这里，不假装做过。**

| syscall | 能否从外部注入 | 状态 |
|---|---|---|
| `create_new`（临时文件创建） | 能：父目录 0555 | **已验证** |
| `write_all` | **不能**——需要注入短写或 ENOSPC | **未验证**。理由见下 |
| `sync_all` | **不能**——需要让 fsync 返回 EIO | **未验证** |
| `rename` | 能：目标为目录 / 父目录只读 | **已验证**（两种方式） |
| 父目录 `fsync` | **不能**——`sync_dir_of` 只在目录 fd 上失败，而正常目录不会 | **未验证** |

`write_all` 与 `sync_all` 无法在稳定可复现的前提下失败：截断写入需要
`RLIMIT_FSIZE`（影响整个进程，且是 SIGXFSZ 而非 `Err`），EIO 需要故障注入块设备
（CI 上不可用）。**不写一个假装覆盖它们的测试。**

### 父 fsync 失败的特殊说明

简报特别指出：parent fsync 失败发生在 `rename` **已经成功之后**。此时新文件
**已经可见**，只是持久性未确认。

这一点很重要，因为它意味着**不能把这种情况描述成「原子写入完全回滚」**：
- 内容层面：新值已经是当前值；
- 持久性层面：断电后可能回到旧值。

本文件**不声称**父 fsync 失败已被测试覆盖，也不声称它是可回滚的。

## 6. Root 下的行为

原实现：

```rust
if running_as_root() { eprintln!("skip: …"); return; }   // 退出码 0
```

在 root runner 上，这是一个**绿色的、什么都没测的用例**。

现在改为打印 `NOT_RUN <测试名>: mode 0555 does not stop uid 0`。
仍然返回 0——`cargo test` 无法在不失败整个 job 的前提下表达「未运行」——
但输出里明确标出未运行，而不是让一个 `ok …` 冒充通过。

**这是折中，不是解决。** 真正的解决需要 `#[ignore]` + 显式的
`--include-ignored` 或按 uid 分流 job，属于 CI 架构变更，不在本阶段。

## 7. 三种崩溃一致性，分开说

| 级别 | 保证 | 本轮验证 |
|---|---|---|
| 进程崩溃（`SIGKILL`） | 已 `write` 的内容仍在页缓存，下一个进程可读 | 由 `migration_durability.rs` 覆盖 |
| OS 崩溃 / 重启 | 同上（页缓存由内核掌管） | 未单独验证，与上一级同源 |
| **真实断电** | 只有 `fsync` 过的内容 | **未验证，也不声称** |

`write_atomic` 对文件与父目录都调 `fsync`，顺序本身是设计属性（ADR-023 §2.5）。
**不能**用「杀进程后文件还在」推断断电安全——那测的是前两级。

## 8. 本轮没有修的（以及为什么）

| 项 | 状态 |
|---|---|
| 断电持久性 | 无法在 CI 模拟。设计属性，非测量结论 |
| 不支持目录 `fsync` 的文件系统 | `sync_dir_of` 会报错而不是继续（既有行为） |
| C1.2.1 之前克隆的目录不可检测 | **open**，ADR-023 §2.3 |
| 非 Unix 无法校验 device/inode | **open**，既有 |
| `write_all` / `sync_all` / parent fsync 注入 | **未验证**，§5 |

本轮**发现的唯一产品缺陷**是 §1 的临时文件泄漏；其余四项是补证据。
如实写在这里，而不是包装成「发现并修复」。
