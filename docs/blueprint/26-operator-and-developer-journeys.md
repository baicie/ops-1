# 开发者与管理员完整用户旅程

## 开发者：创建 → 调试 → 发布 Java 插件
1. 在本地 `opsctl plugin create --language java` 生成项目模板（规划 CLI）；根据 Manifest 指定 `provides/permissions/resources`。
2. `opsctl plugin dev` 仅在 Dev Shell 临时注册 Remote；Java 本机进程热重启，Web Vite HMR。Dev identity 明确限制在 localhost/dev tenant。
3. 编写 OpenAPI、业务权限、Runtime Info/Health；在本地运行通用合约套件，确认 Java 服务与 Go/TS 同一协议。
4. CI 用固定 JDK/Gradle 与 Docker 构建 OCI Image；扫描、SBOM、签名、image@digest。
5. React 前端生成远程 JS/CSS，固定 Chunk Hash/Asset Index；生成 Manifest 包并签名。
6. 安装到测试环境：上传包 → 显示权限差异 → 验签 → 分配节点 → readiness → 版本切换，保留旧制品。
7. 查看审计与日志，并与管理员交接升级/恢复策略。

## 管理员：安装两副本插件
1. 选择可信 Publisher 的包（不自动执行上传文件）。
2. 安装向导展示 Plugin ID、SemVer、前端 URL、OCI Registry/Image Digest、支持 OS/arch、请求权限/出站/Secret、数据库迁移。
3. 用户选择环境、节点标签和副本数=2；平台展示实时可放置容量与失败原因。
4. 下载镜像并校验签名：如果 Registry 访问失败、镜像不匹配或节点资源不足，不允许激活。
5. UI 展示 Prepared A/B、Ready A/B、Effective Revision；Web 路由/菜单随 revision 变化。
6. 日志页面以 instanceId/nodeId/time/stream/cursor 定位实时与最近历史日志；必须有权限、背压、Gap。
7. 升级向导显示前后端 API 兼容窗口、权限 Diff 和 DB Migration 风险，再执行滚动发布。

## 恢复操作者：平台 UI 不可用
- `opsctl status/nodes/instances/logs/doctor` 通过受控管理路径查询 Bootstrap Diagnostics；必要时 `opsctl plugins disable` 带确认与审计。
- Kernel 失联时 Node 不获得永久操作权限；重连后按 Desired/Observed/Effective 对账。
- 禁止 Node 自行联网拉取所谓“最新镜像”修复故障，所有目标镜像须由可信期望状态签发。

## 明确失败场景
- 丢失网络、证书吊销、架构不匹配、镜像拉取超时、GPU 声明不受支持、端口探针错误、数据库拒绝迁移、前端资源 404、不同版本 Web Tab、发布者签名不可信、两个节点只有一个 Ready，都必须有**独立错误码 + UI 状态 + 操作者下一步**。
