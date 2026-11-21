# P-10 多语言 SDK/插件协议强制规则（平台无关）

- MUST：业务插件准入只依赖 Runtime HTTP/JSON Protocol v1、OpenAPI、Manifest、授权、OCI、健康与资源声明，不依赖 Spring/Go/Node/Rust/Python 专属 SDK。
- MUST：Java、Go、TS 三个官方示例运行**同一组黑盒 conformance tests**，提供真实镜像 Digest 与原始结果。
- MUST：请求身份与 Tenant/Scope 由 Kernel 校验并签发；不得信任任意客户端/Header 的自报值；各插件仍需做对象授权。
- MUST：Ready/Liveness/Runtime Info 在所有语言保持相同状态、字段与失败语义；语言相关异常以统一错误模型呈现。
- MUST：Runtime 客户端与生成 DTO 取自 `contracts/`，不能人工独立复制五份不兼容协议。
- MUST：后端业务路径与 Capability Name 相互独立；容器 Node/IP/port 永不成为公共 SDK 的稳定地址。
- SHOULD：后端使用语言原生 idioms（Java lifecycle、Go shutdown、Node graceful shutdown），只统一公开协议，不强制业务目录所有语言一模一样。
