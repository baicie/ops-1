# 09 · 交互、状态和权限矩阵

## 9.1 全局状态语义

| 状态 | UI 指引 | 反例 |
|---|---|---|
| Loading | Skeleton/Progress，有超时/取消语义 | 永远 Spin |
| Empty | 资源真实为空，提供下一操作 | 误报无权限 |
| No Data | 数据源存在但当前时间窗无样本 | 展示 0 指标 |
| Unknown | 观测/权限无法确认，中性状态 | 绿色 READY |
| Partial | 列出哪些来源成功/失败 | “已成功”覆盖缺口 |
| Stale | 显示最后数据时间，提供刷新 | 使用陈旧数据计算百分比不提示 |
| Error | 稳定错误码/请求 ID/重试 | 把服务端原始内部异常直接显示 |
| Forbidden | 无权操作，不暴露资源细节 | 仅 CSS 隐藏按钮 |
| Conflict | 并发更新、版本变更可理解 | 静默覆盖 |
| Demo/Fixture | 清楚标记 DEMO | 假装真实故障 |
| Success | 已收到后端确认，真实状态更新 | 点击按钮立刻绿勾 |

## 9.2 Shell 状态矩阵

| 场景 | Admin Shell | Business Shell | 预期 |
|---|---|---|---|
| 匿名 | Redirect Login | Redirect Login | 同一登录 |
| viewer | Forbidden | 可访问授权业务 | 无 Admin 菜单 |
| operator | 依当前授权过渡策略 | 授权业务 | 不偷偷打断现有角色操作 |
| admin | 正常 | 授权业务 | 无需登出切换 |
| Session 过期 | Login/401 | Login/401 | 清缓存 |
| 权限撤销 | 403+清敏感缓存 | 对业务按权限 | 不展示旧数据 |
| 直接深链 | 恢复标题/侧栏/权限 | 恢复上下文 | 不出现双 Layout |
| Back/Forward | 不泄露 | 稳定 | 状态/URL 一致 |
| Mobile | Sheet Sidebar | 专属简单导航 | 无横向溢出 |

## 9.3 Platform Overview

- `Loading`: 分模块 Skeleton；`Ready`: 更新 observedAt、异常数量可深链；`Degraded`: 折叠详情/可检查根因；`No Data`: 模块未配置说明；`Stale`: 不绿色。
- 每个错误状态必须可回到受限路径，不显示数据源/凭据。

## 9.4 Plugins

- 安装：上传/验证/签名校验/部署/激活/结果；状态区分 VERIFIED/STAGED/READY/ACTIVE/FAILED。
- 版本冲突：显示发布者、签名摘要、当前版本、目标版本；失败不能自动删除数据。
- 表格空数据 vs 加载 vs 权限不足；强危操作二次确认；后台更新后导航失效及时刷新。

## 9.5 Nodes

- Heartbeat 新鲜/过期、Node READY/UNREACHABLE/REVOKED。
- `memoryTotalBytes` 缺失或不合法：不能画 0% 或绿色容量。
- Node 临时断开：保留最后观测时间，并提示数据可能过期。
- 列表分页/时间窗/历史图，显示实际 `observedAt` 和 Units。

## 9.6 Plugin Extension

- 插件未安装/未激活/升级中/扩展 JS 加载失败/贡献不合法/冲突/无权/网络失败/版本不兼容。
- 每类状态必须明确对应 Surface 和错误，不把 Extension crash 扩散到整站。

## 9.7 Business（先预留，后真实实施）

- Incident: New/Acknowledged/Investigating/Resolved 与 source incident ID；未实现的页面不创建假列表。
- Evidence: Available/No Data/Partial/Stale/Unavailable/Forbidden；每条记录附来源、窗口、查询ID、摘要/引用。
- Hypothesis: Supported/Refuted/Unverified/Inconclusive；不把 AI 输出当结论事实。
- Verdict: Human Confirmed/Rejected/Uncertain 与 Author/Time，独立于 Incident Closed。

## 9.8 视觉验收矩阵

| Viewport | Light | Dark | en | zh-CN | Screenshot |
|---|---|---|---|---|---|
| 1440 | ✓ | ✓ | ✓ | ✓ | Required |
| 1024 | ✓ | ✓ | ✓ | ✓ | Required |
| 390 | ✓ | ✓ | ✓ | ✓ | Required |

每个样板页：Overview/Plugins/Nodes/Surface Switcher/403/Login/Extension Error；重要操作状态单独截图。截图命名带 `sha` 与 `surface`、`route`、`viewport`、`theme`、`locale`、`state`，不把截图入源码树（CI Artifact 上传）。
