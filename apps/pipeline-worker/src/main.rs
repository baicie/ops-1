//! Bounded Node-side pipeline worker.
//!
//! The worker is a trusted Node process: it authenticates with the enrolled Node
//! credential, binds every job operation to a READY plugin instance on that
//! Node, and never uses an administrator browser session.

use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use reqwest::{Client, Method, StatusCode};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use uuid::Uuid;

const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECORDS: usize = 10_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeIdentity {
    node_id: Uuid,
    credential: String,
    generation: i64,
}

#[derive(Debug, Clone)]
struct Worker {
    client: Client,
    kernel_url: String,
    node_id: Uuid,
    credential: String,
    generation: i64,
    worker_id: String,
    instance_id: Uuid,
    boot_id: Uuid,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimResponse {
    lease_id: Uuid,
    job_id: Uuid,
    fencing_sequence: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DefinitionResponse {
    pipeline_id: String,
    pipeline_revision: u32,
    definition: Value,
    #[allow(dead_code)]
    plan: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkloadTokenResponse {
    token: String,
}

fn env(name: &str) -> Result<String> {
    std::env::var(name).with_context(|| format!("missing {name}"))
}

impl Worker {
    async fn new() -> Result<Self> {
        let identity_path = env("OPSWEAVE_WORKER_NODE_IDENTITY")?;
        let identity: NodeIdentity = serde_json::from_slice(
            &tokio::fs::read(&identity_path)
                .await
                .with_context(|| format!("read {identity_path}"))?,
        )
        .context("parse node identity")?;
        let instance_id = env("OPSWEAVE_WORKER_INSTANCE_ID")?
            .parse()
            .context("parse instance id")?;
        let boot_id = env("OPSWEAVE_WORKER_BOOT_ID")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or_else(Uuid::new_v4);
        let worker_id = format!("n:{}:i:{}:b:{}", identity.node_id, instance_id, boot_id);
        let kernel_url = env("OPSWEAVE_WORKER_KERNEL_URL")?
            .trim_end_matches('/')
            .to_string();
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            client,
            kernel_url,
            node_id: identity.node_id,
            credential: identity.credential,
            generation: std::env::var("OPSWEAVE_WORKER_NODE_GENERATION")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(identity.generation),
            worker_id,
            instance_id,
            boot_id,
        })
    }

    fn worker_headers(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request
            .bearer_auth(&self.credential)
            .header("x-opsweave-node-id", self.node_id.to_string())
            .header("x-opsweave-instance-id", self.instance_id.to_string())
            .header("x-opsweave-node-generation", self.generation.to_string())
            .header("x-opsweave-boot-id", self.boot_id.to_string())
            .header("x-opsweave-worker-id", &self.worker_id)
    }

    fn worker_body(&self) -> Value {
        json!({
            "workerId": self.worker_id,
            "nodeId": self.node_id,
            "instanceId": self.instance_id,
            "bootId": self.boot_id,
            "version": "0.0.3"
        })
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(StatusCode, Value)> {
        let mut request = self.worker_headers(
            self.client
                .request(method, format!("{}{}", self.kernel_url, path)),
        );
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.context("kernel worker request")?;
        let status = response.status();
        let bytes = response.bytes().await.unwrap_or_default();
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Ok((status, value))
    }

    async fn claim(&self, job_id: Uuid) -> Result<ClaimResponse> {
        let (status, body) = self
            .call(
                Method::POST,
                &format!("/internal/v1/pipeline-jobs/{job_id}/claim"),
                Some(self.worker_body()),
            )
            .await?;
        if !status.is_success() {
            bail!("claim failed ({status}): {body}");
        }
        serde_json::from_value(body).context("parse claim")
    }

    async fn start(&self, job_id: Uuid, lease: &ClaimResponse) -> Result<()> {
        let (status, body) = self
            .call(
                Method::POST,
                &format!("/internal/v1/pipeline-jobs/{job_id}/start"),
                Some(json!({
                    "leaseId": lease.lease_id, "fencingSequence": lease.fencing_sequence
                })),
            )
            .await?;
        if !status.is_success() {
            bail!("start failed ({status}): {body}");
        }
        Ok(())
    }

    fn start_heartbeat(
        &self,
        job_id: Uuid,
        lease: ClaimResponse,
        cancelled: Arc<AtomicBool>,
    ) -> tokio::task::JoinHandle<()> {
        let worker = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;
                if cancelled.load(Ordering::SeqCst) {
                    return;
                }
                if worker.heartbeat(job_id, &lease).await.is_err() {
                    cancelled.store(true, Ordering::SeqCst);
                    return;
                }
            }
        })
    }

    async fn heartbeat(&self, job_id: Uuid, lease: &ClaimResponse) -> Result<()> {
        let (status, body) = self
            .call(
                Method::POST,
                &format!("/internal/v1/pipeline-jobs/{job_id}/heartbeat"),
                Some(json!({
                    "leaseId": lease.lease_id, "fencingSequence": lease.fencing_sequence
                })),
            )
            .await?;
        if !status.is_success() {
            bail!("heartbeat failed ({status}): {body}");
        }
        Ok(())
    }

    async fn checkpoint(
        &self,
        job_id: Uuid,
        lease: &ClaimResponse,
        sequence: usize,
        records: usize,
        completed_batches: usize,
        snapshot_digest: &str,
    ) -> Result<()> {
        let state = json!({
            "records": records,
            "completedBatches": completed_batches,
            "snapshotDigest": snapshot_digest
        });
        let digest = digest(&state);
        let (status, body) = self
            .call(
                Method::POST,
                &format!("/internal/v1/pipeline-jobs/{job_id}/checkpoint"),
                Some(json!({
                    "leaseId": lease.lease_id,
                    "fencingSequence": lease.fencing_sequence,
                    "sequence": sequence,
                    "inputCursor": format!("batch:{completed_batches}"),
                    "stateDigest": digest,
                    "state": state
                })),
            )
            .await?;
        if !status.is_success() {
            bail!("checkpoint failed ({status}): {body}");
        }
        Ok(())
    }

    async fn definition(&self, job_id: Uuid) -> Result<DefinitionResponse> {
        let (status, body) = self
            .call(
                Method::GET,
                &format!("/internal/v1/pipeline-jobs/{job_id}/definition"),
                None,
            )
            .await?;
        if !status.is_success() {
            bail!("definition failed ({status}): {body}");
        }
        serde_json::from_value(body).context("parse definition")
    }

    async fn workload_token(&self) -> Result<String> {
        let body = json!({
            "instanceId": self.instance_id,
            "servicePluginId": "opsweave.pipeline.worker",
            "capabilityName": "data.catalog.v1",
            "capabilityMajor": 1,
            "audience": "plugin:data.catalog.v1",
            "scope": ["dataset:read", "dataset:write"]
        });
        let response = self
            .client
            .post(format!(
                "{}/internal/v1/nodes/{}/workload-token",
                self.kernel_url, self.node_id
            ))
            .bearer_auth(&self.credential)
            .json(&body)
            .send()
            .await
            .context("mint workload token")?;
        let status = response.status();
        let value: WorkloadTokenResponse = response.json().await.context("parse workload token")?;
        if !status.is_success() {
            bail!("workload-token failed ({status})");
        }
        Ok(value.token)
    }

    async fn capability(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(StatusCode, Value)> {
        let url = format!(
            "{}/api/v1/capabilities/data.catalog.v1/1/{}",
            self.kernel_url,
            path.trim_start_matches('/')
        );
        let mut request = self.client.request(method, url).bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.context("catalog capability request")?;
        let status = response.status();
        let bytes = response.bytes().await.unwrap_or_default();
        Ok((
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        ))
    }

    async fn get_snapshot(&self, job_id: Uuid) -> Result<Option<Value>> {
        let (status, body) = self
            .call(
                Method::GET,
                &format!("/internal/v1/pipeline-jobs/{job_id}/snapshot"),
                None,
            )
            .await?;
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            bail!("snapshot lookup failed ({status}): {body}");
        }
        Ok(Some(body))
    }

    async fn save_snapshot(
        &self,
        job_id: Uuid,
        lease: &ClaimResponse,
        source: &[Value],
        etag: Option<String>,
    ) -> Result<Value> {
        let value = Value::Array(source.to_vec());
        let source_digest = digest(&value);
        let serialized = canonical_json(&value).into_bytes();
        if serialized.len() > MAX_SOURCE_BYTES {
            bail!("source snapshot exceeds limit");
        }
        let (status, body) = self
            .call(
                Method::POST,
                &format!("/internal/v1/pipeline-jobs/{job_id}/snapshot"),
                Some(json!({
                    "leaseId": lease.lease_id,
                    "fencingSequence": lease.fencing_sequence,
                    "sourceDigest": source_digest,
                    "sourceLength": serialized.len(),
                    "source": value,
                    "etag": etag
                })),
            )
            .await?;
        if !status.is_success() {
            bail!("snapshot save failed ({status}): {body}");
        }
        Ok(body)
    }

    async fn fetch_source(&self, endpoint: &str) -> Result<Vec<Value>> {
        let policy = SourcePolicy::from_env();
        let url = policy.validate_url(endpoint).await?;
        let host = url
            .host_str()
            .ok_or_else(|| anyhow!("source URL has no host"))?
            .trim_matches(['[', ']'])
            .to_string();
        let port = url
            .port_or_known_default()
            .ok_or_else(|| anyhow!("source URL has no port"))?;
        let pinned: SocketAddr = if let Ok(ip) = host.parse::<IpAddr>() {
            policy.check_ip(ip, &host)?;
            SocketAddr::new(ip, port)
        } else {
            let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
                .await
                .context("source DNS resolution failed")?
                .collect();
            if addresses.is_empty() {
                bail!("source DNS has no addresses");
            }
            for address in &addresses {
                policy.check_ip(address.ip(), &host)?;
            }
            addresses[0]
        };
        let mut builder = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20));
        if host.parse::<IpAddr>().is_err() {
            builder = builder.resolve(&host, pinned);
        }
        let client = builder.build()?;
        let response = tokio::time::timeout(Duration::from_secs(30), client.get(url).send())
            .await
            .map_err(|_| anyhow!("source request timed out"))?
            .context("source request")?;
        if response.status().is_redirection() {
            bail!("source redirects are not allowed");
        }
        if !response.status().is_success() {
            bail!("source returned {}", response.status());
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_SOURCE_BYTES as u64)
        {
            bail!("source body exceeds limit");
        }
        let mut bytes = Vec::new();
        let stream = async {
            let mut response = response;
            while let Some(chunk) = response.chunk().await.context("read source")? {
                if bytes.len().saturating_add(chunk.len()) > MAX_SOURCE_BYTES {
                    bail!("source body exceeds limit");
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok::<(), anyhow::Error>(())
        };
        tokio::time::timeout(Duration::from_secs(20), stream)
            .await
            .map_err(|_| anyhow!("source read timed out"))??;
        let parsed: Value = serde_json::from_slice(&bytes).context("parse source JSON")?;
        let records = parsed
            .as_array()
            .cloned()
            .or_else(|| parsed.get("items").and_then(Value::as_array).cloned())
            .ok_or_else(|| {
                anyhow!("source must be a JSON array or a document with an items array")
            })?;
        if records.is_empty() || records.len() > MAX_RECORDS {
            bail!("source record limit exceeded");
        }
        Ok(records)
    }

    async fn execute(&self, job_id: Uuid) -> Result<()> {
        let lease = self.claim(job_id).await?;
        self.start(job_id, &lease).await?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let heartbeat = self.start_heartbeat(job_id, lease.clone(), cancelled.clone());
        let result = self.run_job(job_id, lease, cancelled.clone()).await;
        heartbeat.abort();
        if cancelled.load(Ordering::SeqCst) {
            bail!("lease heartbeat failed; execution cancelled");
        }
        result
    }

    async fn claim_next(&self) -> Result<Option<ClaimResponse>> {
        let (status, body) = self
            .call(
                Method::POST,
                "/internal/v1/pipeline-jobs/claim-next",
                Some(json!({
                    "workerId": self.worker_id,
                    "nodeId": self.node_id,
                    "instanceId": self.instance_id,
                    "bootId": self.boot_id,
                    "version": "0.0.3"
                })),
            )
            .await?;
        if status == StatusCode::NO_CONTENT {
            return Ok(None);
        }
        if !status.is_success() {
            bail!("claim-next failed ({status}): {body}");
        }
        Ok(Some(
            serde_json::from_value(body).context("parse claim-next response")?,
        ))
    }

    async fn run_auto(&self) -> Result<()> {
        loop {
            let claimed = tokio::select! {
                _ = tokio::signal::ctrl_c() => { eprintln!("worker graceful shutdown"); return Ok(()); }
                claimed = self.claim_next() => claimed,
            };
            match claimed {
                Ok(Some(lease)) => {
                    let job_id = lease.job_id;
                    if let Err(error) = self.start(job_id, &lease).await {
                        eprintln!("worker start failed for {job_id}: {error:#}");
                    } else {
                        let cancelled = Arc::new(AtomicBool::new(false));
                        let heartbeat =
                            self.start_heartbeat(job_id, lease.clone(), cancelled.clone());
                        let result = self.run_job(job_id, lease, cancelled.clone()).await;
                        heartbeat.abort();
                        if cancelled.load(Ordering::SeqCst) {
                            eprintln!("worker heartbeat failed; execution cancelled for {job_id}");
                        } else if let Err(error) = result {
                            eprintln!("worker execution failed for {job_id}: {error:#}");
                        }
                    }
                }
                Ok(None) => tokio::time::sleep(Duration::from_secs(2)).await,
                Err(error) => {
                    eprintln!("worker discovery failed: {error:#}");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
    }

    async fn run_job(
        &self,
        job_id: Uuid,
        lease: ClaimResponse,
        cancelled: Arc<AtomicBool>,
    ) -> Result<()> {
        let definition = self.definition(job_id).await?;
        let nodes = definition
            .definition
            .get("nodes")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("pipeline definition has no nodes"))?;
        let plan = &definition.plan;
        if plan.get("deterministic").and_then(Value::as_bool) != Some(true) {
            bail!("execution plan is not deterministic");
        }
        if let Some(expected) = plan.get("planDigest").and_then(Value::as_str) {
            if digest_without(plan, "planDigest") != expected {
                bail!("execution plan digest mismatch");
            }
        }
        let ordered = plan
            .get("orderedNodes")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("execution plan has no orderedNodes"))?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        let node_map: std::collections::BTreeMap<String, &Value> = nodes
            .iter()
            .filter_map(|node| {
                node.get("nodeId")
                    .and_then(Value::as_str)
                    .map(|id| (id.to_string(), node))
            })
            .collect();
        if ordered.len() != node_map.len() {
            bail!("execution plan node set does not match revision");
        }
        let source_endpoint = nodes
            .iter()
            .find(|node| {
                node.get("type").and_then(Value::as_str) == Some("builtin.source.http_json")
            })
            .and_then(|node| node.get("config"))
            .and_then(|config| config.get("endpoint"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("pinned revision has no HTTP source endpoint"))?;
        let snapshot = self.get_snapshot(job_id).await?;
        let (records, snapshot_digest) = if let Some(snapshot) = snapshot {
            let source = snapshot
                .get("source")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| anyhow!("pinned source snapshot is invalid"))?;
            let snapshot_digest = snapshot
                .get("sourceDigest")
                .or_else(|| snapshot.get("source_digest"))
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("pinned source snapshot digest missing"))?
                .to_string();
            (source, snapshot_digest)
        } else {
            let fetched = self.fetch_source(source_endpoint).await?;
            let saved = self.save_snapshot(job_id, &lease, &fetched, None).await?;
            let snapshot_digest = saved
                .get("sourceDigest")
                .or_else(|| saved.get("source_digest"))
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("snapshot save response has no digest"))?
                .to_string();
            (fetched, snapshot_digest)
        };
        let mut records = records;
        let mut sink_node: Option<&Value> = None;
        for node_id in &ordered {
            let node = node_map
                .get(node_id)
                .ok_or_else(|| anyhow!("execution plan references unknown node {node_id}"))?;
            let node_type = node.get("type").and_then(Value::as_str).unwrap_or_default();
            match node_type {
                "builtin.source.http_json" => {
                    if records.is_empty() {
                        bail!("pinned source snapshot is empty");
                    }
                    // Snapshot was loaded before executing the plan; Job input cannot override it.
                }
                "builtin.parse.json" => {
                    // Source already returns parsed JSON records; this node is typed as
                    // a bounded parse boundary and must not silently substitute fields.
                    if records.is_empty() {
                        bail!("parse node has no source records");
                    }
                }
                "builtin.map.fields" => {
                    records = apply_mapping(records, node.get("config").unwrap_or(&Value::Null))?;
                }
                "builtin.filter.predicate" => {
                    records = apply_filter(records, node.get("config").unwrap_or(&Value::Null))?;
                }
                "builtin.validate.schema" => {
                    validate_records(&records, node.get("config").unwrap_or(&Value::Null))?;
                }
                "builtin.sink.dataset" => {
                    sink_node = Some(node);
                    break;
                }
                other => bail!("unsupported execution node type {other}"),
            }
            if records.len() > MAX_RECORDS {
                bail!("record limit exceeded after node {node_id}");
            }
        }
        let sink = sink_node.ok_or_else(|| anyhow!("execution plan has no sink node"))?;
        let sink_node_id = sink.get("nodeId").and_then(Value::as_str).unwrap_or("sink");
        let dataset_id = sink
            .get("config")
            .and_then(|config| config.get("datasetId"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("sink dataset missing"))?;
        let schema_revision = sink
            .get("config")
            .and_then(|config| config.get("schemaRevision"))
            .and_then(Value::as_u64)
            .unwrap_or(1) as u32;
        let schema_digest_pin = sink
            .get("config")
            .and_then(|config| config.get("schemaDigest"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if records.is_empty() {
            bail!("no records after pipeline execution");
        }
        if std::env::var("OPSWEAVE_WORKER_CRASH_BEFORE_SINK")
            .ok()
            .as_deref()
            == Some("1")
        {
            eprintln!("worker crash injection before sink");
            std::process::exit(17);
        }
        self.heartbeat(job_id, &lease).await?;
        let mut token = self.workload_token().await?;
        let (schema_status, schema_body) = self
            .capability(
                &token,
                Method::GET,
                &format!("api/data-catalog/datasets/{dataset_id}/schemas"),
                None,
            )
            .await?;
        if !schema_status.is_success() {
            bail!("schema pin verification failed ({schema_status})");
        }
        let pinned_schema = schema_body
            .as_array()
            .and_then(|rows| {
                rows.iter().find(|row| {
                    row.get("schemaRevision").and_then(Value::as_u64)
                        == Some(schema_revision as u64)
                })
            })
            .ok_or_else(|| anyhow!("pinned schema revision does not exist"))?;
        if pinned_schema.get("status").and_then(Value::as_str) != Some("PUBLISHED") {
            bail!("pinned schema revision is not PUBLISHED");
        }
        if let Some(expected) = &schema_digest_pin {
            if pinned_schema.get("digest").and_then(Value::as_str) != Some(expected.as_str()) {
                bail!("pinned schema digest mismatch");
            }
        }
        let mut last_receipt = Value::Null;
        let mut accepted_total = 0usize;
        let batch_size = 500usize;
        let batch_count = records.len().div_ceil(batch_size);
        let mut effects: Vec<Value> = Vec::new();
        token = self.workload_token().await?;
        for (index, batch) in records.chunks(batch_size).enumerate() {
            let logical_batch = format!("batch-{}", index + 1);
            let effect = effect_id(
                &job_id,
                &definition.pipeline_id,
                definition.pipeline_revision,
                sink_node_id,
                &logical_batch,
            );
            if cancelled.load(Ordering::SeqCst) {
                bail!("execution cancelled: lease is no longer valid");
            }
            self.checkpoint(
                job_id,
                &lease,
                index + 1,
                records.len(),
                index,
                &snapshot_digest,
            )
            .await?;
            self.heartbeat(job_id, &lease).await?;
            token = self.workload_token().await?;
            let request_digest = digest(&json!({
                "effectId": effect,
                "pipelineId": definition.pipeline_id,
                "pipelineRevision": definition.pipeline_revision,
                "sinkNodeId": sink_node_id,
                "logicalBatchId": logical_batch,
                "schemaRevision": schema_revision,
                "sourceBatchKey": format!("job-{job_id}-{logical_batch}"),
                "records": batch
            }));
            let existing = self
                .capability(
                    &token,
                    Method::GET,
                    &format!(
                        "api/data-catalog/datasets/{dataset_id}/effect-receipts?effectId={effect}"
                    ),
                    None,
                )
                .await?;
            let receipt = if existing.0 == StatusCode::OK {
                let status = existing
                    .1
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if status == "UNKNOWN" {
                    bail!("effect {effect} is UNKNOWN; refusing blind retry");
                }
                if status != "COMMITTED" {
                    bail!("effect {effect} has non-committed state {status}");
                }
                let stored_digest = existing
                    .1
                    .get("requestDigest")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if stored_digest != request_digest {
                    bail!("EFFECT_DIGEST_CONFLICT: effect {effect} committed with a different source snapshot");
                }
                existing.1
            } else if matches!(existing.0, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
                bail!("receipt lookup authorization failed ({})", existing.0);
            } else if existing.0 == StatusCode::NOT_FOUND
                || existing.1.get("code").and_then(Value::as_str) == Some("RECEIPT_NOT_FOUND")
            {
                // A true absence is the only case that may create a new effect.
                let (status, body) = self
                    .capability(
                        &token,
                        Method::POST,
                        &format!("api/data-catalog/datasets/{dataset_id}/fenced-records"),
                        Some(json!({
                            "effectId": effect,
                            "requestDigest": request_digest,
                            "pipelineId": definition.pipeline_id,
                            "pipelineRevision": definition.pipeline_revision,
                            "sinkNodeId": sink_node_id,
                            "logicalBatchId": logical_batch,
                            "schemaRevision": schema_revision,
                            "sourceBatchKey": format!("job-{job_id}-{logical_batch}"),
                            "fence": {
                                "jobId": job_id,
                                "leaseId": lease.lease_id,
                                "fencingSequence": lease.fencing_sequence,
                                "pipelineId": definition.pipeline_id,
                                "pipelineRevision": definition.pipeline_revision
                            },
                            "records": batch
                        })),
                    )
                    .await?;
                if !status.is_success() {
                    bail!("fenced sink failed ({status}): {body}");
                }
                body
            } else {
                bail!("receipt lookup unavailable ({})", existing.0);
            };
            if receipt.get("status").and_then(Value::as_str) != Some("COMMITTED") {
                bail!("batch receipt is not COMMITTED");
            }
            let accepted = receipt.get("accepted").and_then(Value::as_u64);
            let rejected = receipt.get("rejected").and_then(Value::as_u64).unwrap_or(1);
            let unknown = receipt.get("unknown").and_then(Value::as_u64).unwrap_or(1);
            if accepted != Some(batch.len() as u64) || rejected != 0 || unknown != 0 {
                bail!("batch receipt does not prove all records were committed");
            }
            accepted_total += batch.len();
            last_receipt = receipt;
            if let Ok(value) = std::env::var("OPSWEAVE_WORKER_BATCH_DELAY_MS") {
                if let Ok(milliseconds) = value.parse::<u64>() {
                    tokio::time::sleep(Duration::from_millis(milliseconds.min(30000))).await;
                }
            }
            if std::env::var("OPSWEAVE_WORKER_CRASH_AFTER_BATCH")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                == Some(index + 1)
            {
                eprintln!("worker crash injection after batch {}", index + 1);
                std::process::exit(18);
            }
        }
        for (index, batch) in records.chunks(batch_size).enumerate() {
            let logical_batch = format!("batch-{}", index + 1);
            let effect = effect_id(
                &job_id,
                &definition.pipeline_id,
                definition.pipeline_revision,
                sink_node_id,
                &logical_batch,
            );
            let (status, body) = self
                .capability(
                    &token,
                    Method::GET,
                    &format!(
                        "api/data-catalog/datasets/{dataset_id}/effect-receipts?effectId={effect}"
                    ),
                    None,
                )
                .await?;
            if status != StatusCode::OK
                || body.get("status").and_then(Value::as_str) != Some("COMMITTED")
            {
                bail!("effect {effect} is not committed; refusing SUCCEEDED");
            }
            let expected = digest(&json!({
                "effectId": effect,
                "pipelineId": definition.pipeline_id,
                "pipelineRevision": definition.pipeline_revision,
                "sinkNodeId": sink_node_id,
                "logicalBatchId": logical_batch,
                "schemaRevision": schema_revision,
                "sourceBatchKey": format!("job-{job_id}-{logical_batch}"),
                "records": batch
            }));
            if body.get("requestDigest").and_then(Value::as_str) != Some(expected.as_str()) {
                bail!("effect {effect} digest mismatch during completion verification");
            }
            effects.push(json!({
                "effectId": effect,
                "requestDigest": expected,
                "status": "COMMITTED"
            }));
        }
        if std::env::var("OPSWEAVE_WORKER_CRASH_AFTER_SINK")
            .ok()
            .as_deref()
            == Some("1")
        {
            eprintln!("worker crash injection after sink");
            std::process::exit(18);
        }
        let result_digest = digest(&json!({
            "effectId": effect_id(&job_id, &definition.pipeline_id, definition.pipeline_revision, sink_node_id, "result"),
            "batches": batch_count,
            "accepted": accepted_total,
            "receipt": last_receipt
        }));
        let (status, body) = self
            .call(
                Method::POST,
                &format!("/internal/v1/pipeline-jobs/{job_id}/result"),
                Some(json!({
                    "leaseId": lease.lease_id,
                    "fencingSequence": lease.fencing_sequence,
                    "status": "SUCCEEDED",
                    "output": {"accepted": accepted_total, "batches": batch_count},
                    "resultDigest": result_digest,
                    "receipt": last_receipt,
                    "effects": effects
                })),
            )
            .await?;
        if !status.is_success() {
            bail!("result submission failed ({status}): {body}");
        }
        println!(
            "pipeline worker completed job {job_id} batches {batch_count} accepted {accepted_total}"
        );
        Ok(())
    }
}

fn digest_without(value: &Value, field: &str) -> String {
    let mut copy = value.clone();
    if let Some(object) = copy.as_object_mut() {
        object.remove(field);
    }
    digest(&copy)
}

fn apply_mapping(records: Vec<Value>, config: &Value) -> Result<Vec<Value>> {
    let mappings = config.get("mappings").and_then(Value::as_object);
    let Some(mappings) = mappings else {
        return records
            .into_iter()
            .map(|record| {
                let id = record
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("record id missing"))?;
                let name = record
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("record name missing"))?;
                Ok(json!({"id": id, "name": name}))
            })
            .collect();
    };
    records
        .into_iter()
        .map(|record| {
            let mut output = serde_json::Map::new();
            for (target, source) in mappings {
                let path = source
                    .as_str()
                    .ok_or_else(|| anyhow!("mapping source must be a string"))?;
                let value = path
                    .split('.')
                    .try_fold(&record, |current, segment| current.get(segment))
                    .cloned()
                    .ok_or_else(|| anyhow!("mapping source {path} is missing"))?;
                output.insert(target.clone(), value);
            }
            Ok(Value::Object(output))
        })
        .collect()
}

