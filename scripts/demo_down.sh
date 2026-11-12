#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
KERNEL_PORT="${OPSWEAVE_PORT:-18181}"
for port in "$KERNEL_PORT" 9101 9102; do
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true
done
# Scope the sweep to THIS checkout's installation.
#
# `label=opsweave.managed=true` is stamped by every OpsWeave installation in the
# world, so the previous command stopped and removed the containers of any other
# install sharing the daemon - a second checkout, a colleague's demo, anything.
# The installation identity is minted by the node under its state directory and
# travels with each container; it is the only value that answers "is this mine".
for inst in node-a node-b; do
  id_file="$ROOT/data/$inst/installation-id"
  [ -f "$id_file" ] || continue
  install_id="$(cat "$id_file")"
  [ -n "$install_id" ] || continue
  docker ps -aq --filter "label=opsweave.installation-id=$install_id" \
    | xargs -r docker rm -f >/dev/null 2>&1 || true
done
echo "local OpsWeave processes and this installation's containers stopped"
echo "  (containers from a version before the installation label are left alone;"
echo "   list them with: docker ps -a --filter label=opsweave.managed=true)"
