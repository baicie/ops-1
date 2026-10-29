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
- **env 按服务拆分，禁止共享运行时 env 文件**（P0-3）：`postgres.env` / `kernel.env` / `node.env` 各自独立挂载；`staging.env` 降级为 compose 插值输入，永不挂进容器。`node.env` 出现 `POSTGRES_*`、`DATABASE_URL`、`OPSWEAVE_BOOTSTRAP_ADMIN_*`、`OPSWEAVE_GHCR_TOKEN` 或任何 `*SECRET*` 即拒绝启动（`scripts/deploy-staging.sh: assert_service_env_boundary`）。

## 5. 持久化与回滚语义

- 业务数据：`/var/lib/opsweave-staging/pg`。
- Node 身份：`/var/lib/opsweave-staging/node`（对应 C8，跨部署必须保留）。
- 部署记录：`/var/lib/opsweave-staging/deployments/<sha>.json` + `current`/`previous` 指针。
- 备份：`/var/backups/opsweave-staging/<UTC>-<sha8>/`（pg dump + staging.env + postgres.env + kernel.env + node.env + compose.yaml，全部 0600）。
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

## 8. 已知暴露与生产禁用理由（P0-3 追加，2026-10-28）

本节把 staging 预览形态的**已知暴露面**逐条登记，并给出「为何不得用于生产」的判断依据。证据列区分**实测**与**源码行号**，未实测的内容不写成结论。

### 8.1 暴露清单

| # | 暴露 | 证据 | 影响 | 本轮为何未修 |
|---|---|---|---|---|
| E1 | Node 容器持有宿主 Docker Socket（rw） | `deployments/staging/compose.yaml` 中 `/var/run/docker.sock:/var/run/docker.sock` + `group_add: ${DOCKER_GID:-999}`（实测宿主 socket GID=988）；未 privileged | 等价于宿主 root：可创建任意容器、挂载任意宿主路径、读取其它项目容器与镜像 | 这是 Node 的运行时前提（C3：`docker` CLI 驱动 Engine）；收窄需 socket-proxy 白名单或 rootless dockerd，属独立变更 |
| E2 | `172.17.0.1:55432`（PG）与 `172.17.0.1:15001`（registry）**对同宿主所有项目可达** | 实测 `ss -ltn` 显示两端口在 `172.17.0.1` LISTEN；双绑定见 `compose.yaml` 的 postgres/registry `ports` | 默认 bridge 上任何其它项目的容器可直连 staging 数据库（拿到超级用户口令即可全量读写）与镜像仓库 | 收敛要专用 bridge + 固定网关，会同时改插件容器网络与主机路由，按 §9 窗口化实施 |
| E3 | 主机层无包过滤 | 实测 `ufw inactive`、`iptables INPUT` 为 `policy ACCEPT` | 唯一防线是云防火墙（安全组）；规则一旦放宽即等于公网直连 PG/registry | 改 ufw/iptables 属主机写操作且与其它项目共享，本轮明令禁止 |
| E4 | 预览入口为明文 HTTP | `OPSWEAVE_PUBLIC_URL=http://…:18080`，Session Cookie 无 `Secure` | 口令与会话在链路可被截获 | 需域名 + 证书 + 反向代理，超出本轮范围 |
| E5 | 凭据以明文长期落盘 | `kernel.env` 的 `OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD`，以及 `DATABASE_URL` 内嵌的 PG 口令 | 能读 `/srv/opsweave-staging/*.env` 的主体（root、快照、备份）即拿到平台管理员与 DB 超级用户 | 需 secret manager；staging 暂以 0600 + 按服务隔离缓解 |
| E6 | 数据面允许明文 http | `OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT=1`（C1 的代价） | 节点数据面不加密 | 已由 `OPSWEAVE_ALLOWED_NODE_DATA_HOSTS` 限定到 loopback |
| E7 | 旧形态下 postgres / kernel / node 共用同一个 env 文件 | 修复前三处 `env_file` 指向同一 `staging.env`，其中含 `POSTGRES_PASSWORD` 与 `OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD` | Node 进程环境含有 DB 超级用户口令与 bootstrap 管理员口令，而 Node 只需要 docker 与 kernel 地址——属权限越界 | **本轮已修**，见 §8.2 |

