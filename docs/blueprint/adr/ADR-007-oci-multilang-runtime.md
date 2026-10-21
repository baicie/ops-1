# ADR-007：多语言插件与 OCI 正式交付（接受）

- 日期：2026-10-22；适用版本：OpsWeave 0.0.1；替代此前“优先 Linux 原生业务进程”的任何建议，不推翻 [ADR-002](ADR-002-node-runtime-and-oci.md)。
- **决策**：Rust Kernel 不要求业务插件 Rust；后端插件生产形态为 OCI `image@digest`；0.0.1 仅实现 Rootless Docker Engine Reference Adapter，Java、Go、TypeScript 三个真实 Hello 后端同一 HTTP/JSON Runtime v1 黑盒验收。
- 本地开发允许 native process/HMR，但注册为 `DEV_ONLY`，无生产签名/权限资格；不能将 dev 动态代理当成生产热升级。
- Node 守护进程控制本机受限 OCI 运行时并登记容器状态。Plugin 不能读取 Docker Socket、宿主机管理凭据或任意 hostPath。
- Docker Image 的名称只是 OCI 发行物；后续可用 Podman、containerd、Kubernetes Adapter，需另出 ADR 与 E2E，保持 Manifest 和 Capability API 向后兼容。
- 后端语言无关，所有权边界以协议与 Workload Identity 为准。官方 SDK 可选，协议为唯一事实来源。
- **替代方案**：共享 Rust dylib（拒绝 ABI/信任/崩溃边界）；每语言特殊 API（拒绝维护爆炸）；K8s 首版强依赖（拒绝环境过重）；ZIP 内混装 JAR/二进制并直接运行（拒绝主机 runtime 污染）。
- **代价**：OCI registry、签名、镜像版本与宿主 Docker rootless 安装成为首版基建工作；需接受可靠性验证成本。
- **回滚此 ADR 的触发条件**：真实三语言 OCI 实验显示团队无法可靠运维时，可另立 ADR 选择另一 OCI runtime adapter，但不降低制品和协议边界。
