# Skill：OCI 插件发布审查

触发：发布全栈插件、改变 Dockerfile/基础镜像、Node OCI Adapter 或签名流程。

1. 读取 Manifest v1.1、OCI Image Index、Frontend Asset Index，核对不变 Digest、平台架构与权限范围。
2. 审查构建锁定、SBOM/依赖来源、签名 Publisher、Registry 权限与 Secret 来源。
3. 检查容器运行策略：rootless、非 root、只读 rootfs、资源限制、host socket/host mount 拒绝、网络策略。
4. 执行镜像 pull@digest 与合约测试、脏数据/失败拉取/损坏镜像/权限 Diff 测试。
5. 生成 `templates/OCI_RELEASE_ATTESTATION.md` 证据表，区分 VERIFIED 与 NOT_RUN。

产出：镜像摘要、frontend hash、Package Digest、OS/arch、运行时版本、测试命令、签名状态、发布/回滚判断。禁止无证据签署。