### 8.2 本轮已收口的权限越界（E7）

- `postgres.env` 仅 `POSTGRES_DB/USER/PASSWORD`；`kernel.env` 保留 DSN、管理员与运行时限；`node.env` 只有节点身份与一次性 enrolment token。
- `scripts/deploy-staging.sh` 的 `assert_service_env_boundary` 在**每次 compose 调用前**检查：`node.env` 出现 `POSTGRES_*`、`DATABASE_URL`、`OPSWEAVE_BOOTSTRAP_ADMIN_*`、`OPSWEAVE_GHCR_TOKEN` 或 `*SECRET*` 即 exit 1；`postgres.env` 含非 `POSTGRES_*` 键即 exit 1；`kernel.env` 出现 `POSTGRES_PASSWORD` 即 exit 1。
- 只打印**键名**，从不打印值；拆分文件由 `derive_service_env_file` 按允许清单从旧 `staging.env` 一次性派生（默认拒绝，未列出的键不复制），派生后不再覆盖，避免运维改过的值被旧文件回填。
- 一处常见误读需要纠正：Node 并**不**把自身进程环境透传给插件容器——`apps/node/src/docker.rs:248-260` 只注入三个固定 `--env` 参数加 Kernel 下发的 `extra_env`。E7 的实际危害是「Node 进程自身可读这些凭据」，Node 一旦被攻陷即升级为 DB 超级用户/平台管理员，而非「插件容器直接继承」。

### 8.3 生产禁用（硬结论）

**本 ADR 描述的单主机、host 网络、Docker Socket、明文 HTTP、默认 bridge 形态不得用于生产。** 理由：

1. E1 使「Node 容器」与「宿主 root」等价，生产上等于把主机交给一个业务侧进程；容器化在此不提供任何权限收益。
2. E2 + E3 使数据库与镜像仓库的隔离边界依赖**主机外部**（云防火墙）而非主机自身；多项目同宿主时无最小权限可言。
3. E4 + E5 使管理员口令与 DB 超级用户口令以明文存在于 env 文件与 HTTP 链路上。
4. 迁移不可回退（C7）与单实例 Kernel 的组合，在生产事故里没有安全的重放空间。
5. 生产所需的 rootless dockerd / socket-proxy、专用网络与 secret 管理、TLS 入口，本节均未具备。

生产形态的最低要求（不在本 ADR 范围，另立 ADR）：Node 走 socket-proxy 白名单或 rootless Engine；插件容器进专用网络；凭据进 secret 存储而非 env 文件；入口非明文；数据库不对任何 bridge 网段发布。

## 9. 收敛方案（可执行，本轮未实施）

目标：把 E2 的「同宿主跨项目可达」收敛为「只有本项目的插件容器能到达 PG/registry」，且不触碰 `/etc/docker/daemon.json`、ufw/iptables 与其它项目。

### 9.1 现状锚点（源码位置，供实施者定位）

| 关注点 | 位置 | 现状 |
|---|---|---|
| Node 创建插件容器的参数向量 | `apps/node/src/docker.rs:210-254` | `docker create` 的参数里**没有** `--network`，因此插件容器落在默认 `bridge`；这正是必须绑 `172.17.0.1` 的根因 |
| 同一函数的签名 | `apps/node/src/docker.rs:186-194` | `create_and_start(workload, image_ref, container_port, node_id, extra_env, token_file)` 无网络入参 |
| 插件端口发布 | `apps/node/src/docker.rs:199`（`127.0.0.1::{port}`）与 `:246-247`（`--publish`） | 已在 loopback 发布，保留 |
| 插件回连地址来源 | `apps/node/src/docker.rs:255-260`（`extra_env` 透传）→ Kernel `apps/kernel/src/capabilities.rs:422-510`；DSN 主机替换 `apps/kernel/src/storage.rs:208-221` | 插件被告知 `OPSWEAVE_PLUGIN_DB_HOST=${DOCKER_BRIDGE_IP}`（默认 `172.17.0.1`） |
| compose 侧现状 | `deployments/staging/compose.yaml` 的 postgres/registry `ports`（`127.0.0.1:…` 与 `${DOCKER_BRIDGE_IP:-172.17.0.1}:…` 双绑定） | 双绑定是 E2 的直接成因 |

