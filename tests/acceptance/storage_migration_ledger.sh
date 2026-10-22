#!/usr/bin/env bash
# Reproducible SQL-level check for the "late FAILED must not overwrite APPLIED"
# migration ledger rule. This is a focused ledger check, not a two-request
# scheduler race; see docs/acceptance/EVIDENCE.md for that limitation.
set -euo pipefail
DB="${OPSWEAVE_TEST_DATABASE_URL:-opsweave_data_test}"
OUT="$(psql "$DB" -qAt <<'SQL'
INSERT INTO kernel.plugin_migrations (id,plugin_id,version,migration_id,checksum,status,phase,details)
VALUES ('00000000-0000-4000-8000-000000000001','race.test','v1','m1','sha256:x','APPLIED','EXPAND','{}'::jsonb)
ON CONFLICT (plugin_id,version,migration_id) DO UPDATE SET status='APPLIED';
INSERT INTO kernel.plugin_migrations (id,plugin_id,version,migration_id,checksum,status,phase,details)
VALUES ('00000000-0000-4000-8000-000000000002','race.test','v1','m1','sha256:x','FAILED','EXPAND','{"error":"late failure"}'::jsonb)
ON CONFLICT (plugin_id,version,migration_id) DO UPDATE SET status='FAILED', details=EXCLUDED.details WHERE kernel.plugin_migrations.status <> 'APPLIED';
SELECT status FROM kernel.plugin_migrations WHERE plugin_id='race.test' AND version='v1' AND migration_id='m1';
DELETE FROM kernel.plugin_migrations WHERE plugin_id='race.test';
SQL
)"
[ "$OUT" = "APPLIED" ] || { echo "FAIL expected APPLIED, got $OUT"; exit 1; }
echo "PASS  migration ledger cannot overwrite APPLIED with late FAILED"
