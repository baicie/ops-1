use chrono::{DateTime, SecondsFormat, Utc};
use opsweave_contracts::Role;
use std::collections::HashMap;
use std::env;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    pub database_url: String,
    pub data_dir: PathBuf,
    pub web_dist: PathBuf,
    pub public_url: String,
    pub bootstrap_admin_email: Option<String>,
    pub bootstrap_admin_password: Option<String>,
    pub bootstrap_admin_name: String,
    /// Roles whose sessions are declared eligible for the Admin Console surface
    /// (platform:access) by GET /api/v1/auth/me. admin is always part of the set;
    /// OPSWEAVE_ADMIN_SURFACE_ROLES may only widen it.
    pub admin_surface_roles: Vec<Role>,
    pub dev_publisher_id: String,
    pub dev_publisher_public_key: Option<String>,
    pub session_hours: i64,
    pub heartbeat_interval_seconds: u32,
    pub node_stale_seconds: i64,
    pub workload_token_seconds: i64,
    pub workload_token_refresh_grace_seconds: i64,
    pub max_instances_per_node: u32,
    pub request_timeout_seconds: u64,
    pub allow_insecure_node_transport: bool,
    pub allowed_node_data_hosts: Vec<String>,
    pub trusted_proxy_ips: Vec<String>,
    /// The only identities that may produce SOURCE_ATTESTED evidence (G12 A1).
    ///
    /// adapter id -> HMAC secret. An empty map is the safe default: with no
    /// adapter configured nothing can be attested, and the Kernel says so rather
    /// than accepting a claim. The secrets are never logged, never returned by an
    /// endpoint and never written to the database - only the adapter id is stored
    /// on the evidence row it vouched for.
    pub evidence_adapters: HashMap<String, String>,
    /// Per-plugin secret material, keyed by plugin id and then by the
    /// `secretref:` handle the plugin stores. The Kernel hands a plugin only its
    /// own map; the global map never reaches an instance environment.
    ///
    /// Delivery is an environment variable, which is visible to the container
    /// process and to anyone who can `docker inspect`. That is a weaker boundary
    /// than a dedicated secret store; the threat model is recorded in
    /// docs/design/g13-source-evidence/g13-a1-security-runtime-closure.md.
    pub plugin_secrets: HashMap<String, HashMap<String, HashMap<String, String>>>,
    /// The endpoint each (plugin, workspace, secretref) may be sent to. Metadata,
    /// not secret material: the plugin checks it before every outbound call.
    pub plugin_credential_bindings:
        HashMap<String, HashMap<String, HashMap<String, CredentialBinding>>>,
    /// Sources enrolled for automation, from `OPSWEAVE_AUTOMATION_SOURCES`.
    ///
    /// The Kernel, not the plugin, decides which workspace a source belongs to.
    /// Endpoint and TLS are NOT duplicated here: the registry copies them from
    /// the matching credential binding at sync time, so the two cannot disagree.
    /// This is metadata only and enables no endpoint; B1 slice 2 adds issuance.
    pub automation_sources: Vec<AutomationSource>,
    /// Explicitly enables plaintext/disabled-TLS test endpoints. Production
    /// leaves this false; a binding with `tls: TEST_PLAINTEXT` is still required.
    pub allow_insecure_source_endpoints: bool,
    /// Which plugin may receive which evidence adapter's signing key. An adapter
    /// with no entry is not delivered to any plugin, so a collector cannot sign
    /// as an adapter nobody assigned it.
    pub evidence_adapter_plugins: HashMap<String, String>,
    /// Which provider an investigation uses when its request names none. The default
    /// is the deterministic test fixture, because shipping a default that pointed at a
    /// paid model would spend money nobody asked to spend.
    pub investigation_default_provider: String,
    /// Related-context sources THIS deployment authorises for get_related_context.
    ///
    /// Empty is the shipped posture, and it means the tool refuses with
    /// SOURCE_UNAVAILABLE instead of answering an empty page: an empty page would be a
    /// fabricated success for a source that was never read.
    pub investigation_related_sources: Vec<String>,
    /// The real provider, when this deployment has one. All three or nothing: a
    /// half-configured provider is a future outage, and resolve_provider refuses it.
    /// The credential is only ever NAMED here - the value is read from the environment
    /// at request time and never stored.
    pub investigation_http_base_url: Option<String>,
    pub investigation_http_model: Option<String>,
    pub investigation_http_display_name: String,
    pub investigation_http_credential_env: Option<String>,
    /// Millionths of the account currency per million tokens, when the deployment knows
    /// what a token costs. Absent means the kernel records tokens and claims no price.
    pub investigation_price_micros_per_mtok: Option<i64>,
    pub plugin_db_host: String,
    #[allow(dead_code)]
    #[allow(dead_code)]
    pub plugin_kernel_url: String,
    pub plugin_source_allowed_hosts: String,
    /// Full 40-char lowercase commit SHA of the running build; absent when the
    /// build did not record one.
    pub build_sha: Option<String>,
    /// RFC 3339 timestamp of the running build, normalized to UTC seconds.
    pub build_time: Option<String>,
    pub environment: Environment,
    /// Wall-clock instant this process read its configuration, i.e. kernel start.
    pub started_at: DateTime<Utc>,
}

