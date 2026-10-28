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

/// One frontend contribution declared by a plugin manifest.
///
/// The v2 kinds (`navigation.item.v2`, `route.page.v2`) add an explicit
/// `surface`; the v1 kinds keep their historical wire shape. The v2-only
/// fields serialise only when a contribution actually carries them, so an
/// already signed v1 manifest canonicalises to exactly the bytes it did before
/// these fields existed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendContribution {
    pub kind: FrontendContributionKind,
    pub id: String,
    pub path: String,
    /// v2 only: `admin` | `workspace`. Kept as the raw string so an unknown
    /// value is reported as a structured per-contribution rejection instead of
    /// failing the whole manifest during deserialisation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
    /// v2 only: i18n message key for the navigation label.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_key: Option<String>,
    /// v2 only: capabilities the session must additionally hold.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum FrontendContributionKind {
    #[serde(rename = "route.page.v1")]
    RoutePage,
    #[serde(rename = "navigation.item.v1")]
    NavigationItem,
    #[serde(rename = "settings.section.v1")]
    SettingsSection,
    #[serde(rename = "navigation.item.v2")]
    NavigationItemV2,
    /// The page half of the v2 contract: what `route.page.v1` always meant,
    /// now able to name the surface it belongs to. It is a v2 kind, so it
    /// follows the same rules as `navigation.item.v2`.
    #[serde(rename = "route.page.v2")]
    RoutePageV2,
}

impl FrontendContributionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RoutePage => "route.page.v1",
            Self::NavigationItem => "navigation.item.v1",
            Self::SettingsSection => "settings.section.v1",
            Self::NavigationItemV2 => "navigation.item.v2",
            Self::RoutePageV2 => "route.page.v2",
        }
    }

    /// v1 kinds keep their original meaning: the admin surface and the legacy
    /// `/ext/<publisher>/<name>` paths that already signed bundles ship.
    ///
    /// The set is spelled out instead of inferred from a version suffix, so
    /// adding a v2 kind can never silently re-classify an existing v1 one.
    pub fn is_v1(self) -> bool {
        matches!(
            self,
            Self::RoutePage | Self::NavigationItem | Self::SettingsSection
        )
    }
}

// ---------------------------------------------------------------------------
// Extension contribution contract (surfaces, namespaces, capabilities)
// ---------------------------------------------------------------------------

/// Capability vocabulary the platform knows how to grant today.
///
/// A contribution may only require a capability from this set. Extending the
/// vocabulary is a contract change (ADR + tests), never an implicit grant.
pub const CAPABILITY_PLATFORM_ACCESS: &str = "platform:access";
pub const CAPABILITY_WORKSPACE_ACCESS: &str = "workspace:access";
pub const KNOWN_CONTRIBUTION_CAPABILITIES: [&str; 2] =
    [CAPABILITY_PLATFORM_ACCESS, CAPABILITY_WORKSPACE_ACCESS];

/// Shell roots the Kernel owns. A plugin contribution may never occupy one, nor
/// any path shallower than its own extension namespace below them.
pub const RESERVED_SHELL_PREFIXES: [&str; 7] = [
    "/admin",
    "/app",
    "/login",
    "/api",
    "/internal",
    "/assets",
    "/ext",
];

/// The two surfaces a v2 contribution may target.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ContributionSurface {
    Admin,
    Workspace,
}

impl ContributionSurface {
    pub const ALL: [ContributionSurface; 2] = [Self::Admin, Self::Workspace];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admin => "admin",
            Self::Workspace => "workspace",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|surface| surface.as_str() == raw)
    }

    /// Shell root this surface owns.
    pub fn root(self) -> &'static str {
        match self {
            Self::Admin => "/admin",
            Self::Workspace => "/app",
        }
    }

    /// The only path namespace a plugin may contribute into for this surface.
    pub fn namespace(self, plugin_id: &str) -> String {
        format!("{}/ext/{plugin_id}/", self.root())
    }

    /// Capability a session must hold before anything on this surface is
    /// delivered at all.
    pub fn required_capability(self) -> &'static str {
        match self {
            Self::Admin => CAPABILITY_PLATFORM_ACCESS,
            Self::Workspace => CAPABILITY_WORKSPACE_ACCESS,
        }
    }
}

