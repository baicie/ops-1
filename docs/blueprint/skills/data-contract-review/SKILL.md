# Skill: data-contract-review

## 触发条件
设计 0.0.2+ Data Catalog、Connector、Pipeline 接口时

## 必需输入
Schema/Source/Run/Dataset 模型和样本

## 执行步骤
1. 固定 Schema revision、source pins、单位和主键语义
2. 明确 EMPTY/NO_DATA/PARTIAL/UNKNOWN 与错误分母
3. 区分只读 Preview 与持久 Sink、幂等回执
4. 检查跨插件数据库/权限边界和向后兼容
5. 使用真实 HTTP/JSON 样本验证并对照受控负例

## 必交产物
Versioned Contract + Source/Quality Fixtures + Migration Plan

## 退出条件
可重放/可解释错误且预览不写入

## 禁止事项
不伪造运行测试、截图、客户日志或生产部署结果；缺失信息明确标记并阻塞相应验收。
