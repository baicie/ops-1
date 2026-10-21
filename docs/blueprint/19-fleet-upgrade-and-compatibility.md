# Node Runtime / Kernel / Plugin SDK 的长期升级与协议兼容

## 为什么需要单独设计
热插拔的是业务插件，而 Kernel、Node Runtime、Web Shell、Plugin SDK 仍需正常发版。一个分布式平台不可能假设所有节点永远是同一版本；控制面升级和插件滚动升级不是同一个问题。

## 四轴兼容矩阵

| 轴 | 0.0.1 政策 | 不兼容处理 |
|---|---|---|
| Kernel API major | 每个插件 Manifest 显式要求 major | 禁止激活/升级 Kernel 前检查 |
| Node Control Protocol major | Node Hello 报告 protocol major/minor + feature flags | major 不合则拒绝控制命令并标明原因 |
| Web Shell SDK major | Frontend Remote Manifest 要求 major + Shared React 兼容 | 不加载 incompatible remote，保留安全错误页 |
| Plugin Capability major | 每个 provides/requires 声明接口大版本 | 不兼容则阻止相关插件 Activation/Disable |

## Node Runtime 自身升级
1. 先确认 Kernel 支持新旧 Node Protocol（至少一个明确的 rolling compatibility window）。
2. 将 Node 标记为维护中：撤销新路由 / 对有状态任务 Drain；0.0.1 无正式 Durable Worker，仅需停止新请求与有界 Drain。
3. 使用**独立于被升级进程的 Supervisor 或系统服务管理器**验证下载包签名、启动新 Node 二进制、健康握手及回报版本；避免 Node 自删正在运行的可执行文件后无法恢复。
4. 新版 mTLS 重联成功才取消维护状态，Kernel 对账 Observed/Desired。失败在受控窗口内使用旧版已签名二进制恢复。
5. 两台 Node 逐台升级，保证另一台可服务；不得同时重启所有副本。

## Kernel 升级
- **0.0.1 Kernel 是单实例**：Kernel 自身版本升级可产生管理面短时不可用，必须承认；这是独立于插件零重启更新的限制。
- Kernel 先迁移向前兼容 Schema，再升级二进制，Node Protocol 新旧兼容窗口必须先验证；若存在破坏性 DB 迁移，停止并人工安排维护窗口。
- Kernel/PG 的生产 HA、蓝绿发布、多实例 leader fencing 是后续 milestone，不得在 0.0.1 宣称。

## Web Shell 升级
CDN/静态资源内容寻址、Cache-Control 明确策略、旧 Web Shell Tab 不立即消失；发布时使用兼容 API window 或提示刷新，未保存草稿不得强制丢弃。插件激活时发送 activation revision change，而不是要求重建整个 Web Shell。

## Plugin SDK 发布与兼容测试
`kernel X node`、`kernel X web`、`kernel X plugin-sdk`、`plugin consumer X provider` 四个矩阵分别维护；记录哪个组合是 tested / unsupported / deprecated。不得用“SemVer 按理应该兼容”替代真实行为测试。

## 发布约束
- 任何改变 Node Control Protocol 的 PR 必须附兼容矩阵和双版本连接测试。
- 任何涉及 rollout/rolling shutdown 的 PR 必须证明至少一个健康插件副本继续请求服务。
- 任何无法从旧版安全回滚的变更须明显提示不可逆条件并提供恢复 Runbook。

## 五轴版本协商（本轮修订）
在既有 Kernel/Node/Shell/Plugin SDK 之外，**Plugin Runtime Protocol v1 和 OCI Reference Adapter** 是独立版本轴；另有 Web Remote Asset Loader 的兼容版本。升级前运行兼容性矩阵，不能用一个 `sdkVersion` 推断所有 ABI/API 都兼容。
- 0.0.1 Node Runtime 升级前确认 Engine 适配器版本、rootless socket、cgroup、OS/arch。Node 升级不能用“自我替换并立即删除旧进程”的方式破坏正在运行的插件。
- Backend Java/Go/TS 与 Runtime v1 协商不应进入 Kernel 特判；协议升级需同时提供旧版 conformance fixtures。
- **前端生效代次**与**后端镜像部署代次**可短时间不同，但必须处在已签署的兼容窗口中。不可兼容时禁止激活，而不是让旧 Tab 默默报错。
