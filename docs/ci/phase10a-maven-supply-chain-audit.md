# Phase 10A TASK-31: the Maven supply chain, audited

Read-only audit. Every claim below is from the workflow files and the POM in this
repository at `63ef2451`; no measurement is presented without saying where it came
from, and nothing here is an estimate.

## The real call graph

`scripts/build-plugins.sh` is the only thing that runs Maven. It is invoked by
**three** workflows, and a fourth runs the conformance matrix that consumes its
output:

| workflow | job | invokes |
|---|---|---|
| `plugin-lifecycle.yml` | `full TypeScript lifecycle` | `scripts/build-plugins.sh` (`full TypeScript plugin lifecycle`) |
| `data-foundation.yml` | `data-foundation` | `scripts/build-plugins.sh` (line 210) |
| `runtime-conformance.yml` | `conformance` | builds the three bundles (the Java one included) |
| `ci.yml` | `legacy-regression` | `tests/scripts/build-plugins-retry.test.sh` (the retry policy, not a real build) |

**Three workflows each do a full cold `mvn` resolve of the same dependencies.**

## The ten questions, answered

| # | question | answer |
|---|---|---|
| 1 | how many workflows build the Java plugin | **3** (`plugin-lifecycle`, `data-foundation`, `runtime-conformance`) |
| 2 | do they repeat each other's resolution | **yes** — each does its own cold resolve |
| 3 | is `setup-java`'s cache used | **no**. All three use `actions/setup-java@v4` with `{ distribution: temurin, java-version: '21' }` and **no `cache:` input** |
| 4 | is `~/.m2/repository` cached | **no**. `grep -i 'maven\|java'` over the `cache` lines of all three returns nothing |
| 5 | does any cache key cover POM/profiles/toolchain | **not applicable** — there is no cache |
| 6 | can jobs hit a shared valid cache | **no** — nothing is written to share |
| 7 | is a cache failure reported | **not applicable** |
| 8 | do branch scopes prevent sharing | **not applicable today**, and would be the next question once a cache exists: GitHub cache scopes by branch, and a cache written on a PR branch is not readable by `main`'s runs |
| 9 | does Maven still request the same fixed Parent POM every time | **yes**. `plugins/hello-java/pom.xml:6-10` declares `spring-boot-starter-parent:3.3.5` with `<relativePath/>`, which means "resolve it from the repository, never look locally" |
| 10 | can zero-byte POMs or partial files enter a cache | **not today** (no cache). **This becomes a real risk the moment one is added** — Maven writes into `~/.m2` as it downloads, and a cancelled job leaves whatever it had written |

## The dependency that actually fails

Every observed failure names exactly one artifact:

```
org.springframework.boot:spring-boot-starter-parent:pom:3.3.5
Could not transfer artifact ... status: 429
```

`<relativePath/>` is the reason it is always fetched rather than taken from a
local module: it tells Maven the parent is not in this project tree. That is the
correct setting for a published plugin, and it is also why the cold path always
touches the network.

## What is measured, and what is not

**Measured** (from run logs, this repository):

- `full TypeScript lifecycle` wall time: 40–60 minutes on a green run, of which the
  Maven resolve is a small part — the job also builds Rust, installs pnpm, pulls
  Playwright, runs a real browser lifecycle.
- Four 429 failures across six Java-touching runs on one branch, with one pass in
  between. **Six is a small sample**; this supports "frequent enough to cost time",
  not a rate.

**Not measured, and deliberately not guessed:**

- Maven cold versus warm build time. Measuring it requires the warm path to exist,
  which is TASK-32.
- Cache hit rate — there is no cache to hit.
- The share of the critical path that is Maven. The lifecycle job's steps are timed
  individually in its log; nobody has summed the Maven step against the whole.

**An estimate here would be the exact kind of number this project has been burned
by before** — one that reads as measurement and is not.

## What the audit changes

Nothing yet. It establishes two facts that decide TASK-32's shape:

1. **The fix is not "retry more".** The wrapper already retries three times with
   15 s and 30 s backoff, and on run 45931039517 the second attempt also got a 429.
   The limit window outlived the budget.
2. **The fix is one warm repository, shared.** Three workflows resolving the same
   POM independently is the waste; `actions/setup-java`'s `cache: maven` is the
   built-in way to share it, and its key is derived from the POM files it finds.

## The `-U` flag, and why the cache's effect is not yet proven

`mvn_package` runs `mvn -B -U ... package`. `-U` forces a check for updated
release metadata, and the comment above it explains why: without it, a retry
re-reads Maven's cached FAILURE ("This failure was cached in the local
repository") and never issues a second request.

**What `-U` does not do is re-download artifacts it already has.** It refreshes
metadata; a resolved artifact whose checksum matches stays on disk.

**But that is a reading of Maven's behaviour, not a measurement of this pipeline.**
Whether `cache: maven` measurably removes the 429 exposure has to be established
by running it — and it cannot be established from a single green run, because a
green run proves only that Central answered that time.

So this audit's honest position:

- the cache is now configured on all three Java-building workflows;
- the POM dependency path is pinned so a change invalidates it;
- **the benefit is unmeasured**, and will be measured by TASK-35 from run timings
  and from whether the 429 disappears on a future occurrence.

If a future run shows the cache is populated but Central is still contacted for the
parent POM every time, the next step is `-o` for the build step after a warm step —
which is TASK-33/34's subject, not this one's.

## Successor

TASK-32 (unified dependency preparation) and TASK-33 (an immutable snapshot if the
GitHub cache is not enough). Both are gated on measurements this audit says do not
exist yet — so TASK-32 starts by producing them, not by assuming the win.
