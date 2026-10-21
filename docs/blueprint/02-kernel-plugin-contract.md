# 全栈插件协议 / 生命周期 / Extension Host

## 插件单元
一个发布包可以包含：Web Remote、Backend OCI image、Worker image（0.0.1 接口预留）、配置 schema、Capability provides/requires、migration plan、权限与资源预算。发布包的逻辑 identity 为 `publisher/name`，版本遵循 SemVer，`packageDigest` 和各制品 digest 不可变；`id+version` 不允许重新指向其他二进制。

## 安装模型
1. **Upload/Resolve**：上传包或从受信 Artifact Store 拉取，限制大小与解压后路径；阻止 zip-slip、symlink escape、压缩炸弹。
2. **Verify**：校验 package hash、逐制品 digest、签名发布者、Manifest schema、平台 ABI/SDK/API 兼容范围、依赖图、requested permissions、目标节点资源。
3. **Stage**：不对外曝光，先注册候选版和待授权权限。
4. **Prepare**：必要时进行前向兼容的迁移，部署后端到预定节点，等待 readiness 与健康检查。
5. **Activate**：使用一个持久的 activation revision 原子切换 Capability/Route/UI Manifest 有效快照；旧版仍可在兼容窗口服务。
6. **Drain**：不再接受新请求，有界完成旧请求；保存必要 Job checkpoint（0.0.3），注销 Web 扩展及事件订阅。
7. **Rollback/Disable**：若新服务不可用，恢复旧版本路由；若数据迁移不兼容旧版，升级必须被阻止或走恢复流程，不能盲目回滚。
8. **Uninstall/Purge**：默认保留数据，`purge` 为独立高权限操作+备份确认。

## 生命周期状态
Package: `UPLOADED → VERIFIED → STAGED → INSTALLED`，失败 `REJECTED`；Deployment: `PENDING → PREPARING → READY → ACTIVE → DRAINING → DISABLED`，失败 `DEGRADED/FAILED`。**Observed instance state** 独立为 `STARTING/READY/UNHEALTHY/UNREACHABLE/STOPPED/UNKNOWN`。UI 不能将其中任一状态合并成 `SUCCESS`。

## 前端扩展点
| Extension Point | 输入约束 | 宿主行为 |
|---|---|---|
| `navigation.item.v1` | 唯一 route、label、permission | 权限过滤、排序、动态撤销 |
| `route.page.v1` | route、lazy module、layout、min-shell-api | 显示 loader、error boundary、cleanup hook |
| `panel.slot.v1` | host-owned slot、capability scope | 面板独立错误隔离与权限授权 |
| `command.v1` | command name、label、action capability | 由宿主做 permission check + confirmation |
| `settings.section.v1` | schema、scoped storage | 不暴露私有 token / Kernel 内部配置 |

0.0.1 完成 Navigation + Route + Settings；Panel/Command 可先定义契约与一例，不做全通用 IDE 工作台。

### 前端兼容与信任
- 前端只允许受信的已签名发行者 Remote；共享 React 单例及 Web SDK 精确兼容范围；资源 URL 内容寻址，禁止覆盖现有相同路径。
- 动态 JS 模块**并非**沙箱；签名不能消除 XSS 或恶意逻辑风险。不可信第三方 UI 在未来仅允许独立 Origin + sandbox iframe + message protocol。
- 旧 tab 可能持有旧 JS，故 Backend API 需设定明确前后兼容窗口；通过 `activationRevision` 触发“安全刷新/重新加载”；不能把服务切换当作 JS 从内存卸载。
- 远程模块不能拿到原始会话 Token；通过 Shell 能力客户端发起受控 HTTP。UI 权限隐藏不等于服务器权限。

## 后端 Capability
- 定义 `provides`/`requires`，能力包含 name、major contract version、API schema digest、权限、scope、执行模式(sync/async)。
- 通过 Registry 获取**逻辑能力**；Gateway 解析健康实例、身份、资源范围、预算和重试语义；禁止直接依赖节点 IP/端口。
- 0.0.1 提供 service HTTP request/response，幂等读取请求可在健康副本上重试；写请求未经 idempotency token 与已知失败状态不得隐式重试。
- 多提供者解析：明确 Provider Selection Policy (default/specified/capability)；无可用 provider 返回 `CAPABILITY_UNAVAILABLE`，不静默切到 Mock。
- `requires` 对 `provides` 版本兼容进行依赖验证；需要避免循环依赖和在部署中途失去依赖。

## 数据与升级
- 插件声明 storage ownership、Migration Plan。Kernel 提供迁移准入、锁/记录与审计；实际迁移运行在授权的迁移环境，不能通过前端 SQL 任意执行。
- 前向兼容 `expand → migrate → contract`，破坏旧版兼容的 contract 阶段必须在旧实例全部退场及回滚窗口结束后。
- 不允许服务升级流程将不兼容的数据库变更伪装为可自动回滚。
- v0.0.1 示例见 `contracts/examples/plugin-manifest.json`、`contracts/schema/plugin-manifest.v1.schema.json`。

## 2026-10-22 Manifest v1.1 / Runtime v1 附加约束
- `contracts/schema/plugin-manifest.v1.schema.json` 已从 `schemaVersion=1.0` 草案升级为 `1.1`，以 `backend.imageRef`、`protocol{http-json,1,containerPort}` 和 `health{readinessPath,livenessPath,startupPath?}` 取代原来的单一 `imageDigest` + `healthPath`；frontend 增加 `assetIndex/assetIndexDigest/remoteEntryDigest`。1.0 实例不得被 1.1 读取器静默当成有效。
- 后端容器的 Runtime Info 自报必须与受信发布契约核对，但不能授权自己增删 capabilities；SLA 与错误语义由 [plugin-runtime-v1](../contracts/openapi/plugin-runtime-v1.yaml) 确定。
- 发布器为 OCI 镜像签名，安装包发布者签名独立存在。前端资源不可变，旧浏览器 Tab 的兼容窗口是真实义务；详见 [升级回滚](25-rolling-release-and-rollback.md)。