impl Config {
    pub fn from_env() -> Self {
        let _ = dotenvy::dotenv();
        Self {
            bind: env_string("OPSWEAVE_BIND", "127.0.0.1:8081"),
            database_url: env_string(
                "DATABASE_URL",
                "postgres://localhost/opsweave?sslmode=disable",
            ),
            data_dir: PathBuf::from(env_string("OPSWEAVE_DATA_DIR", "./data")),
            web_dist: PathBuf::from(env_string("OPSWEAVE_WEB_DIST", "apps/platform-web/dist")),
            public_url: env_string("OPSWEAVE_PUBLIC_URL", "http://127.0.0.1:8081"),
            bootstrap_admin_email: env::var("OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            bootstrap_admin_password: env::var("OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            bootstrap_admin_name: env_string("OPSWEAVE_BOOTSTRAP_ADMIN_NAME", "Platform Admin"),
            admin_surface_roles: parse_admin_surface_roles(&env_string(
                "OPSWEAVE_ADMIN_SURFACE_ROLES",
                DEFAULT_ADMIN_SURFACE_ROLES,
            )),
            dev_publisher_id: env_string("OPSWEAVE_DEV_PUBLISHER_ID", "trusted-team"),
            dev_publisher_public_key: env::var("OPSWEAVE_DEV_PUBLISHER_PUBLIC_KEY")
                .ok()
                .filter(|value| !value.trim().is_empty()),
            session_hours: env_i64("OPSWEAVE_SESSION_HOURS", 12),
            heartbeat_interval_seconds: env_i64("OPSWEAVE_NODE_HEARTBEAT_SECONDS", 5) as u32,
            node_stale_seconds: env_i64("OPSWEAVE_NODE_STALE_SECONDS", 25),
            workload_token_seconds: env_i64("OPSWEAVE_WORKLOAD_TOKEN_SECONDS", 3600).max(1),
            workload_token_refresh_grace_seconds: env_i64(
                "OPSWEAVE_WORKLOAD_TOKEN_REFRESH_GRACE_SECONDS",
                300,
            )
            .max(1),
            max_instances_per_node: env_i64("OPSWEAVE_MAX_INSTANCES_PER_NODE", 4) as u32,
            request_timeout_seconds: env_i64("OPSWEAVE_REQUEST_TIMEOUT_SECONDS", 10) as u64,
            allow_insecure_node_transport: env_bool(
                "OPSWEAVE_ALLOW_INSECURE_NODE_TRANSPORT",
                false,
            ),
            allowed_node_data_hosts: env_list(
                "OPSWEAVE_ALLOWED_NODE_DATA_HOSTS",
                "127.0.0.1,localhost,::1",
            ),
            trusted_proxy_ips: env_list("OPSWEAVE_TRUSTED_PROXY_IPS", ""),
            evidence_adapters: parse_evidence_adapters(&env_string(
                "OPSWEAVE_EVIDENCE_ADAPTERS",
                "",
            )),
            plugin_secrets: parse_plugin_secrets(&env_string("OPSWEAVE_PLUGIN_SECRETS", "")),
            plugin_credential_bindings: parse_credential_bindings(&env_string(
                "OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS",
                "",
            )),
            automation_sources: parse_automation_sources(&env_string(
                "OPSWEAVE_AUTOMATION_SOURCES",
                "",
            )),
            allow_insecure_source_endpoints: env_bool(
                "OPSWEAVE_ALLOW_INSECURE_SOURCE_ENDPOINTS",
                false,
            ),
            evidence_adapter_plugins: parse_adapter_plugins(&env_string(
                "OPSWEAVE_EVIDENCE_ADAPTER_PLUGINS",
                "",
            )),
            investigation_default_provider: env_string(
                "OPSWEAVE_INVESTIGATION_PROVIDER",
                "test-fixture-v1",
            ),
            investigation_related_sources: env_list("OPSWEAVE_INVESTIGATION_RELATED_SOURCES", ""),
            investigation_http_base_url: env_optional("OPSWEAVE_INVESTIGATION_PROVIDER_BASE_URL"),
            investigation_http_model: env_optional("OPSWEAVE_INVESTIGATION_PROVIDER_MODEL"),
            investigation_http_display_name: env_string(
                "OPSWEAVE_INVESTIGATION_PROVIDER_NAME",
                "Configured model provider",
            ),
            investigation_http_credential_env: env_optional(
                "OPSWEAVE_INVESTIGATION_PROVIDER_CREDENTIAL_ENV",
            ),
            investigation_price_micros_per_mtok: env::var(
                "OPSWEAVE_INVESTIGATION_PRICE_MICROS_PER_MTOKEN",
            )
            .ok()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .filter(|value| *value >= 0),
            plugin_db_host: env_string("OPSWEAVE_PLUGIN_DB_HOST", "host.docker.internal"),
            plugin_kernel_url: env_string(
                "OPSWEAVE_PLUGIN_KERNEL_URL",
                "http://host.docker.internal:18181",
            ),
            plugin_source_allowed_hosts: env_string("OPSWEAVE_PLUGIN_SOURCE_ALLOWED_HOSTS", ""),
            build_sha: parse_build_sha(&env_string("OPSWEAVE_BUILD_SHA", "")),
            build_time: parse_build_time(&env_string("OPSWEAVE_BUILD_TIME", "")),
            environment: Environment::from_env(),
            started_at: Utc::now(),
        }
    }

    pub fn secure_cookies(&self) -> bool {
        self.public_url.starts_with("https://")
    }
}

/// Deployment environment reported by `GET /api/v1/version`.
///
/// Only the four contract members are ever emitted; any other value is reported
/// as UNKNOWN rather than echoed back to the browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Environment {
    Staging,
    Development,
    Production,
    Unknown,
}

