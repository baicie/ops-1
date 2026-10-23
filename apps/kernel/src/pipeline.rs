//! Pure typed-pipeline validation and planning.
//!
//! The registry is a signed artifact; the pipeline author never supplies the
//! executable port signature. This module performs no I/O and no job mutation,
//! which makes the static contract independently testable.

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

pub const PIPELINE_SCHEMA: &str = "pipeline.opsweave.io/v1";
pub const REGISTRY_SCHEMA: &str = "pipeline-registry.opsweave.io/v1";
pub const MAX_NODES: usize = 64;
pub const MAX_EDGES: usize = 128;
pub const MAX_RECORDS: usize = 10_000;
#[allow(dead_code)]
pub const MAX_CHECKPOINT_BYTES: usize = 1024 * 1024;

const REGISTRY_JSON: &str = include_str!("../../../contracts/examples/node-registry.json");
const REGISTRY_KEYS_JSON: &str =
    include_str!("../../../contracts/examples/trusted-registry-keys.json");
const SCHEMA_CATALOG_JSON: &str = include_str!("../../../contracts/examples/schema-catalog.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputPort {
    pub name: String,
    pub data_type: String,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_revision: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputPort {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_revision: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineNode {
    pub node_id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub type_version: u32,
    pub inputs: Vec<InputPort>,
    pub outputs: Vec<OutputPort>,
    pub config: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TypedEdge {
    pub from_node: String,
    pub from_port: String,
    pub to_node: String,
    pub to_port: String,
    pub data_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineDefinition {
    pub schema_version: String,
    pub pipeline_id: String,
    pub name: String,
    pub revision: u32,
    pub status: String,
    pub nodes: Vec<PipelineNode>,
    pub edges: Vec<TypedEdge>,
    pub created_at: String,
    pub digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySignature {
    pub algorithm: String,
    pub key_id: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRegistryEntry {
    #[serde(rename = "type")]
    pub node_type: String,
    pub type_version: u32,
    pub inputs: Vec<InputPort>,
    pub outputs: Vec<OutputPort>,
    pub execution: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_input_records: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_records: Option<u32>,
    pub config_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeRegistry {
    pub schema_version: String,
    pub registry_digest: String,
    pub signature: RegistrySignature,
    pub entries: Vec<NodeRegistryEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedRegistryKey {
    pub key_id: String,
    pub algorithm: String,
    pub public_key_hex: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustedRegistryKeys {
    pub keys: Vec<TrustedRegistryKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaField {
    pub name: String,
    #[serde(rename = "type")]
    pub field_type: String,
    pub nullable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaRevision {
    pub schema_revision: u32,
    pub status: String,
    pub digest: String,
    pub fields: Vec<SchemaField>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDataset {
    pub dataset_id: String,
    pub latest_published_revision: u32,
    pub revisions: Vec<SchemaRevision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCatalog {
    pub catalog_version: String,
    pub datasets: Vec<SchemaDataset>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub code: String,
    pub message: String,
    pub node_id: Option<String>,
    pub port: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationResult {
    pub valid: bool,
    pub errors: Vec<ValidationIssue>,
    pub warnings: Vec<ValidationIssue>,
    pub canonical_order: Vec<String>,
    pub plan_digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineExecutionPlan {
    pub pipeline_id: String,
    pub revision: u32,
    pub digest: String,
    pub ordered_nodes: Vec<String>,
    pub edges: Vec<TypedEdge>,
    pub max_records: usize,
    pub max_bytes: usize,
    pub deterministic: bool,
    pub plan_digest: String,
}

#[derive(Debug, Clone)]
pub struct PipelineError {
    pub code: String,
    pub message: String,
}

impl PipelineError {
    fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for PipelineError {}

pub fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "null".to_string()),
        Value::Array(values) => {
            let items: Vec<String> = values.iter().map(canonical_json).collect();
            format!("[{}]", items.join(","))
        }
        Value::Object(values) => {
            let mut keys: Vec<&String> = values.keys().collect();
            keys.sort();
            let fields: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                        canonical_json(&values[key])
                    )
                })
                .collect();
            format!("{{{}}}", fields.join(","))
        }
    }
}

pub fn digest_value(value: &Value) -> String {
    format!(
        "sha256:{}",
        hex::encode(Sha256::digest(canonical_json(value).as_bytes()))
    )
}

pub fn digest_without_field(value: &Value, field: &str) -> String {
    let mut copy = value.clone();
    if let Value::Object(map) = &mut copy {
        map.remove(field);
    }
    digest_value(&copy)
}

#[allow(dead_code)]
pub fn effect_id(
    job_id: &str,
    pipeline_id: &str,
    revision: u32,
    sink_node_id: &str,
    logical_batch_id: &str,
) -> String {
    let payload = serde_json::json!({
        "jobId": job_id,
        "pipelineId": pipeline_id,
        "pipelineRevision": revision,
        "sinkNodeId": sink_node_id,
        "logicalBatchId": logical_batch_id
    });
    format!(
        "efx:{}",
        hex::encode(Sha256::digest(canonical_json(&payload).as_bytes()))
    )
}

fn signing_document(registry: &NodeRegistry) -> Value {
    serde_json::json!({
        "schemaVersion": registry.schema_version,
        "registryDigest": registry.registry_digest,
        "entries": registry.entries,
    })
}

fn verify_registry_signature(
    registry: &NodeRegistry,
    keys: &TrustedRegistryKeys,
) -> Result<(), PipelineError> {
    let key = keys
        .keys
        .iter()
        .find(|key| key.key_id == registry.signature.key_id)
        .ok_or_else(|| PipelineError::new("UNKNOWN_REGISTRY_KEY", "registry key is not trusted"))?;
    if key.algorithm != "ed25519" || registry.signature.algorithm != "ed25519" {
        return Err(PipelineError::new(
            "REGISTRY_SIGNATURE_INVALID",
            "unsupported registry signature algorithm",
        ));
    }
    let public_key: [u8; 32] = hex::decode(&key.public_key_hex)
        .map_err(|_| {
            PipelineError::new("REGISTRY_SIGNATURE_INVALID", "invalid trusted public key")
        })?
        .try_into()
        .map_err(|_| {
            PipelineError::new(
                "REGISTRY_SIGNATURE_INVALID",
                "invalid trusted public key length",
            )
        })?;
    let verifying_key = VerifyingKey::from_bytes(&public_key).map_err(|_| {
        PipelineError::new("REGISTRY_SIGNATURE_INVALID", "invalid Ed25519 public key")
    })?;
    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(&registry.signature.value)
        .map_err(|_| {
            PipelineError::new("REGISTRY_SIGNATURE_INVALID", "invalid signature encoding")
        })?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| PipelineError::new("REGISTRY_SIGNATURE_INVALID", "invalid signature"))?;
    verifying_key
        .verify_strict(
            canonical_json(&signing_document(registry)).as_bytes(),
            &signature,
        )
        .map_err(|_| {
            PipelineError::new(
                "REGISTRY_SIGNATURE_INVALID",
                "registry signature verification failed",
            )
        })
}

pub fn trusted_registry() -> Result<(NodeRegistry, TrustedRegistryKeys), PipelineError> {
    let registry: NodeRegistry = serde_json::from_str(REGISTRY_JSON)
        .map_err(|error| PipelineError::new("REGISTRY_INVALID", error.to_string()))?;
    if registry.schema_version != REGISTRY_SCHEMA {
        return Err(PipelineError::new(
            "REGISTRY_INVALID",
            "unsupported registry schema version",
        ));
    }
    let keys: TrustedRegistryKeys = serde_json::from_str(REGISTRY_KEYS_JSON)
        .map_err(|error| PipelineError::new("REGISTRY_INVALID", error.to_string()))?;
    let registry_value = serde_json::to_value(&registry.entries)
        .map_err(|error| PipelineError::new("REGISTRY_INVALID", error.to_string()))?;
    if digest_value(&registry_value) != registry.registry_digest {
        return Err(PipelineError::new(
            "REGISTRY_DIGEST_MISMATCH",
            "registry digest mismatch",
        ));
    }
    verify_registry_signature(&registry, &keys)?;
    Ok((registry, keys))
}

pub fn schema_catalog() -> Result<SchemaCatalog, PipelineError> {
    serde_json::from_str(SCHEMA_CATALOG_JSON)
        .map_err(|error| PipelineError::new("SCHEMA_CATALOG_INVALID", error.to_string()))
}

fn validate_config_schema(schema: &Value, config: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    validate_schema_node(schema, config, "$", &mut errors);
    errors
}

fn validate_schema_node(schema: &Value, value: &Value, path: &str, errors: &mut Vec<String>) {
    let Some(object) = schema.as_object() else {
        return;
    };
    if let Some(enum_values) = object.get("enum").and_then(Value::as_array) {
        if !enum_values.iter().any(|candidate| candidate == value) {
            errors.push(format!("{path} is not in enum"));
        }
    }
    if let Some(expected) = object.get("type").and_then(Value::as_str) {
        let matches = match expected {
            "object" => value.is_object(),
            "array" => value.is_array(),
            "string" => value.is_string(),
            "integer" => value.is_i64() || value.is_u64(),
            "number" => value.is_number(),
            "boolean" => value.is_boolean(),
            "null" => value.is_null(),
            _ => true,
        };
        if !matches {
            errors.push(format!("{path} must be {expected}"));
            return;
        }
    }
    if let Some(required) = object.get("required").and_then(Value::as_array) {
        if let Some(map) = value.as_object() {
            for field in required.iter().filter_map(Value::as_str) {
                if !map.contains_key(field) {
                    errors.push(format!("{path}.{field} is required"));
                }
            }
        }
    }
    if let Some(properties) = object.get("properties").and_then(Value::as_object) {
        if let Some(map) = value.as_object() {
            for (field, subschema) in properties {
                if let Some(field_value) = map.get(field) {
                    validate_schema_node(
                        subschema,
                        field_value,
                        &format!("{path}.{field}"),
                        errors,
                    );
                }
            }
            if object.get("additionalProperties").and_then(Value::as_bool) == Some(false) {
                for field in map.keys() {
                    if !properties.contains_key(field) {
                        errors.push(format!("{path}.{field} is not allowed"));
                    }
                }
            }
        }
    }
    if let Some(text) = value.as_str() {
        if let Some(min) = object.get("minLength").and_then(Value::as_u64) {
            if text.chars().count() < min as usize {
                errors.push(format!("{path} is shorter than {min}"));
            }
        }
        if let Some(max) = object.get("maxLength").and_then(Value::as_u64) {
            if text.chars().count() > max as usize {
                errors.push(format!("{path} is longer than {max}"));
            }
        }
        if let Some(pattern) = object.get("pattern").and_then(Value::as_str) {
            if let Ok(regex) = Regex::new(pattern) {
                if !regex.is_match(text) {
                    errors.push(format!("{path} does not match pattern"));
                }
            }
        }
        if object.get("format").and_then(Value::as_str) == Some("uri")
            && url::Url::parse(text).is_err()
        {
            errors.push(format!("{path} is not a URI"));
        }
    }
    if let Some(number) = value.as_i64() {
        if let Some(min) = object.get("minimum").and_then(Value::as_i64) {
            if number < min {
                errors.push(format!("{path} is less than {min}"));
            }
        }
        if let Some(max) = object.get("maximum").and_then(Value::as_i64) {
            if number > max {
                errors.push(format!("{path} is greater than {max}"));
            }
        }
    }
}

fn port_signature_inputs(ports: &[InputPort]) -> Vec<(String, String, bool, Option<u32>)> {
    let mut signature: Vec<_> = ports
        .iter()
        .map(|port| {
            (
                port.name.clone(),
                port.data_type.clone(),
                port.required,
                port.schema_revision,
            )
        })
        .collect();
    signature.sort();
    signature
}

fn port_signature_outputs(ports: &[OutputPort]) -> Vec<(String, String, bool, Option<u32>)> {
    let mut signature: Vec<_> = ports
        .iter()
        .map(|port| {
            (
                port.name.clone(),
                port.data_type.clone(),
                port.nullable,
                port.schema_revision,
            )
        })
        .collect();
    signature.sort();
    signature
}

pub fn topological_order(
    nodes: &[PipelineNode],
    edges: &[TypedEdge],
) -> Result<Vec<String>, PipelineError> {
    let node_ids: BTreeSet<String> = nodes.iter().map(|node| node.node_id.clone()).collect();
    let mut indegree: BTreeMap<String, usize> = node_ids.iter().map(|id| (id.clone(), 0)).collect();
    let mut outgoing: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in edges {
        if !node_ids.contains(&edge.from_node) || !node_ids.contains(&edge.to_node) {
            return Err(PipelineError::new(
                "EDGE_ENDPOINT_UNKNOWN",
                "edge endpoint is unknown",
            ));
        }
        outgoing
            .entry(edge.from_node.clone())
            .or_default()
            .push(edge.to_node.clone());
        *indegree.entry(edge.to_node.clone()).or_default() += 1;
    }
    let mut ready: VecDeque<String> = indegree
        .iter()
        .filter(|(_, count)| **count == 0)
        .map(|(id, _)| id.clone())
        .collect();
    let mut ordered = Vec::new();
    while let Some(current) = ready.pop_front() {
        ordered.push(current.clone());
        if let Some(targets) = outgoing.get(&current) {
            let mut targets = targets.clone();
            targets.sort();
            for target in targets {
                if let Some(count) = indegree.get_mut(&target) {
                    *count = count.saturating_sub(1);
                    if *count == 0 {
                        ready.push_back(target);
                    }
                }
            }
            let mut ready_sorted: Vec<_> = ready.drain(..).collect();
            ready_sorted.sort();
            ready.extend(ready_sorted);
        }
    }
    if ordered.len() != node_ids.len() {
        return Err(PipelineError::new("CYCLE", "pipeline contains a cycle"));
    }
    Ok(ordered)
}

pub fn validate_pipeline(
    definition: &PipelineDefinition,
    registry: &NodeRegistry,
    catalog: &SchemaCatalog,
) -> Result<PipelineExecutionPlan, PipelineError> {
    let definition_value = serde_json::to_value(definition)
        .map_err(|error| PipelineError::new("PIPELINE_INVALID", error.to_string()))?;
    if definition.schema_version != PIPELINE_SCHEMA {
        return Err(PipelineError::new(
            "PIPELINE_VERSION_UNSUPPORTED",
            "unsupported pipeline schema version",
        ));
    }
    if definition.nodes.is_empty() || definition.nodes.len() > MAX_NODES {
        return Err(PipelineError::new(
            "NODE_LIMIT",
            "pipeline node limit exceeded",
        ));
    }
    if definition.edges.len() > MAX_EDGES {
        return Err(PipelineError::new(
            "EDGE_LIMIT",
            "pipeline edge limit exceeded",
        ));
    }
    if definition.digest != digest_without_field(&definition_value, "digest") {
        return Err(PipelineError::new(
            "PIPELINE_DIGEST_MISMATCH",
            "pipeline digest mismatch",
        ));
    }
    let registry_entries: BTreeMap<(String, u32), &NodeRegistryEntry> = registry
        .entries
        .iter()
        .map(|entry| ((entry.node_type.clone(), entry.type_version), entry))
        .collect();
    let mut nodes = BTreeMap::new();
    for node in &definition.nodes {
        if nodes.insert(node.node_id.clone(), node).is_some() {
            return Err(PipelineError::new("DUPLICATE_NODE", "duplicate node id"));
        }
        let entry = registry_entries
            .get(&(node.node_type.clone(), node.type_version))
            .ok_or_else(|| {
                PipelineError::new(
                    "UNKNOWN_NODE_TYPE",
                    format!("unknown node type {}", node.node_type),
                )
            })?;
        if port_signature_inputs(&node.inputs) != port_signature_inputs(&entry.inputs) {
            return Err(PipelineError::new(
                "PORT_SIGNATURE_MISMATCH",
                "input port signature does not match trusted registry",
            ));
        }
        if port_signature_outputs(&node.outputs) != port_signature_outputs(&entry.outputs) {
            return Err(PipelineError::new(
                "PORT_SIGNATURE_MISMATCH",
                "output port signature does not match trusted registry",
            ));
        }
        let config_errors = validate_config_schema(&entry.config_schema, &node.config);
        if !config_errors.is_empty() {
            return Err(PipelineError::new(
                "CONFIG_INVALID",
                config_errors.join("; "),
            ));
        }
        if node.node_type == "builtin.sink.dataset" {
            let dataset_id = node
                .config
                .get("datasetId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let revision = node
                .config
                .get("schemaRevision")
                .and_then(Value::as_u64)
                .unwrap_or(0) as u32;
            let dataset = catalog
                .datasets
                .iter()
                .find(|dataset| dataset.dataset_id == dataset_id)
                .ok_or_else(|| {
                    PipelineError::new(
                        "SCHEMA_REVISION_NOT_FOUND",
                        "dataset schema is not in the trusted catalog",
                    )
                })?;
            let schema = dataset
                .revisions
                .iter()
                .find(|schema| schema.schema_revision == revision)
                .ok_or_else(|| {
                    PipelineError::new(
                        "SCHEMA_REVISION_NOT_FOUND",
                        "schema revision is not published",
                    )
                })?;
            if schema.status != "PUBLISHED" || revision > dataset.latest_published_revision {
                return Err(PipelineError::new(
                    "SCHEMA_NOT_PUBLISHED",
                    "schema revision is not published",
                ));
            }
        }
    }
    let ordered_nodes = topological_order(&definition.nodes, &definition.edges)?;
    // 0.0.3 runtime is deliberately a single-source/single-sink linear pipeline.
    let sources: Vec<&PipelineNode> = definition
        .nodes
        .iter()
        .filter(|node| node.inputs.is_empty())
        .collect();
    let sinks: Vec<&PipelineNode> = definition
        .nodes
        .iter()
        .filter(|node| node.outputs.is_empty())
        .collect();
    if sources.len() != 1 || sinks.len() != 1 {
        return Err(PipelineError::new(
            "TOPOLOGY_NOT_SUPPORTED",
            "0.0.3 requires exactly one source and one sink",
        ));
    }
    if definition.edges.len() != definition.nodes.len().saturating_sub(1) {
        return Err(PipelineError::new(
            "TOPOLOGY_NOT_SUPPORTED",
            "0.0.3 requires a linear edge count (nodes - 1)",
        ));
    }
    for node in &definition.nodes {
        if !node.inputs.is_empty() && node.inputs.len() != 1 {
            return Err(PipelineError::new(
                "TOPOLOGY_NOT_SUPPORTED",
                "0.0.3 nodes must have exactly one input except the source",
            ));
        }
        if !node.outputs.is_empty() && node.outputs.len() != 1 {
            return Err(PipelineError::new(
                "TOPOLOGY_NOT_SUPPORTED",
                "0.0.3 nodes must have exactly one output except the sink",
            ));
        }
    }
    let mut incoming: BTreeMap<(String, String), usize> = BTreeMap::new();
    let mut outgoing_count: BTreeMap<(String, String), usize> = BTreeMap::new();
    for edge in &definition.edges {
        let source = nodes
            .get(&edge.from_node)
            .ok_or_else(|| PipelineError::new("EDGE_ENDPOINT_UNKNOWN", "edge source is unknown"))?;
        let target = nodes
            .get(&edge.to_node)
            .ok_or_else(|| PipelineError::new("EDGE_ENDPOINT_UNKNOWN", "edge target is unknown"))?;
        let source_port = source
            .outputs
            .iter()
            .find(|port| port.name == edge.from_port)
            .ok_or_else(|| PipelineError::new("PORT_UNKNOWN", "edge source port is unknown"))?;
        let target_port = target
            .inputs
            .iter()
            .find(|port| port.name == edge.to_port)
            .ok_or_else(|| PipelineError::new("PORT_UNKNOWN", "edge target port is unknown"))?;
        if source_port.data_type != edge.data_type || target_port.data_type != edge.data_type {
            return Err(PipelineError::new(
                "TYPE_MISMATCH",
                "edge data type does not match ports",
            ));
        }
        *incoming
            .entry((edge.to_node.clone(), edge.to_port.clone()))
            .or_default() += 1;
        *outgoing_count
            .entry((edge.from_node.clone(), edge.from_port.clone()))
            .or_default() += 1;
    }
    for node in &definition.nodes {
        for port in &node.inputs {
            let count = incoming
                .get(&(node.node_id.clone(), port.name.clone()))
                .copied()
                .unwrap_or(0);
            if port.required && count != 1 {
                return Err(PipelineError::new(
                    "REQUIRED_INPUT_COUNT",
                    format!("required input {} has {count} edges", port.name),
                ));
            }
            if !port.required && count > 1 {
                return Err(PipelineError::new(
                    "OPTIONAL_INPUT_MULTIPLE",
                    format!("optional input {} has multiple edges", port.name),
                ));
            }
        }
        for port in &node.outputs {
            let count = outgoing_count
                .get(&(node.node_id.clone(), port.name.clone()))
                .copied()
                .unwrap_or(0);
            if count > 1 {
                return Err(PipelineError::new(
                    "OUTPUT_FANOUT",
                    format!("output {} has multiple edges", port.name),
                ));
            }
        }
    }
    let plan = PipelineExecutionPlan {
        pipeline_id: definition.pipeline_id.clone(),
        revision: definition.revision,
        digest: definition.digest.clone(),
        ordered_nodes,
        edges: definition.edges.clone(),
        max_records: MAX_RECORDS,
        max_bytes: 8 * 1024 * 1024,
        deterministic: true,
        plan_digest: String::new(),
    };
    let plan_value = serde_json::to_value(&plan)
        .map_err(|error| PipelineError::new("PIPELINE_INVALID", error.to_string()))?;
    let mut plan = plan;
    plan.plan_digest = digest_without_field(&plan_value, "planDigest");
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_pipeline() -> PipelineDefinition {
        serde_json::from_str(include_str!(
            "../../../contracts/examples/pipeline-definition.json"
        ))
        .unwrap()
    }

    fn rehash(pipeline: &mut PipelineDefinition) {
        let value = serde_json::to_value(&*pipeline).unwrap();
        pipeline.digest = digest_without_field(&value, "digest");
    }

    fn registry() -> (NodeRegistry, TrustedRegistryKeys) {
        trusted_registry().unwrap()
    }

    #[test]
    fn trusted_registry_signature_is_verified() {
        let (registry, keys) = registry();
        assert_eq!(registry.entries.len(), 6);
        assert_eq!(keys.keys.len(), 1);
    }

    #[test]
    fn valid_pipeline_gets_deterministic_plan() {
        let (registry, _) = registry();
        let plan =
            validate_pipeline(&fixture_pipeline(), &registry, &schema_catalog().unwrap()).unwrap();
        assert_eq!(
            plan.ordered_nodes,
            vec!["source", "parse", "map", "filter", "validate", "sink"]
        );
        assert!(plan.plan_digest.starts_with("sha256:"));
    }

    #[test]
    fn forged_port_type_is_rejected() {
        let (registry, _) = registry();
        let mut pipeline = fixture_pipeline();
        pipeline.nodes[1].inputs[0].data_type = "string".to_string();
        rehash(&mut pipeline);
        let result = validate_pipeline(&pipeline, &registry, &schema_catalog().unwrap());
        assert_eq!(result.unwrap_err().code, "PORT_SIGNATURE_MISMATCH");
    }

    #[test]
    fn cycle_is_rejected() {
        let (registry, _) = registry();
        let mut pipeline = fixture_pipeline();
        pipeline.edges.push(TypedEdge {
            from_node: "sink".into(),
            from_port: "records".into(),
            to_node: "source".into(),
            to_port: "records".into(),
            data_type: "json".into(),
        });
        rehash(&mut pipeline);
        assert_eq!(
            validate_pipeline(&pipeline, &registry, &schema_catalog().unwrap())
                .unwrap_err()
                .code,
            "CYCLE"
        );
    }

    #[test]
    fn bad_registry_signature_is_rejected() {
        let (mut registry, keys) = registry();
        registry.signature.value = "AAAA".to_string();
        assert_eq!(
            verify_registry_signature(&registry, &keys)
                .unwrap_err()
                .code,
            "REGISTRY_SIGNATURE_INVALID"
        );
    }

    #[test]
    fn effect_identity_is_stable_across_attempts() {
        let first = effect_id("job-1", "pipe", 1, "sink", "batch-1");
        let retry = effect_id("job-1", "pipe", 1, "sink", "batch-1");
        let other = effect_id("job-1", "pipe", 1, "sink", "batch-2");
        assert_eq!(first, retry);
        assert_ne!(first, other);
        assert!(!first.contains("attempt"));
        assert!(!first.contains("fence"));
    }

    #[test]
    fn config_and_schema_pins_are_trusted() {
        let (registry, _) = registry();
        let mut pipeline = fixture_pipeline();
        pipeline.nodes[0].config["endpoint"] = Value::String("not a uri".into());
        rehash(&mut pipeline);
        assert_eq!(
            validate_pipeline(&pipeline, &registry, &schema_catalog().unwrap())
                .unwrap_err()
                .code,
            "CONFIG_INVALID"
        );
        let mut pipeline = fixture_pipeline();
        pipeline.nodes[5].config["schemaRevision"] = Value::from(999);
        rehash(&mut pipeline);
        assert_eq!(
            validate_pipeline(&pipeline, &registry, &schema_catalog().unwrap())
                .unwrap_err()
                .code,
            "SCHEMA_REVISION_NOT_FOUND"
        );
    }

    #[test]
    fn pipeline_digest_is_canonical() {
        let pipeline = fixture_pipeline();
        let value = serde_json::to_value(&pipeline).unwrap();
        assert_eq!(pipeline.digest, digest_without_field(&value, "digest"));
    }
}
