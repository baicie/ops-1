# 核心时序图（实现时按实际传输协议补充）

## A. 全栈插件安装
```mermaid
sequenceDiagram
 participant U as Admin UI
 participant K as Kernel
 participant P as PostgreSQL
 participant N as Node Runtime
 participant W as Web Shell
 U->>K: Upload signed bundle + idempotencyKey
 K->>K: Check signature/digests/permissions/dependencies
 K->>P: Persist VERIFIED/STAGED package
 U->>K: Request deployment 2 replicas
 K->>P: Persist Desired deployment generation
 K->>N: Apply verified desired state
 N->>N: Pull immutable OCI digest and start
 N-->>K: Observed instance status, readiness
 K->>P: CAS activationRevision after ready
 W->>K: Fetch effective contributions
 W->>W: Load trusted Web Remote from immutable asset URL
```

## B. Network partition
```mermaid
sequenceDiagram
 participant K as Kernel Reconciler
 participant P as PostgreSQL
 participant N as Node B
 participant G as Gateway
 K--xN: Heartbeat/control connection lost
 K->>P: Record stale observation and UNREACHABLE
 K->>G: Remove Node B effective routes
 Note over K,N: Do not claim B process stopped
 N->>K: Re-authenticate after network returns
 K->>P: Read desired/generation and compare observed
 K->>N: Converge without duplicate unsafe work
```

## C. 实时日志
```mermaid
sequenceDiagram
 participant U as Web
 participant K as Kernel Gateway
 participant N as Node Runtime
 U->>K: GET /instances/id/logs/live?cursor=X
 K->>K: Session + resource permission check
 K->>N: Authorized scoped tail stream
 N-->>K: bounded events + epoch/sequence
 K-->>U: SSE log id=opaque-cursor
 Note over N,U: rotation/overflow emits GAP; no fabricated continuity
```
