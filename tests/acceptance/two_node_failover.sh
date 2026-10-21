#!/usr/bin/env bash
# C05-style experiment on the local two-Node reference environment.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
KERNEL_URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
ADMIN_EMAIL="${OPSWEAVE_ADMIN_EMAIL:-admin@opsweave.local}"
ADMIN_PASSWORD="${OPSWEAVE_ADMIN_PASSWORD:-OpsWeave!2026}"
OPSCTL="$ROOT/target/debug/opsctl"
login() { "$OPSCTL" --url "$KERNEL_URL" login --email "$ADMIN_EMAIL" --password "$ADMIN_PASSWORD" >/dev/null; }
token() { python3 -c 'import json;print(json.load(open("'"$HOME"'/.opsweave/session.json"))["token"])'; }
gateway() { curl -fsS -m 15 --retry 2 --retry-delay 1 --retry-all-errors -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/gateway/dev.opsweave.hello/api/hello"; }

login
A_PID="$(lsof -nP -iTCP:9101 -sTCP:LISTEN -t | head -1)"
echo "node-a pid=$A_PID"
A_INSTANCE="$(curl -fsS -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/plugins/dev.opsweave.hello" | python3 -c 'import sys,json; d=json.load(sys.stdin); dep=next(x for x in d["deployments"] if x["version"]==d["activeVersion"]); print(next(i["id"] for i in dep["instances"] if i["nodeName"]=="node-a" and i["state"]=="READY"))')"
echo "active instance on node-a: $A_INSTANCE"
BEFORE=""
for _ in $(seq 1 30); do
  BEFORE="$(gateway | python3 -c 'import sys,json;print(json.load(sys.stdin)["instanceId"])')"
  [ "$BEFORE" = "$A_INSTANCE" ] && break
done
echo "before (forced node-a): $BEFORE"
[ "$BEFORE" = "$A_INSTANCE" ] || { echo "could not force a request to node-a" >&2; exit 1; }

kill "$A_PID"
sleep 3
IMMEDIATE="$(gateway | python3 -c 'import sys,json;print(json.load(sys.stdin)["instanceId"])')"
echo "immediate failover: $IMMEDIATE"
[ "$IMMEDIATE" != "$A_INSTANCE" ] || { echo "node-a instance still served after kill" >&2; exit 1; }

sleep 27
STATUS="$(curl -fsS -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/nodes" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(" ".join(n["name"]+"="+n["status"] for n in d))')"
echo "node statuses after stale window: $STATUS"
echo "$STATUS" | grep -q 'node-a=UNREACHABLE' || { echo "expected node-a UNREACHABLE" >&2; exit 1; }
AFTER="$(gateway | python3 -c 'import sys,json;print(json.load(sys.stdin)["instanceId"])')"
echo "after stale failover: $AFTER"
[ "$AFTER" != "$A_INSTANCE" ] || { echo "node-a instance still served after stale window" >&2; exit 1; }

nohup env \
  OPSWEAVE_KERNEL_URL="$KERNEL_URL" \
  OPSWEAVE_NODE_NAME=node-a \
  OPSWEAVE_NODE_LABELS="role=node,zone=local" \
  OPSWEAVE_NODE_DATA_BIND=127.0.0.1:9101 \
  OPSWEAVE_NODE_DATA_ENDPOINT=http://127.0.0.1:9101 \
  OPSWEAVE_NODE_STATE_DIR="$ROOT/data/node-a" \
  OPSWEAVE_DOCKER_HOST="${OPSWEAVE_DOCKER_HOST:-unix:///var/run/docker.sock}" \
  ./target/debug/opsweave-node > /tmp/opsweave-node-a.log 2>&1 &
for _ in $(seq 1 60); do
  READY="$(curl -fsS -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/nodes" | python3 -c 'import sys,json; print(sum(1 for n in json.load(sys.stdin) if n["name"]=="node-a" and n["status"]=="READY"))' 2>/dev/null || echo 0)"
  [ "$READY" = "1" ] && break
  sleep 1
done
for _ in $(seq 1 60); do
  RECOVERED="$(curl -fsS -H "Authorization: Bearer $(token)" "$KERNEL_URL/api/v1/plugins/dev.opsweave.hello" | python3 -c 'import sys,json; d=json.load(sys.stdin); dep=next(x for x in d["deployments"] if x["version"]==d["activeVersion"]); print(dep["readyInstances"],dep["desiredReplicas"])')"
  [ "$RECOVERED" = "2 2" ] && break
  sleep 1
done
echo "recovered: $(gateway | python3 -c 'import sys,json;print(json.load(sys.stdin)["instanceId"])')"
"$OPSCTL" --url "$KERNEL_URL" plugins | grep 'dev.opsweave.hello '
[ "$RECOVERED" = "2 2" ] || { echo "deployment did not recover to 2/2 (got $RECOVERED)" >&2; exit 1; }
echo "two-node failover test passed"
