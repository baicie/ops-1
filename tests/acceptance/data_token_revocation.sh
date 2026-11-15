#!/usr/bin/env bash
# Real Node-revocation rejection for refresh and capability invocation.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }

# Keep a worker alive so Node revocation must stop it via the supervisor.
MARKER="$ROOT/data-ci/node-b/worker-enabled"
touch "$MARKER"
WORKER_PID=""
for _ in $(seq 1 60); do
  WORKER_PID="$(pgrep -P "$(cat /tmp/node-b.pid)" -f opsweave-pipeline-worker | head -1 || true)"
  [ -n "$WORKER_PID" ] && break
  sleep 0.5
done
[ -n "$WORKER_PID" ] || bad "supervisor did not start worker before revocation"
echo "revocation worker pid=$WORKER_PID ppid=$(cat /tmp/node-b.pid)"
CONTAINER_ID="$(docker ps --filter label=opsweave.managed=true --format '{{.ID}} {{.Image}}' | awk '/data-integration/ {print $1; exit}')"
[ -n "$CONTAINER_ID" ] || bad "data-integration container not found"
# Wait for the workload token file, do not read it once and assume.
#
# The Node writes `/run/opsweave/capability-tokens.json` inside the container
# after the instance is READY, and refreshes it on its own schedule. Reading it
# immediately after the container exists is a race: measured on run 43660344831,
#
#     revocation worker pid=29983 ppid=29511
#     Traceback (most recent call last):
#       File "<string>", line 1, in <module>
#     KeyError: 'data.catalog.v1'
#     STEP result=FAIL name=data_token_revocation ... secs=2
#
# Two seconds from start to failure - the file was there but the key was not yet.
#
# `data_foundation_ci.sh` already waits for exactly this before its browser block
# ("A Node restart can adopt the Integration container before its workload token
# file is refreshed. Wait for the actual Catalog token, not a sleep."). This
# script is one of the steps that runs BEFORE that block, so it cannot rely on
# it; the same wait belongs here.
#
# Bounded and specific: it waits for THIS key, and a file that never gains it is
# reported with what the file actually contained.
CURRENT_TOKEN=""
TOKEN_SEEN=""
for _ in $(seq 1 60); do
  RAW="$(docker exec "$CONTAINER_ID" cat /run/opsweave/capability-tokens.json 2>/dev/null || true)"
  CURRENT_TOKEN="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: raise SystemExit
print(d.get("data.catalog.v1",""))' 2>/dev/null || true)"
  [ -n "$CURRENT_TOKEN" ] && break
  TOKEN_SEEN="$(printf '%s' "$RAW" | python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print("<not JSON>"); raise SystemExit
print(",".join(sorted(d)) or "<empty object>")' 2>/dev/null || echo "<unreadable>")"
  sleep 1
done
if [ -z "$CURRENT_TOKEN" ]; then
  # Say what the container IS, not only that the key was missing.
  #
  # Run 43675797785 waited the full 60 s and reported `keys seen: <empty object>`
  # for a Node the harness had just confirmed READY. Three things make this file
  # empty and they need different fixes:
  #
  #   * the integration INSTANCE is not READY (its Node is; the instance may not be)
  #   * the instance is READY but the token refresh is being refused by the Kernel
  #   * this is the wrong container (`awk /data-integration/` matches the IMAGE
  #     name, and after #107 an image reference can be a digest with no name in it)
  #
  # The container's own log distinguishes them. `bad` first so the FAIL counter
  # stays right, then the detail, then exit.
  bad "the workload token file never gained data.catalog.v1 within 60 s (keys seen: ${TOKEN_SEEN:-<nothing>})"
  echo "      container: $CONTAINER_ID"
  docker ps --filter "id=$CONTAINER_ID" --format '      image={{.Image}} status={{.Status}}' 2>&1 || true
  echo "      raw file bytes: $(docker exec "$CONTAINER_ID" sh -c 'wc -c </run/opsweave/capability-tokens.json' 2>&1 || echo '<unreadable>')"
  echo "      --- last 20 lines of the container log ---"
  docker logs --tail 20 "$CONTAINER_ID" 2>&1 | sed 's/^/      /' || true
  exit 1
fi
FRESH_RESPONSE="$(curl -fsS -X POST -H "Authorization: Bearer $CURRENT_TOKEN" "$URL/internal/v1/workload-tokens/refresh")"
FRESH_TOKEN="$(printf '%s' "$FRESH_RESPONSE" | json "d['token']")"
DETAIL="$(curl -fsS "${AUTH[@]}" "$URL/api/v1/plugins/opsweave.data-integration")"
NODE_ID="$(printf '%s' "$DETAIL" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(i["nodeId"] for dep in d["deployments"] for i in dep["instances"] if i["state"]=="READY"))')"
[ -n "$NODE_ID" ] || bad "integration instance node not found"
curl -fsS "${AUTH[@]}" -X DELETE "$URL/api/v1/nodes/$NODE_ID" >/dev/null
REFRESH_AFTER="$(curl -sS -o /tmp/token-revoked-refresh.json -w '%{http_code}' -X POST -H "Authorization: Bearer $FRESH_TOKEN" "$URL/internal/v1/workload-tokens/refresh")"
[ "$REFRESH_AFTER" = "403" ] || bad "refresh after node revoke returned $REFRESH_AFTER"
grep -q 'WORKLOAD_IDENTITY_REVOKED' /tmp/token-revoked-refresh.json || bad "refresh after revoke did not return WORKLOAD_IDENTITY_REVOKED"
INVOKE_AFTER="$(curl -sS -o /tmp/token-revoked-invoke.json -w '%{http_code}' -X GET -H "Authorization: Bearer $FRESH_TOKEN" "$URL/api/v1/capabilities/data.catalog.v1/1/api/data-catalog/datasets")"
[ "$INVOKE_AFTER" = "403" ] || bad "invoke after node revoke returned $INVOKE_AFTER"
grep -q 'WORKLOAD_IDENTITY_REVOKED' /tmp/token-revoked-invoke.json || bad "invoke after revoke did not return WORKLOAD_IDENTITY_REVOKED"
if [ -n "$WORKER_PID" ]; then
  for _ in $(seq 1 60); do
    kill -0 "$WORKER_PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$WORKER_PID" 2>/dev/null; then
    bad "revoked Node worker pid=$WORKER_PID still alive"
  fi
  ok "Node revocation/quarantine stopped supervised worker pid=$WORKER_PID"
fi
ok "refresh and old token call rejected after Node revocation"
echo "Data Token Revocation: PASS"
