# UI interaction state matrix — 0.0.1

| Surface | LOADING | EMPTY | READY | DEGRADED / UNREACHABLE | UNKNOWN | FORBIDDEN | CONFLICT / FAILED |
|---|---|---|---|---|---|---|---|
| Overview | skeleton KPI/panel | no nodes or no plugins CTA | health banner + counts | attention list with severity, last observed | never shown as green | hooks return 403 state | error state with retry |
| Plugins | skeleton rows | install CTA | state + active revision | deployment DEGRADED badge | dashed UNKNOWN badge | install/deploy buttons hidden, server still 403 | conflict error toast + request id |
| Install wizard | upload spinner | file chooser | signature/permission review | readiness blocked, reason shown | readiness waits, no fake success | admin-only trust actions | activation rejected, previous revision retained |
| Plugin detail | skeleton | no deployments | effective state + instance table | instance/ deployment badges | last observed retained | disable/uninstall permission errors | deploy/activate conflict shows latest revision |
| Nodes | skeleton | join wizard | heartbeat + resources | stale text with `observed_at` | stale resources show No data | admin-only token/revoke | revoke confirm and error toast |
| Instance logs | connect status | waiting for events | log lines + follow | disconnected/gap banner | explicit `LOG_STREAM_ERROR` | 403 page/state | 400 forged cursor, 410-style gap event |
| Activity | skeleton | no events | event table | failure events in danger tone | n/a | API 403 state | expandable redacted details |
| Access | skeleton | no publishers | users + trust table | revoked publisher badge | n/a | admin controls absent | duplicate user / add error |
| Bootstrap diagnostics | skeleton | no nodes | DB/counts/policies | node status colors | no data instead of zero | admin role required | retry + raw JSON |
| Ops Center | skeleton | no nodes/plugins | health summary + shortcuts | node/plugin issue list | unknown not green | operator controls only | error state with diagnostics link |
| Extension route | loading module | no contribution | signed remote renders | remote error boundary | n/a | host reserved-route rejection | retry without breaking Shell |

Global rules implemented: one primary CTA per view, no fake production health, `UNKNOWN`/`UNREACHABLE` preserve last observation, tables become labelled stacked rows under 760 px, dialogs trap focus and explain consequences, and the log viewer has explicit pause vs. follow semantics.
