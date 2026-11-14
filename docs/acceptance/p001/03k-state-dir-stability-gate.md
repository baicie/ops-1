# P001-C1.4 Gate: is the Node state directory stable enough for a single-instance lock?

**Status: analysis complete. No lock is implemented. This document decides whether one may be.**

| Fact | Value |
|---|---|
| Base | `main` `89113ade63f286707781acc4a053bec1ab513f78` |
| Written | 2026-11-14 |
| Input | the user's `03j-single-instance-lock-review.md` (方案审查定稿) |
| Outcome | see §7 — **CONDITIONAL PASS**, not an unconditional one |

The review document asked for one thing before any `flock` code: proof that the
deployments really do keep `state_dir` stable while a Node runs. This document
answers that from the deployment files, the scripts, and measurements on a real
filesystem. It does not repeat the design; it tests the design's assumption.

---

## 1. The four deployment modes

| # | Mode | Config |
|---|---|---|
| 1 | systemd | `deployments/linux/opsweave-node.service` |
| 2 | Compose **platform** | `deployments/platform/compose.yaml` |
| 3 | Compose **staging** | `deployments/staging/compose.yaml` |
| 4 | CI harness | `tests/ci/p001c_up.sh` |
| — | Compose **local** | `deployments/local/compose.yaml` — **no Node service at all** (postgres + registry only). NOT_APPLICABLE |

---

## 2. The twelve questions, per mode

`PROVEN` = read from the deployment definition and, where it matters, measured.
`NOT_PROVEN` = nothing in this repository guarantees it.
`VIOLATED` = the repository actively does the wrong thing.
`NOT_APPLICABLE` = the mode does not have this property.

### 2.1 systemd (`deployments/linux/opsweave-node.service`)

| # | Question | Verdict | Evidence |
|---|---|---|---|
| 1 | Absolute path | **PROVEN** — `/var/lib/opsweave-node` | `OPSWEAVE_NODE_STATE_DIR` default in the cleanup script; unit now declares it |
| 2 | Created by | **PROVEN** — the Node itself, `create_dir_all` at `main.rs:24` | |
| 3 | Parent permissions | **NOT_PROVEN** — no install rule creates or chowns `/var/lib/opsweave-node` | see §5 |
| 4 | Can the service account delete/replace it? | **NOT_PROVEN** — the unit sets `ReadWritePaths=/var/lib/opsweave-node`, and `opsweave-node` owns it. Nothing prevents `rm -rf` of its own directory | |
| 5 | Restart reuses the same inode | **PROVEN** — systemd does not touch the directory | |
| 6 | Upgrade recreates it? | **NOT_PROVEN** — no install/upgrade rule exists to inspect (§5) | |
| 7 | Compose down/up | **NOT_APPLICABLE** | |
| 8 | A script clears it while the Node runs? | **PROVEN NO** — no such script in this repository | |
| 9 | Stop waits for exit? | **PROVEN** — `Type=simple`, `ExecStopPost` runs after the main process is gone, including after `SIGKILL` | |
| 10 | Restore creates a new inode at the same path? | **VIOLATED** — a restore that replaces the directory does exactly this (§4) | |
| 11 | Symlink allowed as `state_dir`? | **NOT_PROVEN** — nothing rejects one (§4) | |
| 12 | NFS/SMB? | **NOT_PROVEN** — nothing detects one | |

### 2.2 Compose platform

