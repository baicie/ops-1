# G06 / P0 — 让插件区分 Admin/Workspace 并保持签名 v1 兼容

先审计 `apps/platform-web/src/extensions.tsx`、`apps/kernel/src` 的 Extension API/manifest 验证、`contracts/` schema、`plugins/*/manifest.template.json`、`scripts/build-plugins.sh` 与现有签名 Bundle 流程。阅读 `docs/07-plugin-contribution-contract.md`、`contracts/surface-contributions.v2.example.json`、`docs/06-auth-and-permissions.md`。不要直接把示例 JSON 当已实现协议。

## 任务

1. 列出 v1 `navigation.item.v1`, `route.page.v1` 的签名语义、旧 bundle/asset 路径、激活版本和现有插件列表。
2. 写 ADR + Contracts：双 Surface 贡献是否需要 v2 kind / optional `surface`，如何兼容已签 v1，以及如何拒绝未经签名字段变更。保护 `/admin`, `/app`, `/login`, `/api`, `/internal`, `/assets` 等根路径。
3. 增加服务端合法性检查与授权：只有已激活、有权的贡献能发送给当前用户；客户端二次筛选只是 UX。不同插件/版本/Scope 的路由不会冲突。
4. 实现 Admin 和 Workspace 自己的 ExtensionNavigation 与 ExtensionRoute 注册，严格 Namespace，例如 `/admin/ext/:pluginId/*`、`/app/ext/:pluginId/*`。旧 `/ext/*` 保留受控兼容引导，不可以绕权限。
5. 升级/停用/卸载/激活 Revision 改变时，前端刷新导航与远程 Assets；旧版本 Asset 不该冒充新版本。
6. 官方插件做一个真实最小贡献样例：平台维护页面放 Admin，业务质量/报告入口放 Workspace（如果业务后端未成熟，可明确标 `NOT_AVAILABLE`，不能复制同一管理页面冒充产品）。
7. 记录远端 UMD JS 的受信同源边界：即使有 Signed Manifest，不能宣称 hostile plugin sandbox isolation；今后如需 sandbox 单立 ADR。
8. 建立负向测试：非法路径、跨 Surface 路由、重复贡献、viewer 调用 Admin API、失活插件、签名 v1 bundle 原样回归。

## 严禁

不能把远端代码通过 `window.React` 接口加上未审核的原始 Cookie/Token；不能修改已经签名的 bundle 文件而不重新签名；不能把合约示意当成熟组件 Marketplace。

## 验收

v1 真实插件依旧可用，v2 两个 Surface 受控注册，各权限矩阵有真实 E2E/Contract 证明，UI 不暴露越权入口；报告 Schema/Manifest compatibility、Release SHA、Playwright 和 Staging 状态。完成后 G07。
