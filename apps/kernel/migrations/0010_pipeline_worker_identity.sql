-- Trusted Node-managed pipeline workers use a dedicated consumer principal so
-- they do not inherit an arbitrary plugin instance's grants. The Node control
-- credential remains the only way to request this principal.
INSERT INTO kernel.capability_grants
    (id, name, major, consumer_plugin_id, provider_plugin_id, scope, state)
VALUES
    ('00000000-0000-4000-8000-000000001001', 'data.catalog.v1', 1,
     'opsweave.pipeline.worker', NULL,
     '["dataset:read","dataset:write"]'::jsonb, 'ACTIVE')
ON CONFLICT (consumer_plugin_id, name, major) DO NOTHING;