impl Environment {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Staging => "STAGING",
            Self::Development => "DEVELOPMENT",
            Self::Production => "PRODUCTION",
            Self::Unknown => "UNKNOWN",
        }
    }

    fn from_env() -> Self {
        parse_environment(&env_string("OPSWEAVE_ENVIRONMENT", ""))
    }
}

/// Case-insensitive mapping onto the contract members; anything else is UNKNOWN.
fn parse_environment(raw: &str) -> Environment {
    match raw.trim().to_ascii_uppercase().as_str() {
        "STAGING" => Environment::Staging,
        "DEVELOPMENT" => Environment::Development,
        "PRODUCTION" => Environment::Production,
        _ => Environment::Unknown,
    }
}

/// A commit SHA is only trusted as a full lowercase 40-char git digest; anything
/// else (branch name, tag, typo, injected junk) is reported as absent.
fn parse_build_sha(raw: &str) -> Option<String> {
    let value = raw.trim();
    let valid = value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    valid.then(|| value.to_string())
}

/// `buildTime` must parse as RFC 3339; it is re-emitted in UTC so an
/// unparsable or ambiguous value can never reach the browser.
fn parse_build_time(raw: &str) -> Option<String> {
    let value = raw.trim();
    DateTime::parse_from_rfc3339(value).ok().map(|parsed| {
        parsed
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Secs, true)
    })
}

