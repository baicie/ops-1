//! Shared, versioned wire contracts for the OpsWeave 0.0.1 platform.
//!
//! This crate is deliberately dependency-light: it is consumed by the Kernel,
//! the Node Runtime, the recovery CLI and (via JSON) by plugin conformance
//! tests.  It contains no database or transport concerns.

use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;
use uuid::Uuid;

pub const KERNEL_API_MAJOR: i64 = 1;
pub const WEB_SDK_MAJOR: i64 = 1;
pub const RUNTIME_PROTOCOL: &str = "http-json-v1";
pub const MANIFEST_SCHEMA_VERSION: &str = "1.1";

// ---------------------------------------------------------------------------
// Manifest v1.1
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Compatibility {
    pub kernel_api_major: i64,
    pub web_sdk_major: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityRef {
    pub name: String,
    pub major: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendContribution {
    pub kind: FrontendContributionKind,
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum FrontendContributionKind {
    #[serde(rename = "route.page.v1")]
    RoutePage,
    #[serde(rename = "navigation.item.v1")]
    NavigationItem,
    #[serde(rename = "settings.section.v1")]
    SettingsSection,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendSpec {
    pub remote_entry: String,
    pub remote_entry_digest: String,
    pub asset_index: String,
    pub asset_index_digest: String,
    pub contributions: Vec<FrontendContribution>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProtocolSpec {
    pub name: String,
    pub version: String,
    pub container_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HealthSpec {
    pub readiness_path: String,
    pub liveness_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackendSpec {
    pub runtime: String,
    pub image_ref: String,
    pub protocol: ProtocolSpec,
    pub health: HealthSpec,
    pub api_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceRequirements {
    pub cpu_millis: i64,
    #[serde(rename = "memoryMiB")]
    pub memory_mib: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestV11 {
    pub schema_version: String,
    pub id: String,
    pub version: String,
    pub publisher: String,
    pub compatibility: Compatibility,
    pub artifact_digest: String,
    pub frontend: Option<FrontendSpec>,
    pub backend: Option<BackendSpec>,
    pub provides: Vec<CapabilityRef>,
    pub requires: Vec<CapabilityRef>,
    pub permissions: Vec<String>,
    pub resources: ResourceRequirements,
}

impl ManifestV11 {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        if self.schema_version != MANIFEST_SCHEMA_VERSION {
            errors.push(format!(
                "schemaVersion must be {MANIFEST_SCHEMA_VERSION}, got {}",
                self.schema_version
            ));
        }
        if !re(r"^[a-z0-9][a-z0-9.-]{2,100}$").is_match(&self.id) {
            errors.push("id must match ^[a-z0-9][a-z0-9.-]{2,100}$".into());
        }
        if !re(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$").is_match(&self.version) {
            errors.push("version must be SemVer".into());
        }
        if self.publisher.len() < 3 || self.publisher.len() > 96 {
            errors.push("publisher length must be 3..=96".into());
        }
        if self.compatibility.kernel_api_major != KERNEL_API_MAJOR {
            errors.push(format!(
                "kernelApiMajor {} is not supported (kernel supports {KERNEL_API_MAJOR})",
                self.compatibility.kernel_api_major
            ));
        }
        if self.compatibility.web_sdk_major != WEB_SDK_MAJOR {
            errors.push(format!(
                "webSdkMajor {} is not supported (shell supports {WEB_SDK_MAJOR})",
                self.compatibility.web_sdk_major
            ));
        }
        if !is_sha256_digest(&self.artifact_digest) {
            errors.push("artifactDigest must be sha256:<64 lowercase hex>".into());
        }
        if self.frontend.is_none() && self.backend.is_none() {
            errors.push("at least one of frontend/backend must be present".into());
        }
        if let Some(frontend) = &self.frontend {
            if !re(r"^frontend/[A-Za-z0-9_./-]+\.js$").is_match(&frontend.remote_entry) {
                errors.push("frontend.remoteEntry must be a frontend/*.js path".into());
            }
            if frontend.asset_index != "frontend/asset-index.json" {
                errors.push("frontend.assetIndex must be frontend/asset-index.json".into());
            }
            if !is_sha256_digest(&frontend.remote_entry_digest) {
                errors.push("frontend.remoteEntryDigest must be sha256:<hex>".into());
            }
            if !is_sha256_digest(&frontend.asset_index_digest) {
                errors.push("frontend.assetIndexDigest must be sha256:<hex>".into());
            }
            if frontend.contributions.len() > 32 {
                errors.push("frontend.contributions exceeds 32 entries".into());
            }
            for contribution in &frontend.contributions {
                if contribution.id.trim().is_empty() {
                    errors.push("frontend contribution id must not be empty".into());
                }
                if !re(r"^/(?:[A-Za-z0-9_./:-]+)?$").is_match(&contribution.path) {
                    errors.push(format!(
                        "frontend contribution path is invalid: {}",
                        contribution.path
                    ));
                }
            }
        }
        if let Some(backend) = &self.backend {
            if backend.runtime != "oci" {
                errors.push("backend.runtime must be oci".into());
            }
            if !is_image_ref(&backend.image_ref) {
                errors.push(
                    "backend.imageRef must be repository/path@sha256:<64 lowercase hex>".into(),
                );
            }
            if backend.protocol.name != "http-json" || backend.protocol.version != "1" {
                errors.push("backend.protocol must be http-json v1".into());
            }
            if backend.protocol.container_port == 0 {
                errors.push("backend.protocol.containerPort must be 1..=65535".into());
            }
            if !re(r"^/[A-Za-z0-9_/-]+$").is_match(&backend.health.readiness_path) {
                errors.push("backend.health.readinessPath is invalid".into());
            }
            if !re(r"^/[A-Za-z0-9_/-]+$").is_match(&backend.health.liveness_path) {
                errors.push("backend.health.livenessPath is invalid".into());
            }
            if let Some(path) = &backend.health.startup_path {
                if !re(r"^/[A-Za-z0-9_/-]+$").is_match(path) {
                    errors.push("backend.health.startupPath is invalid".into());
                }
            }
            if !re(r"^/api/[a-z0-9/-]+$").is_match(&backend.api_prefix) {
                errors.push("backend.apiPrefix must match ^/api/[a-z0-9/-]+$".into());
            }
        }
        if self.provides.len() > 32 || self.requires.len() > 32 {
            errors.push("provides/requires may contain at most 32 entries".into());
        }
        for capability in self.provides.iter().chain(self.requires.iter()) {
            if !re(r"^[a-z][a-z0-9.]+$").is_match(&capability.name) || capability.major < 1 {
                errors.push(format!("invalid capability ref: {}", capability.name));
            }
        }
        if self.permissions.len() > 64 {
            errors.push("permissions exceeds 64 entries".into());
        }
        let mut seen = std::collections::HashSet::new();
        for permission in &self.permissions {
            if !re(r"^[a-z][a-z0-9.:/-]{2,100}$").is_match(permission) {
                errors.push(format!("invalid permission: {permission}"));
            }
            if !seen.insert(permission) {
                errors.push(format!("duplicate permission: {permission}"));
            }
        }
        if self.resources.cpu_millis < 100 || self.resources.cpu_millis > 16_000 {
            errors.push("resources.cpuMillis must be 100..=16000".into());
        }
        if self.resources.memory_mib < 64 || self.resources.memory_mib > 65_536 {
            errors.push("resources.memoryMiB must be 64..=65536".into());
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    pub fn has_backend(&self) -> bool {
        self.backend.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetEntry {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetIndex {
    pub version: String,
    pub assets: Vec<AssetEntry>,
}

impl AssetIndex {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();
        if self.version != "1" {
            errors.push("asset index version must be 1".into());
        }
        if self.assets.is_empty() || self.assets.len() > 2000 {
            errors.push("asset index must contain 1..=2000 assets".into());
        }
        for asset in &self.assets {
            if !re(r"^frontend/[A-Za-z0-9_./-]+$").is_match(&asset.path) {
                errors.push(format!("invalid asset path: {}", asset.path));
            }
            if !is_sha256_digest(&asset.sha256) {
                errors.push(format!("invalid asset digest: {}", asset.sha256));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

pub fn is_sha256_digest(value: &str) -> bool {
    re(r"^sha256:[a-f0-9]{64}$").is_match(value)
}

pub fn is_image_ref(value: &str) -> bool {
    re(r"^[a-zA-Z0-9._:/-]+/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$").is_match(value)
}

pub fn sha256_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

// ---------------------------------------------------------------------------
// Runtime protocol
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeInfo {
    pub plugin_id: String,
    pub version: String,
    pub runtime_protocol: String,
    pub capability_digest: String,
    pub build_digest: String,
}

// ---------------------------------------------------------------------------
// Identity / states
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Admin,
    Operator,
    Viewer,
}

impl Role {
    pub fn can_operate(self) -> bool {
        matches!(self, Role::Admin | Role::Operator)
    }

    pub fn is_admin(self) -> bool {
        self == Role::Admin
    }
}

impl std::fmt::Display for Role {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Role::Admin => write!(f, "admin"),
            Role::Operator => write!(f, "operator"),
            Role::Viewer => write!(f, "viewer"),
        }
    }
}

impl std::str::FromStr for Role {
    type Err = String;
    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "admin" => Ok(Role::Admin),
            "operator" => Ok(Role::Operator),
            "viewer" => Ok(Role::Viewer),
            other => Err(format!("unknown role: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PackageState {
    Uploaded,
    Verified,
    Staged,
    Installed,
    Rejected,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DeploymentStatus {
    Pending,
    Preparing,
    Ready,
    Active,
    Draining,
    Disabled,
    Degraded,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InstanceState {
    Starting,
    Ready,
    Unhealthy,
    Unreachable,
    Stopped,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum NodeStatus {
    Ready,
    Degraded,
    Unreachable,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DesiredAction {
    Start,
    Stop,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogChannel {
    Stdout,
    Stderr,
    Runtime,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Unknown,
}

// ---------------------------------------------------------------------------
// Node control plane
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceSnapshot {
    pub sampled_at: DateTime<Utc>,
    pub cpu_utilization: Option<f64>,
    pub memory_used_bytes: Option<i64>,
    pub memory_total_bytes: Option<i64>,
    pub cpu_cores: Option<i64>,
    pub filesystem_used_bytes: Option<i64>,
    pub filesystem_total_bytes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeHeartbeatRequest {
    pub generation: i64,
    pub observed_at: DateTime<Utc>,
    pub status: NodeStatus,
    pub resource_snapshot: ResourceSnapshot,
    pub instances: Vec<InstanceObservation>,
    pub data_endpoint: String,
    pub runtime_adapter_version: String,
    pub os: String,
    pub arch: String,
    pub labels: BTreeMap<String, String>,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstanceObservation {
    pub instance_id: Uuid,
    pub deployment_id: Uuid,
    pub generation: i64,
    pub state: InstanceState,
    pub observed_at: DateTime<Utc>,
    pub container_id: Option<String>,
    pub image_digest: Option<String>,
    pub host_port: Option<u16>,
    pub restart_count: i32,
    pub error: Option<String>,
    pub runtime_adapter_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesiredBackend {
    pub image_ref: String,
    pub container_port: u16,
    pub capability_digest: String,
    pub readiness_path: String,
    pub liveness_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_path: Option<String>,
    pub api_prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesiredWorkload {
    pub instance_id: Uuid,
    pub deployment_id: Uuid,
    pub plugin_id: String,
    pub version: String,
    pub generation: i64,
    pub action: DesiredAction,
    pub backend: DesiredBackend,
    pub resources: ResourceRequirements,
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesiredNodeState {
    pub node_id: Uuid,
    pub node_generation: i64,
    pub heartbeat_interval_seconds: u32,
    pub max_instances: u32,
    pub desired: Vec<DesiredWorkload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeEnrollRequest {
    pub token: String,
    pub name: String,
    pub os: String,
    pub arch: String,
    pub labels: BTreeMap<String, String>,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeEnrollResponse {
    pub node_id: Uuid,
    pub credential: String,
    pub data_token: String,
    pub heartbeat_interval_seconds: u32,
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogEvent {
    pub event_id: Uuid,
    pub stream_id: Uuid,
    pub stream_epoch: i64,
    pub sequence: i64,
    pub occurred_at: Option<DateTime<Utc>>,
    pub observed_at: DateTime<Utc>,
    pub node_id: Uuid,
    pub instance_id: Uuid,
    pub channel: LogChannel,
    pub level: LogLevel,
    pub message: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogBatch {
    pub stream_id: Uuid,
    pub stream_epoch: i64,
    pub first_sequence: Option<i64>,
    pub last_sequence: Option<i64>,
    pub events: Vec<LogEvent>,
    pub gap: bool,
}

// ---------------------------------------------------------------------------
// API error
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApiErrorBody {
    pub code: String,
    pub message: String,
    pub request_id: String,
    pub retryable: bool,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn re(pattern: &'static str) -> &'static Regex {
    static CACHE: OnceLock<std::collections::HashMap<&'static str, Regex>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut map = std::collections::HashMap::new();
            map.insert(
                r"^[a-z0-9][a-z0-9.-]{2,100}$",
                Regex::new(r"^[a-z0-9][a-z0-9.-]{2,100}$").unwrap(),
            );
            map.insert(
                r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$",
                Regex::new(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$").unwrap(),
            );
            map.insert(
                r"^frontend/[A-Za-z0-9_./-]+\.js$",
                Regex::new(r"^frontend/[A-Za-z0-9_./-]+\.js$").unwrap(),
            );
            map.insert(
                r"^/(?:[A-Za-z0-9_./:-]+)?$",
                Regex::new(r"^/(?:[A-Za-z0-9_./:-]+)?$").unwrap(),
            );
            map.insert(
                r"^/[A-Za-z0-9_/-]+$",
                Regex::new(r"^/[A-Za-z0-9_/-]+$").unwrap(),
            );
            map.insert(
                r"^/api/[a-z0-9/-]+$",
                Regex::new(r"^/api/[a-z0-9/-]+$").unwrap(),
            );
            map.insert(
                r"^[a-z][a-z0-9.]+$",
                Regex::new(r"^[a-z][a-z0-9.]+$").unwrap(),
            );
            map.insert(
                r"^[a-z][a-z0-9.:/-]{2,100}$",
                Regex::new(r"^[a-z][a-z0-9.:/-]{2,100}$").unwrap(),
            );
            map.insert(
                r"^frontend/[A-Za-z0-9_./-]+$",
                Regex::new(r"^frontend/[A-Za-z0-9_./-]+$").unwrap(),
            );
            map.insert(
                r"^sha256:[a-f0-9]{64}$",
                Regex::new(r"^sha256:[a-f0-9]{64}$").unwrap(),
            );
            map.insert(
                r"^[a-zA-Z0-9._:/-]+/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$",
                Regex::new(r"^[a-zA-Z0-9._:/-]+/[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$").unwrap(),
            );
            map
        })
        .get(pattern)
        .expect("regex pattern is registered")
}

/// Canonical JSON: object keys sorted lexicographically, no insignificant
/// whitespace, UTF-8 encoding. This is the canonicalisation used for the
/// payload index and publisher signatures in 0.0.1.
pub fn canonical_json(value: &Value) -> Vec<u8> {
    serde_json::to_vec(&canonicalize(value)).expect("JSON value is serialisable")
}

fn canonicalize(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for key in keys {
                out.insert(key.clone(), canonicalize(&map[key]));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_json_sorts_keys_and_compacts() {
        let value: Value = serde_json::from_str(r#"{"b":1,"a":{"d":2,"c":[3]}}"#).unwrap();
        assert_eq!(
            String::from_utf8(canonical_json(&value)).unwrap(),
            r#"{"a":{"c":[3],"d":2},"b":1}"#
        );
    }

    #[test]
    fn rejects_manifest_both_null() {
        let manifest = ManifestV11 {
            schema_version: "1.1".into(),
            id: "dev.opsweave.hello".into(),
            version: "0.0.1".into(),
            publisher: "trusted-team".into(),
            compatibility: Compatibility {
                kernel_api_major: 1,
                web_sdk_major: 1,
            },
            artifact_digest: format!("sha256:{}", "a".repeat(64)),
            frontend: None,
            backend: None,
            provides: vec![],
            requires: vec![],
            permissions: vec![],
            resources: ResourceRequirements {
                cpu_millis: 100,
                memory_mib: 64,
            },
        };
        assert!(manifest.validate().is_err());
    }

    #[test]
    fn image_ref_requires_digest() {
        assert!(is_image_ref(&format!(
            "localhost:5000/opsweave/hello@sha256:{}",
            "a".repeat(64)
        )));
        assert!(!is_image_ref("localhost:5000/opsweave/hello:latest"));
    }
}
