# 插件发布审批单

- Publisher / ID / Version / Artifact Digest:
- Signature verification key fingerprint and status:
- Tested Kernel/Web SDK compatibility:
- Changed Provides / Requires:
- Requested Permissions Diff:
- UI Contributions and route collision check:
- OCI Image Digests and SBOM:
- Resource/Network/Secret policy:
- Storage owner and migration plan / rollback compatibility:
- Staging Health Evidence:
- Activation Revision + Rollout Strategy:
- Rollback/Manual Recovery path:
- Reviewers and final decision:

## 插件多语言/OCI 发行附件（2026-10-22）
使用 [OCI Release Attestation](OCI_RELEASE_ATTESTATION.md) 单独记录 image digest、front asset-index digest、Bundle digest、签名 Publisher、三语言 Runtime Conformance、rootless Node/OS、兼容窗口与不可逆迁移风险。即便无后端或无前端也要明确 N/A，而不是生成虚假的签名。
