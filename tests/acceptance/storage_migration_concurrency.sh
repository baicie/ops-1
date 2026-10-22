#!/usr/bin/env bash
# Real HTTP/PostgreSQL migration concurrency test.
#
# A deliberately fails after creating DDL; its FAILED ledger insert is delayed
# by a test trigger. B then applies the same migration successfully. The final
# ledger must be APPLIED and A's late failure must not overwrite it.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
AUTH=(-H "Authorization: Bearer $TOKEN")
SCHEMA="plugin_opsweave_data_catalog"
ROLE="plugin_opsweave_data_catalog_role"
VERSION="concurrency-$(date +%s)"
MIGRATION="race-$(date +%s)"
PLUGIN="opsweave.data-catalog"
json() { python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }
cleanup() {
  psql "$DB" -qAt -c "DROP TRIGGER IF EXISTS test_delay_failed_migration ON kernel.plugin_migrations;" >/dev/null 2>&1 || true
  psql "$DB" -qAt -c "DROP FUNCTION IF EXISTS test_delay_failed_migration();" >/dev/null 2>&1 || true
  psql "$DB" -qAt -c "DELETE FROM kernel.plugin_migrations WHERE plugin_id='$PLUGIN' AND version='$VERSION';" >/dev/null 2>&1 || true
  psql "$DB" -qAt -c "DROP TABLE IF EXISTS \"$SCHEMA\".concurrency_probe;" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql "$DB" -qAt -c "DROP TABLE IF EXISTS \"$SCHEMA\".concurrency_probe;" >/dev/null
psql "$DB" -qAt -c "CREATE OR REPLACE FUNCTION test_delay_failed_migration() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN IF NEW.status='FAILED' THEN PERFORM pg_sleep(4); END IF; RETURN NEW; END \$\$; DROP TRIGGER IF EXISTS test_delay_failed_migration ON kernel.plugin_migrations; CREATE TRIGGER test_delay_failed_migration BEFORE INSERT OR UPDATE ON kernel.plugin_migrations FOR EACH ROW EXECUTE FUNCTION test_delay_failed_migration();" >/dev/null

THRESHOLD="$(python3 -c 'from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)+timedelta(seconds=3)).isoformat())')"
SQL="CREATE TABLE concurrency_probe(id integer); SELECT CASE WHEN clock_timestamp() < '$THRESHOLD'::timestamptz THEN 1/0 ELSE 1 END;"
BODY="$(python3 - "$SQL" "$VERSION" "$MIGRATION" <<'PY'
import hashlib,json,sys
sql,version,mid=sys.argv[1:]
print(json.dumps({'version':version,'migrationId':mid,'phase':'EXPAND','checksum':'sha256:'+hashlib.sha256(sql.encode()).hexdigest(),'sql':sql}))
PY
)"
printf '%s' "$BODY" > /tmp/migration-race-body.json

# A acquires the advisory lock first and creates DDL, then sleeps.
curl -sS -o /tmp/migration-race-a.json -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' --data-binary @/tmp/migration-race-body.json "$URL/api/v1/plugin-storage/$PLUGIN/migrations" > /tmp/migration-race-a.code &
A_PID=$!
# A starts before the threshold and fails. B starts after the threshold; the
# advisory lock still serializes the two requests.
sleep 4
curl -sS -o /tmp/migration-race-b.json -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' --data-binary @/tmp/migration-race-body.json "$URL/api/v1/plugin-storage/$PLUGIN/migrations" > /tmp/migration-race-b.code &
B_PID=$!
wait "$A_PID"
wait "$B_PID"
CODE_A="$(cat /tmp/migration-race-a.code)"; CODE_B="$(cat /tmp/migration-race-b.code)"
[ "$CODE_A" = "409" ] || bad "A failure returned $CODE_A, expected 409: $(cat /tmp/migration-race-a.json)"
[ "$CODE_B" = "200" ] || bad "B success returned $CODE_B, expected 200: $(cat /tmp/migration-race-b.json)"
grep -q 'MIGRATION_FAILED' /tmp/migration-race-a.json || bad "A did not return MIGRATION_FAILED"
grep -q '"status":"APPLIED"' /tmp/migration-race-b.json || bad "B did not return APPLIED"
FINAL="$(psql "$DB" -qAt -c "SELECT status FROM kernel.plugin_migrations WHERE plugin_id='$PLUGIN' AND version='$VERSION' AND migration_id='$MIGRATION';")"
[ "$FINAL" = "APPLIED" ] || bad "final ledger is $FINAL, expected APPLIED"
EXISTS="$(psql "$DB" -qAt -c "SELECT to_regclass('$SCHEMA.concurrency_probe');")"
[ -n "$EXISTS" ] || bad "successful migration did not create the probe table"
ok "A failed, B applied once, late FAILED did not overwrite APPLIED"

REPLAY_CODE="$(curl -sS -o /tmp/migration-race-replay.json -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' --data-binary @/tmp/migration-race-body.json "$URL/api/v1/plugin-storage/$PLUGIN/migrations")"
[ "$REPLAY_CODE" = "200" ] || bad "replay returned $REPLAY_CODE"
grep -q '"replay":true' /tmp/migration-race-replay.json || bad "replay did not return replay=true"
ok "same checksum replay did not execute again"

BAD_BODY="$(printf '%s' "$BODY" | python3 -c 'import json,sys; d=json.load(sys.stdin); d["checksum"]="sha256:0000000000000000000000000000000000000000000000000000000000000000"; print(json.dumps(d))')"
BAD_CODE="$(curl -sS -o /tmp/migration-race-bad.json -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' --data-binary "$BAD_BODY" "$URL/api/v1/plugin-storage/$PLUGIN/migrations")"
[ "$BAD_CODE" = "409" ] || bad "checksum mismatch returned $BAD_CODE"
grep -q 'MIGRATION_CHECKSUM_MISMATCH' /tmp/migration-race-bad.json || bad "checksum mismatch error code missing"
ok "different checksum replay rejected"

CONTRACT_BODY="$(python3 - "$VERSION" "$MIGRATION" <<'PY'
import hashlib,json,sys
sql='SELECT 1;'
print(json.dumps({'version':sys.argv[1],'migrationId':sys.argv[2]+'-contract','phase':'CONTRACT','checksum':'sha256:'+hashlib.sha256(sql.encode()).hexdigest(),'sql':sql}))
PY
)"
CONTRACT_CODE="$(curl -sS -o /tmp/migration-race-contract.json -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$CONTRACT_BODY" "$URL/api/v1/plugin-storage/$PLUGIN/migrations")"
[ "$CONTRACT_CODE" = "409" ] || bad "CONTRACT with live instance returned $CONTRACT_CODE"
grep -q 'MIGRATION_CONTRACT_BLOCKED' /tmp/migration-race-contract.json || bad "CONTRACT error code missing"
ok "CONTRACT blocked while an instance is live"
echo "Migration Concurrency Golden Path: PASS"
