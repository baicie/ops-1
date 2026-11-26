# Phase 9B — TASK-11: does `PREPARING` wait forever?

Baseline `e0f774ae`. Every claim below is either a test in
`apps/kernel/src/deployments.rs` (module `preparing_convergence`) run against real
PostgreSQL, or a line of source named beside it.

## The question, and why it is not the PENDING question again

#227 made a deployment with **zero replicas placed** become `FAILED` after
`OPSWEAVE_PENDING_TIMEOUT_SECONDS`. Its own PR said the limit of that change:

> `PREPARING` carries a similar "forever" risk and is **not** addressed here.

The brief for this task adds three constraints that rule out the obvious move:

> 「不能直接把 PENDING 的 600 秒规则复制给 PREPARING。」
> 「不能错误停止仍在正常拉取大镜像、初始化数据或即将 READY 的部署。」
> 「对于 ACTIVE 后降级的实例，不得使用候选部署失败超时自动下线服务。」

A `PREPARING` deployment has **placed instances**. Some are up, some are starting. A
600-second clock measured from `created_at` would kill a legitimate multi-minute
image pull, and a row that was once ACTIVE could be aged out while it still serves.

## What the state machine actually does — measured

Four tests, each constructing one situation:

| situation | what happens | test |
|---|---|---|
| node healthy, one instance `STARTING`, two hours old | **stays `PREPARING`** — there is no timer on this state | `a_starting_instance_is_not_on_a_timer` |
| the same, but the Node reports observations | **stays `PREPARING`**, and reconcile does not clear `observed_at` | `a_reporting_node_keeps_its_deployment_alive` |
| the node goes stale | **leaves `PREPARING`** — the sweep rewrites `STARTING` to `UNREACHABLE`, `starting` counts only `STARTING|UNKNOWN`, so the `failed > 0` branch takes over | `a_lost_node_moves_the_deployment_out_of_preparing` |
| node healthy, `observed_at` never set, five reconcile passes | **stays `PREPARING` indefinitely** | `a_container_that_never_starts_stays_preparing` |

So the third row is the important one for scoping: **a lost node cannot cause a
permanent `PREPARING`**. The state machine already handles it, and that is why this
task does not need to.

## Is the remaining case reachable? The Node's own bounds

The fourth row is the only unbounded one, and whether it is reachable depends on the
Node, not the Kernel:

| bound | where | value |
|---|---|---|
| image pull | `apps/node/src/docker.rs:445` — `run_with_timeout(&["pull", ...], 300)` | **300 s**, then an error |
| docker command in general | `docker.rs:425`, `run_with_timeout` | per-call |
| container failure → state | `apps/node/src/runtime.rs:49-50` — `Stopped → Stopped`, **`Failed → Unhealthy`** | reported as `Unhealthy` |

`Failed` mapping to `Unhealthy` is the load-bearing fact. `Unhealthy` is counted by
`failed` in the reconciler, so a container that fails to start moves the deployment
to `DEGRADED` through the `failed > 0` branch — **it does not sit in `PREPARING`**.
A pull that hangs is cut off at 300 seconds by the Node and becomes a failure.

**Conclusion: on the paths this code actually implements, `PREPARING` converges.**
The unbounded state exists in the Kernel's state machine, but nothing in the Node
can hold it open indefinitely.

## Therefore: no deadline is added

Adding `PREPARING_TIMEOUT_SECONDS` now would be a rule with no defect behind it,
guarding against a state the Node cannot produce. It would also be the exact thing
the brief forbids — a copy of PENDING's 600 seconds pointed at a state whose
legitimate latency is unbounded (a 300-second pull plus container start plus health
checks is normal, and a slow registry makes it longer).

**What would change this conclusion**, and what to watch:

- a Node path that leaves an instance `STARTING` after a failed pull instead of
  reporting `Unhealthy`;
- a pull timeout raised or removed;
- a runtime adapter that reports `Starting` for a container that exited.

Each of those would make the fourth test's situation reachable, and then the
deadline should be designed against **`observed_at` staleness**, not age: the
Kernel's only evidence of progress is the Node reporting. A rule keyed on "no
observation for N seconds while STARTING" distinguishes a stalled pull from a slow
one, which a rule keyed on `created_at` cannot.

## What this task does not claim

- **Not** that `PREPARING` can never hang. It says the Node's own bounds make the
  hang unreachable today, and names the three changes that would invalidate that.
- **Not** a staging observation. No `PREPARING` deployment exists on staging at the
  moment of writing: the four occupants are three `ACTIVE` and one `DEGRADED`
  (`capacity.json`, run 45799322906).
- **Not** TASK-12..16, which are the rest of Phase 9C.

## The tests are kept

They assert the **current** behaviour, including the parts that are unbounded. When
someone adds a progress deadline, `a_container_that_never_starts_stays_preparing`
is the test that must change — deliberately, with a decision about what "no
progress" means, rather than by inheriting a number from PENDING.
