# The ratchet, before and after

Command, both times, from the repo root:

```
node scripts/check-ui-tokens.mjs                                                  # bare counts
node scripts/check-ui-tokens.mjs --ratchet docs/design/ui-visual-v3/spec/ui-debt.json
node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit
```

## Counts

| rule | at `c6cb34f` | now | Δ | what closed it |
|---|---:|---:|---:|---|
| `radius-tier` | 118 | **0** | −118 | 105 CSS declarations onto `control`/`card`/`pill`; 13 TSX `rounded-*` onto named-tier utilities |
| `control-tier` | 14 | **0** | −14 | 7 CSS heights (30/36/38/46) onto the two tiers; `sm` 28→32; `lg` (44) deleted; 4 primitives off `h-7`/`h-9`/`h-11` |
| `uppercase-guard` | 19 | **0** | −19 | one `:lang(en)` block, 9 rules grouped by tracking value |
| `format-locale` | 4 | **0** | −4 | `formatBytes` / `formatDuration` through `Intl`, absence returns `null` |
| `type-tier` | 7 | **6** | −1 | `code { font-size: .94em }` → `--ow-type-meta`. **The other 6 are blocked — see below.** |
| `one-header` | 5 | **3** | −2 | `NotFound` + `OpsCenter` → `components/app/page-header`. **The other 3 are blocked — see below.** |
| `spacing-token-literal` | 52 | 52 | 0 | not emitted by either gate (see below) |
| `spacing-off-scale` | 108 | 108 | 0 | not emitted by either gate (see below) |

`docs/design/ui-visual-v3/spec/ui-debt.json` was lowered to match each drop, in the
same commit as the drop. No budget was raised. Four rules now sit at zero with a
unit-test floor under them (`src/styles.tier-contract.test.ts`, 12 assertions),
so they cannot be undone by a budget creeping back up.

## Why `type-tier` stops at 6

The remaining six are the six token DECLARATIONS:

```
--ow-type-sm: 12px   --ow-type-base: 14px   --ow-type-lg: 16px
--ow-type-xl: clamp(20px, 2.1vw, 26px)      --ow-type-metric: 21px
--ow-type-hero: clamp(30px, 4vw, 44px)
```

Deleting them is blocked by two facts in the tree, not by effort:

1. **A committed test pins two of them.** `src/styles.token-contract.test.ts:30-31`
   asserts `--ow-type-base: 14px` and `--ow-type-sm: 12px` exist. The spec's R2
   deletes both. One of those two is wrong, and resolving it is a decision about
   which document wins, not a mechanical edit — so the budget stays at 6 rather
   than my deleting a committed assertion to make a number drop.

2. **The gate contradicts its own spec on `hero`.** `token-table.md` R2 says
   `--ow-type-hero` "survives **only** on `/login` and the 403 surface … named in
   the gate's exemption list". `scripts/check-ui-tokens.mjs` has no exemption list
   (`grep -c exempt` → 0), so the documented exception is counted as a violation.
   The two `hero` call sites are `/login` and `.readiness-number` — `/login` scored
   2.75 in the audit and is **not** in this task's page scope.

Collapsing 123 `--ow-type-sm` and 31 `--ow-type-base` usages onto the four-tier
ladder is also a type change on every page in the product, including the three
flagship pages this task must not redo and the `/app` pages four sibling sessions
are editing concurrently. It is a change whose only honest verification is a
browser, which this sandbox does not have.

## Why `one-header` stops at 3

```
components/Ui.tsx                 second PageHeader implementation
pages/workspace.tsx               imports PageHeader from components/Ui
shells/surface/SurfaceChrome.tsx  imports PageHeader from components/Ui
```

`pages/workspace.tsx` is on this task's do-not-touch list. The duplicate in
`components/Ui.tsx` cannot be deleted while a file I may not edit imports it, and
`SurfaceChrome.tsx` is a surface shell, not an `/admin` page.

Both remaining importers pass only `title` / `description` / `eyebrow` / `actions`,
which is a strict subset of the canonical component's props, so the migration is
mechanical for whoever owns those two files: repoint the import, delete
`Ui.tsx`'s copy, and the rule reaches zero.

## Why the two `spacing-*` budgets did not move

Neither gate emits them. `check-ui-tokens.mjs:161` declares its rule list as

```js
const RULES = ['radius-tier', 'control-tier', 'type-tier', 'one-header', 'uppercase-guard', 'format-locale'];
```

and `grep -rn "spacing-off-scale" scripts/ apps/` matches nothing but the budget
file itself. The two keys are inert: a number no code reads. They are left at
their recorded values rather than deleted, because deleting a budget is also a
way of making a gate quieter.
