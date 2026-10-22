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
    pub max_instances_per_node: u32,
    pub request_timeout_seconds: u64,
    pub allow_insecure_node_transport: bool,
    pub allowed_node_data_hosts: Vec<String>,
    pub trusted_proxy_ips: Vec<String>,
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
        }
    }

    pub fn secure_cookies(&self) -> bool {
        self.public_url.starts_with("https://")
    }
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