/// Default of `OPSWEAVE_ADMIN_SURFACE_ROLES`: only `admin` is declared
/// eligible for the Admin Console surface.
pub const DEFAULT_ADMIN_SURFACE_ROLES: &str = "admin";

pub fn default_admin_surface_roles() -> Vec<Role> {
    vec![Role::Admin]
}

/// Resolves the Admin Console surface role set from the raw environment value.
///
/// Fails closed: an unknown token, a value that yields no role at all, or an
/// empty value all fall back to the default `admin`-only set and log a warning,
/// so a typo can never silently widen the surface. The only supported override
/// is widening to further roles (for example `operator`), and any override is
/// logged at startup so an audit can see it.
pub fn parse_admin_surface_roles(raw: &str) -> Vec<Role> {
    let mut roles: Vec<Role> = Vec::new();
    let mut unknown: Vec<String> = Vec::new();
    for token in raw.split(',') {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        match token.to_ascii_lowercase().parse::<Role>() {
            Ok(role) => {
                if !roles.contains(&role) {
                    roles.push(role);
                }
            }
            Err(_) => unknown.push(token.to_string()),
        }
    }
    if !unknown.is_empty() || roles.is_empty() {
        tracing::warn!(
            value = %raw,
            unknown = ?unknown,
            "OPSWEAVE_ADMIN_SURFACE_ROLES is invalid; failing closed to the default admin-only admin surface"
        );
        return default_admin_surface_roles();
    }
    // Misconfiguration must never lock platform admins out of the Admin Console:
    // the variable may widen the surface, never remove the admin role from it.
    if !roles.contains(&Role::Admin) {
        roles.push(Role::Admin);
    }
    if roles != default_admin_surface_roles() {
        tracing::info!(
            roles = ?roles,
            "OPSWEAVE_ADMIN_SURFACE_ROLES widens the Admin Console surface"
        );
    }
    roles
}

/// OPSWEAVE_EVIDENCE_ADAPTERS: comma-separated adapterId:secret pairs.
///
/// A malformed entry is dropped with a warning instead of failing the process,
/// because the fail-safe direction here is "fewer adapters than configured",
/// never "the Kernel refuses to start". Dropping an adapter can only lose an
/// attestation capability; it can never grant one.
/// `{"plugin.id":{"<workspace-uuid>":{"secretref:name":"value"}}}`
///
/// The workspace level is mandatory. A flat plugin→ref map let a source in
/// workspace A name a ref that belonged to B, and the plugin would send B's
/// token to A's endpoint: the credential crossed the boundary even though the
/// evidence could not. Malformed or flat input yields an empty map (fail
/// closed). It is never logged, returned to a user, or written to the database.
pub fn parse_plugin_secrets(
    raw: &str,
) -> HashMap<String, HashMap<String, HashMap<String, String>>> {
    if raw.trim().is_empty() {
        return HashMap::new();
    }
    match serde_json::from_str(raw) {
        Ok(parsed) => parsed,
        Err(error) => {
            tracing::warn!(error = %error, "OPSWEAVE_PLUGIN_SECRETS is not valid JSON; no plugin secrets were loaded");
            HashMap::new()
        }
    }
}

/// `adapterId:pluginId,adapterId2:pluginId2`
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialBinding {
    pub endpoint: String,
    pub tls: String,
}

