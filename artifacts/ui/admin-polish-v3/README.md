# /admin V3 conformance pass — evidence index

Branch `claude/admin-polish-d10085`, 13 commits on top of `c6cb34f`.

| file | what it holds |
|---|---|
| `ratchet-before-after.md` | the eight budgets, before and after, with the command that printed each |
| `state-matrix.md` | the interaction-state matrix AGENTS.md §5 asks for |
| `BLOCKED-screenshots.md` | why there are no screenshots in this directory, with the exact failures |
| `BLOCKED-metrics-are-stale.md` | why `check-ui-metrics: PASS` does **not** validate this branch |

## The one-line summary

Six static rules; four reached zero, two moved partway and are blocked by things
outside this task's scope. Nothing was verified in a browser: this sandbox cannot
launch one and cannot bind a port, so every geometry claim here is a claim about
source text, not about rendered pixels. The two BLOCKED files say so in detail
rather than leaving a reader to infer it from a green gate.
