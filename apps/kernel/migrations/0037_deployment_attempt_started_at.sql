-- A PENDING deployment needs to know how long THIS ATTEMPT has been trying.
--
-- WHY NOT `created_at`.
--
--   `created_at` is when the version was first deployed. A row that keeps failing
--   and is re-deployed keeps its original `created_at`, so a timeout read from it
--   would fire again immediately after the operator's retry - the retry would be
--   born expired. It is also the wrong fact: "this version arrived on Tuesday" is
--   not "this attempt has been failing for ten minutes".
--
-- WHY NOT `updated_at`.
--
--   `reconcile_deployment` writes `updated_at` on every pass that changes the
--   status, and the pass that reads this value is the same pass that can write it.
--   The age would reset each time the reconciler looked, which is forever.
--
-- WHAT THIS IS.
--
--   Set when a deployment ENTERS `PENDING`, and left alone while it stays there.
--   A redeploy or an enable resets it, because those are new attempts at the same
--   version. `NULL` means "not currently attempting", which is every row that is
--   READY, ACTIVE, DEGRADED, DISABLED, DRAINING or already FAILED.
--
--   The backfill is deliberately `updated_at` rather than `now()`: an existing
--   PENDING row on a live installation has been trying since at least then, and
--   starting its clock now would give a nine-day-old hopeless row a fresh ten
--   minutes. `updated_at` is the closest honest lower bound available.
ALTER TABLE kernel.plugin_deployments
    ADD COLUMN IF NOT EXISTS attempt_started_at timestamptz;

UPDATE kernel.plugin_deployments
   SET attempt_started_at = updated_at
 WHERE status = 'PENDING'
   AND attempt_started_at IS NULL;