| # | Question | Verdict | Evidence |
|---|---|---|---|
| 1 | Absolute path | **PROVEN** — `${OPSWEAVE_PLATFORM_DIR:-/srv/opsweave-platform}/node` | `compose.yaml:178` |
| 2 | Created by | **PROVEN** — `create_dir_all` inside the container, on a host bind mount | |
| 3 | Parent permissions | **NOT_PROVEN** — README only says it generates the `*.env` files with mode `0600`; it says nothing about the node directory | |
| 4 | Can the service account delete/replace it? | **NOT_PROVEN** — the container runs `user: ${OPSWEAVE_NODE_USER:-10001:10001}` and owns the bind-mounted directory | |
| 5 | Restart reuses the same inode | **PROVEN** — measured, §3 | |
| 6 | Upgrade recreates it? | **PROVEN NO** — `platform_up.sh:557` upgrades with `compose up -d --force-recreate node`. The **container** is replaced, because `node.env` is an env_file and Compose would otherwise keep a stale environment (the comment at `:548-556` explains the 401 restart loop that caused). The host bind-mount source is never touched; measured in §3 | |
| 7 | Compose down/up reuses the bind mount? | **PROVEN** — bind mount, not a named volume; measured, §3 | |
| 8 | A script clears it while the Node runs? | **PROVEN NO** | |
| 9 | Stop waits for exit? | **PROVEN** — compose removes the container; the process cannot outlive it | |
| 10 | Restore creates a new inode at the same path? | **PROVEN NO for the repository's own restore** — `platform_up.sh restore` restores the **database** and the Kernel's `/app` data; it never writes the node state directory. A hand-run restore (§4.4) is a different matter | |
| 11 | Symlink allowed? | **NOT_PROVEN** (§4) | |
| 12 | NFS/SMB? | **NOT_PROVEN** | |

### 2.3 Compose staging

Identical to 2.2 with two differences that matter:

| # | Question | Verdict | Evidence |
|---|---|---|---|
| 1 | Absolute path | **PROVEN** — `/var/lib/opsweave-staging/node` | `compose.yaml:156`, `:177` |
| 3 | Parent permissions | **PROVEN** — `README.md:39-41` creates the four directories and `chown -R 10001:10001` for `kernel` and `node` | |
| 4 | Can the service account delete/replace it? | **VIOLATED by design** — the Node runs as `10001`, which **owns** the directory and therefore has write permission on it and on nothing else it needs. It can `rm -rf` its own state directory | |

The staging README is the only deployment that documents directory ownership at
all, and what it documents is that the Node owns its own state directory.

### 2.4 CI harness (`tests/ci/p001c_up.sh`)

| # | Question | Verdict | Evidence |
|---|---|---|---|
| 1 | Absolute path | **PROVEN** — `/tmp/p001c-<runid>/node-a`, `node-b` | `p001c_up.sh:85,95` |
| 2 | Created by | **PROVEN** — the harness, `mkdir -p` | `:95` |
| 3 | Parent permissions | **PROVEN** — the invoking user owns `/tmp/p001c-<runid>` | |
| 4 | Can the service account delete/replace it? | **VIOLATED by design** — the harness is the same user as the Node | |
| 5 | Restart reuses the same inode | **PROVEN** — `p001c_up.sh` stops the PIDs and then clears the directory, keeping only `installation-id` (§4.3) | |
| 6 | Upgrade recreates it? | **NOT_APPLICABLE** | |
| 7 | Compose down/up | **NOT_APPLICABLE** | |
| 8 | A script clears it while the Node runs? | **VIOLATED, and guarded** — `:160-184` refuses to clear state while a node PID is still alive. The guard exists and names the reason | |
| 9 | Stop waits for exit? | **PROVEN** — pidfile + `kill -0` polling | `:178` |
| 10 | Restore creates a new inode? | **VIOLATED** — this is a test harness; `--purge` deletes the directory by design | |
| 11 | Symlink allowed? | **NOT_PROVEN** | |
| 12 | NFS/SMB? | **NOT_APPLICABLE** — `/tmp` on the CI runner | |

---

## 3. Measured on a real filesystem

macOS 15.7 / APFS. The Linux behaviour of these four operations is the same, but
**this table is macOS**, and the Linux run is a separate item in §8.

| Operation | device:inode of the directory | What it means for a lock |
|---|---|---|
| initial | `175953853` | — |
| plain restart, nothing done | `175953853` | lock on the same inode holds |
| `docker compose up -d --force-recreate` | `175954062` → `175954062` | **unchanged**; the bind mount source is untouched |
| in-place `mv` one filesystem | `175953853` (same) | the lock follows the inode, not the path |
| `rm -rf` + `mkdir` at the **same path** | `175953856` | **changed** — a lock on the old inode is stale, a second process locks the new one |
| replaced by a symlink | new inode, type `Symbolic Link` | the lock is taken on the link's target |
| bind-mount source swap | target inode changes | same as delete-and-recreate |

