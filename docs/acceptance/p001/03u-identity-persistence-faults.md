# P001-C1.4 后续：Node 身份持久化与异常恢复

| 项 | 值 |
|---|---|
| 单元测试 | `apps/node/src/runtime.rs`（`write_atomic` 故障注入，3 项） |
| 集成测试 | `apps/node/tests/identity_persistence_faults.rs`（3 项） |
| 既有覆盖 | `migration_durability.rs`（4 项，状态机）、`state_dir_clone.rs`（10 项） |

## 1. 本轮补的是哪一层

`migration_durability.rs` 断言**进程崩溃后**状态机收敛到哪个状态。它不攻击
**写入路径本身**——那四次 syscall 各自失败时，目录会变成什么样。

`write_atomic`（`runtime.rs:432-458`）的顺序是：

```text
create_dir_all(parent)
open(temp, O_CREAT|O_EXCL, 0600)   ->  write_all  ->  sync_all
rename(temp, path)
sync_dir_of(parent)
```

## 2. 单元：直接攻击 `write_atomic`

| 注入 | 真实条件 | 断言 |
|---|---|---|
| 临时文件创建失败 | 父目录 `chmod 0555` | 返回 `Err`；目标不存在；**无 `*.tmp.*` 残留** |
| publish 失败 | 目标路径被一个**目录**占据（`rename` → EISDIR） | 返回 `Err`；目录未被替换；内容未丢失 |
| 控件：正常写入 | —— | 字节精确；无临时文件残留 |

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

## 4. 反事实

| 注入 | 结果 |
|---|---|
| `rename` 失败被吞掉（`let _ =`） | `a_target_that_is_a_directory_makes_the_publish_fail` **FAILED** |
| `write_atomic` 永远返回 `Err` | 控件 `a_successful_write_…` **FAILED**（证明另两条不是空过） |
| `pending_migration` 强制作废 marker | `a_partially_written_marker_…` **FAILED** |

第二条是控件：没有它，一个永远失败的 `write_atomic` 也能满足前两条。

## 5. 三种崩溃一致性，分开说

| 级别 | 保证 | 本轮验证 |
|---|---|---|
| 进程崩溃（`SIGKILL`） | 已 `write` 的内容仍在页缓存，下一个进程可读 | 由 `migration_durability.rs` 覆盖 |
| OS 崩溃 / 重启 | 同上（页缓存由内核掌管） | 未单独验证，与上一级同源 |
| **真实断电** | 只有 `fsync` 过的内容 | **未验证，也不声称** |

`write_atomic` 对文件与父目录都调 `fsync`，顺序本身是设计属性（ADR-023 §2.5）。
**不能**用「杀进程后文件还在」推断断电安全——那测的是前两级。

## 6. 本轮没有修的（以及为什么）

| 项 | 状态 |
|---|---|
| 断电持久性 | 无法在 CI 模拟。设计属性，非测量结论 |
| 不支持目录 `fsync` 的文件系统 | `sync_dir_of` 会报错而不是继续（既有行为） |
| C1.2.1 之前克隆的目录不可检测 | **open**，ADR-023 §2.3 |
| 非 Unix 无法校验 device/inode | **open**，既有 |

本轮**没有**发现产品缺陷：四个故障点都正确地返回错误并清理临时文件。
这部分是补证据，不是修 bug——如实写在这里，而不是包装成「发现并修复」。
