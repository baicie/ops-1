# 官方多语言插件模板与目录设计

> 这里是可开发的目录和边界规范，不是已经跑通的项目源码；各模板需配套真实锁文件和集成测试后才能标为 Ready。

## 通用插件结构
```text
plugins/<plugin-id>/
  plugin.json                         # 与发布 payload 绑定的 Manifest v1.1
  frontend/                           # 可选：React/TypeScript
    src/{entry,pages,features,api,components}/
    package.json + lockfile reference
  server/                             # 可选：语言原生项目
    src/ ...
    Dockerfile
  contracts/                          # 业务 OpenAPI/JSON Schema
  migrations/                         # 可选：有所有权、版本与策略
  tests/{unit,contract,integration}/
  README.md / CHANGELOG.md
```

## Java · `hello-java`
- 开发用 Java 21，Spring Boot 仅是示例：`server/src/main/java/.../HelloController.java`、`RuntimeController.java`、`SecurityConfiguration.java`。
- `RuntimeController` 输出 `/info`、`/health/ready`、`/health/live`；Spring Actuator 可以内部复用，但对外路径、Schema、错误与安全语义由 OpsWeave 协议定义。
- 业务 API 使用带资源范围的授权服务，不直接从未经签名的 Header 读取用户/租户。
- Gradle Wrapper/lock 校验真实生成后提交，CI 运行单测/应用端口集成/OCI 容器 conformance。
- 镜像采用 multi-stage build，运行阶段只含必要的 JRE/JAR，非 root，预留真实 Java 启动时间和 startupProbe。

## Go · `hello-go`
- 目录 `cmd/server/main.go`、`internal/runtime`、`internal/hello`、`internal/auth`，业务协议用标准库 `net/http` 即可。
- Go module 依赖锁通过 `go.sum`，镜像可使用最小 rootfs，但 CA/timezone 需求根据真实网络访问配置。
- `http.Server.Shutdown(ctx)` 实现 SIGTERM drain；Handler 不持有 Node 级凭据。
- GOOS/GOARCH 必须与部署节点镜像 Platform 匹配；CGO 情形单独验证依赖。

## TypeScript · `hello-typescript`
- 目录 `server/src/{main,runtime,hello,auth}.ts`，Node 运行时，Fastify 示例但非协议强制。
- `package.json` 固定 Node 兼容区间，`pnpm-lock.yaml` CI frozen 安装；TS 编译到 `dist/`，正式镜像不携带开发依赖、测试文件或密钥。
- Fastify 的 `onClose`、Schema Validation、HTTP body limit 映射到 Runtime Contract；不得使用 Dev HMR 进入生产容器。

## React 前端（各语言共享）
- `frontend/src/entry.ts` 暴露宿主要求的 `activate(context)` / `dispose()`；只允许在公共 Extension Points 注册路由、菜单、设置。
- 数据请求走 `context.capabilities.request(...)`，不直接访问 Node IP/Plugin 端口/Kernel 管理员 API。
- Module Federation 或其它 Remote Loader 是可替换实现；业务只引用稳定 `plugin-sdk-web` 和 Design System。
- 必须实现 Loading/Empty/Error/No Permission/Version Change/Error Boundary，支持 1440/1024/390px 和浅深主题。

## 四种常见开发命令（拟议，由模板实现而非现在已可执行）
```bash
opsctl plugin create --language java --id dev.example.hello-java
opsctl plugin dev --path plugins/hello-java        # web HMR + local JVM dev server
opsctl plugin test --contract --language java      # common conformance suite
opsctl plugin package --path plugins/hello-java    # OCI digest + signed bundle
```

## 版本升级兼容
- API Schema 的升级不依赖语言：`backend schema v1/v2` 的兼容窗口定义在插件发布计划里。
- API Gateway 按 activation revision 路由不同容器版本；旧 Web Tab 只在明确的兼容窗口内可操作。
- 数据迁移的执行主体为专用 DB 用户/Schema，**不随意从 Spring 应用启动钩子自动执行高权限迁移**。
- Java 慢启动、Go 快启动、Node event loop 阻塞等是各运行时的健康与资源特征；调度不应内置语言特判。