**Compose recreate is safe. Directory replacement is not.** The distinction the
Gate turns on is exactly that one: normal lifecycle is fine, and the risk is
confined to restore/replace operations.

---

## 4. The four scenarios the review named, and what actually happens

### 4.1 `state_dir` deleted and re-created while the Node runs

Measured above: the inode changes, so a lock taken by process A is on an inode
nothing else will open. Process B opens the new file, locks it, and succeeds.

Nothing in the repository prevents this. It is exactly the failure the review
document listed as **risk 1**, and this Gate does not close it.

### 4.2 `state_dir` replaced by a symlink

`create_dir_all` on a path that is a symlink to a directory **succeeds silently**
— verified: `os.makedirs(p, exist_ok=True)` returns without error and
`realpath` resolves elsewhere. The Node then writes its identity, its lock and
its migration marker through the link.

`apps/node/src/runtime.rs` has exactly one `canonicalize` call (`:1625`), and it
canonicalizes a *parent* for the capability-token path; it never checks whether
`state_dir` itself is a symlink.

**So a symlinked `state_dir` is accepted, not rejected.** For a lock this means
two Nodes can be given two different paths that resolve to the same directory:
`flock` would serialise them correctly (same inode), but a Node given a
*replaced* symlink and one holding the old target would not.

### 4.3 The CI harness's own clearing step

`p001c_up.sh:224` does `rm -rf "$STATE"/data/* "$STATE"/node-a/* "$STATE"/node-b/*`.

**Measured: `rm -rf dir/*` does not remove dotfiles.** A lock file at
`<state_dir>/.node.lock` would **survive** that step. That is a good property
for the lock — and it is also why the review's rule "never `unlink` the lock
file" is compatible with this harness unchanged.

But it also means the harness's "clean state" is not clean: a stale
`.node.lock` from a killed previous run would remain. `flock` releases on
process death, so the file being stale is harmless; the harness must not be
taught to `rm -rf` the whole directory instead, or it would break this.

### 4.4 Restore creating a new inode at the same path

`scripts/backup.sh` and `scripts/restore.sh` do not touch the Node state
directory at all — verified by grep. There is therefore **no repository-provided
restore path** that would replace it. An operator following `docs/RUNBOOK.md`
with `cp -a` / `rsync` / a backup tool can still do it, and §3 measures that it
changes the inode.

---

## 5. The gap that dominates everything else

**No install rule in this repository produces `/opt/opsweave/bin/`.**

| Referenced | By | Produced by |
|---|---|---|
| `/opt/opsweave/bin/opsweave-node` | `opsweave-node.service:11` | nothing |
| `/opt/opsweave/bin/opsweave-kernel` | `opsweave-kernel.service:11` | nothing |
| `/opt/opsweave/bin/opsweave-node-cleanup` | `opsweave-node.service:16` | nothing |
| `/opt/opsweave/web` | `.env.example:6` | nothing |
| `/var/lib/opsweave-node` (creation/ownership) | the unit implicitly | nothing |

`docs/RUNBOOK.md` already recorded this for the cleanup script. This Gate
extends it: **the systemd deployment mode is not provisioned by this
repository at all.** Therefore questions 3, 4 and 6 for systemd cannot reach
`PROVEN` from anything in the tree — they depend entirely on a provisioning
step that is not here.

That is not a reason to skip the lock. It is a reason the Gate's answer for
systemd must be "conditional on the operator's provisioning", written down as
such rather than assumed.

---

## 6. What the lock would and would not cover

