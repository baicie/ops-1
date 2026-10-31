# Deployed verification — staging serves the branch under review

Staging was serving `51e8eb7` (main) for the entire review period. Every before/after image in
`flagship/` came from a **local** build, so the review was of something that had never run on a
server. This closes that gap.

## What was deployed

```
workflow_dispatch staging-preview.yml  ref=feat/ui-visual-excellence-v3
run 40981417964   plan ✓  build ✓  deploy ✓  smoke ✓  record ✓  report ✓
                  seeded-data ×3 skipped (tier=core, by design)
```

## The check that matters

```
expected  bdb93b07a25a34c214fbc0ad782e6b4fe7d76e5d
served    bdb93b07a25a34c214fbc0ad782e6b4fe7d76e5d
```

A green run is not the same claim as "the host serves this commit". The SHA is compared literally.

## Are the deployed pages the same as the reviewed ones

The build artifacts are **byte-identical**: `index-5YSHGC76.js` (995,325 B, sha256 `28cada48…`),
`index-CSJ-0qwY.css` (115,359 B, sha256 `9a9b54c8…`) and `index.html` all match by `cmp`.

Across all 36 combinations (3 pages × 3 viewports × 2 themes × 2 locales), these are identical
between the deployed build and the reviewed local build:

| property | result |
|---|---|
| type-size set | **36/36 same** — `{11,12,14,16,26}` everywhere |
| surfacesTotal / panels | **36/36 same** |
| document overflow | **36/36 same**, always −15 (scrollbar gutter, not overflow) |
| smallest rendered type | **36/36 = 11px** |
| H1 box and line metrics | **36/36 same** (e.g. overview 1440 light en: 26px / h31 / lh31.2 / w322 / 1 line / not clipped) |
| card radius, shadow, border | **36/36 same** |
| table width and containment | same (1126px in a 1127px container, overflow −1) |
| 390 horizontal overflow | **none** — scrollWidth 375 / clientWidth 390 on all 12 mobile combinations |
| console errors / warnings | **0** across 36 loads |

Pixel difference runs 3.54 % – 17.36 % and is **entirely runtime data**, traced element by element:
the first differing row is y=13 on every desktop combination — the health pill. The reviewed images
show `● 1 critical`; staging shows `● Platform ready`. `/api/v1/overview` confirms it: health
`DEGRADED → READY`, attention `1 → 0`. At 390 the header region is **0.000 %** different, pixel for
pixel, and every difference below it is explained by row counts (plugins 3→4 rows, nodes 2→1 row).

## The one thing this does not cover

The reviewed images were captured against a **degraded** cluster — two macOS nodes, an attention
item, a critical pill. Staging today is healthy. So:

- **Transferable**: type scale, flattened box counts, overflow, spacing, card decoration, dark mode.
- **Not verified on staging**: how the degraded state itself renders — the attention band, the
  critical pill, the warning tone at page level.

If any review conclusion depends on the appearance of a degraded system, it is currently supported
only by local evidence.

## Two defects found while verifying

1. `/admin/overview` sets `document.title` to `"OpsWeave · OpsWeave"` — the overview route has no
   title mapping and falls back to the brand, so the brand appears twice. Every other route is
   correct (`"Plugins · OpsWeave"`). Not fixed: product code was frozen for review.
2. The three plugin `remoteEntry.js` files are refetched on every navigation
   (`fromDiskCache=false`) despite carrying `immutable`. The main JS and CSS are cached correctly.
   A performance issue, not a review blocker.

## Coverage of this document

Screenshots: 6 representative combinations are committed under `deployed/` (one per page at
1440 light en, plus the 390 variants used for the overflow claim). The other 30 were measured,
compared and discarded — the numbers above are the evidence, and this repository has already spent
one round learning what happens when every run's images are committed.

Not covered: hover / focus / dialog / form states, plugin microfrontend pages, DPR=2, locales other
than en and zh-CN.
