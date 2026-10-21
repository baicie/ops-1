# OCI 镜像、前端静态资源和可信发布链

## 为什么要区分三个 Digest
| 标识 | 含义 | 归属 |
|---|---|---|
| `bundleDigest` | 安装 ZIP 原始字节的 SHA-256 | Registry 收包后计算，**不写入 ZIP 自身** |
| `artifactDigest` | Canonical Payload Index 的根摘要（既有草案语义） | Manifest + Publisher 签名覆盖；不是 ZIP hash |
| `backend.imageRef` digest | OCI Manifest 或 Image Index 的内容摘要 | OCI Registry；Node 拉取并校验 |

Frontend `assetIndex` 中每个 asset 的 SHA-256 必须与不可变资源内容对应。**不要把 OCI image 字节放入 ZIP**；ZIP 内只引用固定 OCI digest 和前端静态资产文件。不要用可变 `latest` 标签到生产运行。

## 建议发布结构
```
plugin-bundle.zip
  manifest.json                # schemaVersion=1.1; UTF-8 canonical JSON
  frontend/remoteEntry.js      # 对应 assetIndex
  frontend/assets/*
  frontend/asset-index.json    # 相对路径、bytes、sha256
  payload-index.json           # manifest/签名以外的 payload 记录，冻结 Merkle/hash 算法
  signatures/publisher.sig     # detached；签名覆盖指定 canonical payload
```
OCI 镜像位于独立 Registry，例如 `registry.internal.example/plugin/catalog@sha256:<64hex>`。Publisher 公钥信任根由管理员离线预置/审批；公开网页上传地址不自动授予发行权限。

## 建议发布流水线
1. 编译/测试后端，固定工具链、依赖锁与基础镜像 Digest；对 Java/Go/Node/Rust 等分别构建 OCI 镜像。
2. 校验运行平台 architecture、镜像运行用户、入口、health、SBOM/许可证/漏洞策略；限制特权、capabilities、挂载与网络。
3. 推送到镜像 Registry，获得不可变 manifest digest；**重新按 digest pull 验证**，不能相信 push 返回的 tag。
4. 构建 Web Remote 及 chunk，计算 asset-index；禁止需要动态请求不受控 CDN 的绝对脚本 URL。
5. 固定 Manifest 引用、计算 payload index、签名发布包；为 OCI image digest 分别生成受信签名/attestation，并将验签策略关联到发布者身份。
6. `opsctl plugin verify`（拟议命令）离线校验 bundle schema、路径与静态资产，在线准入额外检查 Registry image digest 和镜像签名。
7. 仅经管理员权限确认，才由 Kernel `Stage → Deploy → Ready → Activate`。运行时审计必须保存 package digest、image digest、front asset index digest、publisher、activation revision。

## 供应链失败策略
- bundle 签名可信 **不代表镜像可信**；缺镜像验签证据拒绝激活（可 staging，但不得执行）。
- tag 与 Digest 不符、架构不存在、缺 sbom/签名、镜像 Registry 故障：进入具体阶段的 `BLOCKED/FAILED`，旧版仍为 Effective。
- 制品允许离线搬运，但每个 artifact 的签名、digest 和来源证明需要一起搬运；不允许静默回退内置镜像/Mock。
- 包的权限申请、新增出站目的地、宿主挂载和 secret 需求必须在升级界面显示 Diff 并重新审批。

## 固定格式之前的工作
Canonical JSON 的具体算法、payload-index 根 Hash、image multi-platform index 选择、签名格式和 trust store 轮换都必须先用至少 Java/Go/TS/Rust 交叉读取的 Golden Fixtures 冻结。**当前给出的 Manifest、ZIP 目录与哈希示例仅是语法草案，不具备真实密钥/签名和可安装镜像。**
