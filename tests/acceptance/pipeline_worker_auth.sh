#!/usr/bin/env bash
# Helpers for authenticating a trusted Node-side pipeline worker in acceptance tests.
# Usage: source this file after TOKEN/AUTH are set, then: load_worker node-b
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
load_worker() {
  local node_name="$1"
  local identity="$ROOT/data-ci/$node_name/node-identity.json"
  [ -f "$identity" ] || { echo "FAIL missing $identity"; exit 1; }
  W_NODE_ID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["nodeId"])' "$identity")"
  W_CRED="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["credential"])' "$identity")"
  W_NODE_GEN="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/nodes" | python3 -c 'import json,sys; data=json.load(sys.stdin); nid=sys.argv[1]; print(next(n["generation"] for n in data if n["id"]==nid))' "$W_NODE_ID")"
  # Wait for a READY instance instead of demanding one on the first look.
  #
  # This used to query once and `exit 1` if nothing was READY. Measured on PR
  # #108 (run 43628236890), at the step that loads a worker for the browser
  # smoke:
  #
  #     FAIL no READY plugin instance on node-b
  #
  # The node had just been through the supervisor tests, which SIGSTOP, SIGINT
  # and SIGTERM it; a Node that restarts re-adopts its containers and re-marks
  # its instances READY asynchronously. The old code sampled that transition
  # once and called it a failure - a race reported as a product finding, the
  # same shape as every other finding this suite has produced.
  #
  # Bounded, so a genuinely missing instance still fails: 90 s, then it says
  # which plugins were looked at and what state they were in.
  W_INSTANCE_ID=""
  W_INSTANCE_SEEN=""
  for _ in $(seq 1 90); do
    for plugin in opsweave.data-catalog opsweave.data-integration; do
      W_INSTANCE_ID="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/plugins/$plugin" 2>/dev/null \
        | python3 -c 'import json,sys
try: data=json.load(sys.stdin)
except Exception: raise SystemExit
nid=sys.argv[1]
print(next((i["id"] for d in data.get("deployments",[]) for i in d["instances"] if i["nodeId"]==nid and i["state"]=="READY"),""))' "$W_NODE_ID" 2>/dev/null || true)"
      if [ -n "$W_INSTANCE_ID" ]; then break; fi
      W_INSTANCE_SEEN="$W_INSTANCE_SEEN $plugin:$(curl -fsS "${AUTH[@]}" "$URL/api/v1/plugins/$plugin" 2>/dev/null \
        | python3 -c 'import json,sys
try: data=json.load(sys.stdin)
except Exception: print("?"); raise SystemExit
nid=sys.argv[1]
states=[i.get("state","?") for d in data.get("deployments",[]) for i in d["instances"] if i.get("nodeId")==nid]
print(",".join(states) if states else "none")' "$W_NODE_ID" 2>/dev/null || echo "?")"
    done
    [ -n "$W_INSTANCE_ID" ] && break
    sleep 1
  done
  if [ -z "$W_INSTANCE_ID" ]; then
    echo "FAIL no READY plugin instance on $node_name after 90 s"
    echo "     states seen:$W_INSTANCE_SEEN"
    echo "     (a Node that restarted re-adopts its containers asynchronously;"
    echo "      this waits for that, and still fails if it never happens)"
    exit 1
  fi
  W_BOOT_ID="$(python3 -c 'import uuid;print(uuid.uuid4())')"
  W_WORKER_ID="n:$W_NODE_ID:i:$W_INSTANCE_ID:b:$W_BOOT_ID"
  W_BODY="$(python3 -c 'import json,sys;print(json.dumps({"workerId":sys.argv[1],"nodeId":sys.argv[2],"instanceId":sys.argv[3],"bootId":sys.argv[4],"version":"0.0.3"}))' "$W_WORKER_ID" "$W_NODE_ID" "$W_INSTANCE_ID" "$W_BOOT_ID")"
  W_HEADERS=(
    -H "Authorization: Bearer $W_CRED"
    -H "X-OpsWeave-Node-Id: $W_NODE_ID"
    -H "X-OpsWeave-Instance-Id: $W_INSTANCE_ID"
    -H "X-OpsWeave-Node-Generation: $W_NODE_GEN"
    -H "X-OpsWeave-Boot-Id: $W_BOOT_ID"
    -H "X-OpsWeave-Worker-Id: $W_WORKER_ID"
  )
}
