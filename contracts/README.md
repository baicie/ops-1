# 公开协议与示例（设计基线，不是运行中的 API）

## 原则
- Protocol / Schema 是前后端和不同语言插件唯一的交互真相；后续使用版本锁定的代码生成。
- JSON Schema 采用 Draft 2020-12，正式 SDK 发布必须进行双向兼容性检查。
- `examples` 中的签名、摘要、地址、身份是**语法演示用假值**，不能用于实际安装或模拟信任验证成功。
- `openapi/` 是候选接口清单，覆盖 0.0.1 关键 UI 请求/状态；实现可扩展字段前必须修改 Schema。
- 0.0.1 生产 readiness、安全授权、响应时间、mTLS 通道需真实 E2E 验收。

## 错误模型
所有错误含稳定 `code`、`message`、`requestId`（必需）、`retryable`，可选 `details`；对外不暴露敏感堆栈、Node 私网地址和凭据。标准错误：`FORBIDDEN`、`UNAUTHENTICATED`、`SIGNATURE_INVALID`、`INCOMPATIBLE_VERSION`、`CAPABILITY_UNAVAILABLE`、`DEPENDENCY_BLOCKED`、`RESOURCE_EXHAUSTED`、`CONFLICT`、`UNKNOWN_OUTCOME`、`CURSOR_EXPIRED`、`NODE_UNREACHABLE`。

## 2026-10-22 / Final OCI & Multi-language amendments
- Plugin Manifest 1.1 now requires `backend.runtime=oci`, digest-pinned `imageRef`, versioned `http-json` protocol/port, distinct readiness/liveness; Web Remote requires asset-index and digest. Both `frontend` and `backend` can be null individually but never both null (semantic verifier).
- `contracts/openapi/plugin-runtime-v1.yaml` plus `plugin-runtime-info` fixtures define language-neutral plugin host endpoints.
- `frontend-asset-index.v1.schema.json` validates static asset listings; example byte lengths/digests are **fictional syntax samples**, not working executable release assets.
- Runtime IDs, image digests and signing are attested by trusted Kernel + Node, not accepted from plugin self-report. See [full design](../docs/20-language-agnostic-plugin-runtime.md).
