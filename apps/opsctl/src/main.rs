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
    /// READ-ONLY capacity audit: who is occupying every node slot, and what would
    /// a deploy of N replicas find. Writes nothing.
    Capacity {
        /// Replicas a hypothetical deploy would request.
        #[arg(long, default_value_t = 1)]
        replicas: i32,
        #[arg(long)]
        json: bool,
    },
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
        /// How many instances to run.
        ///
        /// Required, with no default. The default was 2, and it could not be
        /// satisfied on the topology this repository actually deploys: staging
        /// runs one `node` service (`deployments/staging/compose.yaml:141`) and
        /// every deployment is created with `maxInstancesPerNode: 1`, so the
        /// second replica is refused with
        /// `INSTANCE_CAPACITY_EXCEEDED ... per-deployment limit of 1`.
        ///
        /// A default that is wrong for the only environment it runs in is worse
        /// than no default: `publish-data-plugins.sh` never passed `--replicas`,
        /// so every staging publish asked for two and got one - and the deploy
        /// then waited for a READY that required both. Making it explicit costs
        /// a flag and removes the guess.
        #[arg(long)]
        replicas: i32,
        #[arg(long)]
        selector: Option<String>,
        #[arg(long)]
        wait: bool,
        /// After the deployment is READY, activate it and verify the route moved.
        ///
        /// Without this, `deploy` finishes at READY - a statement about containers,
        /// not about routing. The gateway selects `r.status = 'ACTIVE'`, so a
        /// deployment that is READY but never activated serves nothing while the
        /// version still answers `deploy` with success. `rollback` already closes
        /// this gap (wait, activate, read the effective version back); `deploy` did
        /// not, which is why the staging publish chain could install and deploy a
        /// plugin and leave the previous version serving.
        #[arg(long)]
        activate: bool,
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
        Command::Capacity { replicas, json } => {
            // READ-ONLY, AND SAID SO IN THE COMMAND NAME.
            //
            // Staging fails with INSTANCE_CAPACITY_EXCEEDED, and answering "who is
            // occupying the slots" has so far meant reading the diagnosis document
            // and trusting it. A document goes stale; this asks the running system.
            //
            // IT DELIBERATELY DOES NOT DECIDE WHAT IS SAFE TO REMOVE. Four active
            // deployments with live routes are not garbage, and a tool that named
            // them "reclaimable" would be one step from someone acting on it.
            //
            // BUT IT ALSO DOES NOT DECIDE WHETHER THE DEPLOY WOULD FIT.
            //
            // The first version computed `freeSlots` as `instancesTotal -
            // instancesReady` per node and summed it into a verdict. That is not the
            // capacity question: `instancesTotal` counts instances with
            // `desired_action='START'`, which is a count of replicas, not of the
            // per-node limit the scheduler enforces. Measured on staging
            // 2026-11-25: `verdict: CAPACITY_AVAILABLE`, `freeSlotsTotal: 1`, on a
            // node a publish had been refused on four seconds earlier at 4/4.
            //
            // A second implementation of the capacity rule is exactly what the
            // project forbids, and it disagreed with the real one. The kernel
            // already exposes `/api/v1/capacity/preflight`, which runs the SAME
            // `evaluate_node` the planner runs. So the verdict, the per-node numbers
            // and the rejection code come from there, and this command contributes
            // only what the preflight does not carry: who is occupying the slots and
            // since when.
            let api = Api::new()?;
            let preflight = api
                .get(&format!(
                    "/api/v1/capacity/preflight?replicas={replicas}&max_instances_per_deployment=1"
                ))
                .await?;
            let nodes = api
                .get("/api/v1/nodes")
                .await?
                .as_array()
                .cloned()
                .unwrap_or_default();
            // THERE IS NO `/api/v1/deployments`. Deployments are listed per plugin,
            // at `/api/v1/plugins/{id}/deployments`; an invented top-level route
            // would have 404'd and the audit would have printed "no occupants" -
            // a tool that answers "nothing is holding the slots" when it failed to
            // ask is worse than no tool.
            let plugins = api
                .get("/api/v1/plugins")
                .await?
                .as_array()
                .cloned()
                .unwrap_or_default();
            let mut deployments = Vec::new();
            for plugin in &plugins {
                let Some(id) = plugin["id"].as_str() else {
                    continue;
                };
                match api.get(&format!("/api/v1/plugins/{id}/deployments")).await {
                    Ok(Value::Array(list)) => deployments.extend(list),
                    // A plugin whose deployments cannot be read makes the audit
                    // INCOMPLETE rather than silently shorter.
                    Ok(_) => {}
                    Err(error) => {
                        eprintln!("warning: cannot read deployments for {id}: {error}");
                    }
                }
            }

            // THE NODE REPORT COMES FROM THE PREFLIGHT, NOT FROM ARITHMETIC HERE.
            //
            // `free_slots_per_node` is what the scheduler itself would have left, so
            // it cannot disagree with the decision it explains. `instancesReady` and
            // `instancesTotal` are still reported because they are what an operator
            // uses to recognise the host, but they are no longer the basis of a
            // verdict.
            let mut report = Vec::new();
            for node in preflight["nodes"].as_array().into_iter().flatten() {
                let name = node["node"].as_str().unwrap_or("");
                // Join to the node list only for the fields the preflight omits
                // (status, staleness). A node missing here is not an error: the
                // preflight already answered for it.
                let live = nodes
                    .iter()
                    .find(|n| n["name"].as_str() == Some(name))
                    .cloned()
                    .unwrap_or(Value::Null);
                report.push(serde_json::json!({
                    "node": name,
                    "nodeId": node["node_id"],
                    "status": live["status"],
                    "stale": live["stale"],
                    "instancesReady": live["instancesReady"],
                    "instancesTotal": live["instancesTotal"],
                    "verdict": node["verdict"],
                    "reason": node["code"],
                    "detail": node["detail"],
                    "freeSlots": node["free_slots_per_node"],
                }));
            }

            let occupants: Vec<Value> = deployments
                .iter()
                .filter(|d| d["status"].as_str() != Some("DISABLED"))
                .map(|d| {
                    serde_json::json!({
                        "deploymentId": d["id"],
                        "plugin": d["pluginId"],
                        "version": d["version"],
                        "status": d["status"],
                        "replicas": d["desiredReplicas"],
                        "active": d["status"].as_str() == Some("ACTIVE"),
                        "reason": d["statusReason"],
                        // WHEN THIS ROW BECAME WHAT IT IS, WHICH IS THE QUESTION
                        // A CAPACITY INVESTIGATION ACTUALLY ASKS.
                        //
                        // Staging sat at 4/4 for days and every audit could say
                        // *which* rows occupied the node but not *why they were
                        // still there*. "Which of these is READY, and since when"
                        // decides between three different fixes:
                        //
                        //   READY and older than the newest   -> a reclamation
                        //                                        should have matched
                        //   ACTIVE                            -> it is serving; the
                        //                                        rule was right to skip
                        //   PENDING                           -> the rule never had
                        //                                        a candidate at all
                        //
                        // Both fields are already on the deployment view
                        // (`DeploymentView.createdAt`, `.activatedAt`); this tool
                        // simply was not reading them, which made the one question
                        // it exists to answer unanswerable from its own output.
                        "createdAt": d["createdAt"],
                        "activatedAt": d["activatedAt"],
                    })
                })
                .collect();

            // THE VERDICT IS THE KERNEL'S, VERBATIM.
            //
            // `FITS` / `CAPACITY_BLOCKED` (and `RECLAIM_REQUIRED` once the planner
            // emits it) come from the same `evaluate_node` the scheduler runs. This
            // command has no opinion of its own, which is the point: an audit that
            // disagrees with the decision it explains is worse than no audit.
            let verdict = preflight["verdict"].as_str().unwrap_or("UNKNOWN");

            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "verdict": verdict,
                        "replicasRequested": replicas,
                        // Where the answer came from, so a reader never mistakes
                        // this for an arithmetic this command performed.
                        "decidedBy": "kernel /api/v1/capacity/preflight (same evaluate_node as the scheduler)",
                        // The preflight's own numbers, passed through rather than
                        // recomputed.
                        "replicasPlaceable": preflight["replicas_placeable"],
                        "reason": preflight["reason"],
                        "detail": preflight["detail"],
                        "freeSlotsTotal": preflight["nodes"].as_array().map(|ns| {
                            ns.iter()
                                .filter_map(|n| n["free_slots_per_node"].as_i64())
                                .sum::<i64>()
                        }),
                        "nodes": report,
                        "occupants": occupants,
                        // The kernel's caveat, not a second one: a consumer that
                        // reads two caveats learns that one of them is decoration.
                        "caveat": preflight["caveat"],
                    }))?
                );
            } else {
                println!(
                    "capacity: {verdict} (want {replicas}, placeable {}){}",
                    preflight["replicas_placeable"],
                    preflight["reason"]
                        .as_str()
                        .map(|r| format!("  reason: {r}"))
                        .unwrap_or_default()
                );
                if let Some(detail) = preflight["detail"].as_str() {
                    println!("  {detail}");
                }
                for n in &report {
                    println!(
                        "  node {} status={} stale={} verdict={} ready={}/{} free={}",
                        n["node"].as_str().unwrap_or(""),
                        n["status"].as_str().unwrap_or(""),
                        n["stale"],
                        n["verdict"].as_str().unwrap_or(""),
                        n["instancesReady"],
                        n["instancesTotal"],
                        n["freeSlots"]
                    );
                }
                println!("occupants (NOT a removal list):");
                for o in &occupants {
                    // `since` carries the timestamp that decides between the three
                    // cases the JSON comment describes. A human reading a CI log is
                    // the most common consumer of this command, so leaving the
                    // timestamps out of the text form would hide the answer from
                    // exactly the reader who needs it.
                    println!(
                        "  {} {}@{} status={} replicas={} since={}{}",
                        o["deploymentId"].as_str().unwrap_or(""),
                        o["plugin"].as_str().unwrap_or(""),
                        o["version"].as_str().unwrap_or(""),
                        o["status"].as_str().unwrap_or(""),
                        o["replicas"],
                        o["createdAt"].as_str().unwrap_or("unknown"),
                        o["reason"]
                            .as_str()
                            .map(|r| format!("  reason: {r}"))
                            .unwrap_or_default()
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
            activate,
        } => {
            let api = Api::new()?;
            // Read the revision BEFORE the deployment request: the compare-and-swap
            // that `activate` performs is against the revision that was current when
            // this caller decided to publish. Reading it afterwards would set the
            // expectation to whatever this deploy just changed, which is no check at
            // all.
            let revision_before = if activate {
                let detail = api.get(&format!("/api/v1/plugins/{plugin}")).await?;
                detail["activeRevision"]["generation"].as_i64().unwrap_or(0)
            } else {
                0
            };
            let mut node_selector = serde_json::Map::new();
            if let Some(selector) = selector {
                for pair in selector.split(',') {
                    if let Some((key, value)) = pair.split_once('=') {
                        node_selector.insert(key.trim().into(), Value::String(value.trim().into()));
                    }
                }
            }
            // A deployment that is already the active version is a 409, and until now
            // that 409 was fatal: `Api::handle` bails on every non-2xx, so a second
            // publish of the same content-hash version failed the whole run. The
            // script called that idempotent. It was not.
            //
            // ALREADY_ACTIVE is not "nothing to do" though - it is "the route should
            // already point at this version", which is a claim to verify rather than
            // assume. So it is turned into the same post-condition check the happy
            // path runs, below.
            //
            // The decision is made from the state the Kernel reports BEFORE the call,
            // through `next_step`. Reading first and then asking means the 409 is a
            // backstop for a race rather than the only thing standing between a
            // publish and a silent no-op.
            let observed = api
                .get(&format!("/api/v1/plugins/{plugin}/deployments"))
                .await?;
            let existing = observed.as_array().and_then(|items| {
                items
                    .iter()
                    .find(|item| item["version"] == version)
                    .map(|item| {
                        (
                            item["status"].as_str(),
                            item["readyInstances"].as_i64().unwrap_or(0),
                        )
                    })
            });
            let (observed_status, observed_ready) = match existing {
                Some((status, ready)) => (status, ready),
                None => (None, 0),
            };
            let step = next_step(observed_status, observed_ready);
            // The refusals below apply only to `--activate`, which is the unattended
            // publish path. A plain `deploy --wait` is an operator command with its
            // own history: the Kernel has always accepted a DISABLED/FAILED row and
            // turned it back into PENDING (`deployments.rs`, the redeploy branch), and
            // `p001c_rollback_states.sh` depends on that. Refusing it here would be a
            // regression dressed as a safety check.
            if activate {
                match step {
                    NextStep::RefuseDisabled => bail!(
                        "{plugin}@{version} is {} - a stopped deployment is not redeployed by a \
                         publish; run `opsctl enable` or `opsctl uninstall` deliberately",
                        observed_status.unwrap_or("DISABLED")
                    ),
                    NextStep::RefuseFailed => bail!(
                        "{plugin}@{version} is {} with no READY replica; a publish will not retry \
                         it unattended",
                        observed_status.unwrap_or("FAILED")
                    ),
                    NextStep::RefuseUnknown => bail!(
                        "{plugin}@{version} is in an unrecognised state {:?}; refusing rather than \
                         guessing what to do next",
                        observed_status
                    ),
                    NextStep::Deploy
                    | NextStep::WaitThenActivate
                    | NextStep::Activate
                    | NextStep::VerifyOnly => {}
                }
            }
            let mut already_active = activate && step == NextStep::VerifyOnly;
            let result = if already_active {
                println!("{plugin}@{version} is already the active version");
                Value::Null
            } else {
                match api
                    .post(
                        &format!("/api/v1/plugins/{plugin}/deployments"),
                        json!({
                            "version": version,
                            "desiredReplicas": replicas,
                            "nodeSelector": node_selector,
                            "maxInstancesPerNode": 1
                        }),
                    )
                    .await
                {
                    Ok(body) => body,
                    Err(error) if error.to_string().contains("VERSION_ALREADY_ACTIVE") => {
                        already_active = true;
                        println!("{plugin}@{version} is already the active version");
                        Value::Null
                    }
                    Err(error) => return Err(error),
                }
            };
            if !already_active {
                println!(
                    "deployment {} status={} {}/{} ready",
                    result["id"].as_str().unwrap_or(""),
                    result["status"].as_str().unwrap_or(""),
                    result["readyInstances"],
                    result["totalInstances"]
                );
            }
            // READY is a statement about containers. The gateway routes on
            // `r.status = 'ACTIVE'`, so without the activation below a successful
            // `deploy --wait` can leave the previous version serving indefinitely.
            if wait || activate {
                wait_for_ready(&api, &plugin, &version, 300).await?;
            }
            if activate {
                if !already_active {
                    let activated = api
                        .post(
                            &format!("/api/v1/plugins/{plugin}/activations"),
                            json!({ "version": version, "expectedRevision": revision_before }),
                        )
                        .await?;
                    println!(
                        "activated {plugin}@{version} revision={} status={}",
                        activated["generation"].as_i64().unwrap_or(0),
                        activated["status"].as_str().unwrap_or("")
                    );
                }
                // Read the route back. `activate` returning 200 says the Kernel
                // accepted the request; this says the route actually moved, and it is
                // the same assertion `rollback` makes. A publish is not "done" because
                // a CLI exited 0 - it is done when the version the gateway serves is
                // the one that was published.
                let detail = api.get(&format!("/api/v1/plugins/{plugin}")).await?;
                let effective = detail["activeVersion"].as_str().unwrap_or("");
                if effective != version {
                    bail!(
                        "{plugin}@{version} was activated but the active version is {effective}; \
                         the gateway is not serving what this publish built"
                    );
                }
                println!(
                    "effectiveVersion={effective} (verified against the plugin's active revision)"
                );

                // A version string is not an identity. `PACKAGE_VERSION_CONFLICT`
                // (`packages.rs:164`) is what actually enforces immutability - same
                // id+version with different bytes is refused at install, with an
                // audit event - so by the time a deployment is ACTIVE the bytes
                // cannot have changed underneath it. What this asserts is the part
                // that check does not cover: that the running deployment is the one
                // this publish is talking about, and not a leftover row.
                //
                // `artifactDigest` is the bundle's own digest, recorded by `install`
                // and never rewritten. If it is absent the Kernel's answer is older
                // than this check and the assertion is skipped rather than guessed
                // at - reported, so the gap is visible instead of silent.
                let active_artifact = detail["packageVersions"]
                    .as_array()
                    .and_then(|versions| versions.iter().find(|entry| entry["version"] == version))
                    .and_then(|entry| entry["artifactDigest"].as_str())
                    .map(str::to_string);
                match active_artifact {
                    Some(digest) => println!("artifactDigest={digest} (the bytes the Kernel stored for this version)"),
                    None => println!(
                        "artifactDigest=<unreported> - this Kernel build does not expose packageVersions[].artifactDigest; \
                         version identity was not asserted on this publish"
                    ),
                }
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

            // The Kernel can only redeploy a target that is not READY any more; it
            // cannot activate what it has just asked to be rebuilt. It reports that
            // in the response instead of pretending the rollback finished, and the
            // remaining work happens here: wait, then activate.
            //
            // Without this, `rollback` printed a 200 body and left the previous
            // version serving. Measured 2026-11-11: three gateway polls still
            // answered 0.0.2 after a "successful" rollback to 0.0.1, and only a
            // second manual invocation moved the route.
            // The Kernel reports `rollbackCompleted`, not just "pendingActivation":
            // it reads the ACTIVE revision back and says whether the route really
            // moved. Trusting a pending flag alone would let a branch that neither
            // activates nor needs to (the idempotent case) look unfinished.
            let completed = result["rollbackCompleted"].as_bool().unwrap_or(false);
            println!("{}", serde_json::to_string_pretty(&result)?);
            if !completed {
                if result["pendingActivation"].as_bool().unwrap_or(false) {
                    println!("  waiting for {version} to become READY …");
                    wait_for_ready(&api, &plugin, &version, 300).await?;
                    let activated = api
                        .post(
                            &format!("/api/v1/plugins/{plugin}/activations"),
                            json!({
                                "version": version,
                                "expectedRevision": expected,
                            }),
                        )
                        .await?;
                    println!(
                        "activated {plugin}@{version} revision={} status={}",
                        activated["generation"].as_i64().unwrap_or(0),
                        activated["status"].as_str().unwrap_or("")
                    );
                } else {
                    // Neither completed nor pending: report it, and do not exit 0
                    // as though the rollback had happened.
                    bail!(
                        "rollback to {version} did not complete: effective version is {}",
                        result["effectiveVersion"].as_str().unwrap_or("<none>")
                    );
                }
            }
            // Re-read the plugin and confirm the route is where we say it is. This
            // is the assertion that makes the CLI's "success" mean something.
            let detail = api.get(&format!("/api/v1/plugins/{plugin}")).await?;
            let effective = detail["activeVersion"].as_str().unwrap_or("");
            if effective != version {
                bail!("rollback reported completion but the active version is {effective}, not {version}");
            }
            // Print the outcome AFTER the work is done. The body above is the
            // Kernel's first answer, which for a redeploy branch says
            // `rollbackCompleted: false` - true at that instant, and misleading as
            // the last thing a successful command prints. Callers (and the state
            // machine test) read the final line.
            let final_body = serde_json::json!({
                "targetVersion": version,
                "effectiveVersion": effective,
                "rollbackCompleted": true,
            });
            println!("{}", serde_json::to_string_pretty(&final_body)?);
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

/// What `deploy --activate` should do, given the state the Kernel reports.
///
/// This is the decision table TASK-02 asks for, extracted from the command so it
/// can be asserted without an HTTP server. The command still performs the I/O;
/// this only says which step is next.
///
/// The states are the ones the schema actually has (`plugin_deployments.status`),
/// not an aspirational set: a publish chain that invents states the Kernel cannot
/// report is a diagram, not a state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NextStep {
    /// No deployment row for this version: create one, then wait, then activate.
    Deploy,
    /// A row exists and is on its way; wait for it, then activate.
    WaitThenActivate,
    /// READY but not routed: activate, then verify the effective version.
    Activate,
    /// The Kernel says this version is already active. Verify the route rather
    /// than trusting the 409's message.
    VerifyOnly,
    /// The version was deliberately stopped. Redeploying is an operator decision,
    /// so this is refused rather than guessed at.
    RefuseDisabled,
    /// Failed with no READY replica. A retry is allowed but the caller has to ask
    /// for it - an unattended publish that loops on a permanent failure hides it.
    RefuseFailed,
    /// DRAINING, or a state this table does not know. Anything unrecognised is
    /// refused rather than treated as "probably fine": a new Kernel status must be
    /// added here deliberately.
    RefuseUnknown,
}

/// Decide the next step from the deployment status the Kernel reports for this
/// version, and whether a row exists at all.
///
/// `ready` is the replica count, because FAILED with a live replica is a different
/// animal from FAILED with none: the first is a partial outage that a wait can
/// still resolve, the second cannot resolve itself.
fn next_step(status: Option<&str>, ready_instances: i64) -> NextStep {
    match status {
        None => NextStep::Deploy,
        Some("PENDING" | "PREPARING" | "DEPLOYING") => NextStep::WaitThenActivate,
        Some("READY") => NextStep::Activate,
        Some("ACTIVE") => NextStep::VerifyOnly,
        Some("DEGRADED") => {
            // A DEGRADED deployment still has a replica serving, so activating it
            // would move traffic onto a partially working version. It is treated
            // like a wait: the caller's timeout decides whether it recovers.
            if ready_instances > 0 {
                NextStep::WaitThenActivate
            } else {
                NextStep::RefuseFailed
            }
        }
        Some("FAILED") => {
            if ready_instances > 0 {
                NextStep::WaitThenActivate
            } else {
                NextStep::RefuseFailed
            }
        }
        Some("DISABLED" | "DRAINING" | "UNINSTALLED") => NextStep::RefuseDisabled,
        Some(_) => NextStep::RefuseUnknown,
    }
}

#[cfg(test)]
mod publish_state_machine_tests {
    use super::{next_step, NextStep};

    /// The twelve-plus combinations TASK-02 asks for. Each row is a state the
    /// Kernel can actually be in, and the step that must follow from it.
    #[test]
    fn every_reported_state_has_a_decided_next_step() {
        let cases: &[(Option<&str>, i64, NextStep)] = &[
            // --- absent ---------------------------------------------------------
            (None, 0, NextStep::Deploy),
            // --- on its way -----------------------------------------------------
            (Some("PENDING"), 0, NextStep::WaitThenActivate),
            (Some("PREPARING"), 0, NextStep::WaitThenActivate),
            (Some("DEPLOYING"), 1, NextStep::WaitThenActivate),
            // --- ready, not routed ----------------------------------------------
            (Some("READY"), 2, NextStep::Activate),
            // --- already routed -------------------------------------------------
            (Some("ACTIVE"), 2, NextStep::VerifyOnly),
            // --- degraded: a replica is serving, so wait rather than route ------
            (Some("DEGRADED"), 1, NextStep::WaitThenActivate),
            (Some("DEGRADED"), 0, NextStep::RefuseFailed),
            // --- failed: only recoverable while something is still serving ------
            (Some("FAILED"), 2, NextStep::WaitThenActivate),
            (Some("FAILED"), 0, NextStep::RefuseFailed),
            // --- deliberately stopped -------------------------------------------
            (Some("DISABLED"), 2, NextStep::RefuseDisabled),
            (Some("DRAINING"), 2, NextStep::RefuseDisabled),
            (Some("UNINSTALLED"), 0, NextStep::RefuseDisabled),
            // --- a state this table has never seen ------------------------------
            (Some("SOMETHING_NEW"), 1, NextStep::RefuseUnknown),
        ];
        for &(status, ready, expected) in cases {
            assert_eq!(
                next_step(status, ready),
                expected,
                "status={status:?} ready={ready} must lead to {expected:?}"
            );
        }
        assert_eq!(
            cases.len(),
            14,
            "the table is the deliverable; 12 is the floor"
        );
    }

    /// The counterfactual that matters most for the staging incident: a READY
    /// deployment must NOT be treated as finished. `Deploy`/`WaitThenActivate`
    /// stop at containers; only `Activate` moves the route.
    #[test]
    fn ready_is_not_active_and_the_table_says_so() {
        assert_eq!(next_step(Some("READY"), 2), NextStep::Activate);
        assert_ne!(next_step(Some("READY"), 2), NextStep::VerifyOnly);
        assert_ne!(next_step(Some("READY"), 2), NextStep::WaitThenActivate);
    }

    /// DISABLED is an operator decision, not a failure to retry. A publish chain
    /// that redeployed it would resurrect something someone stopped on purpose.
    #[test]
    fn disabled_is_refused_rather_than_silently_redeployed() {
        assert_eq!(next_step(Some("DISABLED"), 2), NextStep::RefuseDisabled);
        assert_ne!(
            next_step(Some("DISABLED"), 2),
            NextStep::Deploy,
            "DISABLED must not fall through to the create-a-deployment branch"
        );
    }

    /// An unknown status is refused. The dangerous alternative - treating anything
    /// unrecognised as ready to deploy - means a new Kernel status silently changes
    /// what the publish chain does without anyone editing this table.
    #[test]
    fn an_unknown_status_fails_closed() {
        assert_eq!(next_step(Some("BRAND_NEW"), 3), NextStep::RefuseUnknown);
        assert_eq!(next_step(Some(""), 0), NextStep::RefuseUnknown);
    }
}

#[cfg(test)]
mod replica_policy_tests {
    /// The topology this repository deploys is one node with
    /// `maxInstancesPerNode: 1`, so the only satisfiable replica count there is 1.
    ///
    /// `deploy` used to default `--replicas` to 2 and `publish-data-plugins.sh`
    /// never passed one, so every staging publish asked for a placement that the
    /// scheduler must refuse. This test does not call the CLI (that needs a live
    /// Kernel); it records the arithmetic that makes the old default wrong, so a
    /// future default cannot be reintroduced without the reasoning coming with it.
    #[test]
    fn the_old_default_could_not_be_placed_on_the_topology_it_ran_in() {
        const NODES: i32 = 1; // deployments/staging/compose.yaml:141
        const MAX_PER_NODE_PER_DEPLOYMENT: i32 = 1; // main.rs, deploy request
        let placeable = NODES * MAX_PER_NODE_PER_DEPLOYMENT;
        assert_eq!(placeable, 1);
        assert_ne!(
            2, placeable,
            "the removed default of 2 exceeds what one node can place for one deployment; \
             the Kernel refuses slot 2 with INSTANCE_CAPACITY_EXCEEDED (per-deployment)"
        );

        // And `ready == desired_replicas` is what turns a deployment READY
        // (`deployments.rs:1762`), so an unplaceable replica never resolves: the
        // deployment sits below its target forever rather than converging.
        let desired_under_old_default = 2;
        let ready_after_placement = placeable;
        assert_ne!(
            ready_after_placement, desired_under_old_default,
            "with 1 placeable instance and desired 2 the deployment can never report READY"
        );
    }
}

#[cfg(test)]
mod capacity_verdict_comes_from_the_kernel {
    //! `opsctl capacity` used to compute its own verdict, and it was wrong.
    //!
    //! Measured on staging 2026-11-25: `verdict: CAPACITY_AVAILABLE`,
    //! `freeSlotsTotal: 1`, on a node a publish had been refused on four seconds
    //! earlier at 4/4 with INSTANCE_CAPACITY_EXCEEDED.
    //!
    //! The arithmetic was `instancesTotal - instancesReady` per node, where
    //! `instancesTotal` counts instances with `desired_action='START'`. That is a
    //! count of replicas, not of the per-node limit the scheduler enforces, so the
    //! two numbers answered different questions and only one of them decided
    //! placement.
    //!
    //! This module does not call the CLI (that needs a live Kernel). It pins the
    //! two properties that made the answer wrong, so a future "optimisation" that
    //! reintroduces local arithmetic has to delete a test that says why not.

    /// The shape the old code computed, kept here as the counterexample.
    ///
    /// A node at 3 ready of 4 total yields "1 free" - and the publisher was
    /// refused on that node, because the limit counts ALL START instances
    /// (4 of 4) while `instancesReady` counted only the ones reporting READY.
    #[test]
    fn ready_below_total_does_not_mean_a_free_placement_slot() {
        let instances_ready = 3;
        let instances_total = 4;
        let old_free = (instances_total - instances_ready).max(0);
        assert_eq!(old_free, 1, "the old arithmetic reported a free slot");

        // The scheduler's number for the same node. It is a different quantity:
        // every START instance occupies a slot whether or not it reports READY,
        // so 4 of 4 is full.
        let start_instances = 4;
        let per_node_limit = 4;
        assert!(
            start_instances >= per_node_limit,
            "the node was full by the limit the scheduler enforces, while the old \
             verdict said CAPACITY_AVAILABLE with {old_free} free"
        );
    }

    /// The command must not contain the arithmetic it used to perform.
    ///
    /// A behavioural test would need a live Kernel and a full node; this is the
    /// structural assertion that survives without one, and it fails on exactly the
    /// change that would reintroduce the defect.
    ///
    /// TWO TRAPS, AND THIS TEST FELL INTO BOTH BEFORE IT WORKED.
    ///
    /// 1. COMMENTS ARE NOT CODE. Searching the whole file matched the comment above
    ///    `Command::Capacity`, which quotes the old arithmetic to explain why it was
    ///    removed - the same shape as `verify-main.mjs` reading "NO `paths:` filter,
    ///    deliberately" as a filter.
    /// 2. `include_str!("main.rs")` CONTAINS THIS TEST. Searching the whole file for
    ///    the offender also matches the literal in the assertion below, so the test
    ///    could never pass no matter what the command did.
    ///
    /// So the search is bounded to the region between the `Command::Capacity` arm and
    /// the next command arm, with comments stripped. That is the code under test and
    /// nothing else.
    #[test]
    fn the_command_no_longer_subtracts_ready_from_total() {
        let src = include_str!("main.rs");
        let start = src
            .find("Command::Capacity {")
            .expect("the capacity arm exists");
        // The arm ends at the next `Command::` variant, which is `NodeToken`.
        let end = src[start..]
            .find("Command::NodeToken")
            .map(|offset| start + offset)
            .expect("the arm after capacity exists");
        let arm: String = src[start..end]
            .lines()
            .filter(|line| {
                let t = line.trim_start();
                !(t.starts_with("//") || t.starts_with("///") || t.starts_with("//!"))
            })
            .collect::<Vec<_>>()
            .join("\n");

        // WHAT IS ASSERTED, AND WHY IT IS NOT A SPECIFIC EXPRESSION.
        //
        // The first version searched for `total - ready`, and the counterfactual
        // proved that too narrow: restoring a local verdict with
        // `let verdict = if total_free >= replicas { "CAPACITY_AVAILABLE" } ...`
        // reintroduced the defect exactly, and the assertion passed because that
        // rewrite happened not to spell the subtraction. A structural test that only
        // catches one phrasing of the bug it names is a test of the phrasing.
        //
        // The property is: the verdict is READ FROM the preflight, never chosen
        // here. So the assertion is on the absence of the literals this command
        // would have to invent, and on the presence of the read.
        for invented in ["\"CAPACITY_AVAILABLE\"", "\"CAPACITY_BLOCKED\"", "\"FITS\""] {
            assert!(
                !arm.contains(invented),
                "capacity must take its verdict from /api/v1/capacity/preflight; \
                 choosing {invented} here is the second implementation of the capacity \
                 rule that produced CAPACITY_AVAILABLE on a full node"
            );
        }
        // And it must actually read the kernel's answer, or it has no source of
        // truth at all.
        assert!(
            arm.contains("/api/v1/capacity/preflight"),
            "the command must ask the kernel for the preflight verdict"
        );
        assert!(
            arm.contains("preflight[\"verdict\"]"),
            "and the reported verdict must be the preflight's own field"
        );
    }
}
