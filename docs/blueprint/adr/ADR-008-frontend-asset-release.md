# ADR-008：前端远程模块与后端 OCI 镜像分别交付（接受）

- 日期：2026-10-22；决定：业务前端交付为签名发布包关联的不可变静态资源；后端作为 OCI 镜像存入 Registry。一个发布版本用 Manifest 关联两者，但不要求同一 Docker 镜像。
- Kernel Package Registry 保存插件逻辑版本和安装/生效代次；Gateway/Asset Server 按 revision 暴露对应前端 JS/CSS 与后端服务路由。
- Runtime Module Federation 仅作为 Web Remote Loader 的实现，不把某一打包器绑定到公共 Extension API。远程模块与 Shell 共享页面执行权限，因此 0.0.1 只接受可信审核插件。
- 后端升级要兼容仍在浏览器里运行的旧 frontend；前端资源按 content hash 路径保留，不可覆盖；UI 有版本失效/安全刷新状态。卸载 route/subscribe 并不代表已注入 JS 可从内存强制删除。
- 对不可信 Web UI 采取将来的独立 Origin + sandbox iframe + capability message protocol；不允许当前 Remote 靠签名就宣称隔离执行。
- 不选择“为每个插件前端起一个 nginx Docker 容器”，因小组件带来过多进程与网络面；若完全自带 Web 服务，也必须通过统一 Assets Gateway 且资源不可变、受信任。
