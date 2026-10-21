# Skill: plugin-design

## 触发条件
新增或升级前后端全栈插件时

## 必需输入
用户故事、Manifest、发行者、前后端制品、依赖、权限

## 执行步骤
1. 设计 Extension Point 和 Capability provides/requires 版本
2. 定义 Package signature/digest/资源上限/数据 Schema ownership
3. 给出 Staging/Ready/Activate/Drain/Rollback 状态
4. 覆盖新旧页面 Tab/后端 API 兼容窗口与失败升级
5. 使用 Hello v1/v2 合约测试

## 必交产物
Manifest + Permission Diff + Upgrade Playbook + Tests

## 退出条件
不修改宿主构建仍可发布，失败版不破坏旧版

## 禁止事项
不伪造运行测试、截图、客户日志或生产部署结果；缺失信息明确标记并阻塞相应验收。
