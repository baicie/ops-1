#!/usr/bin/env bash
# Real migration API regression for comments, UTF-8, semicolons and dollar quotes.
set -euo pipefail
URL="${OPSWEAVE_URL:-http://127.0.0.1:18181}"
DB="${OPSWEAVE_TEST_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5432/opsweave}"
TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.opsweave/session.json")))["token"])')"
PLUGIN="opsweave.data-catalog"
VERSION="parser-$(date +%s)"
MIGRATION="utf8-$(date +%s)"
ok() { echo "PASS  $*"; }
bad() { echo "FAIL  $*"; exit 1; }
cleanup() {
  psql "$DB" -qAt -c "DROP TABLE IF EXISTS plugin_opsweave_data_catalog.parser_probe;" >/dev/null 2>&1 || true
  psql "$DB" -qAt -c "DELETE FROM kernel.plugin_migrations WHERE plugin_id='$PLUGIN' AND version='$VERSION';" >/dev/null 2>&1 || true
}
trap cleanup EXIT

SQL="-- 中文注释中的分号 ; 不应拆分
CREATE TABLE parser_probe(id integer);
COMMENT ON TABLE parser_probe IS '中文;comment';
DO \$\$ BEGIN RAISE NOTICE '中文; dollar quote'; END \$\$;"
BODY="$(python3 - "$SQL" "$VERSION" "$MIGRATION" <<'PY'
import hashlib,json,sys
sql,version,mid=sys.argv[1:]
print(json.dumps({'version':version,'migrationId':mid,'phase':'EXPAND','checksum':'sha256:'+hashlib.sha256(sql.encode()).hexdigest(),'sql':sql}))
PY
)"
CODE="$(curl -sS -o /tmp/migration-parser.json -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' --data-binary "$BODY" "$URL/api/v1/plugin-storage/$PLUGIN/migrations")"
[ "$CODE" = "200" ] || bad "parser migration returned $CODE: $(cat /tmp/migration-parser.json)"
grep -q '"status":"APPLIED"' /tmp/migration-parser.json || bad "parser migration not APPLIED"
EXISTS="$(psql "$DB" -qAt -c "SELECT to_regclass('plugin_opsweave_data_catalog.parser_probe');")"
[ -n "$EXISTS" ] || bad "parser migration did not create table"
ok "UTF-8 comments, semicolons and PL/pgSQL dollar quotes migrated atomically"
echo "Migration Parser Golden Path: PASS"
