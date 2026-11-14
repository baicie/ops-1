#!/bin/sh
# systemd ExecStopPost safety net: remove containers owned by THIS installation.
#
# The Runtime normally quarantines and removes its own containers. This catches
# SIGKILL/crash paths where no application code can run. Because it runs outside
# the Runtime, it must repeat the Runtime's ownership rule rather than assume it:
#
#   A container belongs to this installation only if its
#   `opsweave.installation-id` label equals the id in <state_dir>/installation-id.
#
# Ownership is NOT decided by `opsweave.node-id`. A restored database or a copied
# state directory reproduces the same node id in two installations (ADR-023), so
# a node-id filter matches a *different* installation's containers. The previous
# version did exactly that and deleted them.
#
# Exit codes (systemd records them; a non-zero ExecStopPost is visible in
# `systemctl status` and in the journal):
#   0  nothing to do, or everything this installation owns was removed
#   1  USAGE       required configuration is missing
#   2  DAEMON      the Docker daemon could not be queried  (NOT "no containers")
#   3  IDENTITY    the installation identity is missing, unreadable or invalid
#   4  REFUSED     could not prove ownership of a candidate; it was left alone
#   5  REMOVAL     a container proven to be ours could not be removed
#
# The distinction between 2 and "no candidates" is the whole point: an
# unreachable daemon must never read as "nothing left to clean up".
set -eu

STATE_DIR="${OPSWEAVE_NODE_STATE_DIR:-/var/lib/opsweave-node}"
IDENTITY_FILE="$STATE_DIR/installation-id"
NODE_FILE="$STATE_DIR/node-identity.json"

# The Docker endpoint must be explicit. `OPSWEAVE_DOCKER_HOST` is the Node's
# variable; the Docker CLI does not read it, so passing only that variable ran
# this script against the DEFAULT socket - which under the rootless unit is a
# different daemon (or none at all). `DOCKER_HOST` is what the CLI reads.
DOCKER_HOST_VALUE="${DOCKER_HOST:-${OPSWEAVE_DOCKER_HOST:-}}"
if [ -z "$DOCKER_HOST_VALUE" ]; then
  echo "opsweave-node-cleanup: no Docker endpoint configured; set DOCKER_HOST" >&2
  exit 1
fi
export DOCKER_HOST="$DOCKER_HOST_VALUE"

say() { echo "opsweave-node-cleanup: $*" >&2; }

# --- 1. The daemon must answer. A failure here is exit 2, never "no containers".
if ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  say "cannot query the Docker daemon at $DOCKER_HOST; refusing to report a clean sweep"
  exit 2
fi

# --- 2. The identity must be readable and valid. Without it there is no owner.
if [ ! -f "$IDENTITY_FILE" ]; then
  say "no installation identity at $IDENTITY_FILE; refusing destructive cleanup"
  exit 3
fi
INSTALLATION_ID="$(tr -d ' \t\r\n' <"$IDENTITY_FILE" 2>/dev/null || true)"
if [ -z "$INSTALLATION_ID" ]; then
  say "the installation identity at $IDENTITY_FILE is empty or unreadable; refusing destructive cleanup"
  exit 3
fi
# Same shape the Runtime mints: a UUID. Anything else is a corrupted file, and
# treating it as a label value would select containers by a string we did not mint.
if ! printf '%s' "$INSTALLATION_ID" | grep -Eqx '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'; then
  say "the installation identity at $IDENTITY_FILE is not a UUID; refusing destructive cleanup"
  exit 3
fi

# --- 3. The node id narrows the candidate set. It is NOT the ownership proof;
#        it only keeps this script from scanning the whole daemon. A missing or
#        unreadable node id is fine - ownership is decided by the installation
#        label below - but if it is present it must be consistent.
NODE_ID=""
if [ -f "$NODE_FILE" ]; then
  NODE_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("nodeId") or "")' "$NODE_FILE" 2>/dev/null || true)"
fi

# --- 4. Candidates: this installation's label. Prefer the node-id filter when we
#        have one (fewer containers to inspect); otherwise the installation label
#        alone. Either way every candidate is re-checked below.
if [ -n "$NODE_ID" ]; then
  CANDIDATES="$(docker ps -aq \
    --filter "label=opsweave.installation-id=$INSTALLATION_ID" \
    --filter "label=opsweave.node-id=$NODE_ID" 2>/dev/null)" || {
      say "cannot list containers by label; refusing to report a clean sweep"
      exit 2
    }
else
  CANDIDATES="$(docker ps -aq \
    --filter "label=opsweave.installation-id=$INSTALLATION_ID" 2>/dev/null)" || {
      say "cannot list containers by label; refusing to report a clean sweep"
      exit 2
    }
fi

[ -n "$CANDIDATES" ] || exit 0

# --- 5. Verify each candidate's real labels, then delete by immutable id.
REMOVED=0
REFUSED=0
FAILED=0
for container in $CANDIDATES; do
  # One inspect gives both labels from the daemon itself. Never the name.
  LABELS="$(docker inspect "$container" \
    --format '{{index .Config.Labels "opsweave.installation-id"}}|{{index .Config.Labels "opsweave.node-id"}}' 2>/dev/null)" || {
      say "cannot inspect $container; leaving it alone"
      REFUSED=$((REFUSED + 1))
      continue
    }
  FOUND_INSTALLATION="${LABELS%%|*}"
  FOUND_NODE="${LABELS#*|}"

  if [ "$FOUND_INSTALLATION" != "$INSTALLATION_ID" ]; then
    say "container $container carries installation id '${FOUND_INSTALLATION}' (wanted '$INSTALLATION_ID'); leaving it alone"
    REFUSED=$((REFUSED + 1))
    continue
  fi
  if [ -n "$NODE_ID" ] && [ "$FOUND_NODE" != "$NODE_ID" ]; then
    say "container $container carries node id '${FOUND_NODE}' (wanted '$NODE_ID'); leaving it alone"
    REFUSED=$((REFUSED + 1))
    continue
  fi

  if docker rm -f "$container" >/dev/null 2>&1; then
    say "removed $container"
    REMOVED=$((REMOVED + 1))
  else
    say "FAILED to remove $container, which this installation owns"
    FAILED=$((FAILED + 1))
  fi
done

say "removed=$REMOVED refused=$REFUSED failed=$FAILED"

if [ "$FAILED" -gt 0 ]; then
  exit 5
fi
if [ "$REFUSED" -gt 0 ]; then
  exit 4
fi
exit 0
