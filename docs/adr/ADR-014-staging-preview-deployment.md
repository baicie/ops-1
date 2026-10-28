# ADR-014: Staging 预览部署形态（单主机 / 镜像化 / SHA 固定 / 可回滚）

- 状态：Accepted（staging-only；不改变生产发布策略）
- 日期：2026-10-28
- 版本状态：本 ADR **不**改变 `0.0.5_PARTIAL`
- 前置：`docs/adr/ADR-011..013`、`docs/RUNBOOK.md`

## 1. 目标

让「Commit → Push → 构建 → 部署 → 浏览器可见」成为同一条闭环：每次提交后能用**固定地址**打开最新经过验证的 OpsWeave，并知道自己在看哪个 SHA。

非目标：Kubernetes、多集群、GitOps 平台、Canary、生产发布审批。本 ADR 只解决一台机器、一个环境、一次提交、一键发布、失败可回滚。

## 2. 决定性约束（来自真实源码，非假设）

| # | 约束 | 证据 |
|---|---|---|
| C1 | **Kernel 每次心跳都校验 Node 上报的 `data_endpoint`，明文 http 仅允许 loopback**；非 loopback 的 http 即使开 `OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT=1` 也返回 400 | `apps/kernel/src/nodes.rs:180-232`、`:406-413` |
| C2 | Kernel 自己托管 Web Shell（`ServeDir` + SPA fallback），无需独立静态服务器 | `apps/kernel/src/routes.rs:260-263`、`config.rs:43` |
| C3 | Node 用 `docker` **CLI 子进程**驱动 Engine（不是 HTTP API 客户端） | `apps/node/src/docker.rs:26-31,37,77,211,275` |
| C4 | Node 的 `docker create` **从不注入** `--add-host host.docker.internal:host-gateway` | `apps/node/src/docker.rs:121-182` |
| C5 | 插件容器靠 `OPSWEAVE_PLUGIN_DB_HOST` 与 `OPSWEAVE_PLUGIN_KERNEL_URL` 回连控制面 | `apps/kernel/src/config.rs:76-80`、`storage.rs:208-221`、`capabilities.rs:422-510` |
| C6 | 插件镜像地址**写死在签名 manifest 的 `backend.imageRef`**（含 digest）；换 registry 必须重打重签 | `plugins/data-catalog/manifest.template.json`、`apps/node/src/docker.rs:76-104` |
| C7 | Kernel 启动即 `sqlx::migrate!`，迁移只前向、幂等（15 个迁移，无 DROP/TRUNCATE） | `apps/kernel/src/main.rs:50`、`db.rs:19-25` |
| C8 | Node 身份写在 `<state_dir>/node-identity.json`（0600），丢失即需重新 enroll、generation 递增 | `apps/node/src/runtime.rs:138-213` |
| C9 | 现有 `deployments/linux/*.service` **按原样装不起来**（无 WorkingDirectory/EnvironmentFile 模板；默认相对路径撞 `ProtectSystem=strict`） | `deployments/linux/opsweave-kernel.service:13-18`、`apps/kernel/src/config.rs:42-43` |
| C10 | 目标主机：Ubuntu 24.04 / x86_64 / 4 vCPU / 3.7GB RAM / 50GB；**无 node/cargo/psql**；sudo 免密；docker 29.6.1 + compose v5.3.1 | 实测 |
| C11 | 主机无法直连 Docker Hub 与 github.com（000），但镜像源可用；`ghcr.io` 可达 | 实测 |
| C12 | 主机已承载他人服务：`workbuddy2api`(7863)、`workbuddy2api-global`(7864)、`account-onboarding`(127.0.0.1:18789) | 实测 |

C1 是最强约束：**任何让 Kernel 处于桥接网络的方案都会让 Node 数据面不可达**——容器内的 `127.0.0.1` 不是宿主的 `127.0.0.1`，而改用网关 IP 又会被 C1 的 loopback 检查拒绝。
C10 排除「在目标机构建」：无工具链，且 3.7GB 内存不适合 workspace 级 Rust 编译。

## 3. 候选方案

### A. 全部容器化（桥接网络）
**被 C1 否决**：Kernel 无法直连 `127.0.0.1:9101`；Node 容器化还等于把宿主 Docker 控制权交给业务侧容器。

