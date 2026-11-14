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
  # This used to query once and `exit 1` if nothing was READY. A Node that is
  # restarted re-adopts its containers and re-marks its instances READY
  # asynchronously, so a single sample says "not yet" about a Node that is
  # coming back - a race reported as a product finding, the same shape as every
  # other finding this suite has produced.
  #
  # THE 90 s FAILURE THAT FIRST EXPOSED THIS WAS NOT THAT RACE. Measured on run
  # 43631374366, the poll ran all 90 times and reported:
  #
  #     FAIL no READY plugin instance on node-b after 90 s
  #          states seen: opsweave.data-integration:UNREACHABLE ...
  #
  # Never "STARTING", never "none" - always UNREACHABLE, for the whole 90 s. A
  # transition would have moved; a revoked Node cannot. The cause was step order
  # in `data_foundation_ci.sh`: `data_token_revocation.sh` revokes node-b and is
  # irreversible, and the negatives were scheduled after it. That is fixed next
  # to the revocation step, not here.
  #
  # So this wait is for the restart transition, and it is bounded: 90 s, then it
  # says which plugins were looked at and what state each was in. When the states
  # never change, the message points at revocation rather than at a slow Node.
  W_INSTANCE_ID=""
  W_INSTANCE_SEEN=""
  W_INSTANCE_STATES=""
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
    case "$W_INSTANCE_SEEN" in
      *UNREACHABLE*)
        # A transition moves; a revoked Node does not. Say which this is, because
        # "no READY instance" reads like a deployment defect and sent me looking
        # at adoption on run 43631374366 when node-b had `revoked_at` set.
        echo "     UNREACHABLE and never changing: this Node's credential was revoked"
        echo "     (revoked_at set), not a slow restart. Step order is the usual cause;"
        echo "     check whether a revocation step ran before this one." ;;
      *)
        echo "     (a Node that restarted re-adopts its containers asynchronously;"
        echo "      this waits for that, and still fails if it never happens)" ;;
    esac
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
