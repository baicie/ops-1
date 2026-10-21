use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use futures::StreamExt;
use opsweave_bundle::{
    build_bundle_from_dir, generate_signing_key, key_fingerprint, read_signing_key, verify_bundle,
    BundleLimits,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Parser)]
#[command(
    name = "opsctl",
    version,
    about = "OpsWeave recovery and plugin developer CLI"
)]
struct Cli {
    #[arg(long, env = "OPSWEAVE_URL", default_value = "http://127.0.0.1:18181")]
    url: String,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate an Ed25519 publisher keypair.
    Keygen {
        #[arg(long, default_value = "./keys")]
        out_dir: PathBuf,
    },
    /// Build a deterministic, signed plugin bundle from a directory.
    Bundle {
        #[arg(long)]
        dir: PathBuf,
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        key: PathBuf,
    },
    /// Authenticate and store a local session for opsctl.
    Login {
        #[arg(long)]
        email: String,
        #[arg(long)]
        password: String,
    },
    /// Platform status from the authorized overview API.
    Status,
    /// Bootstrap diagnostics, including DB connectivity and failure events.
    Doctor {
        #[arg(long)]
        json: bool,
    },
    /// List enrolled nodes.
    Nodes,
    /// Create a one-time node enrollment token.
    NodeToken {
        #[arg(long)]
        label: Option<String>,
        #[arg(long, default_value_t = 30)]
        ttl_minutes: i64,
    },
    /// List installed and available plugins.
    Plugins,
    /// Upload a signed plugin package (stages it; does not activate).
    Install { bundle: PathBuf },
    /// Create or update a deployment for a plugin version.
    Deploy {
        plugin: String,
        version: String,
        #[arg(long, default_value_t = 2)]
        replicas: i32,
        #[arg(long)]
        selector: Option<String>,
        #[arg(long)]
        wait: bool,
    },
    /// Activate a READY deployment after policy and dependency checks.
    Activate {
        plugin: String,
        version: String,
        #[arg(long)]
        expected_revision: Option<i64>,
    },
    /// Disable the active revision and stop routing to its instances.
    Disable {
        plugin: String,
        #[arg(long)]
        reason: Option<String>,
    },
    /// Request re-deployment of a disabled plugin.
    Enable { plugin: String },
    /// Roll back to a previously deployed version.
    Rollback {
        plugin: String,
        version: String,
        #[arg(long)]
        expected_revision: Option<i64>,
        #[arg(long, default_value_t = 2)]
        replicas: i32,
    },
    /// Uninstall a plugin while retaining its data.
    Uninstall { plugin: String },
    /// Stream an authorized instance log tail.
    Logs {
        instance: String,
        #[arg(long)]
        cursor: Option<String>,
    },
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredSession {
    url: String,
    token: String,
    csrf: String,
}

fn session_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".opsweave").join("session.json")
}

