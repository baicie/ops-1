# 插件发布、滚动升级与回滚协议

## 双副本服务的发布阶段
```
Signed package verified
    → Candidate registered
    → Permissions / Dependency / API / Migration review
    → Pull OCI digest to target Nodes
    → New Replica(s) staged (no gateway traffic)
    → Startup + Readiness + Info identity/version/digest verification
    → Activation Revision CAS (effective routes & Web manifest)
    → Old replicas drain / route revoke
    → Old content kept for compatibility window
    → Report + audit + artifact retention
```
- **先后端，后前端**：新后端应在一段明确窗口兼容旧前端协议，然后前端才切新 Manifest；发布不可依赖浏览器自动马上刷新。
- 两副本滚动更新的策略须明确 `maxUnavailable=0/maxSurge=1` 是否受资源允许；若无容量先新后旧，发布应进入 `BLOCKED_CAPACITY`，不能偷偷造成全量中断。
- 若候选版本只在 Node A Ready，但策略要求两个 Ready，Activation 不得报告全部成功。
- Kernel 单实例断线或 PostgreSQL 失联时，Candidate 必须保持中间状态并可恢复，不能把阶段进度仅留在内存。

## 回滚分类
| 类别 | 自动操作边界 |
|---|---|
| 新实例启动/健康失败、未切流量 | 清理候选容器，旧 Effective Routes 保留 |
| 切流量后 HTTP 错误超过阈值，DB 未变更 | 新请求回旧已知健康镜像，审计切换；运行中请求有界 Drain |
| DB `expand` 向前兼容 | 满足已声明的 rollbackCompatible 可回旧程序，DB 结构不物理回退 |
| DB `contract` 删除旧字段 | **阻止自动回滚**，需前向修复或已演练恢复 |
| frontend chunk 已加载 | 保留旧静态资源，提示兼容窗口/安全刷新，不能热删除在执行的 JS |
| Node UNREACHABLE | 撤销 Effective Route，Observed=UNKNOWN；不能仅凭失联判定停止 |

## 数据库迁移 Gate
- `Data Migration Plan`：插件所有权、迁移版本、范围、事务影响、兼容窗口、恢复策略、备份验证、审计记录。
- 契约性删除字段必须在旧版本、旧 Tab、队列任务兼容窗口结束后执行。
- `rollbackCompatible=true` 是基于具体迁移测试的结论，不是用户勾选后就成立。

## 无状态与有状态区分
0.0.1 只承诺**同步无状态 Service** 的跨节点部署与轮换。Redis、数据库连接、长任务、Session 需外置或通过明确租约设计，不能让某副本内存成为唯一事实源。0.0.3 增加 Worker Lease/Checkpoint/Fencing 后才能声明可靠任务重调度。
