#!/usr/bin/env bash
# Real Gateway/HTTP connector SSRF negative tests.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
INT="$URL/api/v1/gateway/opsweave.data-integration/api/data-integration"
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }

check_blocked() {
  local name="$1" endpoint="$2" source code
  local http_code="" attempt=0
  for attempt in $(seq 1 60); do
    http_code="$(curl -sS -o /tmp/data-ssrf-source.json -w '%{http_code}' "${AUTH[@]}" -X POST -H 'content-type: application/json' \
      "$INT/sources" -d "{\"name\":\"$name\",\"connectorType\":\"http-json\",\"endpoint\":\"$endpoint\",\"credential\":{\"credentialRef\":\"secret://local/http-json/$name\",\"kind\":\"none\",\"maskedHint\":\"local\"}}")"
    if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then break; fi
    # A restarted Node can report its plugin instance READY before the Gateway
    # route is installed; retry the harness request, never ignore a final 404.
    sleep 1
  done
  [ "$http_code" = "200" ] || [ "$http_code" = "201" ] || bad "$name source create returned $http_code after retry: $(cat /tmp/data-ssrf-source.json 2>/dev/null || true)"
  source="$(cat /tmp/data-ssrf-source.json)"
  local source_id
  source_id="$(printf '%s' "$source" | json "d['sourceId']")"
  code="$(curl -sS -o /tmp/data-ssrf.json -w '%{http_code}' "${AUTH[@]}" -X POST \
    "$INT/sources/$source_id/test")"
  [ "$code" = "422" ] || bad "$name returned $code, expected 422: $(cat /tmp/data-ssrf.json)"
  grep -q 'SOURCE_SSRF_BLOCKED' /tmp/data-ssrf.json || bad "$name did not return SOURCE_SSRF_BLOCKED"
  ok "$name blocked"
}

check_blocked ipv4-loopback 'http://127.0.0.1:18090/data-hosts.json'
check_blocked ipv4-mapped-loopback 'http://[::ffff:7f00:1]:18090/data-hosts.json'
check_blocked ipv4-mapped-metadata 'http://[::ffff:a9fe:a9fe]:80/'
check_blocked ipv6-loopback 'http://[::1]:18090/data-hosts.json'
check_blocked ipv6-ula 'http://[fc00::1]:80/'
check_blocked ipv6-link-local 'http://[fe80::1]:80/'
check_blocked ipv4-metadata 'http://169.254.169.254/latest/meta-data'
check_blocked ipv4-private 'http://10.0.0.1/'
check_blocked ipv4-documentation 'http://198.51.100.1/'
echo "Data SSRF Golden Path: PASS"
