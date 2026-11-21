# S-03 权限、安全与隐私规则

- MUST：区分 User/Node/Workload 身份；授权在 Kernel/Gateway/Node 执行前后验证，UI 隐藏不算授权。
- MUST：Node 先 enrollment 后加入，mTLS 双向校验；短期令牌只能使用一次，过期/撤销必须拒绝。
- MUST：Trusted Publisher + Artifact Digest + 签名验证；不可信 UI 必须独立安全边界，不能共享宿主 JS Realm。
- MUST：Plugin Secrets 用引用和短期访问许可，禁止进入日志/Manifest/URL/错误响应；所有诊断日志先脱敏。
- MUST：限制请求体、超时、出站目标、并发、磁盘/内存/CPU、日志大小；错误码与审计必须可追踪。
- MUST：跨插件与跨租户读写不能靠传入的 `tenantId` 或 `subjectId` 自证；业务插件不可直读别人的数据表。
- Gate：未授权日志订阅、伪造节点、未知签名、提升权限、压缩包路径穿越全部有负向测试。
