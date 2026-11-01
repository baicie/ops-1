# Interaction state matrix — `/admin` V3 polish

`AGENTS.md` clause 5 asks for this matrix **and** real browser screenshots at
1440 / 1024 / 390 in both themes. The matrix is below. **The screenshots do not
exist**: the sandbox blocks both halves of the instrument (Chrome cannot create
its process-singleton socket; `127.0.0.1` cannot be bound; `cdn.playwright.dev`
is denied). `BLOCKED-screenshots.md` in this directory records the exact commands
and the exact errors. Nothing here is a visual claim — every row says what
verified it, and "not verified" appears wherever that is the truth.

Legend for **verified by**:
- `src` — source-text assertion in `src/styles.tier-contract.test.ts` (12 assertions, each
  mutation-tested: I reintroduced the defect, watched the test fail, reverted).
- `css` — the value in the **shipped** bundle, read out of `dist/assets/*.css` after
  `pnpm --filter @opsweave/platform-web build`.
- `unit` — `vitest run src` (226 passing).
- `tsc` — `tsc --noEmit` (exit 0).
- `gate` — `check-ui-tokens.mjs` counts.
- **`eye` — NOT VERIFIED.** Needs a browser. No row below is marked `eye`-verified.

---

## 1. Radius tiers (`token-table` R1)

| state | expected | verified by |
|---|---|---|
| any control (button, input, select, tab, chip, inline `code`, row menu) | 6px via `--ow-radius-control` | `src`, `css` (41 declarations in bundle) |
| any surface (panel, card, KPI card, dialog, popover, menu) | 10px via `--ow-radius-card` | `src`, `css` (51) |
| any round thing (badge, status pill, avatar, dot, progress track, icon ring) | 9999px via `--ow-radius-pill` | `src`, `css` (24) |
| a 24×32 icon button in a toast | a pill, **not an ellipse** | `src` (asserts no `50%` survives) |
| `rounded-md` / `rounded-sm` / `rounded-lg` in a copy-in primitive | none exist; the four primitives read `rounded-control` / `rounded-card` | `src`, `gate` (0) |
| **shape preservation** | the 17 `50%` circles and 8 `999px` pills stayed round. My first pass collapsed all 25 onto `control` (6px) — avatars and status dots rendered as rounded squares. Caught by reading the rewritten selectors back before commit; the mapping is now per-job, not per-value. | `src`, `css` |

## 2. Control tiers (`token-table` R3)

| state | expected | verified by |
|---|---|---|
| form control (button, input, select, primary row action) | 40px (`--ow-control-md`) | `src`, `css` |
| dense control (tab, filter chip, icon button, row menu) | 32px (`--ow-control-sm`, was 28) | `src`, `css` |
| `≤767px`, any interactive control | `min-height: 44px` from `--ow-control-touch`, stated once | `src` (asserts no per-component `44px`) |
| `≤767px`, icon button | 44×44 — **both** axes, not a 32×44 rectangle | `src` |
| `≤767px`, decoration (dot, bar, brand mark, spinner) | untouched by the floor | `src` |
| `size="lg"` on a Button | the size no longer exists; 44 is a floor, not a size a call site may ask for | `tsc` (union type), `gate` |
| toolbar row | every control on the row is 40px — the measured defect was a 36px Input beside a 28px TabsTrigger | `src`-adjacent: the rule is scoped `.toolbar [role='tab']`, asserted present in `css`. **Row alignment itself is `eye`: NOT VERIFIED.** |
| tab strip in a table row or panel head | keeps 32px — C1 is about context, not component | `css` (scoping is `.toolbar`-only) |

## 3. Machine language (`machine-language-rules` M1–M3)

| state | expected | verified by |
|---|---|---|
| `formatBytes(undefined \| null \| NaN \| -1)` | `null` → caller renders dashed `NO_DATA` | `unit` (`src/format.test.ts`) |
| `formatBytes(0)` | `"0 B"` — a reading. **Zero is not absence**; the old `value <= 0` folded them together | `unit` |
| `formatBytes(1536)` in `zh-CN` | `"1.5 KiB"` — binary symbols stay (IEC 80000-13), the number localizes | `unit` |
| `formatDuration(67000)` | `"18h"` / `"18小时"` from one `Intl` call, no unit keys in the catalog | `unit` |
| `formatDuration(-1 \| NaN)` | `null` → caller renders the token | `unit` |
| a byte pair with one half missing | **one** dashed token for the pair, never `NO_DATA / NO_DATA` (M1 budgets one per region) | `unit`, `tsc` |
| uppercase micro-label, `lang="en"` | uppercase + its original tracking, unchanged pixels | `src`, `css` |
| uppercase micro-label, `lang="zh-CN"` | no transform, **no letter-spacing** — tracking travels with the transform, because .04–.09em is what makes CJK look broken | `src`, `css` |
| `<html lang>` | set to `en` or `zh-CN` live by `i18n/index.tsx:85`, so `:lang(en)` is not inert | `grep` + `Locale` union in `tsc` |

## 4. Status semantics (the audit's most severe defect — must not regress)

