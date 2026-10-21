# Security Architecture / Threat Model（必读）

## 信任边界
1. 浏览器不可信；即便登录用户也要做 server-side resource/role 授权。
2. Kernel 是权限根，但外部网络/插件输入仍然不可信。
3. Node 有受控管理权限：Node 运行时可执行受签名允许列表和范围限制的部署命令，不能被插件或普通用户自由调用。
4. Plugin Instance 不能继承 Node 的宿主权限；拥有单独 Workload Identity 和限期能力许可。
5. Artifact、Manifest、日志、数据源、模型输出均视为不可信内容，验证/转义/限流后再用。

## 插件供应链
- 包格式：规范化 Manifest、逐文件 SHA-256、不可变 Artifact Reference、发行者 Ed25519 签名；验签用受控信任根，支持发行者禁用/撤销。
- 先限制在团队签名的 Trusted Publishers，不开放公众上传执行；验签通过**不等于**证明代码没有恶意行为，仍需最小权限、代码审查和运行隔离。
- 危险归档路径/链接/超大压缩比拒绝；容器镜像强制 digest；依赖许可证/漏洞/SBOM 检查，记录审批人。
- 前端远程 JS 在宿主同执行域，CSP + 内容寻址 + 受信发行者 + 宿主 token broker 只是风险降低，不是硬隔离；不可信 UI 后续使用 iframe 隔离模式。

## 机器与插件运行隔离
- 0.0.1 Linux + OCI，无 privileged 容器、host network、host PID、任意 hostPath；默认只读根文件系统，drop capabilities，禁提权，seccomp/user namespaces（视运行时支持与验收），资源 cgroup 限额。
- Node Runtime 接触 OCI Engine 的管理 socket 属于高风险：放到独立的专用 Node 主机，采用最小系统服务权限和操作白名单；绝不把 socket 暴露成网络 API。
- 0.0.1 限可信自家插件部署；安全隔离测试不合格，不能允许多租户恶意代码共宿主。
- 网络默认阻断无关出站；根据插件声明的目标允许列表审批，不保证仅通过应用层“只允许 URL”即可防 SSRF；需要 DNS 重绑定、私网段和重定向策略。

## 身份/授权/秘密
- User Session（受保护 cookie / CSRF）≠ Node mTLS Identity ≠ Workload Token；来源权不能互相替代。
- 0.0.1 支持单工作区、管理员/Operator/Viewer 最小 RBAC；为后续 tenant_id 留字段与授权约束，但**不宣称生产多租户隔离**。
- Node enrollment 使用一次性短时令牌、审批、节点密钥本地保存、证书轮换、吊销后拒绝连接；时钟偏差检查。
- Plugin Capability 许可按 Workload Identity、scope、expiry、audience、resource 绑定；不可由前端或插件传任意 subject 提升权限。
- Secret Broker v0.0.1 最小能力：引用密钥而非在 Manifest 放明文；限制读取角色、轮换和日志脱敏；后续接 Vault/KMS 适配。

## 威胁清单（验收必须覆盖）
| 威胁 | 处理 |
|---|---|
| 恶意 ZIP 路径穿越 / zip bomb | canonical path + size/entry/decompression limits |
| 被替换的镜像 / JS bundle | digest / signature verification / immutable storage |
| 跨插件访问内网 IP | Gateway policy + Node egress deny/allow |
| 伪造 Node 注册/心跳 | enrollment mTLS + server-side identity binding |
| Replay of deploy instruction | command ID + generation + expiration + idempotency |
| 订阅他人日志 | server-side RBAC + scope + stream ownership |
| 日志注入/密钥泄漏 | structured log encode + redact + audit + output size cap |
| CSRF/XSS/remote JS | SameSite/CSRF + CSP + trusted publisher restrictions |
| 成功安装却不具备权限 | permissions diff approved before activation; fail closed |

## 生产准入之前独立补齐
OIDC/MFA、统一 CA/KMS、可信工作负载身份、强隔离策略检验、备份加密、密钥轮换演练、漏洞/渗透测试、组织租户授权证明、软件供应链签署和灾备。0.0.1 仅声明内部实验环境可用。
