# 协议级状态和行为（强制）

## 命令语义
- `202 Accepted` 表示接受到持久命令，不表示插件运行成功；后续查询 Receipt / Deployment 状态。
- 重复 `Idempotency-Key` 且请求摘要一致 → 返回原命令回执；摘要不同 → `409 CONFLICT`。
- 网络超时 → `UNKNOWN_OUTCOME`；客户端不得生成新键自动 POST，应以原 requestId/Idempotency-Key 回查。

## API 语义
- 资源作用域由服务端会话绑定，URL/JSON 的 tenant/permission/identity 不是信任根。
- 路由与权限判定使用 activation revision 和当前有效策略；插件实例即使监听 HTTP 端口也不能直接暴露。
- Error body `code/message/requestId/retryable`，不暴露内部网络细节。
- SSE Cursor 必须与有权的 streamId+epoch+sequence 一起验证；过期返回 GAP 或 HTTP 410，并附可读指导。

## 兼容性
- 0.0.1 对外 v1 API 可增加可选字段，但**闭合 Schema 的消费者必须明确版本协商**，不能期待旧客户端自动接受新增字段。
- Activation 改变前应检查 frontend shared SDK 与 backend API major；旧 Tab 的兼容窗口由新旧插件实现保证。
- 数据和 Schema 迁移本质上不是自动回滚；迁移风险高时明确要求维护窗口。

## Final v1.1: 语言无关 Manifest 与生产部署
- 原 `backend.imageDigest`（没有 Registry Locator）废弃；新 `imageRef=repository@sha256:digest`。旧 Manifest 1.0 需要显式迁移或拒绝，不能被静默读成 1.1。
- `ready/live/startup` 是三种独立状态；远程 Plugin 自报 `info` 必须匹配 Publisher 签名包与 Activation Version。
- 0.0.1 **只有同步 HTTP/JSON Service**，异步 Worker 协议未来单独添加；Host 地址、Docker Socket 永不成为公共能力。