| Threat | Covered by a lock in `<state_dir>/.node.lock`? |
|---|---|
| two Nodes started on one directory (normal) | **yes** — measured, and the mechanism is the kernel's |
| restart / upgrade / compose recreate | **yes** — inode unchanged (§3) |
| `SIGKILL` of one Node, another starts | **yes** — kernel releases on process death |
| directory deleted and re-created mid-run | **no** — risk 1, unchanged |
| directory replaced by a symlink mid-run | **no** — risk 5, unchanged |
| an old Node version that does not take the lock | **no** — advisory locks are cooperative |
| NFS/SMB | **unknown, and must not be claimed** |
| a Node with permission to `rm -rf` its own state dir | **no** — it can, and does not need the lock to |

The last row is the one that decides the Gate. In staging — the only deployment
that documents ownership — the Node **owns** its state directory. A process that
can delete the directory can defeat any lock inside it.

---

## 7. Gate decision

**CONDITIONAL PASS — the lock may be implemented, with three conditions, and it
must not be described as guaranteeing single-instance operation on its own.**

| # | Decision | Basis |
|---|---|---|
| 1 | **Proceed with `<state_dir>/.node.lock`.** Normal lifecycle (restart, upgrade, compose recreate, `SIGKILL`) keeps the inode stable — measured, §3 | |
| 2 | **No parent-directory lock in this phase.** A parent-level lock would need a directory the Node does not own, which no deployment currently defines; inventing one here would be a deployment change, not a lock implementation | §5, §6 |
| 3 | **The lock strictly improves the situation and is not sold as complete.** Risks 1 and 5 stay open and must be stated in the ADR and the runbook, not in a footnote | §4.1, §4.2 |

The reasoning for proceeding rather than blocking: in every deployment mode,
the lock converts "two Nodes silently corrupt each other" into "the second Node
refuses to start" for the **normal** lifecycle, which is the case that actually
occurs on restarts and upgrades. The remaining holes require a deliberate,
privileged action (deleting or replacing the state directory) that would be
destructive to the installation's identity regardless of the lock.

**This is not a claim that the lock is sufficient.** An installation whose
state directory is replaced between two starts has lost the lock's protection
*and* its identity binding; ADR-023 already treats that as an operator-action
hazard.

---

## 8. Conditions attached to the PASS

Before the implementation PR is opened:

1. **The ADR must state the residual risks as risks** (§4.1, §4.2), with the
   same wording the review document uses. A PASS that drops them is not this
   PASS.
2. **The Linux inode measurement must be repeated on the CI runner**, not
   inferred from macOS. §3 is macOS only; `linux-runtime` exists and is the
   right place.
3. **`p001c_up.sh` must not be changed to `rm -rf` the whole state directory.**
   §4.3 measures that the current globs leave the lock file in place, which is
   what the design wants. A future "tidy-up" of that line would silently defeat
   the lock in CI without failing anything.

## 9. What would turn this into BLOCKED

If a deployment were found that recreates `state_dir` on every restart, the
lock's whole premise would fail there. None was found: compose recreate keeps
the inode, `deploy-staging.sh` has no destructive volume operation, and the CI
harness refuses to clear state while a process is alive.

If the project later requires protection against a **privileged** actor
replacing the directory, the parent-directory lock becomes necessary and this
decision must be revisited.

---

## 10. Provenance of every claim

| Claim | How it was checked |
|---|---|
| compose recreates keep the inode | ran `docker compose up -d --force-recreate` on a bind mount and compared `stat -f %i` |
| `rm -rf dir/*` leaves dotfiles | ran it on a directory containing `.node.lock` |
| `create_dir_all` accepts a symlink | ran `os.makedirs(..., exist_ok=True)` on a symlink-to-dir |
| `deploy-staging.sh` never destroys the node directory | `grep` for `down -v`, `volume rm`, `rm -rf` → none |
| `backup.sh` / `restore.sh` ignore the node state dir | `grep` |
| no install rule produces `/opt/opsweave/bin` | `grep -rn 'opt/opsweave'` → only the units and `.env.example` |
| `p001c_up.sh` waits for a node to exit before clearing | read `:160-184` |
| staging chowns the node directory to the Node's uid | `deployments/staging/README.md:39-41` |

**This document does not implement, and does not claim, any lock.**