fn apply_filter(records: Vec<Value>, config: &Value) -> Result<Vec<Value>> {
    let Some(field) = config.get("field").and_then(Value::as_str) else {
        return Ok(records);
    };
    let op = config.get("op").and_then(Value::as_str).unwrap_or("eq");
    let expected = config.get("value").cloned().unwrap_or(Value::Null);
    records
        .into_iter()
        .filter(|record| {
            let actual = record.get(field).unwrap_or(&Value::Null);
            match op {
                "eq" => actual == &expected,
                "ne" => actual != &expected,
                "gt" => actual
                    .as_f64()
                    .zip(expected.as_f64())
                    .is_some_and(|(a, b)| a > b),
                "lt" => actual
                    .as_f64()
                    .zip(expected.as_f64())
                    .is_some_and(|(a, b)| a < b),
                "exists" => !actual.is_null(),
                _ => false,
            }
        })
        .collect::<Vec<_>>()
        .pipe(Ok)
}

fn validate_records(records: &[Value], config: &Value) -> Result<()> {
    let required = config
        .get("required")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![Value::from("id"), Value::from("name")]);
    for record in records {
        if !record.is_object() {
            bail!("validated record is not an object");
        }
        for field in &required {
            let field = field
                .as_str()
                .ok_or_else(|| anyhow!("required field must be a string"))?;
            if record.get(field).is_none_or(|value| value.is_null()) {
                bail!("required field {field} is missing");
            }
        }
    }
    Ok(())
}

trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_default(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort();
            let fields: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(&values[key])
                    )
                })
                .collect();
            format!("{{{}}}", fields.join(","))
        }
    }
}

fn digest(value: &Value) -> String {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(canonical_json(value).as_bytes()))
    )
}

fn effect_id(
    job_id: &Uuid,
    pipeline_id: &str,
    revision: u32,
    sink_node_id: &str,
    logical_batch: &str,
) -> String {
    let value = json!({
        "jobId": job_id,
        "pipelineId": pipeline_id,
        "pipelineRevision": revision,
        "sinkNodeId": sink_node_id,
        "logicalBatchId": logical_batch
    });
    format!(
        "efx:{}",
        hex::encode(Sha256::digest(canonical_json(&value).as_bytes()))
    )
}

#[derive(Debug, Default)]
struct SourcePolicy {
    allowlist: Vec<String>,
}

impl SourcePolicy {
    fn from_env() -> Self {
        let allowlist = std::env::var("OPSWEAVE_WORKER_SOURCE_ALLOWLIST")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_lowercase)
            .collect();
        Self { allowlist }
    }

    fn allowed(&self, value: &str) -> bool {
        let value = value.trim_matches(['[', ']']).to_ascii_lowercase();
        self.allowlist.iter().any(|entry| entry == &value)
    }

    fn check_ip(&self, ip: IpAddr, host: &str) -> Result<()> {
        if self.allowed(host) || self.allowed(&ip.to_string()) {
            return Ok(());
        }
        if is_public_ip(ip) {
            Ok(())
        } else {
            bail!("source address is not public")
        }
    }

    async fn validate_url(&self, endpoint: &str) -> Result<reqwest::Url> {
        let url = reqwest::Url::parse(endpoint).context("invalid source URL")?;
        if !matches!(url.scheme(), "http" | "https") {
            bail!("source scheme must be http or https");
        }
        if !url.username().is_empty() || url.password().is_some() {
            bail!("source URL must not contain credentials");
        }
        if url.fragment().is_some() {
            bail!("source URL must not contain a fragment");
        }
        let host = url
            .host_str()
            .ok_or_else(|| anyhow!("source URL has no host"))?
            .trim_matches(['[', ']']);
        if (host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost"))
            && !self.allowed(host)
        {
            bail!("source host is local");
        }
        if let Ok(ip) = host.parse::<IpAddr>() {
            self.check_ip(ip, host)?;
        }
        Ok(url)
    }
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let value = u32::from(ip);
    let first = (value >> 24) as u8;
    let second = (value >> 16) as u8;
    !(first == 0
        || first == 10
        || first == 127
        || (first == 100 && (64..=127).contains(&second))
        || (first == 169 && second == 254)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 0)
        || (first == 192 && second == 168)
        || (first == 198 && (18..=19).contains(&second))
        || (first == 198 && second == 51 && (value >> 8 & 0xff) == 100)
        || (first == 203 && second == 0 && (value >> 8 & 0xff) == 113)
        || first >= 224)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        return false;
    }
    if (segments[0] & 0xfe00) == 0xfc00 || (segments[0] & 0xffc0) == 0xfe80 {
        return false;
    }
    if (segments[0] & 0xffc0) == 0xfec0 || (segments[0] == 0x2001 && segments[1] == 0x0db8) {
        return false;
    }
    if segments[0] == 0
        && segments[1] == 0
        && segments[2] == 0
        && segments[3] == 0
        && segments[4] == 0
        && segments[5] == 0xffff
    {
        let v4 = Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            (segments[6] & 0xff) as u8,
            (segments[7] >> 8) as u8,
            (segments[7] & 0xff) as u8,
        );
        return is_public_v4(v4);
    }
    if segments[0..6].iter().all(|segment| *segment == 0) {
        return false;
    }
    true
}