/// Why a declared contribution was refused. The code is stable and machine
/// readable; the detail carries the offending value for an operator log.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ContributionRejectionCode {
    MissingSurface,
    InvalidSurface,
    ReservedPrefix,
    NamespaceEscape,
    InvalidPath,
    UnknownCapability,
    UnexpectedField,
    InvalidPluginId,
}

impl ContributionRejectionCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingSurface => "MISSING_SURFACE",
            Self::InvalidSurface => "INVALID_SURFACE",
            Self::ReservedPrefix => "RESERVED_PREFIX",
            Self::NamespaceEscape => "NAMESPACE_ESCAPE",
            Self::InvalidPath => "INVALID_PATH",
            Self::UnknownCapability => "UNKNOWN_CAPABILITY",
            Self::UnexpectedField => "UNEXPECTED_FIELD",
            Self::InvalidPluginId => "INVALID_PLUGIN_ID",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContributionRejection {
    pub code: ContributionRejectionCode,
    pub plugin_id: String,
    pub contribution_id: String,
    pub kind: String,
    pub detail: String,
}

impl ContributionRejection {
    fn new(
        code: ContributionRejectionCode,
        plugin_id: &str,
        contribution: &FrontendContribution,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            code,
            plugin_id: plugin_id.to_string(),
            contribution_id: contribution.id.clone(),
            kind: contribution.kind.as_str().to_string(),
            detail: detail.into(),
        }
    }
}

fn is_under(path: &str, prefix: &str) -> bool {
    path == prefix || (path.starts_with(prefix) && path.as_bytes().get(prefix.len()) == Some(&b'/'))
}

/// True when the path contains a `.` or `..` segment.
///
/// Both contract generations share this rule: a `.`/`..` segment is path
/// traversal, never a page name, so neither branch may let one through. Keeping
/// it in one function is what stops the v1 and v2 checks from drifting apart.
fn traverses(path: &str) -> bool {
    path.split('/')
        .any(|segment| segment == "." || segment == "..")
}

fn reserved_shell_prefix(path: &str) -> Option<&'static str> {
    RESERVED_SHELL_PREFIXES
        .into_iter()
        .find(|prefix| is_under(path, prefix))
}