### B. Compose（PG+Registry）+ systemd（Kernel+Node）
架构审计的推荐形态，长期最干净（Node 独立用户 + rootless socket）。但发布物是「二进制 + unit + env」而非不可变镜像；回滚要同时换二进制、改 unit、重启；与「打镜像部署」的产品要求不符；且需先修 C9 的 4 处 unit 缺陷。

### C. 选定：单镜像双角色 + Compose + **host 网络**
- 一个镜像 `ghcr.io/baicie/opsweave:<40位SHA>`（kernel / node / opsctl / pipeline-worker + Web 产物）。
- Compose 四服务：`postgres`、`registry`（桥接，双绑定 loopback + docker 网关）、`kernel`、`node`（`network_mode: host`）。
- **host 网络是 C1 的唯一合规解**：Kernel 与 Node 共享宿主 loopback，`http://127.0.0.1:9101` 校验通过且真实可达。
- 插件容器仍在默认 bridge 上运行（保留 `--read-only`/`--cap-drop`/digest 校验语义），通过 `172.17.0.1` 回连 Kernel 与 PG（对应 C4/C5）。

**为什么允许 Node 在容器里**：本方案中 Node 容器与宿主进程拥有等价的 Docker 访问（同一个 socket），容器化收益是「不可变部署 + 一键回滚」，不是权限收窄。该暴露被显式登记为技术债，后续以 socket-proxy 白名单或 rootless dockerd 收紧。

## 4. 安全边界（staging-only，强制）

- Node 容器挂载 `/var/run/docker.sock`：仅限本 staging project，属已知风险与技术债。
- 预览入口为**明文 HTTP**。保护手段是产品自身登录 + 不公开默认口令。**不得**宣称「已限制公网访问」。
- **不修改** `/etc/docker/daemon.json`（全主机共享，会影响他人项目）。因此**不使用**需要 `insecure-registries` 的明文本地 registry 作为插件镜像源；插件镜像改用 `ghcr.io`（C11 可达）。
- **禁止**全局清理（`docker system prune`/`volume prune`/`docker rm` 无过滤）。所有 Compose 操作限定 `-p opsweave-staging`。
- 端口只用未占用的 `18080`、`55432`、`15001`；PG/Registry 必须同时绑 `127.0.0.1` 与 `172.17.0.1`，否则插件 bridge 容器无法回连。
- 部署前必须 `pg_dump` 且校验备份可读；**禁止** `down -v`、DROP、RESET、重装数据库。

## 5. 持久化与回滚语义

- 业务数据：`/var/lib/opsweave-staging/pg`。
- Node 身份：`/var/lib/opsweave-staging/node`（对应 C8，跨部署必须保留）。
- 部署记录：`/var/lib/opsweave-staging/deployments/<sha>.json` + `current`/`previous` 指针。
- 备份：`/var/backups/opsweave-staging/<UTC>-<sha8>/`（pg dump + staging.env + compose.yaml）。
- 回滚 = 把镜像 tag 切回上一个成功 SHA 并重建容器。**镜像回滚不等于数据库回滚**：迁移只前向（C7），若新版本已执行不兼容迁移，回滚旧镜像会失败，此时必须拒绝并保留现场，不得删库重来。

## 6. 被否决的诱人做法

- Kernel 桥接容器（违反 C1）。
- 在目标机构建（违反 C10）。
- 复用明文本地 registry（需改共享 daemon.json）。
- 用 `latest`/分支名作为部署标识。
- 同版本重发插件（URL 只含 version，会被 `immutable` 缓存 + loader 短路吃掉）。
- 以「Workflow 文件已写好」声明「自动部署已验收」。

## 7. 后果

| 风险 | 处置 |
|---|---|
| Node 持有宿主 Docker 控制权 | 记录技术债；后续 socket-proxy/rootless 收紧；本轮不扩大暴露面 |
| 明文 HTTP 预览 | 记录访问范围限制；仅非生产 |
| Kernel 单实例 | 禁止横向扩容（C7：reconciler + 迁移无 leader election）；CI 用 concurrency lock 串行部署 |
| 首次镜像构建慢（仓库此前从无 release 构建） | CI 加 cargo 缓存；首次耗时写入交付报告 |
| 迁移不可回退 | 部署前强制备份 + 回滚前检查迁移兼容性 |
