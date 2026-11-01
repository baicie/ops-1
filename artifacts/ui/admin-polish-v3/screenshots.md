# Real-browser screenshots: now produced (this file used to say BLOCKED)

AGENTS.md §5 requires real browser screenshots at 1440 / 1024 / 390 in light and dark for any
UI change, plus an interaction-state matrix. An earlier commit on this branch recorded that none
could be produced: the sandbox refused to launch a browser, refused to bind a port, and refused
the Playwright CDN. **That is no longer true**, and this file records what replaced it.

The earlier text is kept at the bottom verbatim, because the first run's failures were real and
because two of them are what hid the defects the images then exposed.

## What was produced

| artifact | where |
|---|---|
| 84 matrix screenshots (7 pages × 3 widths × 2 themes × 2 locales) | `artifacts/ui/g08-admin-polish/g08-<sha>-<page>-<width>-<theme>-<locale>.png` |
| the state fixtures the spec re-captures as it runs | same directory, `state-*.png` |
| the interaction-state matrix | `state-matrix.md` |
| fresh geometry measurements | `artifacts/ui/visual-v3/audit-fresh/_metrics_r*.json` |

## How, exactly

The previous attempt tried to drive the Vite dev server. That was the wrong instrument: the
kernel already serves the built bundle, and it was one `cargo build` away.

```
# 1. A Kernel built from THIS tree, not borrowed from another checkout.
#    (ops-0.0.4-studio's binary is 13k lines ahead - it has scope.rs and workspaces.rs - so
#    running the specs against it would have tested a different backend.)
cargo build -p opsweave-kernel --offline

# 2. An isolated database: four sibling sessions share this machine.
createdb opsweave_adminpolish_ui

# 3. The bundle the Kernel will serve.
pnpm --filter @opsweave/platform-web build

# 4. Kernel on the port every spec defaults to.
OPSWEAVE_BIND=127.0.0.1:18181 \
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/opsweave_adminpolish_ui \
OPSWEAVE_WEB_DIST=$PWD/apps/platform-web/dist \
OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL=admin@opsweave.local \
OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD='OpsWeave!2026' \
OPSWEAVE_DEV_PUBLISHER_ID=trusted-team \
OPSWEAVE_DEV_PUBLISHER_PUBLIC_KEY="$(cat keys/publisher.pub)" \
./target/debug/opsweave-kernel

# 5. Playwright's own Chromium (1.64.1 -> chromium-1248).
tests/ui/node_modules/.bin/playwright install chromium

# 6. The spec.
cd tests/ui && OPSWEAVE_URL=http://127.0.0.1:18181 \
  ./node_modules/.bin/playwright test admin-polish.spec.ts --project=chromium
```

`keys/` is gitignored, so it was copied from the main checkout; the kernel will not seed a
trusted publisher without it.

## What the browser found that no static check could

Both of these were introduced by this branch, and both are invisible to `check-ui-tokens.mjs`,
which reads source text and not geometry. The committed audit records `overflow: -15` on every
page at 390, so neither existed at `c6cb34f`:

1. **Every admin page measured 393 against 390.** The touch floor added earlier in this branch
   raised the two 32px topbar squares to 44 - correct for the height, and then I made them 44
   *wide* as well to keep them square. That is +24px on a fixed row with 16px of slack. The spec
   constrains the control's height, not its width; the floor now raises the height only.
2. **`/admin/jobs` measured 442.** The status strip overflowed the page rather than scrolling in
   place: Radix's `Tabs` root is a plain div that sized to its content as a flex child, so the
   scroller's `max-width: 100%` resolved against an inflated parent and the inner `overflow-x`
   never had anything to scroll.

The first was visible in the very first screenshot taken (the account button clipped at the right
edge). No gate reported it. That is the argument for the §5 requirement, made by the requirement.

## What is still not covered

- **The `zh-CN` locale screenshots are not proof-read by a human.** They exist and were captured;
  the letter-spacing change on micro-labels is one of the things §5 asks a person to look at, and
  no person has.
- **The full suite has not been run to completion against this tree.** `admin-polish.spec.ts`
  passes 11/11; the other spec files were not all exercised.
- **No production or staging data.** Every image is this local kernel with its bootstrap admin and
  empty tables. Pages whose value is in their rows (a populated Jobs table, an activity stream)
  show their empty state here, and their layout with data is unverified.

---

# Appendix: the original failure record (kept verbatim, superseded)

## 1. No local port could be bound

```
$ node -e "require('http').createServer().listen(5199,'127.0.0.1')"
BIND FAILED: EPERM listen EPERM: operation not permitted 127.0.0.1:5199
```

`sandbox.network.allowLocalBinding` was false, so `vite dev` / `vite preview` could not serve the
app.

## 2. Chrome could not start, even headless, even on file://

```
ERROR:.../crashpad/util/mach/bootstrap.cc:65] bootstrap_check_in
  org.chromium.crashpad.child_port_handshake...: Permission denied (1100)
ERROR:.../chrome/browser/process_singleton_posix.cc:1046] Failed to create socket directory.
ERROR:.../chrome/app/chrome_main_delegate.cc:624] Failed to create a ProcessSingleton for your
  profile directory. ... Aborting now to avoid profile corruption.
```

## 3. `playwright install` could not reach its CDN

```
Error: getaddrinfo ENOTFOUND cdn.playwright.dev
```