| state | expected | verified by |
|---|---|---|
| `SUCCEEDED` | `ok` tone, **check** glyph — not "never observed" | `unit` (`status-tone.test.ts`) |
| `RUNNING` / `CLAIMED` | `info`, **refresh** glyph | `unit` |
| `QUEUED` | `warn`, **alert** glyph | `unit` |
| `CANCELLED` | `neutral`, **pause** glyph | `unit` |
| `ACCEPTED` | `neutral`, **inbox** glyph — "we accepted it" is not "it happened" | `unit` |
| an unmapped wire code | `unknown` tone, **rotate** glyph, code verbatim in `title` + `data-status`; never silently folded into a known value | `unit` |
| colour-blind reading | shape differs per tone (check / refresh / alert / warning / pause / rotate / inbox), so shape carries the meaning before colour does | `unit` (glyph map asserted) |
| the two-table divergence guard | still passing, untouched | `unit` (12 assertions across `status-tone` + `status-indicator`) |

**I changed no status mapping.** The one shared table and its tests are as I found them.

## 5. Page-level changes

| page | state | expected | verified by |
|---|---|---|---|
| `/admin/pipelines/:id/editor` (2.25) | N saved drafts | one labelled `<select>` + a count, replacing N equal-weight buttons. The audit measured 18 buttons / 3 rows / 130px presenting *history* as the primary action area. | `tsc`, `unit` |
| same | draft timestamp | the shell's own age ladder. It was `new Date().toLocaleString()` — browser-locale, so a `zh-CN` console printed `10/29/2026, 7:09:01 PM`. | `tsc` (key union), `grep` (no `toLocaleString` left in `studio/`) |
| same | the dead `.draft-row` / `.studio-drafts` CSS | deleted — `code-rules.test.ts` caught both as orphans, which is the existing test working | `unit` |
| `/admin/pipelines/:id` (2.62) | execution path at ≤767 | stacks vertically, arrows rotate 90°, `small` wraps. It was `overflow-x: auto` + `white-space: nowrap`, measured 91px past the 375px content box — so reading execution *order* required horizontal scrolling. | `css`. **Visual stack is `eye`: NOT VERIFIED.** |
| `/admin/settings/diagnostics` (2.62) | 6-item band ladder | 6 → 2 → 1 columns. It went 6 → **3** → 2 → 1; the spec forbids 3 ("a 4-col band that can be 3 columns cannot be scanned as a band"). | `css` |
| `/admin/plugins/:id` (3.0) | 7-tab strip at 390 | `FilterScroller` — a fade only on an edge that really hides content, and the active tab scrolled into view. It was a bare `overflow-x-auto`: 97px clipped, no hint, and the tab in force could sit outside the window. | `tsc`, `unit` |
| `/admin/jobs` (3.12) | 6-tab status strip | same scroller; was `flex-wrap`, which grew the toolbar's declared 40px row into an undeclared two-line one | `tsc`, `unit` |
| all band pages | KPI band gap | 16px, not 12. The card's own padding is 16, so a 12px gap made the space *inside* a card tighter than the space *between* cards. | `css` |
| all band pages | KPI card height | 92px floor on band members, scoped `.metric-grid > *` / `.pipeline-stats > *` / `.job-stats > *` | `css` |
| `/admin/overview` (flagship, must not be redone) | `.stat-strip` / `.ow-metric` / `.module-strip` | **unchanged.** My first attempt put the 92px floor on `.ow-metric` itself, which `.stat-strip > *` also matches — that would have inflated Overview's deliberately dense strip. Reverted and re-scoped to the band container. | `git diff` shows no `.stat-strip` / `.ow-metric` / `.module-strip` rule modified |

## 6. The five things the audit says must survive

| # | thing | state |
|---|---|---|
| 1 | five async states | `AsyncBoundary` untouched; `unit` green |
| 2 | status encoded three ways, not colour alone | tone + glyph + text, `unit` green (§4) |
| 3 | missing data prints `NO_DATA`, never `0` | **strengthened**: `formatBytes` no longer folds `0` into absence |
| 4 | one primary action per page header | `PageHeader`'s `primary` prop untouched; 2 more pages now use it instead of the duplicate |
| 5 | dark mode is pure token swap | no colour token added, removed or changed; `git diff` touches no `html[data-theme="dark"]` rule. **Dark rendering itself is `eye`: NOT VERIFIED.** |

## 7. What a reviewer with a browser still has to look at

In priority order, because these are the rows above that no static check can close:

1. **390px:** `/admin/pipelines/:id` — is the stacked path readable, do the rotated arrows read as sequence?
2. **390px:** `/admin/plugins/:id` and `/admin/jobs` — does the fade appear only when content is really hidden, is the active tab visible?
3. **1440 + 1024:** every toolbar row — is the 40px baseline actually flat now?
4. **Both themes:** nothing should have moved, but the radius change touched 105 declarations and only a screenshot pair can prove no corner looks wrong.
5. **`zh-CN` at every width:** the micro-labels lost their letter-spacing. That is intended; it should be *checked*.