fn load_session() -> Result<StoredSession> {
    let path = session_path();
    let bytes = std::fs::read(&path).with_context(|| {
        format!(
            "no opsctl session at {}; run `opsctl login`",
            path.display()
        )
    })?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn save_session(session: &StoredSession) -> Result<()> {
    let path = session_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_vec_pretty(session)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

struct Api {
    client: reqwest::Client,
    session: StoredSession,
}

impl Api {
    fn new() -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()?,
            session: load_session()?,
        })
    }

    async fn get(&self, path: &str) -> Result<Value> {
        self.handle(
            self.client
                .get(format!("{}{}", self.session.url, path))
                .bearer_auth(&self.session.token)
                .header("x-csrf-token", &self.session.csrf)
                .send()
                .await?,
        )
        .await
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value> {
        let key = uuid::Uuid::new_v4().to_string();
        self.handle(
            self.client
                .post(format!("{}{}", self.session.url, path))
                .bearer_auth(&self.session.token)
                .header("x-csrf-token", &self.session.csrf)
                .header("idempotency-key", key)
                .json(&body)
                .send()
                .await?,
        )
        .await
    }

    async fn handle(&self, response: reqwest::Response) -> Result<Value> {
        let status = response.status();
        let body: Value = response.json().await.unwrap_or_else(|_| json!({}));
        if !status.is_success() {
            bail!(
                "API {} returned {}: {}",
                status,
                body.get("code").and_then(Value::as_str).unwrap_or("ERROR"),
                body.get("message").and_then(Value::as_str).unwrap_or("")
            );
        }
        Ok(body)
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Keygen { out_dir } => {
            std::fs::create_dir_all(&out_dir)?;
            let key = generate_signing_key();
            let seed = hex::encode(key.to_bytes());
            let public = hex::encode(key.verifying_key().to_bytes());
            std::fs::write(out_dir.join("publisher.key"), format!("{seed}\n"))?;
            std::fs::write(out_dir.join("publisher.pub"), format!("{public}\n"))?;
            std::fs::write(
                out_dir.join("publisher.fingerprint"),
                format!("{}\n", key_fingerprint(&key.verifying_key())),
            )?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(
                    out_dir.join("publisher.key"),
                    std::fs::Permissions::from_mode(0o600),
                );
            }
            println!("publisher key written to {}", out_dir.display());
            println!("public key: {public}");
            println!("fingerprint: {}", key_fingerprint(&key.verifying_key()));
        }
        Command::Bundle { dir, out, key } => {
            let signing_key = read_signing_key(&key)?;
            let bundle = build_bundle_from_dir(&dir, &signing_key, &BundleLimits::default())?;
            let verified = verify_bundle(
                &bundle,
                &signing_key.verifying_key(),
                &BundleLimits::default(),
            )?;
            std::fs::write(&out, &bundle)?;
            println!("bundle: {}", out.display());
            println!("bundleDigest: {}", verified.bundle_digest);
            println!("artifactDigest: {}", verified.artifact_digest);
            println!(
                "plugin: {}@{}",
                verified.manifest.id, verified.manifest.version
            );
        }
        Command::Login { email, password } => {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()?;
            let response = client
                .post(format!(
                    "{}/api/v1/auth/login",
                    cli.url.trim_end_matches('/')
                ))
                .json(&json!({"email": email, "password": password}))
                .send()
                .await?;
            let status = response.status();
            let cookies = response
                .headers()
                .get_all("set-cookie")
                .iter()
                .filter_map(|value| value.to_str().ok())
                .map(str::to_string)
                .collect::<Vec<_>>();
            let body: Value = response.json().await?;
            if !status.is_success() {
                bail!("login failed: {body}");
            }
            let token = cookies
                .iter()
                .find_map(|cookie| {
                    cookie
                        .strip_prefix("opsweave_session=")
                        .and_then(|rest| rest.split(';').next())
                        .map(str::to_string)
                })
                .ok_or_else(|| anyhow::anyhow!("login response did not set a session cookie"))?;
            let csrf = body
                .get("csrfToken")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("login response did not include csrfToken"))?;
            save_session(&StoredSession {
                url: cli.url.trim_end_matches('/').to_string(),
                token,
                csrf: csrf.to_string(),
            })?;
            println!("logged in to {}", cli.url);
        }
        Command::Status => {
            let api = Api::new()?;
            let overview = api.get("/api/v1/overview").await?;
            println!(
                "health={} nodes={}/{} plugins={} instances={}/{} activeDeployments={}",
                overview["health"].as_str().unwrap_or("UNKNOWN"),
                overview["nodesReady"],
                overview["nodesTotal"],
                overview["pluginsInstalled"],
                overview["instancesReady"],
                overview["instancesTotal"],
                overview["activeDeployments"]
            );
            if let Some(items) = overview["attention"].as_array() {
                for item in items {
                    println!(
                        "  [{}] {} — {}",
                        item["severity"].as_str().unwrap_or("info"),
                        item["title"].as_str().unwrap_or(""),
                        item["detail"].as_str().unwrap_or("")
                    );
                }
            }
        }
        Command::Doctor { json } => {
            let api = Api::new()?;
            let diagnostics = api.get("/api/v1/diagnostics").await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&diagnostics)?);
            } else {
                println!(
                    "kernel={} api=v{} database={} uptime={}s",
                    diagnostics["kernel"]["version"],
                    diagnostics["kernel"]["apiMajor"],
                    diagnostics["kernel"]["database"],
                    diagnostics["kernel"]["uptimeSeconds"]
                );
                println!(
                    "packages={} installedPlugins={} deployments={} readyInstances={}",
                    diagnostics["counts"]["packages"],
                    diagnostics["counts"]["installedPlugins"],
                    diagnostics["counts"]["deployments"],
                    diagnostics["counts"]["readyInstances"]
                );
                if let Some(nodes) = diagnostics["nodes"].as_array() {
                    for node in nodes {
                        println!(
                            "node {} {} status={} lastSeen={}",
                            node["name"], node["id"], node["status"], node["lastSeenAt"]
                        );
                    }
                }
                println!("recovery: opsctl status | opsctl nodes | opsctl plugins");
            }
        }
        Command::Nodes => {
            let api = Api::new()?;
            for node in api
                .get("/api/v1/nodes")
                .await?
                .as_array()
                .cloned()
                .unwrap_or_default()
            {
                println!(
                    "{} {} {} status={} stale={} instances={}/{}",
                    node["name"].as_str().unwrap_or(""),
                    node["id"].as_str().unwrap_or(""),
                    node["arch"].as_str().unwrap_or(""),
                    node["status"].as_str().unwrap_or(""),
                    node["stale"],
                    node["instancesReady"],
                    node["instancesTotal"]
                );
            }
        }
        Command::NodeToken { label, ttl_minutes } => {
            let api = Api::new()?;
            let result = api
                .post(
                    "/api/v1/nodes/enrollment-tokens",
                    json!({"label": label, "ttlMinutes": ttl_minutes}),
                )
                .await?;
            println!("{}", result["token"].as_str().unwrap_or(""));
            eprintln!("token expires at {}", result["expiresAt"]);
        }
        Command::Plugins => {
            let api = Api::new()?;
            for plugin in api
                .get("/api/v1/plugins")
                .await?
                .as_array()
                .cloned()
                .unwrap_or_default()
            {
                println!(
                    "{} {} active={} state={} replicas={}/{}",
                    plugin["id"].as_str().unwrap_or(""),
                    plugin["latestVersion"].as_str().unwrap_or("-"),
                    plugin["activeVersion"].as_str().unwrap_or("-"),
                    plugin["state"].as_str().unwrap_or(""),
                    plugin["readyInstances"],
                    plugin["totalInstances"]
                );
            }
        }
        Command::Install { bundle } => {
            let api = Api::new()?;
            let bytes = std::fs::read(&bundle)?;
            let response = api
                .client
                .post(format!("{}/api/v1/plugins/packages", api.session.url))
                .bearer_auth(&api.session.token)
                .header("x-csrf-token", &api.session.csrf)
                .header("idempotency-key", uuid::Uuid::new_v4().to_string())
                .header("content-type", "application/octet-stream")
                .body(bytes)
                .send()
                .await?;
            let result = api.handle(response).await?;
            println!(
                "staged {}@{} bundle={}",
                result["pluginId"].as_str().unwrap_or(""),
                result["version"].as_str().unwrap_or(""),
                result["bundleDigest"].as_str().unwrap_or("")
            );
        }
        Command::Deploy {
            plugin,
            version,
            replicas,
            selector,
            wait,
        } => {
            let api = Api::new()?;
            let mut node_selector = serde_json::Map::new();
            if let Some(selector) = selector {
                for pair in selector.split(',') {
                    if let Some((key, value)) = pair.split_once('=') {
                        node_selector.insert(key.trim().into(), Value::String(value.trim().into()));
                    }
                }
            }
            let result = api
                .post(
                    &format!("/api/v1/plugins/{plugin}/deployments"),
                    json!({
                        "version": version,
                        "desiredReplicas": replicas,
                        "nodeSelector": node_selector,
                        "maxInstancesPerNode": 1
                    }),
                )
                .await?;
            println!(
                "deployment {} status={} {}/{} ready",
                result["id"].as_str().unwrap_or(""),
                result["status"].as_str().unwrap_or(""),
                result["readyInstances"],
                result["totalInstances"]
            );
            if wait {
                wait_for_ready(&api, &plugin, &version, 300).await?;
            }
        }
        Command::Activate {
            plugin,
            version,
            expected_revision,
        } => {
            let api = Api::new()?;
            let expected = match expected_revision {
                Some(value) => value,
                None => {
                    let detail = api.get(&format!("/api/v1/plugins/{plugin}")).await?;
                    detail["activeRevision"]["generation"].as_i64().unwrap_or(0)
                }
            };
            let result = api
                .post(
                    &format!("/api/v1/plugins/{plugin}/activations"),
                    json!({"version": version, "expectedRevision": expected}),
                )
                .await?;
            println!(
                "activated {}@{} revision={} status={}",
                plugin,
                version,
                result["generation"],
                result["status"].as_str().unwrap_or("")
            );
        }
        Command::Disable { plugin, reason } => {
            let api = Api::new()?;
            let result = api
                .post(
                    &format!("/api/v1/plugins/{plugin}/disable"),
                    json!({"reason": reason}),
                )
                .await?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        Command::Enable { plugin } => {
            let api = Api::new()?;
            let result = api
                .post(&format!("/api/v1/plugins/{plugin}/enable"), json!({}))
                .await?;
            println!(
                "deployment {} status={} — wait for READY, then run opsctl activate",
                result["id"].as_str().unwrap_or(""),
                result["status"].as_str().unwrap_or("")
            );
        }
        Command::Rollback {
            plugin,
            version,
            expected_revision,
            replicas,
        } => {
            let api = Api::new()?;
            let expected = match expected_revision {
                Some(value) => value,
                None => {
                    let detail = api.get(&format!("/api/v1/plugins/{plugin}")).await?;
                    detail["activeRevision"]["generation"].as_i64().unwrap_or(0)
                }
            };
            let result = api
                .post(
                    &format!("/api/v1/plugins/{plugin}/rollback"),
                    json!({
                        "targetVersion": version,
                        "expectedRevision": expected,
                        "desiredReplicas": replicas
                    }),
                )
                .await?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        Command::Uninstall { plugin } => {
            let api = Api::new()?;
            let result = api
                .post(&format!("/api/v1/plugins/{plugin}/uninstall"), json!({}))
                .await?;
            println!("{}", serde_json::to_string_pretty(&result)?);
        }
        Command::Logs { instance, cursor } => {
            let api = Api::new()?;
            let url = match cursor {
                Some(cursor) => format!(
                    "{}/api/v1/instances/{}/logs/live?cursor={}",
                    api.session.url, instance, cursor
                ),
                None => format!(
                    "{}/api/v1/instances/{}/logs/live",
                    api.session.url, instance
                ),
            };
            let response = api
                .client
                .get(url)
                .bearer_auth(&api.session.token)
                .send()
                .await?;
            if !response.status().is_success() {
                let status = response.status();
                let body = response.text().await.unwrap_or_default();
                bail!("log stream failed ({status}): {body}");
            }
            let mut stream = response.bytes_stream();
            let mut buffer = String::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(index) = buffer.find("\n\n") {
                    let frame = buffer[..index].to_string();
                    buffer.drain(..index + 2);
                    let mut event = "message".to_string();
                    let mut data = String::new();
                    for line in frame.lines() {
                        if let Some(value) = line.strip_prefix("event: ") {
                            event = value.to_string();
                        } else if let Some(value) = line.strip_prefix("data: ") {
                            data.push_str(value);
                        }
                    }
                    if event == "log" {
                        if let Ok(value) = serde_json::from_str::<Value>(&data) {
                            println!(
                                "{} {} {}",
                                value["observedAt"].as_str().unwrap_or(""),
                                value["level"].as_str().unwrap_or(""),
                                value["message"].as_str().unwrap_or("")
                            );
                        }
                    } else if event == "gap" || event == "status" {
                        eprintln!("[{event}] {data}");
                    }
                }
            }
        }
    }
    Ok(())
}

async fn wait_for_ready(
    api: &Api,
    plugin: &str,
    version: &str,
    timeout_seconds: u64,
) -> Result<()> {
    let started = std::time::Instant::now();
    loop {
        let deployments = api
            .get(&format!("/api/v1/plugins/{plugin}/deployments"))
            .await?;
        if let Some(deployment) = deployments
            .as_array()
            .and_then(|items| items.iter().find(|item| item["version"] == version))
        {
            let status = deployment["status"].as_str().unwrap_or("");
            println!(
                "  {} {}/{} ready ({})",
                status,
                deployment["readyInstances"],
                deployment["totalInstances"],
                deployment["statusReason"].as_str().unwrap_or("")
            );
            if status == "READY" || status == "ACTIVE" {
                return Ok(());
            }
            // A transient DEGRADED state can occur while a Node restarts or a
            // replacement replica is being observed. Keep polling until the
            // bounded timeout; the command still fails if READY is never met.
            if status == "FAILED" && deployment["readyInstances"].as_i64().unwrap_or(0) == 0 {
                eprintln!("deployment is FAILED; still polling for operator visibility");
            }
        }
        if started.elapsed() > Duration::from_secs(timeout_seconds) {
            bail!("timed out waiting for deployment readiness");
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
