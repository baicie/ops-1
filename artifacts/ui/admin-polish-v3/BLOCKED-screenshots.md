# Real-browser screenshots: blocked by this session's sandbox

AGENTS.md §5 requires real browser screenshots at 1440 / 1024 / 390 in light and dark for any
UI change. In THIS session that is not achievable, and the reason is the sandbox, not the code.
Recorded here verbatim so the next session does not re-derive it.

## 1. No local port can be bound

```
$ node -e "require('http').createServer().listen(5199,'127.0.0.1')"
BIND FAILED: EPERM listen EPERM: operation not permitted 127.0.0.1:5199
```

`sandbox.network.allowLocalBinding` is false here, so `vite dev` / `vite preview` cannot serve
the app. Every committed Playwright spec points at `http://127.0.0.1:5173`, so none of them can
run either.

## 2. Chrome cannot start, even headless, even on file://

Real Chrome is installed (`/Applications/Google Chrome.app`) and `--dump-dom` on a `file://` URL
works, but `--screenshot` and Playwright's `channel: 'chrome'` both abort:

```
ERROR:.../crashpad/util/mach/bootstrap.cc:65] bootstrap_check_in
  org.chromium.crashpad.child_port_handshake...: Permission denied (1100)
ERROR:.../chrome/browser/process_singleton_posix.cc:1046] Failed to create socket directory.
ERROR:.../chrome/app/chrome_main_delegate.cc:624] Failed to create a ProcessSingleton for your
  profile directory. ... Aborting now to avoid profile corruption.
```

Tried and still failing: `--user-data-dir` inside `$TMPDIR`, `--headless=new`,
`--disable-crash-reporter`, `--no-sandbox`, `--disable-features=ProcessSingleton`,
`--crash-dumps-dir` in `$TMPDIR`, and `HOME` redirected into `$TMPDIR`. The blocker is the
Mach bootstrap port and the singleton socket directory, which the Seatbelt profile denies
regardless of where the profile lives. No Playwright-managed Chromium is installed and the
download host is denied (see §3).

## 3. The package registry is denied

```
$ pnpm install
ERR_PNPM_FETCH_403  GET https://registry.npmmirror.com/...: user denied - 403
ERR_PNPM_FETCH_403  GET https://registry.npmjs.org/@playwright/test/...: user denied - 403
<sandbox_violations> deny network-outbound registry.npmjs.org:443 (user denied)
```

So `playwright install chromium` cannot fetch a browser either.

## What WAS verified instead, and what that does and does not prove

| instrument | what it proves | what it cannot prove |
|---|---|---|
| `check-ui-tokens.mjs` | the source text obeys R1–R7 (exit 0) | nothing about rendered pixels |
| `check-ui-metrics.mjs` | the 30 committed page measurements still satisfy all 9 §4.2 assertions | the measurements predate this branch; they are not a reading of it |
| `vitest run src` 214/214 | the token contract, the status table, the code rules | no layout, no geometry |
| `tsc --noEmit` exit 0 | every call site type-checks | — |

The radius/control/type work in this branch changes RENDERED values (e.g. 7px -> 6px corners,
28px -> 32px dense controls). Those deltas are derived in each commit message from the source,
and they are NOT visually confirmed. Treat them as unverified until someone runs the matrix
below on a machine that can bind a port and start a browser.

## The matrix to run, once a browser is available

```bash
pnpm --filter @opsweave/platform-web dev           # needs allowLocalBinding
cd tests/ui && V3_MODE=after npx playwright test ui-table-audit.spec.ts --project=chromium
node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/table/after
```

Routes that carry this branch's risk, in order: `/admin/pipelines/:id/editor` (the studio owns
the most literals that moved), `/admin/pipelines/:id` (the 390 flow-step overflow), `/admin/jobs`
(toolbar control tiers), `/admin/governance`, `/admin/settings/diagnostics`. Each at 1440 / 1024
/ 390, light and dark, `en` and `zh-CN` — the `:lang(en)` casing rule must be checked in BOTH
languages, since that is the pair it is about.

---

## What `check-ui-metrics` PASS does and does not prove (read this before quoting it)

`node scripts/check-ui-metrics.mjs artifacts/ui/visual-v3/audit` exits 0 on this branch. That
exit code is **not** evidence about my changes, and must not be reported as if it were.

The script reads `_metrics_*.json` from disk. Those three files are tracked in git and were
written by `c6cb34f` (the flagship commit, 2026-10-31):

```
$ git log --oneline -1 -- artifacts/ui/visual-v3/audit/_metrics_r390-light-en.json
c6cb34f UI Visual Excellence V3: audit, design system, and three flagship pages (#15)
```

The only thing in the tree that writes them is `tests/ui/ui-table-audit.spec.ts`, which needs a
browser and a dev server — both blocked above. So the gate is re-asserting October's geometry
against October's numbers. It proves my commits did not *delete or corrupt* the artifact set; it
proves nothing about the geometry of the pages after my CSS edits.

Stated plainly: **the 30 page measurements behind that PASS predate every commit on this branch.**
