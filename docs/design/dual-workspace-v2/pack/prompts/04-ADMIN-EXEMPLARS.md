# G03 / P0 — Admin 控制台三页样板：Overview、Plugins、Nodes

读取 `docs/04-design-system-and-shadcn-admin.md` 的 4.5/4.6、`docs/09-interaction-state-matrix.md`，逐一审计 `pages/Overview.tsx`, `Plugins.tsx`, `PluginDetail.tsx`, `Nodes.tsx`, `components/Ui.tsx` 与真实 API。

## 1. Overview

重做页面视觉层次：顶层可用性/异常、待处理事项与深链、最近变更。卡片少而有用，显示真实 observedAt；Node/Plugin/Kernel 不可用时中性/危险，不准给假 0/READY。保留刷新、错误与 Loading 的可用性。

## 2. Plugins

统一可筛选 DataTable：名称、Publisher/Trust、版本、Activation/READY、副本、最近状态、操作菜单。使用 DetailSheet/已存在详情页；“安装/禁用/回滚/卸载”有实际权限与确认，不因视觉变更误删数据。动态插件加载失败需可诊断。

## 3. Nodes

统一列表/卡片（390）、Node 详情和资源/历史状态。CPU/Memory/时间戳单位正确；资源快照空缺/过期显示 `NO_DATA`/`STALE` 而不是百分比 0 或绿色。支持筛选与深链，若图表来源不存在需明确缺口。

## 执行方式

按 Overview → Plugins → Nodes 三个可独立验收的提交单元推进；每单元更新真实浏览器 screenshot，并对比旧/新版本；CI/Playwright 严格绑定该 SHA。测试中文/英文、Light/Dark、1440/1024/390、empty/loading/error/forbidden、键盘/focus/移动端操作。

## 禁止

不要把 Catalog/Quality/Governance 的部署阻断用假数据掩盖，也不要为了页面展示强行插入未经标注的 Fixture。样板页不用进入 Incident/RCA 业务范围。

## 完成

三个页面均“可看、可点、可理解状态、能从异常走到详细操作”，有真正的 API 证据与截图；输出三页差异矩阵、缺陷清单、PR/HEAD/CI/Staging。继续 G04。
