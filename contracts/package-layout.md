# 插件包与 OCI 镜像目录 — Manifest v1.1

```text
hello-ops.plugin.zip
  manifest.json                  # Canonical JSON; id/version/compatibility/artifactDigest
  frontend/remoteEntry.js        # Trusted Remote entry，允许 frontend:null
  frontend/assets/*
  frontend/asset-index.json      # asset path/size/sha256；本体 digest 由 Manifest 引用
  payload-index.json            # 已定义规范化 payload 哈希树（算法待 Fixture 冻结）
  signatures/publisher.sig      # detached publisher signature；不能把签名字节加进自身 digest
```

**后端 OCI Image 不存入 ZIP**：Manifest `backend.imageRef=registry/repo@sha256:...` 直接引用镜像仓库中的 Digest；Node pull/verify 后再启动。每种语言都使用相同镜像契约。

**三个不同的哈希：**
- `manifest.artifactDigest`: 与既有设计一致，指 payload 集合的规范化摘要（不是 ZIP hash，也不是 image digest）；签名协议需要明确覆盖范围与 fixture。
- `backend.imageRef`: 指 OCI Image Manifest 或 Index 的 digest；Registry 与 Node 都要校验供应链签名和拉取物摘要。
- `frontend.assetIndexDigest`: 静态资源索引 digest；索引内逐资产 digest；远程脚本单独有 `remoteEntryDigest`。
- Registry 自行计算**上传 ZIP 原始字节 `bundleDigest`**，不要嵌入 ZIP 自身避免自引用。

**路径与解包安全：** 限制压缩比、数量、最大字节、解包深度；拒绝绝对路径、`..`、Symlink Escape、重复名称/大小写冲突、超限与 ZIP Bomb；不允许运行上传时自带的任意 shell。

**兼容性与签名：** Manifest 1.1 是本轮冻结设计草案，替代 1.0 字段 `backend.imageDigest` 与 `healthPath`；真实升级前需要实现 1.0→1.1 拒绝或显式适配策略。Publisher 签名验证、镜像签名和 Payload Hash Fixture 独立于“JSON Schema 通过”；这份设计包内的 `sha256:aaaa...` 等仅为**语法示例，不是真实镜像/可信制品**。

**v0.0.1 接受策略**：仅受信 Publisher 签名包，禁止任意第三方运行；不支持下载无信任验证的远程 ZIP/JS。详见 [OCI 发布链](../docs/21-oci-artifacts-and-signing.md)。
