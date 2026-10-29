-- Global retention filtering is by observed_at, not node_id. Keep a separate
-- index so offline-node cleanup does not scan the node-scoped index.
CREATE INDEX IF NOT EXISTS node_resource_samples_observed_idx
    ON kernel.node_resource_samples (observed_at, sample_id);
