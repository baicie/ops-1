# P-02 插件生命周期与 Runtime 规则

- MUST：每份发布包被绑定 `publisher/id/version/digest`，不可覆盖，逐制品 Hash 与签名验证；禁止未经审核的第三方不可信插件运行。
- MUST：安装与激活分离；先 Stage，准备与 Readiness 成功后 CAS 切 active revision；失败保留上次可用版本。
- MUST：Provides/Requires 解析版本范围、权限、循环依赖、停用依赖影响；激活后能力实例仍须受 Gateway 授权。
- MUST：停用/卸载不自动丢数据；数据迁移需标记 `rollbackCompatible` 和影响范围，不承诺任意回滚。
- MUST：Web Remote 卸载其路由/订阅/监听；老 Tab 和已执行 JS 采用版本窗口/安全重载，不宣称彻底从内存清除代码。
- MUST：插件不得获得 OCI Engine Socket、宿主 root Shell 或私有文件任意访问；资源 budget 强制生效。
- Gate：一个新增插件在 clean Shell/Kernel 构建产物下安装、升级、禁用，不需重编宿主。
