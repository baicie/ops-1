# Skill: release-gate

## 触发条件
任一版本签署候选发布时

## 必需输入
Tag candidate、变更日志、报告、包/镜像 digest

## 执行步骤
1. 逐项核验 Release Gate 的原始测试证据
2. 独立标记 RUN/PASS/FAIL/NOT_RUN/SKIPPED 与环境
3. 检查协议/DB/签名/权限/灾备/性能/视觉验收
4. 重演最少一次双节点热升级及失败回滚（0.0.1）
5. 输出发布决定、已知限制和恢复说明

## 必交产物
Release Decision Record + Verified Evidence Index

## 退出条件
所有阻塞项已实测 PASS，未执行不得写通过

## 禁止事项
不伪造运行测试、截图、客户日志或生产部署结果；缺失信息明确标记并阻塞相应验收。