/// One source enrolled for automation. `state` is READY or DISABLED; a missing
/// credential binding or an unsafe TLS policy turns it into INVALID in the
/// registry rather than dropping it silently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationSource {
    pub source_id: uuid::Uuid,
    pub workspace_id: uuid::Uuid,
    pub plugin_id: String,
    pub secret_ref: String,
    pub state: String,
}

/// `{"plugin.id":{"<workspace-uuid>":{"secretref:name":{"endpoint":"https://...","tls":"VERIFY"}}}}`
///
/// Malformed input yields an empty map: the plugin then refuses to use any
/// credential (fail closed). This map is delivered as metadata; it contains no
/// token.
pub fn parse_credential_bindings(
    raw: &str,
) -> HashMap<String, HashMap<String, HashMap<String, CredentialBinding>>> {
    if raw.trim().is_empty() {
        return HashMap::new();
    }
    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(error = %error, "OPSWEAVE_PLUGIN_CREDENTIAL_BINDINGS is not valid; no credential bindings were loaded");
            return HashMap::new();
        }
    };
    let Some(plugins) = value.as_object() else {
        return HashMap::new();
    };
    let mut out = HashMap::new();
    for (plugin, workspaces) in plugins {
        let Some(workspaces) = workspaces.as_object() else {
            continue;
        };
        let mut per_workspace = HashMap::new();
        for (workspace, refs) in workspaces {
            if uuid::Uuid::parse_str(workspace).is_err() {
                continue;
            }
            let Some(refs) = refs.as_object() else {
                continue;
            };
            let mut per_ref = HashMap::new();
            for (reference, binding) in refs {
                if !reference.starts_with("secretref:") {
                    continue;
                }
                let (Some(endpoint), Some(tls)) = (
                    binding.get("endpoint").and_then(|value| value.as_str()),
                    binding.get("tls").and_then(|value| value.as_str()),
                ) else {
                    continue;
                };
                if !matches!(tls, "VERIFY" | "TEST_PLAINTEXT") {
                    continue;
                }
                // Reject what the plugin would reject anyway: a binding that
                // carries userinfo/query/fragment is not an endpoint this
                // Kernel should inject into an environment.
                let Ok(url) = url::Url::parse(endpoint) else {
                    continue;
                };
                if !matches!(url.scheme(), "http" | "https")
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    continue;
                }
                per_ref.insert(
                    reference.clone(),
                    CredentialBinding {
                        endpoint: endpoint.to_string(),
                        tls: tls.to_string(),
                    },
                );
            }
            if !per_ref.is_empty() {
                per_workspace.insert(workspace.to_lowercase(), per_ref);
            }
        }
        if !per_workspace.is_empty() {
            out.insert(plugin.clone(), per_workspace);
        }
    }
    out
}
/// `{"<plugin>":{"<workspace-uuid>":{"<source-uuid>":{"secretRef":"secretref:x","state":"READY"}}}}`
///
/// The workspace is named by the Kernel's deployment configuration, not by the
/// plugin at runtime. Malformed entries and duplicate source ids are dropped
/// (fail closed); an unsafe or missing binding is not dropped here, it becomes
/// INVALID in the registry so the misconfiguration is visible.
pub fn parse_automation_sources(raw: &str) -> Vec<AutomationSource> {
    if raw.trim().is_empty() {
        return Vec::new();
    }
    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(error = %error, "OPSWEAVE_AUTOMATION_SOURCES is not valid; no sources were enrolled");
            return Vec::new();
        }
    };
    let Some(plugins) = value.as_object() else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (plugin_id, workspaces) in plugins {
        let plugin_id = plugin_id.trim();
        if plugin_id.is_empty() || plugin_id.len() > 200 {
            continue;
        }
        let Some(workspaces) = workspaces.as_object() else {
            continue;
        };
        for (workspace, sources) in workspaces {
            let Ok(workspace_id) = uuid::Uuid::parse_str(workspace) else {
                continue;
            };
            let Some(sources) = sources.as_object() else {
                continue;
            };
            for (source, entry) in sources {
                let Ok(source_id) = uuid::Uuid::parse_str(source) else {
                    continue;
                };
                let Some(secret_ref) = entry.get("secretRef").and_then(|value| value.as_str())
                else {
                    continue;
                };
                let Some(state) = entry.get("state").and_then(|value| value.as_str()) else {
                    continue;
                };
                if !secret_ref.starts_with("secretref:") || !matches!(state, "READY" | "DISABLED") {
                    continue;
                }
                if !seen.insert(source_id) {
                    tracing::warn!(
                        source_id = %source_id,
                        "OPSWEAVE_AUTOMATION_SOURCES names the same source twice; keeping the first"
                    );
                    continue;
                }
                out.push(AutomationSource {
                    source_id,
                    workspace_id,
                    plugin_id: plugin_id.to_string(),
                    secret_ref: secret_ref.to_string(),
                    state: state.to_string(),
                });
            }
        }
    }
    out
}

