# Release Gate：多语言/OCI/分布式一体验收

## 0.0.1 Required
| ID | 测试 | 必须留存的证据 |
|---|---|---|
| C01 | Java Spring Boot Fullstack v1 安装、页面/接口可见 | bundle/image digest、curl/Browser Trace、日志 |
| C02 | Go backend v1 用相同 Runtime v1 合约接入 | contract JSON report、容器健康记录 |
| C03 | TS/Node Fullstack v1 同样运行、独立升级 | contract report、发布 revision Diff |
| C04 | Node A/B 各运行一份镜像 Digest 一致的副本 | node_id/container_id/digest、Ready timestamps |
| C05 | 只关闭 A 进程，B 持续服务；网关没有永久路由坏实例 | outage window、数据面请求记录 |
| C06 | 上传篡改包、未签名镜像、Digest tag mismatch 拒绝激活 | 策略拒绝审计与错误码 |
| C07 | Node 凭据过期/被撤销，禁止新部署/操作 | Enrollment/mTLS 测试记录 |
| C08 | 资源配额、host socket/hostPath/privileged 请求受禁止 | 容器 inspect/OS 限制证据 |
| C09 | 旧浏览器 Tab 在 v1→v2 发布期间按兼容协议工作或明确阻断 | 页面截图、HTTP contract |
| C10 | DB 不兼容 migration 明确阻止自动回滚 | 迁移前检查与审计记录 |
| C11 | Kernel 重启后从 PG 与节点 Observed 对账 | Desired/Observed/Effective 快照 |
| C12 | SSE tail：授权、断连续读、Cursor Gap、背压、撤权 | 原始 SSE stream/403/410 |
| C13 | Node Runtime 退出/升级时既有工作负载处理符合声明策略 | Node lifecycle +容器状态和应答 |
| C14 | 390/1024/1440px + light/dark 真实浏览器截图验收 | 截图与 UI 审核结果 |

> 三台机器真实 Linux 网络/Rootless Docker/PG/签名镜像为必需；仅 Mock、Docker Compose 单机或单元测试不能签署“分布式通过”。0.0.1 不承诺控制面多副本 HA。

## 质量门禁（每一 PR）
- 合约：JSON Schema/OpenAPI 校验，Breaking Change 检测，生成客户端无手改；三语言互通场景逐步覆盖。
- Runtime：Rust fmt/clippy/unit/integration；Java test/check；Go test/race；TS typecheck/unit/Playwright；必要容器扫描/签名验收。
- 安全：鉴权、租户、工作负载身份、签名/摘要、资源配额、Secret、Egress/Ingress、Supply Chain。
- 运维：升级/回退、失联/超时、非预期重试/UNKNOWN/审计日志；平台自身 CLI 能恢复。
- UX：核心状态（Loading/Empty/Partial/Denied/Stale/Unknown/Conflict）和 6 张截图矩阵。

## 报告标准
每份 Test Evidence 必含 commit SHA、Kernel/Node 版本、镜像 Digest、机器 OS/arch、rootless Engine 版本、PG schema version、配置/权限、实际运行命令、开始结束时间、结果和失败日志摘要。未跑记 `NOT_RUN`，不可虚构全部通过。
