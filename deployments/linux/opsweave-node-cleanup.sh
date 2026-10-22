#!/bin/sh
# systemd ExecStopPost safety net: remove managed containers owned by this Node.
# The Runtime normally quarantines and removes its own containers; this catches
# SIGKILL/crash paths where no application code can run.
set -eu
STATE="${OPSWEAVE_NODE_STATE_DIR:-/var/lib/opsweave-node}/node-identity.json"
[ -f "$STATE" ] || exit 0
NODE_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["nodeId"])' "$STATE" 2>/dev/null || true)"
[ -n "$NODE_ID" ] || exit 0
docker ps -aq --filter "label=opsweave.node-id=$NODE_ID" | while read -r container; do
  [ -n "$container" ] && docker rm -f "$container" >/dev/null 2>&1 || true
done
