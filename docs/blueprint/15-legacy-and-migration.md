# 从现有 OpsWeave / Nebula 项目迁移的策略

## 保留与不保留
- 保留旧 OpsWeave 为只读历史，冻结现有 Schema、产品文档、具体数据源的行为测试、真实故障案例与安全校验思路；不要把旧 Repo 的模块依赖全量拷入新 Kernel。
- 不迁移旧 WorkflowStore 的巨大接口、Java 接入编排存储实现、旧导航/UI DOM、未经证明的通用 Pipeline/Agent 框架。
- NebulaSpec 继续负责协议/语义制品；RUM Web 和未来 Native RUM SDK 按专门 Research 项目演进。OpsWeave 不复制协议代码私有 fork。
- Zabbix Connector 以契约/行为和可验证经验为资产，在 0.0.2 新插件 API 下逐步重建，而不是在 0.0.1 塞入 Kernel。

## 迁移分段
0. **Inventory**：列出旧数据、配置、用例、协议与必须保存资产，Hash 归档，不触发生产写入。
1. **Foundation Greenfield**：新 Repo 和新部署环境，0.0.1 除 Hello/Ops Center 不接旧业务数据。
2. **Contract Adapter**：0.0.2 数据插件做显式 Migration/Import Wizard，字段映射、缺失、冲突、来源标注、可取消。
3. **Dual Validation**：新旧源数据同时间窗对照，证明结果一致或解释差异，不写回旧库。
4. **Cutover**：明确版本/时间、备份、回退对象，只有经过授权才把流量切换到新系统。

## 绝对约束
- 不允许在没有迁移报告的情况下将旧数据库“直接指向”新 Kernel。
- 不把历史 Mock/Fixture 伪装成真实上线数据。
- 新平台重新生成证书与凭据，不拷贝旧 dev token。
