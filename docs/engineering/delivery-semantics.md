# 交付语义：exactly-once 不可辩护（TASK-22）

**审计 2026-11-20，main `64ff84f`。**

---

## 1. 结论

**「exactly-once」不是这个系统能声称的性质。** 正确的名称是：

> **effectively-once**（at-least-once 投递 + 去重的已提交效果）

代码本身是**可辩护的**——at-least-once 加幂等 sink 是正确的工程选择。不可辩护的是
把它**叫作** exactly-once。

## 2. 四个问题的实际答案

| 问题 | 答案 |
|---|---|
| Claim 是否原子？ | **是**。`g13_b14_claim.sh` 与 claim SQL 用的是单条带条件的 UPDATE，`RETURNING` 拿所有权。 |
| Fencing 机制？ | 单调 `fence` 序列 + `lease_id`。两条都在 `catalog_fenced_sink.sh` 的失败路径里被断言。 |
| Worker 在 effect 中途被 SIGKILL？ | 重试时 **sink 去重**——effect 不会重复提交，因为 receipt 先写。这就是「receipt-first」。 |
| Sink 是否按业务键幂等？ | **是**。`sourceBatchKey` 是业务键，重复提交落到同一 receipt。 |

**但这四条加起来仍然只是 at-least-once + 幂等**：两次投递可以发生，只有**效果**是唯一的。
这依赖 sink 的幂等实现永远正确——它不是「投递只发生一次」这个更强的性质。

## 3. 三处契约与实现不一致（真实的、可修的）

这些不是语义哲学问题，是代码与契约文档对不上：

### 3.1 Receipt 读取端点

`contracts/openapi/data-catalog-fenced-v1.yaml` 规定
`GET /datasets/{datasetId}/receipts/{sourceBatchKey}`，而实际服务返回 **404**。

**后果**：从契约写出来的 0.0.2 / 第三方客户端拿不到 receipt，而 receipt-first 正是整个
恢复路径的基础。

### 3.2 UNKNOWN 状态未实现

契约定义了 `UNKNOWN`，但 `catalog_effect_receipts.status` 是个**没有 CHECK 约束的 text 列**，
fenced handler 只写两种值。

**后果**：如果插件提交了 effect、响应丢失、且 receipt 写入未匹配，恢复逻辑没有状态可以表达。

### 3.3 缺少语句超时

fenced sink 的 check-then-write 没有 statement/lock timeout，而插件其它写路径有。

**后果**：不是正确性漏洞（锁正是目的），是**可用性耦合**——一个卡住的 Catalog 事务会串行化
所有 claim。

## 4. 三条不能做的事

1. 不能把 `g13_b14_claim.sh` 的通过当作 exactly-once 的证明。它证明的是 claim 原子性。
2. 不能因为 sink 幂等就说投递一次。要证明「一次」，需要证明重试**从未发生**，而这恰恰是
   at-least-once 系统不保证的。
3. 不能在没有 3.1/3.2 修复的情况下声称 receipt-first 恢复路径可用——那条路径的读取端点
   返回 404。

## 5. 建议的措辞（写给文档和发布说明）

| 不要说 | 说 |
|---|---|
| exactly-once delivery | at-least-once delivery with a deduplicated, receipt-backed effect |
| guaranteed single execution | business effect applied once per `sourceBatchKey` |
| no duplicates possible | duplicates are detected by `sourceBatchKey` and do not re-apply |

**这不是降低标准**，是把标准说准。一个声称 exactly-once 却在网络分区下重投的系统，比一个
诚实声称 at-least-once 的系统更危险——因为前者让人停止检查幂等实现。
