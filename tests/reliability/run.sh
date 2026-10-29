#!/usr/bin/env bash
# OpsWeave isolated Quality lifecycle fault-injection harness.
# Requires local PostgreSQL, curl, python3 and backend `npm ci`.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CASE=""; ALL=0
while [ $# -gt 0 ]; do case "$1" in --case) CASE="${2:?}"; shift 2;; --all) ALL=1; shift;; *) echo "usage: $0 --case FT-01|--all" >&2; exit 2;; esac; done
[ "$ALL" = 1 ] && CASES="FT-01 FT-02 FT-06 FT-IDEM-01" || CASES="$CASE"
[ -n "$CASES" ] || { echo "no case selected" >&2; exit 2; }
BASE_PORT="${FT_PORT:-18300}"
ART_ROOT="$ROOT/artifacts/reliability/$(date +%Y%m%dT%H%M%S)-$$"
mkdir -p "$ART_ROOT"
CAT_PID=""; DB=""; PORT=""; CASE_ART=""; DATASET_ID=""
cleanup_case() {
  if [ -n "$CAT_PID" ]; then
    kill -TERM "$CAT_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$CAT_PID" 2>/dev/null || break; sleep .1; done
    kill -KILL "$CAT_PID" 2>/dev/null || true
    wait "$CAT_PID" 2>/dev/null || true
    CAT_PID=""
  fi
  if [ -n "$PORT" ] && lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
    echo "HARNESS FAIL: listener remains on $PORT" >&2
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
    exit 1
  fi
  if [ -n "$DB" ]; then dropdb --if-exists --force "$DB" >/dev/null 2>&1 || { echo "HARNESS FAIL: could not drop $DB" >&2; exit 1; }; fi
  DB=""
}
trap cleanup_case EXIT
api() { curl -fsS -H 'x-opsweave-user-role: admin' -H 'content-type: application/json' "$@"; }
run_status() { psql -d "$DB" -tAc "select status from catalog_quality_runs where run_id='$1'"; }
wait_run() {
  local rid="$1" expected="$2" deadline=$((SECONDS+30)) s
  while [ $SECONDS -lt $deadline ]; do
    s="$(run_status "$rid" 2>/dev/null || true)"
    case "$s" in "$expected") return 0;; PASSED|FAILED|ERROR|CANCELLED) echo "expected $expected got $s" >&2; return 1;; esac
    sleep .1
  done
  echo "deadline waiting for $expected (last=$s)" >&2; return 1
}
start_catalog() {
  local log="$1"
  (cd "$ROOT/plugins/data-catalog/backend" && exec env DATABASE_URL="${FT_DATABASE_PREFIX:-postgres://localhost}/$DB?sslmode=disable" OPSWEAVE_PLUGIN_DATABASE_URL="${FT_DATABASE_PREFIX:-postgres://localhost}/$DB?sslmode=disable" OPSWEAVE_CALLER_CONTEXT_KEY='' OPSWEAVE_QUALITY_TEST_DELAY_MS=2000 PORT="$PORT" node server.mjs >"$log" 2>&1) &
  CAT_PID=$!
  echo "$CAT_PID" > "$CASE_ART/catalog.pid"
  for _ in $(seq 1 100); do
    kill -0 "$CAT_PID" 2>/dev/null || { echo "catalog process exited during startup" >&2; cat "$log" >&2; return 1; }
    curl -fsS "http://127.0.0.1:$PORT/_opsweave/health/ready" >/dev/null 2>&1 && { lsof -ti tcp:"$PORT" | grep -qx "$CAT_PID"; return 0; }
    sleep .1
  done
  echo "catalog did not become ready" >&2; cat "$log" >&2; return 1
}
make_fixture() {
  local name="$1" payload ds
  payload="$(printf '{"name":"%s","fields":[{"name":"id","type":"string","nullable":false,"ordinal":0},{"name":"name","type":"string","nullable":true,"ordinal":1}],"retentionPolicy":{"mode":"RETAIN","maxRecords":10000,"maxBytes":16777216}}' "$name")"
  ds="$(api -X POST "http://127.0.0.1:$PORT/api/data-catalog/datasets" -d "$payload")"
  DATASET_ID="$(printf '%s' "$ds" | python3 -c 'import json,sys;print(json.load(sys.stdin)["datasetId"])')"
  api -X POST "http://127.0.0.1:$PORT/api/data-catalog/datasets/$DATASET_ID/quality-rules" -d '{"ruleType":"RECORD_COUNT","config":{"min":1,"max":10000},"severity":"HIGH"}' >/dev/null
  python3 - "$PORT" "$DATASET_ID" <<'PY' >/dev/null
import json,sys,urllib.request
port,ds=sys.argv[1:]
records=[{"id":str(i),"name":"n"} for i in range(20)]
req=urllib.request.Request(f"http://127.0.0.1:{port}/api/data-catalog/datasets/{ds}/records",data=json.dumps({"schemaRevision":1,"sourceBatchKey":"ft-batch-00000001","records":records}).encode(),headers={"content-type":"application/json","x-opsweave-user-role":"admin"},method="POST")
urllib.request.urlopen(req).read()
PY
}
submit() {
  local key="$1"
  api -X POST -H "Idempotency-Key: $key" "http://127.0.0.1:$PORT/api/data-catalog/datasets/$DATASET_ID/quality-runs" -d '{"schemaRevision":1}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["runId"])'
}
record_run() {
  local rid="$1" out="$2"
  psql -d "$DB" -Atc "select json_build_object('runId',run_id,'status',status,'attempt',attempt,'fencingToken',fencing_token,'leaseOwner',lease_owner,'leaseExpiresAt',lease_expires_at,'errorCode',error_code,'resultCount',(select count(*) from catalog_quality_results r where r.run_id=q.run_id)) from catalog_quality_runs q where run_id='$rid'" > "$out"
}
run_case() {
  local id="$1" index="$2" rid r1 r2 code s n
  DB="opsweave_ft_${id//-/_}_$$_$(date +%s)"; PORT=$((BASE_PORT+index)); CASE_ART="$ART_ROOT/$id"; mkdir -p "$CASE_ART"
  createdb "$DB" || { echo "HARNESS FAIL: createdb $DB" >&2; exit 1; }
  echo "{\"case\":\"$id\",\"git\":\"$(git -C "$ROOT" rev-parse HEAD)\",\"db\":\"$DB\",\"port\":$PORT,\"startedAt\":\"$(date -u +%FT%TZ)\"}" > "$CASE_ART/metadata.json"
  start_catalog "$CASE_ART/catalog-initial.log"
  make_fixture "ft-dataset-$id"
  case "$id" in
    FT-01)
      rid="$(submit ft-01-key-0001)"; wait_run "$rid" RUNNING
      record_run "$rid" "$CASE_ART/before.json"
      kill -KILL "$CAT_PID"; wait "$CAT_PID" 2>/dev/null || true
      kill -0 "$CAT_PID" 2>/dev/null && { echo "FT-01 FAIL: pid did not exit" >&2; exit 1; }
      CAT_PID=""
      psql -d "$DB" -c "update catalog_quality_runs set lease_expires_at=now()-interval '1 second' where run_id='$rid'" >/dev/null
      start_catalog "$CASE_ART/catalog-after-restart.log"
      wait_run "$rid" ERROR
      n="$(psql -d "$DB" -tAc "select count(*) from catalog_quality_results where run_id='$rid'")"; [ "$n" = 0 ] || { echo "FT-01 FAIL: orphan results=$n" >&2; exit 1; }
      ;;
    FT-02)
      rid="$(submit ft-02-key-0001)"; wait_run "$rid" RUNNING
      record_run "$rid" "$CASE_ART/before.json"
      kill -TERM "$CAT_PID"; wait "$CAT_PID" 2>/dev/null || true; CAT_PID=""
      psql -d "$DB" -c "update catalog_quality_runs set lease_expires_at=now()+interval '1 second' where run_id='$rid'" >/dev/null
      start_catalog "$CASE_ART/catalog-after-restart.log"
      [ "$(run_status "$rid")" = RUNNING ] || { echo "FT-02 FAIL: premature terminal" >&2; exit 1; }
      wait_run "$rid" ERROR
      n="$(psql -d "$DB" -tAc "select count(*) from catalog_quality_results where run_id='$rid'")"; [ "$n" = 0 ] || { echo "FT-02 FAIL: orphan results=$n" >&2; exit 1; }
      ;;
    FT-06)
      rid="$(submit ft-06-key-0001)"; wait_run "$rid" RUNNING
      code="$(curl -sS -o "$CASE_ART/cancel.json" -w '%{http_code}' -H 'x-opsweave-user-role: admin' -X POST "http://127.0.0.1:$PORT/api/data-catalog/datasets/$DATASET_ID/quality-runs/$rid/cancel")"
      [ "$code" = 200 ] || { echo "FT-06 FAIL: cancel http=$code" >&2; exit 1; }
      [ "$(run_status "$rid")" = CANCELLED ] || { echo "FT-06 FAIL: not cancelled" >&2; exit 1; }
      n="$(psql -d "$DB" -tAc "select count(*) from catalog_quality_results where run_id='$rid'")"; [ "$n" = 0 ] || { echo "FT-06 FAIL: results=$n" >&2; exit 1; }
      ;;
    FT-IDEM-01)
      r1="$(submit ft-idem-key-0001)"; r2="$(submit ft-idem-key-0001)"; [ "$r1" = "$r2" ] || { echo "FT-IDEM-01 FAIL: two run ids" >&2; exit 1; }
      rid="$r1"; wait_run "$rid" PASSED
      n="$(psql -d "$DB" -tAc "select count(*) from catalog_quality_results where run_id='$rid'")"; [ "$n" = 1 ] || { echo "FT-IDEM-01 FAIL: result rows=$n" >&2; exit 1; }
      ;;
    *) echo "unknown case $id" >&2; exit 2;;
  esac
  record_run "$rid" "$CASE_ART/after.json"
  psql -d "$DB" -Atc "select json_agg(json_build_object('runId',run_id,'status',status,'attempt',attempt,'resultCount',(select count(*) from catalog_quality_results r where r.run_id=q.run_id))) from catalog_quality_runs q" > "$CASE_ART/assertions.json"
  echo "PASS $id" | tee "$CASE_ART/summary.md"
  cleanup_case
}
idx=0
for c in $CASES; do run_case "$c" "$idx"; idx=$((idx+1)); done
echo "ALL REQUESTED CASES PASSED: $(echo "$CASES" | wc -w | tr -d ' ')"
