use chrono::{DateTime, SecondsFormat, Utc};
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

fn env_i64(key: &str, default: i64) -> i64 {
    env::var(key)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::{parse_build_sha, parse_build_time, parse_environment, Environment};

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
}
