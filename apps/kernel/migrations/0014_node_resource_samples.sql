-- Bounded, append-only node resource telemetry. Heartbeat remains authoritative
-- even when sample persistence is temporarily unavailable.
CREATE TABLE IF NOT EXISTS kernel.node_resource_samples (
    sample_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    node_id uuid NOT NULL REFERENCES kernel.nodes(id) ON DELETE CASCADE,
    generation bigint NOT NULL,
    observed_at timestamptz NOT NULL,
    sampled_at timestamptz NOT NULL,
    cpu_utilization double precision,
    memory_used_bytes bigint,
    memory_total_bytes bigint,
    cpu_cores bigint,
    filesystem_used_bytes bigint,
    filesystem_total_bytes bigint,
    UNIQUE (node_id, sampled_at)
);
CREATE INDEX IF NOT EXISTS node_resource_samples_node_time_idx
    ON kernel.node_resource_samples (node_id, observed_at DESC, sample_id DESC);
