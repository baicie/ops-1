# Skill: distributed-fault-review

## 触发条件
Node、Scheduler、Gateway、Lease、SSE、插件运维代码变更时

## 必需输入
网络拓扑、状态机、日志/请求链路与部署副本配置

## 执行步骤
1. 区分 Desired/Observed/Effective、心跳过期与真实进程退出
2. 验证 command ID、generation、幂等、超时、backpressure
3. 模拟 Node crash、network partition、Kernel restart、stale update
4. 对异步任务检查 Fencing 与副作用执行归属
5. 记录真实实验指令与结果而非仅编译通过

## 必交产物
Fault Matrix + 实测日志 + 恢复演练记录

## 退出条件
任何断线无错误的成功/STOPPED 假象，旧路由可以安全回收

## 禁止事项
不伪造运行测试、截图、客户日志或生产部署结果；缺失信息明确标记并阻塞相应验收。