pub fn parse_adapter_plugins(raw: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for entry in raw.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let Some((adapter, plugin)) = entry.split_once(':') else {
            tracing::warn!("OPSWEAVE_EVIDENCE_ADAPTER_PLUGINS entry has no ':' separator; ignored");
            continue;
        };
        let (adapter, plugin) = (adapter.trim(), plugin.trim());
        if adapter.is_empty() || plugin.is_empty() {
            tracing::warn!("OPSWEAVE_EVIDENCE_ADAPTER_PLUGINS entry is empty; ignored");
            continue;
        }
        if map
            .insert(adapter.to_string(), plugin.to_string())
            .is_some()
        {
            tracing::warn!(adapter, "OPSWEAVE_EVIDENCE_ADAPTER_PLUGINS declares this adapter twice; the last entry wins");
        }
    }
    map
}

pub fn parse_evidence_adapters(raw: &str) -> HashMap<String, String> {
    let mut adapters = HashMap::new();
    for entry in raw.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let Some((id, secret)) = entry.split_once(':') else {
            tracing::warn!("OPSWEAVE_EVIDENCE_ADAPTERS entry has no ':' separator; ignored");
            continue;
        };
        let id = id.trim();
        let secret = secret.trim();
        if id.is_empty() || id.chars().count() > 100 || secret.is_empty() {
            tracing::warn!(
                "OPSWEAVE_EVIDENCE_ADAPTERS entry is malformed (id 1..100 chars, non-empty secret); ignored"
            );
            continue;
        }
        if adapters
            .insert(id.to_string(), secret.to_string())
            .is_some()
        {
            tracing::warn!(
                adapter = id,
                "OPSWEAVE_EVIDENCE_ADAPTERS declares this adapter twice; the last secret wins"
            );
        }
    }
    if !adapters.is_empty() {
        tracing::info!(
            adapters = ?adapters.keys().collect::<Vec<_>>(),
            "source adapters configured to produce attested evidence"
        );
    }
    adapters
}

fn env_string(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn env_bool(key: &str, default: bool) -> bool {
    env::var(key)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes"
            )
        })
        .unwrap_or(default)
}

fn env_list(key: &str, default: &str) -> Vec<String> {
    env::var(key)
        .unwrap_or_else(|_| default.to_string())
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
        .collect()
}