impl FrontendContribution {
    /// Enforces the pinned contribution contract and returns the surface the
    /// contribution is delivered under.
    ///
    /// v1 kinds keep their historical meaning (admin surface, legacy path form)
    /// and are refused only when they smuggle v2-only fields, so an already
    /// signed v1 bundle keeps loading unchanged.
    pub fn validate_for_plugin(
        &self,
        plugin_id: &str,
    ) -> Result<ContributionSurface, ContributionRejection> {
        if !re(r"^[A-Za-z0-9._-]+$").is_match(plugin_id) {
            return Err(ContributionRejection::new(
                ContributionRejectionCode::InvalidPluginId,
                plugin_id,
                self,
                format!("plugin id {plugin_id:?} cannot name a route namespace"),
            ));
        }
        if self.kind.is_v1() {
            if self.surface.is_some()
                || self.title_key.is_some()
                || !self.required_capabilities.is_empty()
            {
                return Err(ContributionRejection::new(
                    ContributionRejectionCode::UnexpectedField,
                    plugin_id,
                    self,
                    "v1 contributions cannot carry surface/titleKey/requiredCapabilities; publish the v2 kind instead (route.page.v2 for pages, navigation.item.v2 for navigation)",
                ));
            }
            if !re(r"^/(?:[A-Za-z0-9_./:-]+)?$").is_match(&self.path) {
                return Err(ContributionRejection::new(
                    ContributionRejectionCode::InvalidPath,
                    plugin_id,
                    self,
                    format!("path {:?} is not a safe shell path", self.path),
                ));
            }
            // The pattern above is the historical v1 wire shape, which keeps `..`
            // legal; the shared segment rule is what refuses traversal. Only a
            // traversing path is newly refused, so every already signed v1
            // manifest (/ext/<publisher>/<name>) stays valid byte for byte.
            if traverses(&self.path) {
                return Err(ContributionRejection::new(
                    ContributionRejectionCode::InvalidPath,
                    plugin_id,
                    self,
                    format!("path {:?} must not contain . or .. segments", self.path),
                ));
            }
            return Ok(ContributionSurface::Admin);
        }

        let raw_surface = self.surface.as_deref().ok_or_else(|| {
            ContributionRejection::new(
                ContributionRejectionCode::MissingSurface,
                plugin_id,
                self,
                "navigation.item.v2 must declare surface (admin|workspace)",
            )
        })?;
        let surface = ContributionSurface::parse(raw_surface).ok_or_else(|| {
            ContributionRejection::new(
                ContributionRejectionCode::InvalidSurface,
                plugin_id,
                self,
                format!("surface {raw_surface:?} is not one of admin|workspace"),
            )
        })?;

        let namespace = surface.namespace(plugin_id);
        if self.path == namespace.trim_end_matches('/') {
            return Err(ContributionRejection::new(
                ContributionRejectionCode::InvalidPath,
                plugin_id,
                self,
                format!(
                    "path {:?} is the plugin namespace root, not a page below {namespace}",
                    self.path
                ),
            ));
        }
        if self.path.starts_with(&namespace) {
            let relative = &self.path[namespace.len()..];
            if relative.is_empty()
                || traverses(relative)
                || !re(r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$").is_match(relative)
            {
                return Err(ContributionRejection::new(
                    ContributionRejectionCode::InvalidPath,
                    plugin_id,
                    self,
                    format!(
                        "path {:?} must name a real page below {namespace}",
                        self.path
                    ),
                ));
            }
        } else if is_under(&self.path, "/admin/ext") || is_under(&self.path, "/app/ext") {
            return Err(ContributionRejection::new(
                ContributionRejectionCode::NamespaceEscape,
                plugin_id,
                self,
                format!(
                    "path {:?} is outside the {surface} namespace {namespace}",
                    self.path,
                    surface = surface.as_str()
                ),
            ));
        } else if let Some(prefix) = reserved_shell_prefix(&self.path) {
            return Err(ContributionRejection::new(
                ContributionRejectionCode::ReservedPrefix,
                plugin_id,
                self,
                format!(
                    "path {:?} occupies the reserved shell prefix {prefix}; {surface} contributions live below {namespace}",
                    self.path,
                    surface = surface.as_str()
                ),
            ));
        } else {
            return Err(ContributionRejection::new(
                ContributionRejectionCode::NamespaceEscape,
                plugin_id,
                self,
                format!(
                    "path {:?} must start with the {surface} namespace {namespace}",
                    self.path,
                    surface = surface.as_str()
                ),
            ));
        }

        if let Some(unknown) = self
            .required_capabilities
            .iter()
            .find(|required| !KNOWN_CONTRIBUTION_CAPABILITIES.contains(&required.as_str()))
        {
            return Err(ContributionRejection::new(
                ContributionRejectionCode::UnknownCapability,
                plugin_id,
                self,
                format!(
                    "capability {unknown:?} is not in the platform vocabulary {KNOWN_CONTRIBUTION_CAPABILITIES:?}"
                ),
            ));
        }
        Ok(surface)
    }
}

/// A contribution the Kernel is willing to hand to one session: validated and
/// authorised, with the surface made explicit.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeliveredContribution {
    pub kind: FrontendContributionKind,
    pub id: String,
    pub path: String,
    pub surface: ContributionSurface,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_key: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ContributionDelivery {
    pub delivered: Vec<DeliveredContribution>,
    pub rejections: Vec<ContributionRejection>,
}

/// Splits declared contributions into what this session receives and what the
/// contract refused.
///
/// A contribution the session is not authorised for appears in neither list:
/// it must not be dispatched (surface capability missing, or a required
/// capability missing), and it must not be reported either, because the
/// response would then disclose a surface the session cannot enter.
pub fn deliverable_contributions(
    plugin_id: &str,
    contributions: &[FrontendContribution],
    granted_capabilities: &[&str],
) -> ContributionDelivery {
    let mut delivery = ContributionDelivery::default();
    for contribution in contributions {
        let surface = match contribution.validate_for_plugin(plugin_id) {
            Ok(surface) => surface,
            Err(rejection) => {
                delivery.rejections.push(rejection);
                continue;
            }
        };
        let holds = |capability: &str| granted_capabilities.contains(&capability);
        if !holds(surface.required_capability())
            || contribution
                .required_capabilities
                .iter()
                .any(|required| !holds(required))
        {
            continue;
        }
        delivery.delivered.push(DeliveredContribution {
            kind: contribution.kind,
            id: contribution.id.clone(),
            path: contribution.path.clone(),
            surface,
            title_key: contribution.title_key.clone(),
            required_capabilities: contribution.required_capabilities.clone(),
        });
    }
    delivery
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
                if let Err(rejection) = contribution.validate_for_plugin(&self.id) {
                    errors.push(format!(
                        "frontend contribution {} ({}) rejected: {} - {}",
                        contribution.id,
                        contribution.kind.as_str(),
                        rejection.code.as_str(),
                        rejection.detail
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
    /// Host memory in use, in bytes: the budget plugin containers draw from.
    pub memory_used_bytes: Option<i64>,
    /// Host memory total, in bytes. Never the Node Runtime container's own
    /// cgroup limit - plugin containers are host siblings of that container.
    pub memory_total_bytes: Option<i64>,
    /// Host-schedulable CPU cores: the budget plugin containers draw from.
    /// Never the Node Runtime container's own cgroup quota.
    pub cpu_cores: Option<i64>,
    /// Diagnostic only: the CPU cap of the Node Runtime's own cgroup, in
    /// cores. It bounds the agent, not the plugins placed from this snapshot,
    /// so placement MUST NOT read it.
    pub self_cpu_limit_cores: Option<f64>,
    /// Diagnostic only: the memory cap of the Node Runtime's own cgroup, in
    /// bytes. Placement MUST NOT read it either.
    pub self_memory_limit_bytes: Option<i64>,
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
            map.insert(
                r"^[A-Za-z0-9._-]+$",
                Regex::new(r"^[A-Za-z0-9._-]+$").unwrap(),
            );
            map.insert(
                r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$",
                Regex::new(r"^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$").unwrap(),
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

    // -- extension contribution contract (v1 compat + v2 surfaces) ----------

    const PLUGIN: &str = "opsweave.data-catalog";

    fn v2_contribution(
        path: &str,
        surface: Option<&str>,
        required: &[&str],
    ) -> FrontendContribution {
        FrontendContribution {
            kind: FrontendContributionKind::NavigationItemV2,
            id: "catalog-manage".into(),
            path: path.into(),
            surface: surface.map(str::to_string),
            title_key: Some("catalog.nav.manage".into()),
            required_capabilities: required.iter().map(|name| name.to_string()).collect(),
        }
    }

    fn rejection_code(contribution: &FrontendContribution) -> ContributionRejectionCode {
        contribution
            .validate_for_plugin(PLUGIN)
            .expect_err("contribution must be refused")
            .code
    }

    #[test]
    fn rejects_unknown_surface_value() {
        let contribution =
            v2_contribution("/admin/ext/opsweave.data-catalog/manage", Some("root"), &[]);
        let rejection = contribution
            .validate_for_plugin(PLUGIN)
            .expect_err("root is not a surface");
        assert_eq!(rejection.code, ContributionRejectionCode::InvalidSurface);
        assert!(rejection.detail.contains("root"), "{}", rejection.detail);
    }

    #[test]
    fn rejects_v2_contribution_without_surface() {
        let contribution = v2_contribution("/admin/ext/opsweave.data-catalog/manage", None, &[]);
        assert_eq!(
            rejection_code(&contribution),
            ContributionRejectionCode::MissingSurface
        );
    }

    #[test]
    fn rejects_path_outside_the_plugin_namespace() {
        for path in [
            "/admin/ext/opsweave.data-integration/manage",
            "/app/ext/opsweave.data-catalog/manage",
            "/finance/report",
        ] {
            let contribution = v2_contribution(path, Some("admin"), &[]);
            assert_eq!(
                rejection_code(&contribution),
                ContributionRejectionCode::NamespaceEscape,
                "{path}"
            );
        }
    }

    #[test]
    fn rejects_reserved_shell_prefix() {
        for path in [
            "/admin",
            "/admin/plugins",
            "/app",
            "/login",
            "/api/v1/extensions",
            "/internal/secrets",
            "/assets/payload.js",
            "/ext/trusted-team/data-catalog",
        ] {
            let contribution = v2_contribution(path, Some("admin"), &[]);
            assert_eq!(
                rejection_code(&contribution),
                ContributionRejectionCode::ReservedPrefix,
                "{path}"
            );
        }
    }

    #[test]
    fn rejects_path_traversal_and_the_bare_namespace() {
        for path in [
            "/admin/ext/opsweave.data-catalog/",
            "/admin/ext/opsweave.data-catalog",
            "/admin/ext/opsweave.data-catalog/../data-integration/manage",
            "/admin/ext/opsweave.data-catalog//manage",
        ] {
            let contribution = v2_contribution(path, Some("admin"), &[]);
            assert_eq!(
                rejection_code(&contribution),
                ContributionRejectionCode::InvalidPath,
                "{path}"
            );
        }
    }

    #[test]
    fn rejects_unknown_required_capability() {
        let contribution = v2_contribution(
            "/admin/ext/opsweave.data-catalog/manage",
            Some("admin"),
            &["business:quality:read"],
        );
        let rejection = contribution
            .validate_for_plugin(PLUGIN)
            .expect_err("business:quality:read does not exist");
        assert_eq!(rejection.code, ContributionRejectionCode::UnknownCapability);
        assert!(rejection.detail.contains("business:quality:read"));
    }

    #[test]
    fn v1_contribution_cannot_carry_v2_fields() {
        let contribution = FrontendContribution {
            kind: FrontendContributionKind::NavigationItem,
            id: "hello-nav".into(),
            path: "/ext/trusted-team/hello".into(),
            surface: Some("admin".into()),
            title_key: None,
            required_capabilities: vec![],
        };
        assert_eq!(
            rejection_code(&contribution),
            ContributionRejectionCode::UnexpectedField
        );
    }

    #[test]
    fn workspace_only_session_cannot_see_admin_contributions() {
        let contributions = vec![
            v2_contribution(
                "/admin/ext/opsweave.data-catalog/manage",
                Some("admin"),
                &[],
            ),
            v2_contribution(
                "/app/ext/opsweave.data-catalog/quality",
                Some("workspace"),
                &[],
            ),
        ];

        let workspace_only =
            deliverable_contributions(PLUGIN, &contributions, &["workspace:access"]);
        assert_eq!(workspace_only.delivered.len(), 1);
        assert_eq!(
            workspace_only.delivered[0].path,
            "/app/ext/opsweave.data-catalog/quality"
        );
        assert_eq!(
            workspace_only.delivered[0].surface,
            ContributionSurface::Workspace
        );
        assert!(
            workspace_only
                .delivered
                .iter()
                .all(|delivered| delivered.surface != ContributionSurface::Admin),
            "an admin contribution must not reach a session without platform:access"
        );
        assert!(
            workspace_only.rejections.is_empty(),
            "authorisation is not a contract violation and must not be reported"
        );

        let platform = deliverable_contributions(
            PLUGIN,
            &contributions,
            &["platform:access", "workspace:access"],
        );
        assert_eq!(platform.delivered.len(), 2);
    }

    #[test]
    fn v1_contribution_keeps_its_legacy_wire_shape_and_admin_surface() {
        let raw =
            r#"{"kind":"navigation.item.v1","id":"hello-nav","path":"/ext/trusted-team/hello"}"#;
        let contribution: FrontendContribution = serde_json::from_str(raw).unwrap();
        assert_eq!(
            serde_json::to_string(&contribution).unwrap(),
            raw,
            "a v1 contribution must round-trip byte for byte"
        );
        assert_eq!(
            contribution.validate_for_plugin("opsweave.hello"),
            Ok(ContributionSurface::Admin)
        );

        let delivery = deliverable_contributions(
            "opsweave.hello",
            std::slice::from_ref(&contribution),
            &["platform:access", "workspace:access"],
        );
        assert_eq!(delivery.delivered.len(), 1);
        assert_eq!(delivery.delivered[0].path, "/ext/trusted-team/hello");
        assert_eq!(delivery.delivered[0].surface, ContributionSurface::Admin);

        // v1 semantics are admin semantics: a workspace-only session receives
        // nothing, and the omission is not reported as a contract violation.
        let workspace_only = deliverable_contributions(
            "opsweave.hello",
            std::slice::from_ref(&contribution),
            &["workspace:access"],
        );
        assert!(workspace_only.delivered.is_empty());
        assert!(workspace_only.rejections.is_empty());
    }

    /// The pinned v1 manifest: adding the v2 contribution fields must not move a
    /// single byte of the canonical manifest that publisher signatures cover.
    #[test]
    fn v1_manifest_canonicalises_to_the_same_bytes() {
        let raw = r#"{
  "schemaVersion": "1.1",
  "id": "opsweave.hello",
  "version": "0.0.1",
  "publisher": "trusted-team",
  "compatibility": {"kernelApiMajor": 1, "webSdkMajor": 1},
  "artifactDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "frontend": {
    "remoteEntry": "frontend/remoteEntry.js",
    "remoteEntryDigest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "assetIndex": "frontend/asset-index.json",
    "assetIndexDigest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "contributions": [
      {"kind": "route.page.v1", "id": "hello-page", "path": "/ext/trusted-team/hello"},
      {"kind": "navigation.item.v1", "id": "hello-nav", "path": "/ext/trusted-team/hello"}
    ]
  },
  "backend": null,
  "provides": [],
  "requires": [],
  "permissions": [],
  "resources": {"cpuMillis": 100, "memoryMiB": 64}
}"#;
        let original: Value = serde_json::from_str(raw).unwrap();
        let manifest: ManifestV11 = serde_json::from_value(original.clone()).unwrap();
        let reparsed = serde_json::to_value(&manifest).unwrap();
        assert_eq!(canonical_json(&original), canonical_json(&reparsed));
        assert!(manifest.validate().is_ok());
    }

    #[test]
    fn manifest_validation_refuses_an_invalid_v2_contribution() {
        let mut manifest: ManifestV11 = serde_json::from_value(serde_json::json!({
            "schemaVersion": "1.1",
            "id": "opsweave.data-catalog",
            "version": "0.0.1",
            "publisher": "trusted-team",
            "compatibility": {"kernelApiMajor": 1, "webSdkMajor": 1},
            "artifactDigest": format!("sha256:{}", "a".repeat(64)),
            "frontend": {
                "remoteEntry": "frontend/remoteEntry.js",
                "remoteEntryDigest": format!("sha256:{}", "b".repeat(64)),
                "assetIndex": "frontend/asset-index.json",
                "assetIndexDigest": format!("sha256:{}", "c".repeat(64)),
                "contributions": []
            },
            "backend": null,
            "provides": [],
            "requires": [],
            "permissions": [],
            "resources": {"cpuMillis": 100, "memoryMiB": 64}
        }))
        .unwrap();
        let frontend = manifest.frontend.as_mut().unwrap();
        frontend.contributions = vec![v2_contribution("/admin/plugins", Some("admin"), &[])];
        let errors = manifest.validate().expect_err("reserved prefix must fail");
        assert!(
            errors.iter().any(|error| error.contains("RESERVED_PREFIX")),
            "{errors:?}"
        );
    }

    /// `route.page.v2` is the page half of the v2 contract: the kind the shell
    /// already renders, now with a surface on it. It must follow exactly the v2
    /// rules, not the legacy page rules.
    #[test]
    fn route_page_v2_is_a_v2_kind_with_the_same_surface_rules() {
        let admin: FrontendContribution = serde_json::from_str(
            r#"{"kind":"route.page.v2","id":"hello-page","path":"/admin/ext/opsweave.hello/hello","surface":"admin"}"#,
        )
        .unwrap();
        assert_eq!(admin.kind, FrontendContributionKind::RoutePageV2);
        assert_eq!(admin.kind.as_str(), "route.page.v2");
        assert!(!admin.kind.is_v1(), "route.page.v2 is a v2 kind");
        assert_eq!(
            admin.validate_for_plugin("opsweave.hello"),
            Ok(ContributionSurface::Admin)
        );

        let workspace: FrontendContribution = serde_json::from_str(
            r#"{"kind":"route.page.v2","id":"hello-page","path":"/app/ext/opsweave.hello/hello","surface":"workspace"}"#,
        )
        .unwrap();
        assert_eq!(
            workspace.validate_for_plugin("opsweave.hello"),
            Ok(ContributionSurface::Workspace)
        );

        // surface is mandatory for a v2 page, and the rejection names the kind
        // the manifest actually declared.
        let anonymous = FrontendContribution {
            surface: None,
            ..admin.clone()
        };
        let rejection = anonymous
            .validate_for_plugin("opsweave.hello")
            .expect_err("a v2 page must declare its surface");
        assert_eq!(rejection.code, ContributionRejectionCode::MissingSurface);
        assert_eq!(rejection.kind, "route.page.v2");

        let escaped = FrontendContribution {
            path: "/admin/ext/opsweave.other/hello".into(),
            ..admin.clone()
        };
        assert_eq!(
            escaped
                .validate_for_plugin("opsweave.hello")
                .unwrap_err()
                .code,
            ContributionRejectionCode::NamespaceEscape
        );

        let traversal = FrontendContribution {
            path: "/admin/ext/opsweave.hello/../opsweave.other/hello".into(),
            ..admin
        };
        assert_eq!(
            traversal
                .validate_for_plugin("opsweave.hello")
                .unwrap_err()
                .code,
            ContributionRejectionCode::InvalidPath
        );

        // The v2 field set is the v2 field set: what the v1 page kind refuses as
        // UNEXPECTED_FIELD is legal here.
        let tagged = FrontendContribution {
            title_key: Some("hello.page.title".into()),
            required_capabilities: vec![CAPABILITY_PLATFORM_ACCESS.to_string()],
            ..workspace
        };
        assert_eq!(
            tagged.validate_for_plugin("opsweave.hello"),
            Ok(ContributionSurface::Workspace)
        );
    }

    /// Both generations share one segment rule: a `.`/`..` segment is refused,
    /// while the `/ext/<publisher>/<name>` shape already signed v1 bundles ship
    /// keeps being accepted unchanged.
    #[test]
    fn v1_path_refuses_traversal_but_keeps_signed_paths_valid() {
        for path in [
            "/ext/trusted-team/../admin",
            "/ext/trusted-team/./hello",
            "/ext/trusted-team/hello/../../app/ext/other",
        ] {
            for kind in [
                FrontendContributionKind::RoutePage,
                FrontendContributionKind::NavigationItem,
                FrontendContributionKind::SettingsSection,
            ] {
                let contribution = FrontendContribution {
                    kind,
                    id: "hello-nav".into(),
                    path: path.into(),
                    surface: None,
                    title_key: None,
                    required_capabilities: vec![],
                };
                let rejection = contribution
                    .validate_for_plugin("opsweave.hello")
                    .expect_err("a v1 path may not traverse");
                assert_eq!(
                    rejection.code,
                    ContributionRejectionCode::InvalidPath,
                    "{path}"
                );
            }
        }

        // The exact path the pinned v1 manifest ships is still a valid page.
        let signed: FrontendContribution = serde_json::from_str(
            r#"{"kind":"route.page.v1","id":"hello-page","path":"/ext/trusted-team/hello"}"#,
        )
        .unwrap();
        assert_eq!(
            signed.validate_for_plugin("opsweave.hello"),
            Ok(ContributionSurface::Admin)
        );
    }
}
