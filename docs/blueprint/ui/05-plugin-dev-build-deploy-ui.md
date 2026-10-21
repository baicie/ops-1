# Web Console：插件构建、安装、部署、升级的完整交互

> 0.0.1 管理员界面不在浏览器里编译 Java/Go/Node 代码。编译由开发者本地/CI 完成；Web Console 负责**可信包审核、安装、部署、路由生效、诊断与恢复**。

## IA 与关键页面
```
Platform Shell
  Overview              # Fleet/Kernel/Health summary
  Plugins               # Installed / Catalog (trusted local) / Updates
    Plugin Detail        # Versions / Capabilities / Dependencies / Permissions / Deployments
    Installation Wizard  # Verify → Review → Place → Prepare → Activate
  Nodes                 # Fleet / Node Detail / Workloads / Basic Metrics
  Deployments           # Desired vs Observed vs Effective / Rollout Timeline
  Logs                  # Instance Tail / Filters / Resume / Gap
  Audit & Diagnostics   # Security/Deployment events / recovery hints
  Settings              # Trusted Publishers / Credentials / Policy
```

## 安装向导六步
1. **来源与内容**：可信 Publisher、包摘要、插件版本、Web Asset Hash、OCI Image Ref、OS/arch 支持；无签名时不可 Next。
2. **权限 Diff**：新读写/网络/Secret/CPU/内存/Node Scope 变化，用红线说明风险，不用绿色通知隐藏高风险请求。
3. **依赖与兼容**：Kernel API、Web SDK、插件依赖、API Compatibility、已运行旧前端页面。
4. **部署放置**：目标环境、replicas、节点资源、node labels、maxInstancesPerNode；显示容量不足、无法路由、不匹配架构等阻断状态。
5. **准备与校验**：逐节点下载镜像→启动→startup/info/ready，清楚显示哪个节点不 Ready 及原因。
6. **激活与审计**：展示 Activation Revision、旧/新有效路由、可否回滚；仅在声明的 Gate 达标后显示完成。

## 插件详情页基本线框
```
[icon] Data Catalog                    [Staged | Active | Degraded]   [Upgrade] [Disable]
Version 0.0.2   Publisher team     Bundle SHA256     Backend image SHA256
─────────────────────────────────────────────────────────────────────────────
Tabs: Overview | Versions | Deployments | Routes | Capabilities | Permissions | Audit

Health:  2 desired | 2 ready | 2 effective                 [View rollout]
Node A  ● Ready  image@sha256...  CPU ...  Memory ...           [Logs]
Node B  ● Ready  image@sha256...  CPU ...  Memory ...           [Logs]

Public API: data.catalog.v1
Depends on: platform.identity.v1
Frontend: /ext/... (asset digest)
Data lifecycle: plugin schema preserved on disable
```

## Live Logs 交互
- 默认单 Instance；有 Node/Stream/Time、Pause/Resume、Auto-scroll、Copy-with-redaction、Download with audit。
- SSE 断线后清楚标记 `Reconnecting`，Cursor expired 显示不可隐去的 `GAP` 行；高频日志到达引起 Client Buffer Overflow 时显示 Drop count，不静默吞掉。
- `403` 清除敏感内容缓存并关闭订阅；不可用时保留最后已知观察的 `asOf` 而不是显示绿点。

## 视觉规范
- 单个页面只有一个 Primary CTA；部署确认与破坏性操作必须分开。
- 层级为 `Page Heading → Summary/status → Primary work area → Inspector/Details`，避免每个指标一个装饰卡片、卡片嵌套卡片。
- 状态优先文字+形状+颜色共同表达；`UNKNOWN`、`UNREACHABLE`、`NOT_READY` 不使用与 Healthy 相同的配色。
- 6 场景截图验收：1440/1024/390 三宽度 × 浅/深色；另做长包名、超长错误、两副本故障、无限日志流键盘操作。
