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
use std::time::Duration;
use uuid::Uuid;

const MAX_SOURCE_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECORDS: usize = 10_000;
const EFFECT_BATCH: &str = "batch-host-metrics-0001";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeIdentity {
    node_id: Uuid,
    credential: String,
    generation: i64,
}

#[derive(Debug)]
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimResponse {
    lease_id: Uuid,
    fencing_sequence: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DefinitionResponse {
    pipeline_id: String,
    pipeline_revision: u32,
    input: Value,
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

    async fn checkpoint(&self, job_id: Uuid, lease: &ClaimResponse, records: usize) -> Result<()> {
        let digest = format!(
            "sha256:{}",
            hex::encode(Sha256::digest(json!({"records": records}).to_string()))
        );
        let (status, body) = self
            .call(
                Method::POST,
                &format!("/internal/v1/pipeline-jobs/{job_id}/checkpoint"),
                Some(json!({
                    "leaseId": lease.lease_id,
                    "fencingSequence": lease.fencing_sequence,
                    "sequence": 1,
                    "inputCursor": "batch:0",
                    "stateDigest": digest,
                    "state": {"records": records}
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
            "capabilityName": "data.catalog",
            "capabilityMajor": 1,
            "audience": "plugin:data.catalog",
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
            "{}/api/v1/capabilities/data.catalog/1/{}",
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

    async fn execute(&self, job_id: Uuid) -> Result<()> {
        let lease = self.claim(job_id).await?;
        self.start(job_id, &lease).await?;
        let definition = self.definition(job_id).await?;
        let source = definition
            .input
            .get("source")
            .and_then(Value::as_str)
            .or_else(|| {
                definition
                    .definition
                    .get("nodes")
                    .and_then(Value::as_array)
                    .and_then(|nodes| {
                        nodes.iter().find(|node| {
                            node.get("type").and_then(Value::as_str)
                                == Some("builtin.source.http_json")
                        })
                    })
                    .and_then(|node| node.get("config"))
                    .and_then(|config| config.get("endpoint"))
                    .and_then(Value::as_str)
            })
            .ok_or_else(|| anyhow!("job has no HTTP source"))?
            .to_string();
        let response = self
            .client
            .get(&source)
            .send()
            .await
            .context("source request")?;
        if !response.status().is_success() {
            bail!("source returned {}", response.status());
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_SOURCE_BYTES as u64)
        {
            bail!("source body exceeds limit");
        }
        let bytes = response.bytes().await.context("read source")?;
        if bytes.len() > MAX_SOURCE_BYTES {
            bail!("source body exceeds limit");
        }
        let parsed: Value = serde_json::from_slice(&bytes).context("parse source JSON")?;
        let raw_records = parsed
            .as_array()
            .cloned()
            .or_else(|| parsed.get("items").and_then(Value::as_array).cloned())
            .ok_or_else(|| {
                anyhow!("source must be a JSON array or a document with an items array")
            })?;
        if raw_records.is_empty() || raw_records.len() > MAX_RECORDS {
            bail!("record limit exceeded");
        }
        let records: Vec<Value> = raw_records
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
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .filter(|record| {
                record
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| !id.is_empty())
            })
            .collect();
        if records.is_empty() {
            bail!("no records after parse/filter");
        }
        self.heartbeat(job_id, &lease).await?;
        self.checkpoint(job_id, &lease, records.len()).await?;
        if std::env::var("OPSWEAVE_WORKER_CRASH_BEFORE_SINK")
            .ok()
            .as_deref()
            == Some("1")
        {
            eprintln!("worker crash injection before sink");
            std::process::exit(17);
        }
        let sink = definition
            .definition
            .get("nodes")
            .and_then(Value::as_array)
            .and_then(|nodes| {
                nodes.iter().find(|node| {
                    node.get("type").and_then(Value::as_str) == Some("builtin.sink.dataset")
                })
            })
            .ok_or_else(|| anyhow!("pipeline has no sink"))?;
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
        let effect_id = effect_id(
            &job_id,
            &definition.pipeline_id,
            definition.pipeline_revision,
            sink_node_id,
            EFFECT_BATCH,
        );
        let token = self.workload_token().await?;
        let existing = self
            .capability(
                &token,
                Method::GET,
                &format!(
                    "api/data-catalog/datasets/{dataset_id}/effect-receipts?effectId={effect_id}"
                ),
                None,
            )
            .await?;
        let receipt = if existing.0 == StatusCode::OK
            && existing.1.get("status").and_then(Value::as_str) == Some("COMMITTED")
        {
            existing.1
        } else {
            let request_digest = digest(&json!({
                "effectId": effect_id,
                "pipelineId": definition.pipeline_id,
                "pipelineRevision": definition.pipeline_revision,
                "sinkNodeId": sink_node_id,
                "logicalBatchId": EFFECT_BATCH,
                "schemaRevision": schema_revision,
                "sourceBatchKey": format!("job-{job_id}-effect"),
                "records": records
            }));
            let (status, body) = self
                .capability(
                    &token,
                    Method::POST,
                    &format!("api/data-catalog/datasets/{dataset_id}/fenced-records"),
                    Some(json!({
                        "effectId": effect_id,
                        "requestDigest": request_digest,
                        "pipelineId": definition.pipeline_id,
                        "pipelineRevision": definition.pipeline_revision,
                        "sinkNodeId": sink_node_id,
                        "logicalBatchId": EFFECT_BATCH,
                        "schemaRevision": schema_revision,
                        "sourceBatchKey": format!("job-{job_id}-effect"),
                        "fence": {
                            "jobId": job_id,
                            "leaseId": lease.lease_id,
                            "fencingSequence": lease.fencing_sequence,
                            "pipelineId": definition.pipeline_id,
                            "pipelineRevision": definition.pipeline_revision
                        },
                        "records": records
                    })),
                )
                .await?;
            if !status.is_success() {
                bail!("fenced sink failed ({status}): {body}");
            }
            body
        };
        if std::env::var("OPSWEAVE_WORKER_CRASH_AFTER_SINK")
            .ok()
            .as_deref()
            == Some("1")
        {
            eprintln!("worker crash injection after sink");
            std::process::exit(18);
        }
        let result_digest = digest(&json!({"effectId": effect_id, "receipt": receipt}));
        let (status, body) = self
            .call(
                Method::POST,
                &format!("/internal/v1/pipeline-jobs/{job_id}/result"),
                Some(json!({
                    "leaseId": lease.lease_id,
                    "fencingSequence": lease.fencing_sequence,
                    "status": "SUCCEEDED",
                    "output": {"accepted": receipt.get("accepted"), "effectId": effect_id},
                    "resultDigest": result_digest,
                    "receipt": receipt
                })),
            )
            .await?;
        if !status.is_success() {
            bail!("result submission failed ({status}): {body}");
        }
        println!("pipeline worker completed job {job_id} effect {effect_id}");
        Ok(())
    }
}

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

#[tokio::main]
async fn main() -> Result<()> {
    let worker = Worker::new().await?;
    let job_id: Uuid = env("OPSWEAVE_WORKER_JOB_ID")?
        .parse()
        .context("parse job id")?;
    let _ = Utc::now();
    worker.execute(job_id).await
}
