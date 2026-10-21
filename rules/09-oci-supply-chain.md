# P-09 OCI/供应链强制规则（平台无关）

- MUST：正式插件后端使用不可变 OCI `image@sha256:digest`，不得在部署期解析可变 Tag。
- MUST：发布 CI 校验基础镜像固定、锁文件完整、运行用户非 root、签名和制品摘要、SBOM、运行架构/许可证/安全扫描。
- MUST：Node Runtime 必须执行 CPU/内存/PID 与容器权限约束；不允许 privileged、host Docker Socket、host Network/PID、任意宿主路径。
- MUST：镜像 registry 凭据属于 Node 部署控制面，不得传给业务插件；Web Remote 静态资源有逐文件 Hash 与可信来源。
- MUST：Release Manifest/Frontend Assets/Image Digest 一致，安装和部署分别验证；Bundle 签名不能代替镜像签名。
- MUST：Container Runtime Adapter 选择与安全设置以真实 Linux 集成/故障实验验收，不凭 Dockerfile 表面声明推断安全。
- MUST NOT：将业务插件 JAR/Node 二进制解压到 Kernel 宿主执行当成正式热插拔能力。
