# ADR-023: Installation identity is bound to a state directory, and a clone is not the original

- Status: Proposed (P001-C1.2.1)
- Date: 2026-11-12
- Related: [ADR-020](ADR-020-plugin-identity-hardening.md), `docs/acceptance/p001/03h-lifecycle-correctness.md`

## 1. Context

P001-C1.2 gave every Node installation an `opsweave.installation-id`, minted once
into `<state_dir>/installation-id` and stamped on every container the Node
creates. Ownership questions — may I delete this? may I adopt it? — are answered
by comparing that label.

That defence assumes two installations have different ids. It holds for two
installations that were **created independently**, which is what C1.2 tested. It
does not hold when one installation's state directory is a byte-for-byte copy of
another's:

```
cp -a /data/node-a /data/node-b     # node-identity.json AND installation-id
```

The clone inherits both identities. Every ownership question the clone asks is
then answered "yes", because the comparison is `label == my_id` and the ids are
equal. Measured on the C1.2 code: a full clone answers `Ours` for a container
the original created and is actively serving.

### The four events that must not be conflated

| Event | On disk | Must the identity persist? |
|---|---|---|
| **Restart** | same directory, same inode | **yes** — otherwise every restart orphans its own containers |
| **In-place move** (`mv`, same filesystem) | same inode, new path | **yes** — it is the same install that moved |
| **Backup / restore into a new place** | new inode, old install may or may not still run | **yes, but only if the original is gone** — the operator must say which |
| **Full clone** (`cp -a`, `rsync`, untar) | new inode, original still runs | **no** — this is a different installation and must not inherit ownership |

Restore and clone are **the same bytes**. No amount of reading the state
directory can tell them apart; only the surrounding context can. An
implementation that guesses will be wrong about one of them, and being wrong in
the clone direction means deleting another installation's live containers.

## 2. Decision

### 2.1 Identity is bound to the directory it was minted in

Alongside `installation-id`, the Node writes `installation-binding.json`:

```json
{
  "installationId": "…",
  "stateDirDevice": 16777220,
  "stateDirInode": 8614421331,
  "recordedAt": "2026-11-12T09:40:00Z"
}
```

The device and inode of the state directory are recorded **when the identity is
minted**. They survive:

- a restart — the directory is not recreated;
- an in-place `mv` on one filesystem — renaming a directory does not change its
  inode.

They do **not** survive `cp -a`, `rsync -a`, `tar x`, or a Docker volume
recreated from a backup — all of which allocate a new inode. That is exactly the
set of events that produce a second installation claiming the same identity.

On load, a binding that does not match the directory it is read from means "this
directory is a copy of the one the identity was minted in".

### 2.2 A mismatch fails closed, and the operator chooses

A Node that finds a mismatched binding **refuses to start supervision** and
reports `INSTALLATION_IDENTITY_CONFLICT`. It does not silently mint a second
identity, and it does not silently keep the old one — both would be a decision
made on the operator's behalf about which containers they may destroy.

The operator resolves it once, explicitly, with an environment variable:

| Value | Meaning | Effect |
|---|---|---|
| `accept` | "this state dir is the same installation, moved or restored" | keeps the id, re-records the binding |
| `reinitialize` | "this state dir is a clone; it is a new installation" | mints a new id, re-records the binding; the original's containers stay with the original |

Both are one-time. Neither is a default.

### 2.2a `reinitialize` covers the Kernel identity too (C1.2.2)

`reinitialize` as first shipped only re-minted the Docker ownership token. It
left `node-identity.json` alone, and that file holds the node id, the control
credential, the data token and the generation. Measured against a real Kernel:

```
A node=8c820e19…  endpoint=http://127.0.0.1:9251
clone reinitialized, installation id changed, Kernel node id unchanged
A endpoint=http://127.0.0.1:21637      <- the clone overwrote A's endpoint
```

Two processes heartbeating one node row alternate `generation`, `last_seen_at`
and `data_endpoint`; both receive the same `DesiredWorkload` list and both may
create instances for it. Separating the Docker identity alone therefore fixes
only the container half of the collision.