/// An environment value that is absent when unset, empty or whitespace.
///
/// Distinct from env_string: a present-but-empty variable is a deployment mistake, and
/// an empty endpoint is not a configured endpoint.
fn env_optional(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_i64(key: &str, default: i64) -> i64 {
    env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::{
        parse_adapter_plugins, parse_admin_surface_roles, parse_automation_sources,
        parse_build_sha, parse_build_time, parse_credential_bindings, parse_environment,
        parse_plugin_secrets, Environment,
    };
    use opsweave_contracts::Role;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn build_sha_requires_a_full_lowercase_hex_digest() {
        assert_eq!(parse_build_sha(SHA).as_deref(), Some(SHA));
        assert_eq!(parse_build_sha(&format!("  {SHA}\n")).as_deref(), Some(SHA));
        assert_eq!(parse_build_sha(""), None);
        assert_eq!(parse_build_sha("main"), None);
        assert_eq!(parse_build_sha(&SHA.to_uppercase()), None);
        assert_eq!(parse_build_sha(&SHA[..39]), None);
        assert_eq!(parse_build_sha(&format!("{SHA}0")), None);
        assert_eq!(parse_build_sha(&format!("{}z", &SHA[..39])), None);
    }

    #[test]
    fn environment_maps_only_contract_members_and_is_case_insensitive() {
        assert_eq!(parse_environment("production"), Environment::Production);
        assert_eq!(parse_environment("Production"), Environment::Production);
        assert_eq!(parse_environment("PRODUCTION"), Environment::Production);
        assert_eq!(parse_environment("  production\n"), Environment::Production);
        assert_eq!(parse_environment("staging"), Environment::Staging);
        assert_eq!(parse_environment("Development"), Environment::Development);
        assert_eq!(parse_environment(""), Environment::Unknown);
        assert_eq!(parse_environment("prod"), Environment::Unknown);
        assert_eq!(parse_environment("preview"), Environment::Unknown);
        assert_eq!(Environment::Production.as_str(), "PRODUCTION");
    }

    #[test]
    fn build_time_is_normalized_to_utc_or_dropped() {
        assert_eq!(
            parse_build_time("2026-10-28T15:29:00Z").as_deref(),
            Some("2026-10-28T15:29:00Z")
        );
        assert_eq!(
            parse_build_time("2026-10-28T23:29:00+08:00").as_deref(),
            Some("2026-10-28T15:29:00Z")
        );
        assert_eq!(parse_build_time(""), None);
        assert_eq!(parse_build_time("not-a-timestamp"), None);
        assert_eq!(parse_build_time("2026-10-28"), None);
    }

    #[test]
    fn admin_surface_roles_default_to_admin_only() {
        assert_eq!(parse_admin_surface_roles("admin"), vec![Role::Admin]);
        assert_eq!(parse_admin_surface_roles(" ADMIN "), vec![Role::Admin]);
        assert_eq!(parse_admin_surface_roles("admin,admin"), vec![Role::Admin]);
    }

    #[test]
    fn admin_surface_roles_env_can_widen_to_operator() {
        assert_eq!(
            parse_admin_surface_roles("operator"),
            vec![Role::Operator, Role::Admin]
        );
        assert_eq!(
            parse_admin_surface_roles("admin,operator"),
            vec![Role::Admin, Role::Operator]
        );
        assert_eq!(
            parse_admin_surface_roles("Operator , Admin"),
            vec![Role::Operator, Role::Admin]
        );
    }

    #[test]
    fn invalid_admin_surface_roles_fail_closed_to_admin_only() {
        for raw in [
            "",
            "   ",
            ",,",
            "root",
            "admin operator",
            "admin;operator",
            // A widened set that also contains an unknown token is rejected as a
            // whole: the valid token is never partially honoured.
            "operator,root",
        ] {
            assert_eq!(
                parse_admin_surface_roles(raw),
                vec![Role::Admin],
                "raw={raw:?}"
            );
        }
    }

    #[test]
    fn admin_surface_roles_cannot_lock_admins_out() {
        assert_eq!(
            parse_admin_surface_roles("viewer"),
            vec![Role::Viewer, Role::Admin]
        );
    }

    #[test]
    fn plugin_secrets_are_parsed_and_malformed_input_fails_closed() {
        let parsed = parse_plugin_secrets(
            r#"{"a.plugin":{"00000000-0000-4000-8000-00000000000a":{"secretref:db":"value"}}}"#,
        );
        assert_eq!(
            parsed["a.plugin"]["00000000-0000-4000-8000-00000000000a"]["secretref:db"],
            "value"
        );
        // A flat map is the P0 shape: one workspace could name another's ref.
        // It must be rejected rather than silently accepted.
        assert!(parse_plugin_secrets(r#"{"a.plugin":{"secretref:db":"value"}}"#).is_empty());
        assert!(parse_plugin_secrets("{not json").is_empty());
        assert!(parse_plugin_secrets("").is_empty());
    }

    #[test]
    fn credential_bindings_are_parsed_and_malformed_input_fails_closed() {
        let raw = r#"{"a.plugin":{"00000000-0000-4000-8000-00000000000a":{"secretref:a":{"endpoint":"https://zabbix.example/api_jsonrpc.php","tls":"VERIFY"}}}}"#;
        let parsed = parse_credential_bindings(raw);
        assert_eq!(
            parsed["a.plugin"]["00000000-0000-4000-8000-00000000000a"]["secretref:a"].endpoint,
            "https://zabbix.example/api_jsonrpc.php"
        );
        assert!(parse_credential_bindings("{not json").is_empty());
        let userinfo = r#"{"a.plugin":{"00000000-0000-4000-8000-00000000000a":{"secretref:a":{"endpoint":"https://user:pw@zabbix.example/api_jsonrpc.php","tls":"VERIFY"}}}}"#;
        assert!(parse_credential_bindings(userinfo).is_empty());
        let bad_tls = r#"{"a.plugin":{"00000000-0000-4000-8000-00000000000a":{"secretref:a":{"endpoint":"https://zabbix.example/api_jsonrpc.php","tls":"INSECURE"}}}}"#;
        assert!(parse_credential_bindings(bad_tls).is_empty());
    }

    #[test]
    fn automation_sources_are_kernel_scoped_and_deduplicated() {
        let workspace = "00000000-0000-4000-8000-00000000000a";
        let source = "00000000-0000-4000-8000-0000000000b1";
        // Not a UUID on purpose: the parser must skip it, not panic.
        let raw = format!(
            r#"{{"zabbix-source":{{"{workspace}":{{"{source}":{{"secretRef":"secretref:zabbix/main","state":"READY"}},"not-a-uuid":{{"secretRef":"secretref:x","state":"READY"}}}}}}}}"#
        );
        let parsed = parse_automation_sources(&raw);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].plugin_id, "zabbix-source");
        assert_eq!(parsed[0].secret_ref, "secretref:zabbix/main");
        assert_eq!(parsed[0].state, "READY");
        assert_eq!(parsed[0].source_id.to_string(), source);

        let bad_ref = format!(
            r#"{{"zabbix-source":{{"{workspace}":{{"{source}":{{"secretRef":"plain","state":"READY"}}}}}}}}"#
        );
        assert!(parse_automation_sources(&bad_ref).is_empty());
        let bad_state = format!(
            r#"{{"zabbix-source":{{"{workspace}":{{"{source}":{{"secretRef":"secretref:x","state":"ACTIVE"}}}}}}}}"#
        );
        assert!(parse_automation_sources(&bad_state).is_empty());
        assert!(parse_automation_sources("{not json").is_empty());

        let other_workspace = "00000000-0000-4000-8000-00000000000b";
        let duplicate = format!(
            r#"{{"zabbix-source":{{"{workspace}":{{"{source}":{{"secretRef":"secretref:x","state":"READY"}}}},"{other_workspace}":{{"{source}":{{"secretRef":"secretref:y","state":"READY"}}}}}}}}"#
        );
        assert_eq!(parse_automation_sources(&duplicate).len(), 1);
    }

    #[test]
    fn adapter_plugin_assignments_are_explicit() {
        let parsed = parse_adapter_plugins("zabbix-main:a.plugin,other:b.plugin");
        assert_eq!(parsed["zabbix-main"], "a.plugin");
        assert_eq!(parsed["other"], "b.plugin");
        assert!(parse_adapter_plugins("broken").is_empty());
    }
}
