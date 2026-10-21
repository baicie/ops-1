# UI 信息架构 / 导航 / 权限模型

## 产品交互原则
**先完成用户任务，再暴露系统结构**。用户不应该看到 Kernel 内部十几个 crate 的导航，也不应该在页面中同时看插件、容器、节点、权限的所有调试字段。默认视图围绕“平台健康、插件、节点、运行事件、权限”；开发者高级详情再展示 revisions、digest、capabilities。

### 0.0.1 一级导航
| 一级入口 | 页面 | 主要 CTA | RBAC |
|---|---|---|---|
| Overview | 平台健康、节点/插件摘要、近期事件、问题入口 | 查看需处理的异常 | Viewer |
| Plugins | Installed、Catalog（仅本地受信包）、Plugin Detail、Deploy/Upgrade | 安装签名包 / 部署 | Operator + Admin |
| Nodes | Node List、Node Detail、实例资源、心跳、日志 | 加入节点 / 查看故障 | Operator |
| Activity | Deployment Events、Audit、Failure timeline | 定位部署/权限失败 | Viewer 授权范围 |
| Access | Role/Permission/Publisher trust/Enrollment | 添加受信发行者、管理授权 | Admin |
| Settings | General、Artifacts、Runtime Policies、Diagnostics | 检查内核状态 | Admin |

保留开发者入口：`Developer / Extension Inspector` 是授权开关下的详情页，不占所有普通用户的主要导航。0.0.2 新增 `Data Sources`、`Data Catalog` 导航完全由插件贡献，而非修改 Kernel 路由表。

## 页面结构
- 主侧栏 240px（可折叠至 64px），顶栏 56px，主区域最大阅读宽 1480px；大型表格/日志/拓扑可以使用宽屏全幅布局。
- 页面结构固定：**标题 + 语义摘要 → 主要操作/工具栏 → 主内容 → 上下文诊断**。最多一个默认主 CTA；二级操作进入 dropdown/toolbar，不以十多个彩色按钮抢占视线。
- 列表→详情：列表保持过滤/页码；详情由 URL 深链、可刷新重建；删除/禁用/升级必须有确认和审计。
- 长错误完整信息使用右侧 Drawer 或独立 Diagnostics Tab；默认只展示影响、原因、下一步。
- 危险操作在聚焦语境中出现，不在每一行放不可辨别图标。

## 首次使用体验
1. Empty Overview 提示：先加入可信 Node，再安装 Hello 插件；下一步清楚、无死胡同。
2. Join Node Wizard 展示 mTLS Enrollment 令牌短期有效、命令/步骤、连通性检查；从不在普通审计日志回显令牌。
3. Plugin Install Wizard 先展示签名状态与请求权限，再选择 Nodes/副本数/资源，不允许把签名失败改成无提示“继续”。
4. 完成后自动带到 Plugin Detail：实例 Readiness、运行日志和新注册页面入口。

## 路由规划（建议）
```text
/                         Overview
/plugins                  Installed Plugins
/plugins/install          Install Wizard
/plugins/:id              Plugin Detail
/plugins/:id/deployments  Deployments
/nodes                    Node List
/nodes/:id                Node Detail
/instances/:id/logs       Instance Log Detail
/activity                 Activity and Audit
/access                   Access & Publishers
/settings/diagnostics     Bootstrap Diagnostics
/ext/:publisher/:plugin/*  Plugin-provided Routes
```

## 插件贡献的 UI 治理
Namespace 与路径冲突自动拒绝；不能覆盖 `/access`、`/plugins`、`/settings` 等内核路由；不能在未经批准时把顶级菜单增加到超过信息架构预算。插件可以贡献二级菜单/路由，但宿主拥有搜索、Breadcrumb、权限过滤、全局错误视图和键盘快捷键。

## 2026-10-22 管理员安装/发布交互
Plugins、Nodes、Deployments、Logs 与 Audit 路由保持独立；插件详情提供 OCI 镜像、前端资产、版本兼容与权限 Diff。安装向导严格六步，逐节点验证 Readiness 后才允许 Activate。详细线框见 [新增 UI 规范](05-plugin-dev-build-deploy-ui.md)。