#[tokio::main]
async fn main() -> Result<()> {
    let worker = Worker::new().await?;
    if let Ok(value) = std::env::var("OPSWEAVE_WORKER_JOB_ID") {
        let job_id: Uuid = value.parse().context("parse job id")?;
        let _ = Utc::now();
        worker.execute(job_id).await
    } else {
        worker.run_auto().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_metadata_addresses_are_blocked() {
        for value in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
        ] {
            assert!(
                !is_public_ip(value.parse().unwrap()),
                "{value} should be blocked"
            );
        }
    }

    #[test]
    fn public_addresses_are_allowed() {
        for value in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(
                is_public_ip(value.parse().unwrap()),
                "{value} should be public"
            );
        }
    }

    #[tokio::test]
    async fn source_url_rejects_localhost_and_non_http_scheme() {
        let policy = SourcePolicy::default();
        assert!(policy.validate_url("http://127.0.0.1/data").await.is_err());
        assert!(policy.validate_url("file:///etc/passwd").await.is_err());
        assert!(policy
            .validate_url("http://169.254.169.254/latest/meta-data")
            .await
            .is_err());
        assert!(policy.validate_url("http://[::1]/").await.is_err());
        assert!(policy
            .validate_url("http://user:pass@example.com/")
            .await
            .is_err());
    }
}
