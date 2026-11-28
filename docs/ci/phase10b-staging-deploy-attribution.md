# Phase 10B TASK-36: staging deploy failures, attributed

Two staging runs failed on `63ef2451`. **They have different causes**, and the
brief's warning not to assume a shared root is correct — the second one's message
even points at the first one's area and would be misleading if taken at face value.

## Run 45910239668 — `PLUGIN_PUBLISH`

```
Error: opsweave.data-catalog@0.0.65450 is FAILED with no READY replica;
a publish will not retry it unattended
```

The deploy refused to proceed because a plugin it needs is in `FAILED`. This is
the capacity situation ADR-030 and the Phase 9D change plan address: the node is
4/4, the target package did not reach READY, and the platform will not silently
retry a failed publish unattended.

**Attribution: `PLUGIN_PUBLISH`.** Not transport, not the host.

## Run 45999793408 — `RELEASE_IDENTITY`, behind a misleading message

`build image: success`. The deploy then failed with:

```
image ghcr.io/baicie/opsweave:63ef2451... is not resolvable yet (attempt 1/3)
image ghcr.io/baicie/opsweave:63ef2451... is not resolvable yet (attempt 2/3)
image ghcr.io/baicie/opsweave:63ef2451... is not resolvable yet (attempt 3/3)
ERROR image ... is not resolvable from this host; check that the build pushed it
      and that registry credentials are valid
```

The build succeeded and pushed, so the "not pushed" half of that message is
wrong. The log line above it says why:

```
no /srv/opsweave-staging/ghcr.token; relying on an existing docker login for ghcr.io/baicie/opsweave
```

`check_image_available` calls `ensure_registry_auth || true` — **it continues after
authentication fails.** With no token file on the host, the check ran against
whatever login was already there, which was evidently not able to read the
manifest. Three retries at five-second intervals cannot fix an authentication
problem.

**Attribution: `RELEASE_IDENTITY`** — the host could not establish the identity of
the image it was asked to run. Calling it `IMAGE_TRANSPORT` would be wrong: nothing
needed transferring, and the fallback said so.

### The second defect: the fallback's inference

The next step reasoned:

> "The host holds no image" is the only evidence that the pull is what failed […]
> Any other failure must not be papered over with a transfer.

and, finding the host *did* hold the image, concluded:

> The host already holds … so the failed deploy was not an image transport
> failure and nothing is transferred; read the deploy step above.

**That inference is invalid.** "The host has the image" and "the registry has the
image" are different facts. The first is satisfied by any earlier successful
deploy; the second is what `docker manifest inspect` asks. So the fallback's
stated conclusion — *not* an image transport failure — does not follow, and the
advice "read the deploy step above" points at a step whose only actionable line is
the resolution error the operator already read.

The condition that actually distinguishes the cases is the one the script already
computes and then discards: **did authentication succeed?**

## The precise failure stage of each

| run | stage | evidence |
|---|---|---|
| 45910239668 | `PLUGIN_PUBLISH` | the plugin is `FAILED` with no READY replica |
| 45999793408 | `RELEASE_IDENTITY` | build pushed; manifest unreadable because `ghcr.token` is absent on the host and the failure was swallowed by `|| true` |

Neither is `IMAGE_TRANSPORT`, `HOST_PREPARATION`, `DEPLOY_LOCK`,
`COMPOSE_UPDATE`, `HEALTH_VERIFICATION` or `ACCEPTANCE`.

## What a fix must not do

- **Not** retry the manifest check more times. Authentication does not fix itself
  in fifteen seconds.
- **Not** transfer the image. The host has it; the problem is that the *release
  identity* cannot be confirmed, and transferring a copy would not confirm it.
- **Not** treat "host holds the image" as evidence about the registry.

## What is deliberately not changed here

The obvious fix — make `check_image_available` fail fast when
`ensure_registry_auth` fails, instead of `|| true` — changes the failure message
for a path the maintainers may want to keep tolerant (a host whose existing login
*is* valid should not be blocked by a missing token file).

That is a product decision about the deploy script, and this document is the input
to it rather than the decision. **The measurable consequence of leaving it: a
missing token file produces a three-retry delay and a wrong explanation.**

## Successor

TASK-37 covers the capacity half (`PLUGIN_PUBLISH`). The `RELEASE_IDENTITY` half
needs the deploy script's behaviour decided; TASK-38's release receipt is where the
identity chain belongs, and this run is its first real failing case.
