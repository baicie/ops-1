# Skill: security-review

## 触发条件
处理插件包、身份、Node、Secret、网络、日志、授权时

## 必需输入
威胁模型、信任边界、输入校验、策略

## 执行步骤
1. 枚举 User/Node/Workload 授权与有效期
2. 检查签名/digest/制品归档风险和包路径边界
3. 检查 SSRF、特权容器、OCI 管理 socket 和日志 secrets
4. 编写越权/伪造/过期/撤权/重放负面测试
5. 核对数据最小化和权限审计

## 必交产物
Security Checklist + Threat Diff + Negative Tests

## 退出条件
高风险越权测试全部通过且有独立审查记录

## 禁止事项
不伪造运行测试、截图、客户日志或生产部署结果；缺失信息明确标记并阻塞相应验收。
