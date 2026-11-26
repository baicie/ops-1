# Phase 9C — TASK-15: a slot is not a container

Baseline after `51439d66`. Claims are tests in two places, named beside each, run
against real PostgreSQL or the real `InstanceRuntime`.

## The distinction the brief draws

> 「不能把 desired_action=STOP 单独当成物理资源回收成功。」
> 「调度槽位释放与实际容器退出可能不是同一时刻。必须分别验证。」

Two facts, and the Kernel must not let one stand for the other:

| | evidence | what it means |
|---|---|---|
| scheduling slot | `desired_action='START'` on a planned deployment | the scheduler will place / keep this |
| container | `container_id` | a process may exist |

## Measured: the slot half works

`a_stopped_instance_releases_its_scheduling_slot` — set `desired_action='STOP'` and
the planner's occupancy drops from 1 to 0 immediately, because every capacity
aggregate counts START instances. **The slot is released before the container is
necessarily gone.** That is correct and it is the half the brief calls the scheduling
slot.

## Measured: the container half was wrong

`a_stopped_instance_still_reports_a_container` — after the instance reports
`STOPPED`, the row **still carries the old `container_id`**:

```
state='STOPPED', desired_action='STOP', container_id='ctr-live'
```

Nothing in the Kernel clears it. The only production writes that set
`container_id=NULL` are rebuilds and migrations, and neither runs for a plain stop.

The Node side is why: `RuntimeState::Stopped` is reported through `set_state`
(`apps/node/src/runtime.rs:94`), which updated `state`, `error` and `observed_at`
and left `container_id` alone.

## Why this is a real defect and not a cosmetic one

ADR-030 D4 makes `container_id` load-bearing for reclamation: a failed candidate
whose instance still references a container is **not** auto-reclaimed
(`RUNTIME_MAY_BE_RUNNING`), because stopping it would be a physical action against a
process that might be mid-write.

With a stale id, every stopped instance permanently looks like it might still be
running. The fail-closed direction is the safe one to be wrong in — nothing dangerous
happens — but it means the protection never lifts, so a candidate that has genuinely
stopped can never be reclaimed automatically. **The guard would silently become a
permanent block.**

## The fix

`set_state` clears `container_id` and `host_port` when the state becomes `Stopped`:

```rust
if matches!(state, RuntimeState::Stopped) {
    status.container_id = None;
    status.host_port = None;
}
```

In `set_state` rather than at the six `Stopped` call sites, because a seventh caller
would otherwise reintroduce the stale id silently — the same "one writer owns the
transition" argument ADR-030 D1 makes for `DRAINING` → `DISABLED`.

Two tests hold it:

- `stopping_clears_the_container_identity` — the field is cleared, and the published
  port with it.
- `only_stopping_clears_the_container_identity` — an `Unhealthy` instance **keeps** its
  container id. That distinction is what makes an unhealthy instance different from a
  stopped one, and clearing on every transition would erase it.

## What this still does not prove

- **The Kernel-side ordering.** This change makes the Node stop *claiming* a
  container it no longer has. It does not make the Kernel observe the container's
  exit independently — the Kernel still learns about it because the Node reported it,
  and a Node that dies without reporting leaves the last report standing. That is the
  failure mode `node_stale_seconds` and the UNREACHABLE sweep exist for, and it is
  Phase 9A's subject, not this one.
- **CPU/memory reservation, volumes, port release.** The brief lists these as separate
  observables. None is measured here: the Node reports state and container identity,
  not resource accounting, and nothing in the Kernel tracks per-instance CPU after the
  instance stops.
- **No staging observation.** staging has no stopped instance to observe; the four
  occupants are three `ACTIVE` and one `DEGRADED` (`capacity.json`, run 45799322906).
- **Not TASK-16.** The repeated release cycle, with restarts and failures interleaved,
  is the next task.

## One test-quality note

`concurrent_activate_and_reclaim_never_produce_both_outcomes` (TASK-14) failed once in
the full suite and passed alone three times. The cause was its own `(false, false)`
branch asserting `READY` after both operations backed out — a concurrent
`reconcile_once` from another test can move that row. The assertion now checks the
invariant that actually holds under concurrency (no ACTIVE revision was left behind)
rather than a final state the test does not exclusively own. **A test that asserts a
state another writer also owns is a test that fails at random.**
