-- 0029 · The trusted collection policy for an automation source.
--
-- An Event names a source and a nativeId; it must never choose which Zabbix
-- items are read. The item list and the window length come from deployment
-- configuration (OPSWEAVE_AUTOMATION_SOURCES), are validated at sync time, and
-- are stored on the Kernel-owned registry row. A source with no items is still
-- a valid registry row, but automation refuses with
-- AUTOMATION_CONFIGURATION_REQUIRED instead of calling collect with an empty
-- selection (an empty collection would be an EMPTY measurement nobody asked
-- for, not evidence).
--
-- Bounds: at most 32 items per source, window 30–3600 seconds. The plugin
-- additionally clamps to its own ceiling and reports any clamp.
--
-- Rollback:
--   ALTER TABLE kernel.telemetry_sources
--     DROP COLUMN automation_window_seconds, DROP COLUMN automation_item_ids;

ALTER TABLE kernel.telemetry_sources
    ADD COLUMN IF NOT EXISTS automation_item_ids text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE kernel.telemetry_sources
    ADD COLUMN IF NOT EXISTS automation_window_seconds integer NOT NULL DEFAULT 300;

ALTER TABLE kernel.telemetry_sources
    DROP CONSTRAINT IF EXISTS telemetry_sources_automation_items_check;
ALTER TABLE kernel.telemetry_sources
    ADD CONSTRAINT telemetry_sources_automation_items_check
    CHECK (cardinality(automation_item_ids) <= 32);

ALTER TABLE kernel.telemetry_sources
    DROP CONSTRAINT IF EXISTS telemetry_sources_automation_window_check;
ALTER TABLE kernel.telemetry_sources
    ADD CONSTRAINT telemetry_sources_automation_window_check
    CHECK (automation_window_seconds BETWEEN 30 AND 3600);
