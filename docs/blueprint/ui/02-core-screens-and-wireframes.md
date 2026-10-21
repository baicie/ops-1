# 0.0.1 核心页面规格与线框图

以下是信息和交互线框，不是最终视觉稿。所有数据示例均虚构；UI 实施必须使用真实契约/Fixture 并在运行环境截图审查。

## A. Overview（首屏）
```text
┌───────────── Navigation ─────────────┬────────────────────────────────────────┐
│ OpsWeave                             │ Overview     [Workspace] [Settings]    │
│ Overview                             │                                        │
│ Plugins                              │ Platform health: Degraded (1 issue)   │
│ Nodes                                │ Nodes 2 / 2 | Instances 3 / 4 | ...   │
│ Activity                             │                                        │
│ Access                               │ Attention                               │
│ Settings                             │ • Node B heartbeat stale [Inspect]    │
│                                      │ • Plugin v2 pending approval [Review]  │
│                                      │                                        │
│                                      │ Recent deployment events / timeline    │
└──────────────────────────────────────┴────────────────────────────────────────┘
```
**可见决策**：首先告诉用户需做什么，问题列表按严重性排序，不能用假“系统正常”填充无数据。点击 issue 进入具体 Node/Plugin Detail，支持详情深链。

## B. Installed Plugins / Plugin Detail
```text
Plugin: hello-ops  v1.0.0 [Active]                 [Upgrade] [Disable] […]
Publisher: trusted-team  Signature verified   Dependencies: none
Tabs: Overview | Deployments | Capabilities | Permissions | Events | Logs
Overview: two instances / desired 2 / ready 2
A  Ready    1.0.0  10.0.0.X  CPU/MEM  [View logs]
B  Ready    1.0.0  10.0.0.Y  CPU/MEM  [View logs]
```
**升级**前弹出版本/能力/权限/Schema Migration Diff；如 permission 扩张必须重新批准。Disable 有依赖时展示阻止原因，不让按钮变灰而无解释。

## C. Installation Wizard
1. Select trusted package / paste digest（显示 Publisher，签名异常阻止继续）；
2. Review permissions + dependency graph + compatibility；
3. Select instances, node labels, CPU/RAM budget；
4. Stage/Readiness，进度真实、阶段可查看、重试有界；
5. Activate preview and Result（失败保留旧版且提供 Diagnostics 链接）。
**不能自动跳过签名/权限页**；`Stage` 与 `Activate` 明确分离。

## D. Nodes / Node Detail
- 列表：Node、Verified Identity、OS/Arch、Capability labels、Heartbeat `observed_at`、Status、Plugin instances、CPU/Memory/Disk。
- Detail Header：`Ready` 仅意味着节点控制通道可用；插件实例另有 Readiness；Unknown 显示最后观察时间。
- Tabs：Overview（基本资源仪表）/ Instances（可排序）/ Events / Live Logs / Enrollment（Admin）。
- `Cordon`、`Drain` 作为将来能力预留，0.0.1 仅包含有界停用和单节点维护模式（如实现并测试）。

## E. Instance Live Logs
```text
Instance ai-plugin@node-b  ● Connected  Stream stdout   [Pause] [Follow] [Copy]
Filter [ level ... ] [contains text ... ]  Window: last 500 events
18:22:04.217 INFO  server started request_id=...
18:22:05.001 WARN  upstream timeout...
──── Connection lost. Last event: 917. [Reconnect] ────
──── GAP: cursor expired; older entries unavailable ─────
```
- 默认 Follow 最新；Pause 有明确“仅暂停界面”与“停止订阅”语义；过滤支持复制时保持时间与原文；大量日志分行虚拟化。
- 不使用 `dangerouslySetInnerHTML` 显示日志、ANSI escape 明确转义；日志中超长 JSON 可折叠。

## F. Access / Trusted Publishers
- 在屏幕上清晰区分 User Roles、Node Trust、Publisher Keys、Plugin Capability Grants。
- 证书/密钥完整正文永不展示；仅指纹/有效期/最后轮换时间；撤销操作显示受影响节点/实例。

## G. Bootstrap Recovery
- 无业务插件时仍可打开：Kernel live/readiness、DB connectivity、节点注册状态、最近失败安装及诊断日志。
- 不需要加载非核心远程 JS 才能查看，恢复操作通过独立授权和审计。

## 响应式
- 1440：侧栏/主内容，Node detail 可同时两列；
- 1024：压缩次要元数据，表格列选择、详情抽屉；
- 390：侧栏变抽屉，表格变可纵向阅读的条目列表，保留操作/错误/状态，日志支持横向独立滚动。
- 深色：对比度、边框密度、图表和状态显著性重新验收，不能只做颜色反转。