### 9.2 步骤

1. **建专用网络（固定网关，避开 172.17.0.0/16）**：

   ```
   docker network create --driver bridge --subnet 172.31.240.0/24 --gateway 172.31.240.1 opsweave-staging-net
   ```

2. **compose 接入该网络**：postgres / registry 增加 `networks: [opsweave-staging-net]`；端口绑定由 `${DOCKER_BRIDGE_IP}` 改为 `${OPSWEAVE_STAGING_GATEWAY:-172.31.240.1}`；删除 `DOCKER_BRIDGE_IP`（`grep -rn` 显示它只出现在 `deployments/staging/compose.yaml`、`staging.env.example`、同目录 README 与本 ADR 中，**无代码依赖**）。Kernel 仍为 `network_mode: host`（C1），但网关地址在宿主上可直接连接，故 `OPSWEAVE_PLUGIN_DB_HOST` / `OPSWEAVE_PLUGIN_KERNEL_URL` 改指 `172.31.240.1`。
3. **Node 让插件容器进同一网络**（唯一代码改动点）：在 `apps/node/src/docker.rs:210-254` 的参数向量中注入 `--network <name>`；网络名从新配置项读取（`apps/node/src/config.rs` 增加 `OPSWEAVE_PLUGIN_NETWORK`，与 `OPSWEAVE_DOCKER_BIN` 同一读取方式），由 compose 的 node `environment` 传值。**不要**写死常量：同一镜像要能部署到网关不同的主机。
4. **验证清单（切换后必须全部通过）**：
   - `ss -ltn` 不再出现 `172.17.0.1:55432` / `172.17.0.1:15001`；
   - 从另一个项目的容器执行 `nc -vz 172.31.240.1 55432` 必须失败，从本项目插件容器必须成功；
   - 插件实例仍能回连 Kernel（`OPSWEAVE_PLUGIN_KERNEL_URL`）并完成数据面调用；
   - `docker compose -f deployments/staging/compose.yaml config` 通过，部署脚本健康检查全绿。
5. **回滚**：保留一版双绑定（旧 compose）在同一天内可回退；回退只需把 `OPSWEAVE_IMAGE`/compose 切回上一 SHA 组合，不允许 `down -v`。
6. **风险与协调**：若其它项目依赖 `172.17.0.1:<port>` 上的本服务端口，切换必须在协调窗口内进行；本方案不改 daemon.json、不改 ufw/iptables，因此不改变 E3 现状——E3 的收敛（主机防火墙）需与主机上其它项目一并决策。

## 10. 凭据卫生（P0-3 核查结论）

- 模板一律使用 `__CHANGE_ME_*` / `__HOST_PUBLIC_IP__` 占位符：`deployments/staging/staging.env.example`、`postgres.env.example`、`kernel.env.example`、`node.env.example` 均无真实口令。
- 仓库内 grep 到的 demo 口令集中在 `tests/**`（`tests/ui/*.spec.ts`、`tests/acceptance/*.sh`、`tests/ci/*`、`tests/runtime/*`）、`scripts/opsweave.sh`、`scripts/demo_up.sh` 与根 `README.md`，均为**本地 demo 默认值**；本轮允许改动的文件集合（`deployments/staging/**`、`scripts/deploy-staging.sh`、本 ADR）中**不含**该字符串，故未做替换（越界），登记为待办：若 staging 实际口令等于该 demo 默认值，属 HIGH，必须在 UI 轮换。
- `scripts/deploy-staging.sh` 不在日志或 stdout 打印任何口令值；拆分与派生流程只打印键名与该键来自哪个文件。
- 本轮**未**在服务器上执行任何写操作，未轮换任何真实凭据。

