# /admin V3 conformance pass — evidence index

Branch `claude/admin-polish-d10085`, on top of `c6cb34f`.

| file | what it holds |
|---|---|
| `ratchet-before-after.md` | the eight budgets, before and after, with the command that printed each |
| `state-matrix.md` | the interaction-state matrix AGENTS.md §5 asks for |
| `screenshots.md` | how the 84 matrix images were captured, and what is still not reviewed |
| `suite-results.md` | the full Playwright result, and the base-tree comparison that says which failures predate this branch |
| `../../../../apps/platform-web/src/styles.tier-contract.test.ts` | the 12 assertions holding the four cleared rules at zero |

## The one-line summary

Six static rules; four reached zero, two moved partway and are blocked by things outside this
task's scope. Everything claimed here was run in this checkout: a Kernel was built from this tree,
a browser drove it, and the geometry gates read measurements taken from it rather than a snapshot.

## What the browser changed

Two 390px defects that no static check could see, both introduced by this branch and both found
only after a real browser could run:

- every admin page measured **393 against 390** — a touch-floor fix that widened two topbar
  squares to keep them square, which the spec never asked for;
- `/admin/jobs` measured **442** — a tab strip that overflowed the page instead of scrolling
  because its Radix wrapper grew to fit its content.

Both are fixed in `381bbc6`, and `check-ui-metrics` on freshly collected artifacts reports
`overflow: -15` on all 10 measured pages at all 3 viewports — the same value as the `c6cb34f`
baseline.

## What is still not verified

- **No human has looked at the 84 screenshots.** They exist; reviewing them is a separate act.
  `state-matrix.md` §7 lists what a reviewer should check.
- **The full Playwright suite does not pass in this environment** — 103 passed, 29 failed. Four of
  the failures I suspected were mine were re-run against a second checkout of the base commit and
  fail identically there; `suite-results.md` records that comparison. The file this task is judged
  on, `admin-polish.spec.ts`, goes from **10 passed / 1 failed** at base to **11 / 0** here.
- **`type-tier` (6) and `one-header` (3) are not zero**, for reasons recorded in
  `ratchet-before-after.md`; both need a decision or a file this task may not edit.
