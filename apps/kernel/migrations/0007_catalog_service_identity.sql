-- Minimal read-only service principal used by the Kernel to resolve live Catalog
-- dataset/schema metadata during Pipeline publish. It is not a user session and
-- is still subject to capability provider resolution, grant state and scope.
INSERT INTO kernel.capability_grants
    (id, name, major, consumer_plugin_id, provider_plugin_id, scope, state)
VALUES
    ('00000000-0000-4000-8000-000000000701', 'data.catalog.v1', 1,
     'opsweave.kernel.catalog', NULL, '["dataset:read"]'::jsonb, 'ACTIVE')
ON CONFLICT (consumer_plugin_id, name, major) DO NOTHING;
