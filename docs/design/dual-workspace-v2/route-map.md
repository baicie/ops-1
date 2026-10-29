# 路由图与 Surface 归属（G00 实测 + 迁移目标）

现状 **20 条路由全部挂在单一 `RequireAuth` 之下**，没有 `/admin` 或 `/app` 前缀。
下表是本轮审计得到的真实路由、Surface 归属判断与迁移目标。

## 1. 现状路由

| 现状路由 | 页面 | 归属 Surface（判断） | 迁移目标 | 迁移风险 |
|---|---|---|---|---|
| `/` | Overview | **admin** | `/admin/overview` | 低（旧 `/` 重定向需按权限分流） |
| `/plugins` | Plugins | admin | `/admin/plugins` | 低 |
| `/plugins/install` | InstallWizard | admin | `/admin/plugins/install` | 中（向导 4 步 + 上传） |
| `/plugins/:id` | PluginDetail | admin | `/admin/plugins/:id` | 中（6 个 tab + 5 个确认弹窗） |
| `/pipelines` | Pipelines | admin | `/admin/pipelines` | 低 |
| `/pipelines/:pipelineId` | PipelineDetail | admin | `/admin/pipelines/:pipelineId` | 低 |
| `/pipelines/:pipelineId/editor` | PipelineStudio | admin | `/admin/pipelines/:pipelineId/editor` | **中高**（React Flow + 未迁移的 `.btn` 类名） |
| `/pipelines/:pipelineId/run` | JobSubmit | admin | `/admin/pipelines/:pipelineId/run` | 低 |
| `/jobs` | Jobs | admin | `/admin/jobs` | 低 |
| `/jobs/:jobId` | JobDetail | admin | `/admin/jobs/:jobId` | 低 |
| `/nodes` | Nodes | admin | `/admin/nodes` | 低 |
| `/nodes/:id` | NodeDetail | admin | `/admin/nodes/:id` | 低 |
| `/governance` | Governance | **admin**（维护视角） | `/admin/governance` | 中（业务侧未来只投影质量结果，不复制此页） |
| `/instances/:id/logs` | InstanceLogs | admin | `/admin/instances/:id/logs` | 低 |
| `/activity` | Activity | admin | `/admin/activity` | 低 |
| `/access` | Access | admin | `/admin/access` | 中（RBAC 相关，G05 同步） |
| `/settings` | Settings | admin | `/admin/settings` | 低 |
| `/settings/diagnostics` | Diagnostics | admin | `/admin/settings/diagnostics` | 低 |
| `/ops-center` | OpsCenter | admin | `/admin/ops-center` | 低 |
| `/ext/*` | ExtensionRoute | **两者都可能** | `/admin/ext/*` + `/app/ext/*` | **高**（需要 v2 surface 合同，G06） |
| `*` | NotFound | 共用 | 保留 | 低 |

**结论**：现有 20 条路由**全部是平台维护语义**，没有一条属于业务 Workspace。
`Pipeline Studio` 是编排工具，**不是** Incident/Investigation UI，不得当作业务能力交付。

## 2. 目标路由（G04 落地）

```text
/                 -> 按授权与上次 Surface 分流（admin → /admin/overview；仅业务 → /app/home）
/login            -> 唯一登录入口（保留）
/admin/*          -> Platform Console（上表迁移目标）
/app/home         -> 业务工作台首页
/app/incidents    -> Incident 列表（G07 建壳 + 明确 COMING_SOON 状态，不造假数据）
/app/investigations, /app/observability, /app/resources, /app/sources, /app/reports -> G07 建壳
/app/ext/*        -> 业务插件贡献
/403              -> 无权访问（新增）
/legacy/*         -> 临时兼容 + 退役计划
```

## 3. 旧 URL 兼容策略

1. **先建映射表并加测试**，再改路由（`docs/08 §8.4`）。
2. 旧路径一律 302/重定向到对应 `/admin/*`（业务语义的另议）；深链参数只允许 allowlist 透传。
3. 重定向**不得绕过鉴权**：`/nodes` → `/admin/nodes` 后仍走 `RequireAuth` + Surface 守卫。
4. 兼容窗口内保留旧 E2E 回归；退役需单独 Gate。

## 4. 插件路由与保留前缀

现状 `SHELL_RESERVED = ['/plugins','/nodes','/activity','/access','/settings','/ops-center','/instances']`。
G04 后这些前缀将移到 `/admin` 之下，G06 需要：
- 把保留清单升级为 **surface-aware**（`/admin`、`/app` 根路径本身不可被插件注册）；
- 冲突检测在安装/激活时执行并在控制台报告原因，而不是静默失败；
- v1 `navigation.item.v1` 继续工作（默认归 admin surface），v2 新增 surface 字段。
