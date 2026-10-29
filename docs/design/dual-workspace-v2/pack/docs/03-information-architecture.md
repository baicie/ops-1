# 03 · 信息架构、导航与用户旅程

## 3.1 页面树（目标，不等于现状）

```text
/                   -> 授权的 Last Surface / 合理默认入口
/login              -> 唯一登录入口
/app                -> Business Workspace Shell
  /home             -> 我的工作台（未来业务数据）
  /incidents        -> Incident List
  /incidents/:id    -> Incident Investigation Workspace
  /investigations   -> 我的调查与历史报告
  /observability    -> 指标/Trace/Logs 受控入口
  /resources        -> 资源与拓扑
  /sources          -> 可用数据源/连接状态（授权业务视角）
  /reports          -> 报告与人工 Verdict
  /ext/:pluginId/*  -> 业务插件贡献
/admin              -> Platform Console Shell
  /overview         -> 维护概览：平台健康与异常
  /plugins          -> 插件及实例/签名/发布/安装
  /plugins/:id      -> 详情与生命周期
  /nodes            -> 节点、资源、实例、历史
  /deployments      -> 平台部署与版本（能力不成熟时不造假）
  /pipelines        -> 平台/插件级流水线管理（保留已有功能）
  /jobs             -> 维护与 Pipeline Job 管理
  /governance       -> 既有 Catalog 维护治理视图
  /activity         -> 审计与操作历史
  /access           -> 用户与权限
  /settings         -> 系统设置与诊断
  /ops-center       -> 运维中心
  /ext/:pluginId/*  -> 管理型插件贡献
/legacy/*           -> 临时兼容，必须有退役计划
/403                -> 无权访问
/404                -> 路由不存在
```

路由应有集中元数据 `{surface, routeId, requiredCapability?, breadcrumb, navGroup}`，不通过字符串猜测权限；`/app/*` 内容必须来自真实服务或显式 `COMING_SOON / DESIGN_PREVIEW`，不伪造 Incident 数据。

## 3.2 两侧导航分组

**Admin：**
- 平台：Overview / Components & Plugins / Nodes / Deployments
- 运行：Pipelines / Jobs / Governance（既有功能，后续审视是否重归属）
- 安全与诊断：Access / Activity / Settings / Ops Center
- 已授权 Admin Extension

**Business：**
- 工作：Home / Incidents / Investigations
- 发现：Observability / Resources
- 管理业务：Sources（需授权）/ Reports
- 已授权 Business Extension

重叠的“治理”不必原样复制：业务侧只看质量结果，平台侧看插件运行状况与配置。

## 3.3 交互流程

### 管理员切换
1. 管理员登录，只进行一次 Session 建立。
2. 点击顶部或左下 Surface Switcher，菜单显示 Business Workspace 与 Platform Console。
3. 切换到 `/admin/overview`，保留业务最近路径；返回 `/app/incidents` 保留筛选与打开的业务范围（可通过 URL search params 恢复）。
4. 刷新后仍在当前合法 Surface。权限撤销时**立刻不可再访问受保护 Admin API**；下次会话刷新收起入口并跳转拒绝页。

### 普通业务用户
1. 登录进入 `/app`。
2. 不出现 Platform Console 选项。
3. 输入 `/admin/nodes`，收到 Forbidden/Redirect，没有泄露节点、管理员数据或插件配置。
4. 浏览器 Back/Forward 不可借缓存展示受限 Admin 页面。

### Admin 典型操作
`平台异常提醒 → Node/Plugin 详情 → 原因与事件 → 授权操作 → 操作结果/审计 → 返回`。避免 Overview 是一堆没有行动路径的 KPI。

### Business 典型操作
`Incident List → 时间线和 Evidence → Hypothesis → Agent Query Steps → Verdict → Report`。详细目标与旧设计 08 节一致。

## 3.4 信息架构保护

- 不将 `admin` 作为业务 Workspace 名字或 ID；后台的 `surface=admin` 与授权业务 workspace ID 分开。
- 页面显示/隐藏属于 UX；绝不替代 API 级授权。
- `Legacy` 旧入口需要在 E2E 下兼容外部书签；旧路径不允许变成匿名或越权跳板。
- 插件路由优先保留固定 Namespace；冲突、重复、试图注册 `/admin` 或 `/app` 根路径时拒绝并在管理控制台报告原因。

## 3.5 推荐文案

- 菜单：`业务工作台`、`平台控制台`（不将二者都称作“工作空间”）。
- Admin 首页：`平台概览`，副标题 `管理运行环境、组件与平台健康`。
- Business 首页：`我的工作台`，副标题 `查看待处理故障与最近调查`。
- 权限不足：`无权访问平台控制台`，辅助说明 `请联系平台管理员申请相应权限`；不展示敏感资源详情。
