#!/usr/bin/env bash
# Isolated Quality lifecycle fault-injection harness.
# Requires: local PostgreSQL, curl, python3, Node.js with backend npm ci already run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CASE=""
ALL=0
while [ $# -gt 0 ]; do case "$1" in --case) CASE="${2:?}"; shift 2;; --all) ALL=1; shift;; *) echo "usage: $0 --case FT-01|--all" >&2; exit 2;; esac; done
[ "$ALL" = 1 ] && CASES="FT-01 FT-02 FT-06 FT-14" || CASES="$CASE"
[ -n "$CASES" ] || { echo "no case selected" >&2; exit 2; }
DB="opsweave_ft_$$_$(date +%s)"
PORT="${FT_PORT:-18299}"
BASE="http://127.0.0.1:$PORT"
ART="$ROOT/artifacts/reliability"
mkdir -p "$ART"
CAT_PID=""
CASE_ART="$ART"
cleanup() {
  [ -n "$CAT_PID" ] && kill "$CAT_PID" 2>/dev/null || true
  [ -n "$CAT_PID" ] && wait "$CAT_PID" 2>/dev/null || true
  dropdb --if-exists --force "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT
createdb "$DB"
start_catalog() {
  (cd "$ROOT/plugins/data-catalog/backend" && exec env DATABASE_URL="postgres://localhost/$DB?sslmode=disable" OPSWEAVE_PLUGIN_DATABASE_URL="postgres://localhost/$DB?sslmode=disable" OPSWEAVE_CALLER_CONTEXT_KEY='' OPSWEAVE_QUALITY_TEST_DELAY_MS=1500 PORT="$PORT" node server.mjs >"$CASE_ART/catalog.log" 2>&1) &
  CAT_PID=$!
  for _ in $(seq 1 80); do curl -fsS "$BASE/_opsweave/health/ready" >/dev/null 2>&1 && return 0; sleep .1; done
  echo "catalog did not become ready" >&2; cat "$ART/catalog.log" >&2; return 1
}
api() { curl -fsS -H 'x-opsweave-user-role: admin' -H 'content-type: application/json' "$@"; }
status() { api "$BASE/api/data-catalog/datasets/$DATASET_ID/quality-runs/$1" | python3 -c 'import json,sys;print(json.load(sys.stdin)["status"])'; }
run_status() { psql -d "$DB" -tAc "select status from catalog_quality_runs where run_id='$1'"; }
run_id_for() { psql -d "$DB" -tAc "select run_id from catalog_quality_runs where idempotency_key='$1'"; }
make_fixture() {
  local case_id="$1" ds payload; payload="$(printf '{"name":"ft-dataset-%s","fields":[{"name":"id","type":"string","nullable":false,"ordinal":0},{"name":"name","type":"string","nullable":true,"ordinal":1}],"retentionPolicy":{"mode":"RETAIN","maxRecords":10000,"maxBytes":16777216}}' "$case_id")"; ds="$(api -X POST "$BASE/api/data-catalog/datasets" -d "$payload")"
  DATASET_ID="$(printf '%s' "$ds" | python3 -c 'import json,sys;print(json.load(sys.stdin)["datasetId"])')"
  api -X POST "$BASE/api/data-catalog/datasets/$DATASET_ID/quality-rules" -d '{"ruleType":"RECORD_COUNT","config":{"min":1,"max":10000},"severity":"HIGH"}' >/dev/null
  python3 - "$BASE" "$DATASET_ID" <<'PY' >/tmp/ft_records.json
import json,sys,urllib.request
base,ds=sys.argv[1:]
records=[{"id":str(i),"name":"n"} for i in range(20)]
req=urllib.request.Request(base+"/api/data-catalog/datasets/"+ds+"/records",data=json.dumps({"schemaRevision":1,"sourceBatchKey":"ft-batch-00000001","records":records}).encode(),headers={"content-type":"application/json","x-opsweave-user-role":"admin"},method="POST")
print(urllib.request.urlopen(req).read().decode())
PY
}
submit() {
  local key="$1"; api -X POST -H "Idempotency-Key: $key" "$BASE/api/data-catalog/datasets/$DATASET_ID/quality-runs" -d '{"schemaRevision":1}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["runId"])'
}
run_case() {
  local id="$1"; local dir="$ART/$id"; mkdir -p "$dir"; CASE_ART="$dir"; echo "{\"case\":\"$id\",\"git\":\"$(git -C "$ROOT" rev-parse HEAD)\",\"db\":\"$DB\",\"port\":$PORT}" > "$dir/metadata.json"
  start_catalog
  make_fixture "$id"
  case "$id" in
    FT-01)
      local rid; rid="$(submit ft-01-key-0001)"; sleep .05
      kill -9 "$CAT_PID" 2>/dev/null || true; wait "$CAT_PID" 2>/dev/null || true; CAT_PID=""
      psql -d "$DB" -c "update catalog_quality_runs set lease_expires_at=now()-interval '1 second' where run_id='$rid'" >/dev/null
      start_catalog
      for _ in $(seq 1 60); do s="$(run_status "$rid")"; case "$s" in ERROR|PASSED|FAILED|CANCELLED) break;; esac; sleep .2; done
      case "$s" in ERROR) local n; n="$(psql -d "$DB" -tAc "select count(*) from catalog_quality_results where run_id='$rid'")"; [ "$n" = 0 ] || { echo "FT-01 failed: orphan results=$n"; exit 1; };; PASSED|FAILED|CANCELLED) ;; *) echo "FT-01 failed: permanent $s"; exit 1;; esac
      ;;
    FT-02)
      local rid; rid="$(submit ft-02-key-0001)"; sleep .05
      kill -TERM "$CAT_PID" 2>/dev/null || true; wait "$CAT_PID" 2>/dev/null || true; CAT_PID=""
      psql -d "$DB" -c "update catalog_quality_runs set lease_expires_at=now()+interval '1 second' where run_id='$rid'" >/dev/null
      start_catalog
      for _ in $(seq 1 80); do s="$(run_status "$rid")"; case "$s" in PASSED|FAILED|ERROR|CANCELLED) break;; esac; sleep .2; done
      case "$s" in PASSED|FAILED|ERROR|CANCELLED) ;; *) echo "FT-02 failed: permanent $s"; exit 1;; esac
      ;;
    FT-06)
      local rid; rid="$(submit ft-06-key-0001)"; local code; code="$(curl -sS -o /tmp/ft06.json -w '%{http_code}' -H 'x-opsweave-user-role: admin' -X POST "$BASE/api/data-catalog/datasets/$DATASET_ID/quality-runs/$rid/cancel")"
      case "$code" in 200) [ "$(run_status "$rid")" = CANCELLED ] ;; 409) s="$(run_status "$rid")"; case "$s" in PASSED|FAILED|ERROR|CANCELLED) ;; *) echo "FT-06 failed: $s"; exit 1;; esac;; *) echo "FT-06 failed: cancel http=$code"; exit 1;; esac
      local n; n="$(psql -d "$DB" -tAc "select count(*) from catalog_quality_results where run_id='$rid'")"; [ "$n" = 0 ] || [ "$code" = 409 ] || { echo "FT-06 failed: cancelled results=$n"; exit 1; }
      ;;
    FT-14)
      local r1 r2; r1="$(submit ft-14-key-0001)"; r2="$(submit ft-14-key-0001)"; [ "$r1" = "$r2" ] || { echo "FT-14 failed: different runs"; exit 1; }
      ;;
  esac
  psql -d "$DB" -c "select run_id,status,attempt,records_examined,records_failed from catalog_quality_runs" > "$dir/after.txt"
  echo "PASS $id" | tee "$dir/summary.md"
}
for c in $CASES; do run_case "$c"; done
