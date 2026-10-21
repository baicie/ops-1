# Skill：多语言后端协议一致性

触发：新增某语言 Plugin SDK、修改 Runtime API、增加 Java/Go/TypeScript 模板或版本兼容性。

1. 阅读 `contracts/openapi/plugin-runtime-v1.yaml` 和 Manifest v1.1；先冻结测试向量/错误语义。
2. 在真实独立容器中启动 Java、Go、TS 测试服务，不使用 mock Gateway 冒充网络成功。
3. 使用同一个 tester 依次覆盖 info/ready/live、超时、body limit、非法 Header、权限、幂等、graceful drain。
4. 逐语言保存容器 Digest、运行日志、失败用例、SDK 是否可选和生成代码兼容情况。
5. 任一语言必须在不改 Kernel 业务逻辑的条件下接入；否则提交 ADR 说明违反 Platform Contract 的原因。

输出：Conformance Matrix 和测试证据；未测语言明确 NOT_RUN，不宣传“全语言已支持”。
