# 02 · 产品定义、Persona 与双 Surface 边界

## 2.1 精确定义

**Surface** = 顶层产品界面与权限边界。固定两种：`admin`、`workspace`。  
**Workspace（业务空间）** = 用户归属的一个业务域/团队/项目上下文（未来可多实例）；不是平台管理控制台。  
**Plugin** = 按 Kernel 验证/部署/激活的能力组件，可选择为一个或两个 Surface 提供 UI。  
**Module/Feature** = 在一个 Surface 内完成工作的一组页面/API，而非独立租户。

第一版只有默认业务 Workspace，不设计多租户/计费/自定义 Workspace CRUD；先准备可扩展接口，而不制造空产品。

## 2.2 用户与任务

| Persona | 主要问题 | 默认入口 | 是否见 `/admin` |
|---|---|---|---|
| 值班工程师 | 哪些故障影响服务、如何排障 | `/app/incidents` | 否 |
| 研发/服务负责人 | Trace/Log/指标与根因证据 | `/app/investigations` | 否 |
| 业务域管理员 | 团队分工、Incident 审批/权限范围 | `/app` | 默认否 |
| 平台维护者 | 插件安装、升级、节点、诊断、备份 | `/admin` 或最近一次 Surface | 经过服务端授权 |
| 平台管理员 | 平台身份、插件信任、升级、系统配置 | `/admin` | 是 |

管理权限与业务数据读取权限是两条轴；**平台 admin 不自动获得所有业务域所有事故/日志的读取权限**（第一版若现有 RBAC 做不到，应在权限矩阵标注显式过渡差异，不伪造隔离）。

## 2.3 核心产品原则

- Single login, shared session; 切换 Surface 时**不再登录**，但目标资源仍需服务端鉴权。
- `admin` 是授权的控制台入口；不可视为用户可创建的 Workspace。
- 业务人员不暴露 Node/OCI/Publisher/Bundle/Deployment/Capability 的实现概念；业务插件提供业务功能。
- 管理员可查看已授权业务 Workspace，但不可借管理 Surface 直接绕过业务授权。
- 用户进入 `/`：若最近一次使用的 Surface 仍获授权，恢复到记忆路径；否则落到有真实功能的 Business Home；在 Business 尚未就绪的迁移期，对仅 admin 用户允许落入 `/admin`，**不能把空白占位页当成产品交付**。
- Surface Switcher：在头像菜单或工作空间选择器区域，显示“业务工作台 / 平台控制台”两项；无 Admin 权限则只显示业务项。支持键盘、移动端、地址链接、最近路径记忆。

## 2.4 业务能力不等于平台维护功能

| 能力 | Platform Console | Business Workspace |
|---|---|---|
| 插件安装、签名、版本、启停、回滚 | 主操作 | 不可直接操作 |
| Node 状态、实例、日志 | 完整维护 | 只在业务资源视角有权限时以相关信息展示 |
| Catalog/Integration 部署 | 平台侧实例部署 | 数据接入配置可作为受控业务功能提供，需明确授权 |
| Quality/Governance | 插件自身配置和健康 | 数据质量报告/业务治理可单独投影，不是复制整个管理页 |
| Incident / RCA | 只提供服务健康、配置诊断 | 主流程与审阅 |
| 用户/RBAC/Publisher 信任 | 平台身份管理 | 业务域成员管理后续单独设计 |

## 2.5 非目标 / 范围控制

- 不引入第二身份系统、不做第二套登录页、不拆两套 API Gateway。
- 不以一个 `admin` 布尔值授权所有后台操作。
- 不立即支持任意用户创建多个工作空间；真实组织边界/tenant model 到位后再设计。
- 不做 Admin Console 里随意拖拽 Dashboard、小组件商城，也不把业务调查内容灌进 Platform Overview。
- 不把具备管理员身份当成自动可以读取全部原始 Trace/Log。

## 2.6 产品成功度量

最小成功：管理员从 `/admin/plugins` 升级/核验插件（在权限范围内），无需登出直接切换到 `/app` 浏览授权业务内容，业务用户直接输入 `/admin/*` 被拒绝；旧业务页面迁移不丢功能。

进阶成功：第一个 `Incident → Evidence → Verdict` 可真实演示后，普通用户不必理解插件、Node、Gateway 或 Workflow 仍能完成调查。
