-- P001: the platform console grant must reach an administrator created at bootstrap.
--
-- Migration 0035 granted `opsweave.console` to every account that existed WHEN IT
-- RAN. That is correct for an upgrade (nobody gains or loses access) and wrong for
-- every deployment created afterwards, because the bootstrap administrator is
-- inserted by `seed_admin` AFTER the migrations have run. A fresh install
-- therefore had an admin whose `GET /api/v1/applications` said:
--
--   {"applications": [], "denied": ["opsweave.console"]}
--
-- The console does not gate on that grant today (its guard is the platform:access
-- surface, which the admin role does carry), so nothing was blocked. It was still
-- a false statement: the one account that administers the platform was reported as
-- not permitted to open the platform's own console.
--
-- Why this is a database rule and not another seed step:
--   * `seed_admin` runs only when NO human account exists, so it cannot fix an
--     account that already exists in an older deployment.
--   * A future admin created through `POST /api/v1/users` has the same problem,
--     and a trigger covers every path that assigns the role.
--   * It is additive: it inserts a grant and never deletes one.

-- 1. Repair the accounts that already exist. Same shape and same empty permission
--    list as 0035, so this migration cannot widen a verb either.
INSERT INTO kernel.application_grants (application_id, user_id, permissions, granted_by)
SELECT 'opsweave.console', u.id, ARRAY[]::text[], NULL::uuid
  FROM kernel.users u
 WHERE u.role = 'admin'
ON CONFLICT (application_id, user_id) DO NOTHING;

-- 2. Keep it true for accounts created later, whichever path creates them.
--
--    The function is SECURITY DEFINER because the inserting role (the kernel's or
--    an operator's) must not need INSERT rights on kernel.application_grants to
--    create a user; the function itself does exactly one thing.
CREATE OR REPLACE FUNCTION kernel.grant_console_to_admin() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kernel, pg_temp
AS $$
BEGIN
    IF NEW.role = 'admin' THEN
        INSERT INTO kernel.application_grants (application_id, user_id, permissions, granted_by)
        VALUES ('opsweave.console', NEW.id, ARRAY[]::text[], NULL::uuid)
        ON CONFLICT (application_id, user_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION kernel.grant_console_to_admin() IS
    'P001: an account with the admin role holds the platform console grant. Additive only; never removes a grant.';

DROP TRIGGER IF EXISTS users_admin_gets_console ON kernel.users;
CREATE TRIGGER users_admin_gets_console
    AFTER INSERT OR UPDATE OF role ON kernel.users
    FOR EACH ROW
    EXECUTE FUNCTION kernel.grant_console_to_admin();