**`reinitialize` now means: this directory is a new installation, in both
senses.** It mints a new installation id *and* discards the inherited Kernel
identity, so the node must enrol afresh.

| Question | Answer |
|---|---|
| What is discarded? | `installation-id`, `installation-binding.json`, `node-identity.json` |
| What is required? | a **new** enrolment token; the inherited one was spent by the original enrolment and the Kernel refuses it twice |
| Node credential / data token / generation | all new, issued by `POST /api/v1/node-enrollment/redeem` |
| When is state destroyed? | **after** the new enrolment succeeds, never before |
| If enrolment fails? | the original files are untouched and the node exits non-zero — it can be retried, and it never falls back to the shared credential |

The inherited identity is not deleted up front: it is read, the replacement is
obtained, and only then are the old files replaced. A failure therefore leaves a
directory that is still exactly what it was.

**The clone also needs a name of its own.** `kernel.nodes.name` is `UNIQUE`, and
the inherited name belongs to the original. Enrolling a clone without setting
`OPSWEAVE_NODE_NAME` fails with the Kernel's generic

```
node enrollment failed (409 Conflict): {"code":"CONFLICT", ...}
```

which does not say why. This is a real operational trap and it is not fixed
here: the Kernel cannot know that two enrolments are one clone, and inventing a
`CONFLICT` explanation from a bare unique violation would be a guess. The
documented step is to set `OPSWEAVE_NODE_NAME` when reinitializing a clone.

`accept` is unchanged and means the opposite: this directory **is** the same
installation, moved or restored. It keeps the Kernel identity as well.

### 2.2b A node identity is not proof of a distinct process

Even with separate node ids, two nodes can be misconfigured onto one state
directory. That is a different failure and is not solved here: it is the
"concurrent processes sharing one directory" case §2.2 leaves out of scope.

### 2.3 Pre-C1.2.1 state directories adopt in place

An installation that has `installation-id` but no binding predates this ADR. It
cannot be verified, so it adopts the binding for its current directory and logs
that it did. This is the only silent path, and it exists because the alternative
— refusing to start every existing installation on upgrade — is worse.

**Boundary, stated plainly:** a clone made *before* the upgrade is undetectable
by this mechanism, because both copies adopt their own directories as their own
binding and keep the shared id. Closing that case needs the post-upgrade
mechanism to have been in place before the clone was made. It is recorded as a
residual risk in `03h-lifecycle-correctness.md`, not claimed as fixed.

### 2.4 Minting is atomic and race-free

`load_or_create_installation_id` had three defects, all fixed here:

1. `if let Ok(existing) = read_to_string(...)` treated **every** read error as
   "no identity", so an `EACCES` on the state directory silently minted a second
   identity. Only `NotFound` means "absent"; anything else is an error.
2. A fixed `installation-id.tmp` meant two concurrent Nodes wrote the same
   temporary file; the loser's rename won and the winner returned an id that was
   never persisted.
3. There was no `create_new`. The final file is now created with
   `O_CREAT|O_EXCL`, and a loser re-reads the winner's value.

## 3. Consequences

- **A clone can no longer delete, stop or take over the original's containers**
  — it cannot even start until the operator says what it is.
- **A restore is no longer invisible.** The operator must pass `accept` once.
  That is a deliberate cost: the alternative is guessing, and a wrong guess
  destroys another installation's live workload.
- **Containers from before C1.2 carry no label** and stay unmanaged until
  removed deliberately. Unchanged from C1.2.
- **The clone that predates this ADR** stays undetectable. Residual, recorded.
- **This does not make concurrent processes safe.** Two processes that both hold
  a valid binding for the same directory are the same installation by
  definition; that case is out of scope here and covered by the rollout and
  quarantine rules.

## 4. Alternatives considered

**Mint a new id on every start.** Rejected by the brief and by the data: every
restart would orphan every container the installation owns.

**Never share a state dir; forbid copies.** Not enforceable. Operators copy
directories.

**Compare file mtimes.** `cp -a` preserves them, so a clone would look identical.
Inode is the right signal precisely because copying cannot preserve it.

**Ask the daemon.** On one daemon both installations see the same daemon id, so
it distinguishes nothing. Across daemons the question does not arise.
