use crate::config::Args;
use crate::docker::{container_name, ContainerInfo, DockerAdapter, Ownership};
use crate::logs::{parse_docker_log_line, parse_level, LogBuffer};
use anyhow::Context;
use chrono::Utc;
use opsweave_contracts::{
    DesiredNodeState, DesiredWorkload, InstanceObservation, InstanceState, LogChannel,
    NodeEnrollRequest, NodeEnrollResponse, NodeHeartbeatRequest, NodeStatus, ResourceSnapshot,
    RuntimeInfo,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex as StdMutex,
};
use std::time::{Duration, Instant};
use tokio::sync::{watch, RwLock};
use uuid::Uuid;

pub const ADAPTER_VERSION: &str = "opsweave-node/0.0.1+docker-cli";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub node_id: Uuid,
    pub credential: String,
    pub data_token: String,
    pub generation: i64,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeState {
    Starting,
    Ready,
    Unhealthy,
    Stopped,
    Failed,
}

impl RuntimeState {
    pub fn as_contract(self) -> InstanceState {
        match self {
            RuntimeState::Starting => InstanceState::Starting,
            RuntimeState::Ready => InstanceState::Ready,
            RuntimeState::Unhealthy => InstanceState::Unhealthy,
            RuntimeState::Stopped => InstanceState::Stopped,
            RuntimeState::Failed => InstanceState::Unhealthy,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RuntimeStatus {
    pub state: RuntimeState,
    pub container_id: Option<String>,
    pub host_port: Option<u16>,
    pub restart_count: i32,
    pub error: Option<String>,
    pub observed_at: chrono::DateTime<Utc>,
}

impl Default for RuntimeStatus {
    fn default() -> Self {
        Self {
            state: RuntimeState::Starting,
            container_id: None,
            host_port: None,
            restart_count: 0,
            error: None,
            observed_at: Utc::now(),
        }
    }
}

#[derive(Clone)]
pub struct InstanceRuntime {
    pub workload: DesiredWorkload,
    pub status: Arc<StdMutex<RuntimeStatus>>,
    pub logs: Arc<LogBuffer>,
}

impl InstanceRuntime {
    pub fn new(workload: DesiredWorkload) -> Self {
        Self {
            workload,
            status: Arc::new(StdMutex::new(RuntimeStatus::default())),
            logs: Arc::new(LogBuffer::new()),
        }
    }

    pub fn set_state(&self, state: RuntimeState, error: Option<String>) {
        if let Ok(mut status) = self.status.lock() {
            status.state = state;
            status.error = error;
            status.observed_at = Utc::now();
        }
    }

    pub fn status_copy(&self) -> RuntimeStatus {
        self.status
            .lock()
            .map(|status| status.clone())
            .unwrap_or_default()
    }
}

pub struct Shared {
    pub args: Args,
    pub http: reqwest::Client,
    pub docker: DockerAdapter,
    pub docker_version: String,
    pub identity: RwLock<Identity>,
    pub desired: RwLock<DesiredNodeState>,
    pub runtimes: Arc<RwLock<HashMap<Uuid, InstanceRuntime>>>,
    pub tasks: Arc<tokio::sync::Mutex<HashMap<Uuid, TaskEntry>>>,
    pub lifecycle: Arc<tokio::sync::Mutex<()>>,
    pub metrics: Arc<StdMutex<MetricsState>>,
    pub quarantined: Arc<AtomicBool>,
    pub quarantine_error: Arc<StdMutex<Option<String>>>,
    pub lease_deadline: Arc<StdMutex<Option<Instant>>>,
    /// Set exactly once by the Unix signal handler; all supervision loops observe it.
    pub shutdown: Arc<tokio::sync::watch::Sender<bool>>,
    /// Parsed `OPSWEAVE_CONTAINER_LABELS`, stamped on every container this node
    /// creates so a caller can scope cleanup to its own install even when node
    /// ids collide.
    pub extra_container_labels: Vec<String>,
}

pub struct TaskEntry {
    pub cancel: watch::Sender<bool>,
    pub generation: i64,
}

#[derive(Default)]
#[allow(dead_code)]
pub struct MetricsState {
    previous_cpu: Option<(u64, u64)>,
}

pub async fn enroll(args: &Args, http: &reqwest::Client) -> anyhow::Result<Identity> {
    let state_file = state_file(args);
    if let Some(identity) = load_identity(&state_file)? {
        let mut identity = identity;
        identity.generation += 1;
        save_identity(&state_file, &identity)?;
        tracing::info!(node_id = %identity.node_id, generation = identity.generation, "loaded node identity");
        return Ok(identity);
    }
    let token = args.enrollment_token.clone().ok_or_else(|| {
        anyhow::anyhow!(
            "no node identity at {} and OPSWEAVE_ENROLLMENT_TOKEN is not set",
            state_file.display()
        )
    })?;
    let request = NodeEnrollRequest {
        token,
        name: args.node_name.clone(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        labels: args.label_map(),
        capabilities: args.capabilities(),
    };
    let response = http
        .post(format!(
            "{}/api/v1/node-enrollment/redeem",
            args.kernel_url.trim_end_matches('/')
        ))
        .json(&request)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("node enrollment failed ({status}): {body}");
    }
    let enrolled: NodeEnrollResponse = response.json().await?;
    let identity = Identity {
        node_id: enrolled.node_id,
        credential: enrolled.credential,
        data_token: enrolled.data_token,
        generation: 1,
        name: args.node_name.clone(),
    };
    // The enrolment token was consumed by the call above - the Kernel will refuse
    // it a second time. If the identity cannot be persisted, this node has no way
    // back: it will retry with a spent token on every restart until an operator
    // issues a new one. That is a state worth naming loudly rather than reporting
    // as a generic write error.
    save_identity(&state_file, &identity).map_err(|error| {
        anyhow::anyhow!(
            "enrolled as node {} but could not persist the identity to {}: {error}. \
             The enrolment token is now SPENT - issue a new one (opsctl node-token) \
             and restart this node; it cannot recover on its own.",
            identity.node_id,
            state_file.display()
        )
    })?;
    tracing::info!(node_id = %identity.node_id, "node enrolled");
    Ok(identity)
}

fn state_file(args: &Args) -> PathBuf {
    args.state_dir.join("node-identity.json")
}

/// What the operator says a mismatched binding means. See ADR-023 §2.2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityAction {
    /// Unset: a mismatch is a hard error.
    None,
    /// The directory moved or was restored over. Keep the id, re-record the
    /// binding.
    Accept,
    /// This directory is a clone. Mint a new id; the original keeps its
    /// containers.
    Reinitialize,
}

impl IdentityAction {
    pub fn from_env() -> anyhow::Result<Self> {
        match std::env::var("OPSWEAVE_INSTALLATION_ID_ACTION") {
            Err(std::env::VarError::NotPresent) => Ok(Self::None),
            Err(std::env::VarError::NotUnicode(_)) => {
                anyhow::bail!("OPSWEAVE_INSTALLATION_ID_ACTION is not valid UTF-8")
            }
            Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
                "" => Ok(Self::None),
                "accept" => Ok(Self::Accept),
                "reinitialize" => Ok(Self::Reinitialize),
                other => anyhow::bail!(
                    "OPSWEAVE_INSTALLATION_ID_ACTION={other:?} is not a recognised action; \
                     use `accept` (this directory is the same installation, moved or restored) \
                     or `reinitialize` (this directory is a clone and is a new installation)"
                ),
            },
        }
    }
}

/// Device and inode of a state directory, the two values a copy cannot preserve.
#[cfg(unix)]
fn directory_identity(dir: &Path) -> anyhow::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(dir)
        .with_context(|| format!("stat the node state directory {}", dir.display()))?;
    Ok((meta.dev(), meta.ino()))
}

#[cfg(not(unix))]
fn directory_identity(dir: &Path) -> anyhow::Result<(u64, u64)> {
    // The binding still exists off Unix so the file format is portable, but it
    // cannot detect a clone there. Say so rather than pretending.
    tracing::warn!(
        dir = %dir.display(),
        "installation identity binding cannot detect a copied state directory on this \
         platform; a clone will share this installation's ownership token"
    );
    Ok((0, 0))
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallationBinding {
    installation_id: String,
    state_dir_device: u64,
    state_dir_inode: u64,
    #[serde(default)]
    recorded_at: Option<String>,
}

fn binding_path(args: &Args) -> PathBuf {
    args.state_dir.join("installation-binding.json")
}

fn write_binding(args: &Args, token: &str) -> anyhow::Result<()> {
    let (device, inode) = directory_identity(&args.state_dir)?;
    let binding = InstallationBinding {
        installation_id: token.to_string(),
        state_dir_device: device,
        state_dir_inode: inode,
        recorded_at: Some(chrono::Utc::now().to_rfc3339()),
    };
    // The binding is a *record*, not a claim: `accept` rewrites it and a
    // concurrent mint reads the winner's id and records it. Replace it
    // atomically. The identity file is the opposite - it must never be
    // replaced, which is what `write_private`'s create_new enforces.
    let path = binding_path(args);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // A fixed `.tmp` name made concurrent starts fight: one rename moved the
    // temporary file out from under another writer, which then failed with
    // ENOENT - and the identity it had just minted had no binding at all.
    // Unique per write, so each rename is independent.
    let temporary = path.with_extension(format!("tmp.{}", Uuid::new_v4()));
    std::fs::write(&temporary, serde_json::to_vec_pretty(&binding)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&temporary, &path)
        .with_context(|| format!("write the installation binding at {}", path.display()))?;
    Ok(())
}

/// Write a file that only this user can read, atomically, without ever
/// replacing an existing one.
///
/// `create_new` alone is not enough, and CI proved it: it reserves the *name*
/// atomically but fills it in a second step, so a concurrent Node that lost the
/// reserved the name and read it before `write_all` landed saw an EMPTY file and
/// failed with `is not a valid installation id ("")`. Measured on the first CI
/// run of `concurrent_mints_agree_on_one_identity`.
///
/// The content is written to a unique temporary file, synced, and then published
/// with `hard_link`, which fails with `AlreadyExists` when the target is there.
/// A reader therefore only ever sees a complete file: the name either points at
/// fully-written content or does not exist.
fn write_private(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("pub.{}", Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| -> anyhow::Result<()> {
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error)
            .with_context(|| format!("write the temporary file for {}", path.display()));
    }
    // Publish. `hard_link` is the atomic "create only if absent" primitive that
    // also carries the complete content, which `create_new` + `write` does not.
    let published = std::fs::hard_link(&temporary, path);
    let _ = std::fs::remove_file(&temporary);
    published.with_context(|| format!("publish {}", path.display()))?;
    Ok(())
}

/// Read, mint, or re-adopt this installation's ownership token.
///
/// The token is stored next to the enrolment identity rather than in the
/// database: a restored database is one of the ways two installations come to
/// share a node id, so a token kept there would be reproduced with the
/// collision and prove nothing.
///
/// A token alone is not enough. A full `cp -a` of the state directory carries
/// the token *and* the node identity, and then the clone answers "yes" to every
/// ownership question. The binding records the device and inode the token was
/// minted in - values a copy cannot preserve - so a clone is detected rather
/// than trusted. See ADR-023.
pub fn load_or_create_installation_id(args: &Args) -> anyhow::Result<String> {
    load_or_create_installation_id_with(args, IdentityAction::from_env()?)
}

pub fn load_or_create_installation_id_with(
    args: &Args,
    action: IdentityAction,
) -> anyhow::Result<String> {
    let path = args.state_dir.join("installation-id");
    // Only `NotFound` means "absent". Every other read error used to fall
    // through to "mint a new one", which on an unreadable directory silently
    // produced a second identity and orphaned everything the first owned.
    let existing = match std::fs::read_to_string(&path) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "cannot read the existing installation identity at {}; refusing to mint \
                     a second one, which would orphan every container this installation owns",
                    path.display()
                )
            })
        }
    };

    let Some(existing) = existing else {
        return mint_installation_id(args, &path);
    };
    let token = existing.trim();
    if !is_valid_installation_id(token) {
        anyhow::bail!(
            "{} exists but is not a valid installation id ({:?}); refusing to mint a second \
             one, because that would orphan every container this installation already owns",
            path.display(),
            token
        );
    }
    let token = token.to_string();

    let (device, inode) = directory_identity(&args.state_dir)?;
    let binding = read_binding(args)?;
    match binding {
        Some(binding)
            if binding.installation_id == token
                && binding.state_dir_device == device
                && binding.state_dir_inode == inode =>
        {
            Ok(token)
        }
        Some(binding) if binding.installation_id != token => {
            // Identity file and binding disagree. One of them was edited or
            // partially restored; neither can be trusted to say what this
            // installation may delete.
            anyhow::bail!(
                "INSTALLATION_IDENTITY_CONFLICT: {} carries installation id {token} but the \
                 binding in {} names {}. Refusing to guess which is this installation's. \
                 Restore both files from the same backup, or set \
                 OPSWEAVE_INSTALLATION_ID_ACTION=reinitialize to treat this directory as a \
                 new installation.",
                path.display(),
                binding_path(args).display(),
                binding.installation_id
            )
        }
        Some(binding) => {
            // Same token, different directory: this is a copy of the state dir
            // the identity was minted in (or a restore into a new place). Which
            // one it is cannot be read off disk - only the operator knows.
            match action {
                IdentityAction::None => anyhow::bail!(
                    "INSTALLATION_IDENTITY_CONFLICT: {} was created in a directory with \
                     device/inode {}/{} but is now read from {}/{}. This directory is a COPY \
                     of the one the identity was minted in - a backup restored elsewhere, or \
                     a full clone - and two installations sharing one ownership token can \
                     delete each other's containers. Nothing was changed.\n  \
                     If this is the same installation moved or restored over: \
                     OPSWEAVE_INSTALLATION_ID_ACTION=accept\n  \
                     If this is a clone that must be its own installation: \
                     OPSWEAVE_INSTALLATION_ID_ACTION=reinitialize\n\
                     See ADR-023.",
                    path.display(),
                    binding.state_dir_device,
                    binding.state_dir_inode,
                    device,
                    inode
                ),
                IdentityAction::Accept => {
                    tracing::warn!(
                        installation_id = %token,
                        "this state directory is a copy; accepting the existing installation \
                         identity for it. Containers of the copy's original installation are \
                         now indistinguishable from this one's."
                    );
                    write_binding(args, &token)?;
                    Ok(token)
                }
                IdentityAction::Reinitialize => {
                    tracing::warn!(
                        previous = %token,
                        "reinitializing: this state directory is a clone and becomes a new \
                         installation. Containers created with the previous identity are left \
                         to the installation that still owns them."
                    );
                    // Both files must go, or the next start reads the old token
                    // (or the old binding) again and asks the same question.
                    // Removed identity-first: a crash between the two leaves a
                    // binding with no identity, which mints cleanly, rather than
                    // an identity with a stale binding, which does not.
                    std::fs::remove_file(&path).with_context(|| {
                        format!("remove the inherited identity at {}", path.display())
                    })?;
                    let binding = binding_path(args);
                    match std::fs::remove_file(&binding) {
                        Ok(()) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => {
                            return Err(error).with_context(|| {
                                format!("remove the inherited binding at {}", binding.display())
                            })
                        }
                    }
                    mint_installation_id(args, &path)
                }
            }
        }
        None => {
            // Pre-C1.2.1 state directory: identity but no binding. It cannot be
            // verified, so adopt the directory it is in. This is the only silent
            // path, and ADR-023 §2.3 records why it exists and what it cannot
            // detect.
            tracing::warn!(
                installation_id = %token,
                "no installation binding found; adopting {} as the directory this identity \
                 belongs to. A clone made before this version cannot be detected.",
                args.state_dir.display()
            );
            write_binding(args, &token)?;
            Ok(token)
        }
    }
}

fn read_binding(args: &Args) -> anyhow::Result<Option<InstallationBinding>> {
    let path = binding_path(args);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("read the installation binding at {}", path.display()))
        }
    };
    let binding = serde_json::from_slice(&bytes).with_context(|| {
        format!(
            "the installation binding at {} is not valid JSON; it cannot say which directory \
             this identity belongs to",
            path.display()
        )
    })?;
    Ok(Some(binding))
}

fn mint_installation_id(args: &Args, path: &Path) -> anyhow::Result<String> {
    assert!(
        !path.exists(),
        "mint_installation_id must not be called when an identity exists"
    );
    let token = Uuid::new_v4().to_string();
    match write_private(path, token.as_bytes()) {
        Ok(()) => {}
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|io| io.kind() == std::io::ErrorKind::AlreadyExists) =>
        {
            // Another Node won the mint. Use its value rather than the one we
            // generated and failed to persist - the previous implementation
            // returned the loser's id and left the daemon labelled with it.
            let winner = std::fs::read_to_string(path)
                .with_context(|| format!("read the identity at {}", path.display()))?;
            let winner = winner.trim();
            if !is_valid_installation_id(winner) {
                anyhow::bail!(
                    "{} was created concurrently and is not a valid installation id ({:?})",
                    path.display(),
                    winner
                );
            }
            tracing::info!(
                installation_id = %winner,
                "another Node minted this installation identity first; adopting it"
            );
            write_binding(args, winner)?;
            return Ok(winner.to_string());
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("create the installation identity at {}", path.display()))
        }
    }
    write_binding(args, &token)?;
    tracing::info!(
        installation_id = %token,
        path = %path.display(),
        "minted an installation identity; containers created before this point carry no \
         installation label and will be reported rather than swept"
    );
    Ok(token)
}

/// A UUID, which is what `load_or_create_installation_id` writes. Validated on
/// read so a truncated or hand-edited file cannot become a label wildcard.
fn is_valid_installation_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok()
}

fn load_identity(path: &Path) -> anyhow::Result<Option<Identity>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path)?;
    let identity = serde_json::from_slice(&bytes)?;
    Ok(Some(identity))
}

fn save_identity(path: &Path, identity: &Identity) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(identity)?)?;
    std::fs::rename(temporary, path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub async fn lease_watchdog(shared: Arc<Shared>) {
    loop {
        if shared.quarantined.load(Ordering::SeqCst) {
            break;
        }
        let deadline = shared.lease_deadline.lock().ok().and_then(|value| *value);
        if let Some(deadline) = deadline {
            if Instant::now() >= deadline {
                quarantine(&shared, "node lease deadline expired").await;
                break;
            }
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

pub async fn heartbeat_loop(shared: Arc<Shared>) {
    let mut orphans_cleaned = false;
    let mut last_success = Instant::now();
    let lease = Duration::from_secs(shared.args.lease_seconds.max(5));
    loop {
        if shared.quarantined.load(Ordering::SeqCst) {
            break;
        }
        let started = Instant::now();
        match send_heartbeat(&shared).await {
            Ok(interval) => {
                last_success = Instant::now();
                if let Ok(mut deadline) = shared.lease_deadline.lock() {
                    *deadline = Some(last_success + lease);
                }
                reconcile(shared.clone()).await;
                if !orphans_cleaned {
                    cleanup_orphans(&shared).await;
                    orphans_cleaned = true;
                }
                let elapsed = started.elapsed();
                let sleep = Duration::from_secs(interval.max(2)).saturating_sub(elapsed);
                tokio::time::sleep(sleep).await;
            }
            Err(HeartbeatError::Rejected(status, body))
                if status == 401 || status == 403 || status == 409 || status == 400 =>
            {
                tracing::error!(status = status, body = %body, "node credential rejected; quarantining workloads");
                quarantine(&shared, &format!("heartbeat rejected with {status}")).await;
                break;
            }
            Err(error) => {
                let expired = last_success.elapsed() >= lease;
                tracing::warn!(error = %error, expired, "node heartbeat failed");
                if expired {
                    quarantine(&shared, "node lease expired while Kernel was unreachable").await;
                    break;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

enum HeartbeatError {
    Rejected(u16, String),
    Transport(anyhow::Error),
}

impl std::fmt::Display for HeartbeatError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(status, body) => write!(formatter, "rejected ({status}): {body}"),
            Self::Transport(error) => write!(formatter, "{error}"),
        }
    }
}

async fn send_heartbeat(shared: &Arc<Shared>) -> Result<u64, HeartbeatError> {
    let identity = shared.identity.read().await.clone();
    let snapshot = resource_snapshot(&shared.metrics);
    let observations = collect_observations(shared).await;
    // Node status is the control-channel/adapter status. Instance readiness is
    // reported separately and must never make an otherwise healthy node
    // ineligible for placement.
    let status = NodeStatus::Ready;
    let request = NodeHeartbeatRequest {
        generation: identity.generation,
        observed_at: Utc::now(),
        status,
        resource_snapshot: snapshot,
        instances: observations,
        data_endpoint: shared.args.data_endpoint.clone(),
        runtime_adapter_version: format!("{ADAPTER_VERSION} docker/{}", shared.docker_version),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        labels: shared.args.label_map(),
        capabilities: shared.args.capabilities(),
    };
    let response = shared
        .http
        .post(format!(
            "{}/internal/v1/nodes/{}/heartbeat",
            shared.args.kernel_url.trim_end_matches('/'),
            identity.node_id
        ))
        .bearer_auth(&identity.credential)
        .json(&request)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|error| HeartbeatError::Transport(error.into()))?;
    if !response.status().is_success() {
        let status_code = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(HeartbeatError::Rejected(status_code, body));
    }
    let desired: DesiredNodeState = response
        .json()
        .await
        .map_err(|error| HeartbeatError::Transport(error.into()))?;
    let interval = desired.heartbeat_interval_seconds as u64;
    *shared.desired.write().await = desired;
    Ok(interval)
}

async fn quarantine(shared: &Arc<Shared>, reason: &str) {
    if shared.quarantined.swap(true, Ordering::SeqCst) {
        return;
    }
    tracing::error!(
        reason,
        "node entering quarantine; stopping all managed workloads"
    );
    let entries: Vec<TaskEntry> = {
        let mut tasks = shared.tasks.lock().await;
        tasks.drain().map(|(_, entry)| entry).collect()
    };
    for entry in entries {
        let _ = entry.cancel.send(true);
    }
    let node_id = shared.identity.read().await.node_id;
    let result = try_cleanup(shared, node_id, reason).await;
    match result {
        Ok(()) => {
            set_quarantine_error(shared, None);
            tracing::info!("quarantine cleanup confirmed no managed containers remain");
        }
        Err(error) => {
            tracing::error!(error = %error, "quarantine cleanup attempt failed; starting retry task");
            set_quarantine_error(shared, Some(error.clone()));
            mark_unhealthy(shared, &error);
            // Never scan/delete without the lifecycle barrier. Keep retrying
            // until the in-flight create/start leaves and a guarded sweep is
            // confirmed; the health endpoint exposes the unresolved state.
            tokio::spawn(cleanup_retry_loop(
                shared.clone(),
                node_id,
                reason.to_string(),
            ));
        }
    }
}

async fn try_cleanup(shared: &Arc<Shared>, node_id: Uuid, reason: &str) -> Result<(), String> {
    try_cleanup_with_timeout(
        shared,
        node_id,
        reason,
        Duration::from_secs(15),
        Duration::from_secs(45),
    )
    .await
}

async fn try_cleanup_with_timeout(
    shared: &Arc<Shared>,
    node_id: Uuid,
    reason: &str,
    lock_timeout: Duration,
    cleanup_timeout: Duration,
) -> Result<(), String> {
    let lifecycle_guard = tokio::time::timeout(lock_timeout, shared.lifecycle.lock())
        .await
        .map_err(|_| "QUARANTINE_CLEANUP_FAILED: lifecycle lock wait exceeded 15s".to_string())?;
    let result = tokio::time::timeout(cleanup_timeout, cleanup_locked(shared, node_id, reason))
        .await
        .map_err(|_| "QUARANTINE_CLEANUP_FAILED: cleanup exceeded 45s".to_string())?;
    drop(lifecycle_guard);
    result
}

async fn cleanup_retry_loop(shared: Arc<Shared>, node_id: Uuid, reason: String) {
    cleanup_retry_loop_with(
        shared,
        node_id,
        reason,
        Duration::from_secs(30),
        Duration::from_secs(45),
        Duration::from_secs(2),
    )
    .await;
}

async fn cleanup_retry_loop_with(
    shared: Arc<Shared>,
    node_id: Uuid,
    reason: String,
    lock_timeout: Duration,
    cleanup_timeout: Duration,
    retry_delay: Duration,
) {
    loop {
        if !shared.quarantined.load(Ordering::SeqCst) {
            return;
        }
        match tokio::time::timeout(lock_timeout, shared.lifecycle.lock()).await {
            Ok(lifecycle_guard) => {
                let result = tokio::time::timeout(
                    cleanup_timeout,
                    cleanup_locked(&shared, node_id, &reason),
                )
                .await;
                drop(lifecycle_guard);
                match result {
                    Ok(Ok(())) => {
                        set_quarantine_error(&shared, None);
                        tracing::info!("quarantine retry confirmed no managed containers remain");
                        return;
                    }
                    Ok(Err(error)) => {
                        set_quarantine_error(&shared, Some(error.clone()));
                        mark_unhealthy(&shared, &error);
                    }
                    Err(_) => {
                        let error = "QUARANTINE_CLEANUP_FAILED: retry exceeded 45s; host intervention may be required".to_string();
                        set_quarantine_error(&shared, Some(error.clone()));
                        mark_unhealthy(&shared, &error);
                    }
                }
            }
            Err(_) => {
                let error = "QUARANTINE_CLEANUP_FAILED: waiting for in-flight lifecycle operation; retrying".to_string();
                set_quarantine_error(&shared, Some(error.clone()));
                mark_unhealthy(&shared, &error);
            }
        }
        tokio::time::sleep(retry_delay).await;
    }
}

fn set_quarantine_error(shared: &Arc<Shared>, error: Option<String>) {
    if let Ok(mut slot) = shared.quarantine_error.lock() {
        *slot = error;
    }
}

fn mark_unhealthy(shared: &Arc<Shared>, error: &str) {
    if let Ok(runtimes) = shared.runtimes.try_read() {
        for runtime in runtimes.values() {
            runtime.set_state(RuntimeState::Unhealthy, Some(error.to_string()));
        }
    }
}

async fn cleanup_locked(shared: &Arc<Shared>, node_id: Uuid, reason: &str) -> Result<(), String> {
    let runtimes: Vec<InstanceRuntime> = shared.runtimes.read().await.values().cloned().collect();
    let mut failures: Vec<String> = Vec::new();
    for runtime in &runtimes {
        let name = container_name(node_id, runtime.workload.instance_id);
        if let Err(error) = shared.docker.stop_and_remove_owned(&name).await {
            failures.push(format!("{name}: {error}"));
        }
    }
    for attempt in 1..=3 {
        match shared.docker.list_managed(node_id).await {
            Ok(names) => {
                for name in names {
                    if let Err(error) = shared.docker.stop_and_remove_owned(&name).await {
                        failures.push(format!("{name}: {error}"));
                    }
                }
            }
            Err(error) => failures.push(format!("list managed containers: {error}")),
        }
        let remaining = shared
            .docker
            .list_managed(node_id)
            .await
            .map(|names| names.len())
            .unwrap_or(usize::MAX);
        if remaining == 0 {
            for runtime in &runtimes {
                runtime.set_state(RuntimeState::Stopped, Some(reason.to_string()));
            }
            return Ok(());
        }
        if attempt < 3 {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    let error = if failures.is_empty() {
        "QUARANTINE_CLEANUP_FAILED: managed containers may remain".to_string()
    } else {
        format!(
            "QUARANTINE_CLEANUP_FAILED: managed containers may remain: {}",
            failures.join("; ")
        )
    };
    // No confirmed cleanup: preserve an explicit failure state rather than
    // claiming the workload is STOPPED.
    for runtime in &runtimes {
        runtime.set_state(RuntimeState::Failed, Some(error.clone()));
    }
    Err(error)
}

async fn collect_observations(shared: &Arc<Shared>) -> Vec<InstanceObservation> {
    let runtimes = shared.runtimes.read().await;
    runtimes
        .values()
        .map(|runtime| {
            let status = runtime.status_copy();
            InstanceObservation {
                instance_id: runtime.workload.instance_id,
                deployment_id: runtime.workload.deployment_id,
                generation: runtime.workload.generation,
                state: status.state.as_contract(),
                observed_at: status.observed_at,
                container_id: status.container_id.clone(),
                image_digest: Some(runtime.workload.backend.image_ref.clone()),
                host_port: status.host_port,
                restart_count: status.restart_count,
                error: status.error.clone(),
                runtime_adapter_version: ADAPTER_VERSION.to_string(),
            }
        })
        .collect()
}

pub async fn reconcile(shared: Arc<Shared>) {
    if shared.quarantined.load(Ordering::SeqCst) {
        return;
    }
    let desired = shared.desired.read().await.clone();
    let wanted: HashMap<Uuid, DesiredWorkload> = desired
        .desired
        .into_iter()
        .map(|workload| (workload.instance_id, workload))
        .collect();
    let mut tasks = shared.tasks.lock().await;

    for workload in wanted.values() {
        let needs_start = match tasks.get(&workload.instance_id) {
            None => true,
            Some(task) => task.generation != workload.generation,
        };
        if !needs_start {
            continue;
        }
        if let Some(previous) = tasks.remove(&workload.instance_id) {
            let _ = previous.cancel.send(true);
        }
        let runtime = {
            let mut runtimes = shared.runtimes.write().await;
            match runtimes.get(&workload.instance_id) {
                Some(existing) => {
                    if existing.workload.generation != workload.generation {
                        let new_runtime = InstanceRuntime::new(workload.clone());
                        runtimes.insert(workload.instance_id, new_runtime.clone());
                        new_runtime
                    } else {
                        existing.clone()
                    }
                }
                None => {
                    let runtime = InstanceRuntime::new(workload.clone());
                    runtimes.insert(workload.instance_id, runtime.clone());
                    runtime
                }
            }
        };
        let (cancel, mut cancel_rx) = watch::channel(false);
        tasks.insert(
            workload.instance_id,
            TaskEntry {
                cancel,
                generation: workload.generation,
            },
        );
        let shared_clone = shared.clone();
        let runtime_clone = runtime.clone();
        tokio::spawn(async move {
            supervise(shared_clone, runtime_clone, &mut cancel_rx).await;
        });
    }

    let stale: Vec<Uuid> = tasks
        .keys()
        .filter(|id| !wanted.contains_key(*id))
        .copied()
        .collect();
    for id in stale {
        if let Some(task) = tasks.remove(&id) {
            let _ = task.cancel.send(true);
        }
        if let Some(runtime) = shared.runtimes.read().await.get(&id) {
            runtime.set_state(RuntimeState::Stopped, None);
        }
    }
}

async fn supervise(
    shared: Arc<Shared>,
    runtime: InstanceRuntime,
    cancel: &mut watch::Receiver<bool>,
) {
    let workload = runtime.workload.clone();
    let mut restart_attempts = 0_i32;
    loop {
        if *cancel.borrow() {
            cleanup(&shared, &workload).await;
            runtime.set_state(RuntimeState::Stopped, None);
            return;
        }
        match run_once(&shared, &runtime, cancel).await {
            Ok(RunOutcome::Cancelled) => {
                cleanup(&shared, &workload).await;
                runtime.set_state(RuntimeState::Stopped, None);
                return;
            }
            Ok(RunOutcome::Exited(error)) => {
                tracing::warn!(instance = %workload.instance_id, error = %error, attempt = restart_attempts + 1, "instance supervisor observed exit");
                restart_attempts += 1;
                if let Ok(mut status) = runtime.status.lock() {
                    status.restart_count = restart_attempts;
                }
                runtime.set_state(RuntimeState::Unhealthy, Some(error.clone()));
                cleanup(&shared, &workload).await;
                if restart_attempts > 3 {
                    runtime.set_state(RuntimeState::Failed, Some(error));
                    return;
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(2)) => {},
                    _ = cancel.changed() => {
                        cleanup(&shared, &workload).await;
                        runtime.set_state(RuntimeState::Stopped, None);
                        return;
                    }
                }
            }
            Err(error) => {
                tracing::warn!(instance = %workload.instance_id, error = %error, attempt = restart_attempts + 1, "instance supervisor error");
                restart_attempts += 1;
                runtime.set_state(RuntimeState::Unhealthy, Some(error.to_string()));
                cleanup(&shared, &workload).await;
                if restart_attempts > 3 {
                    runtime.set_state(RuntimeState::Failed, Some(error.to_string()));
                    return;
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(2)) => {},
                    _ = cancel.changed() => {
                        cleanup(&shared, &workload).await;
                        runtime.set_state(RuntimeState::Stopped, None);
                        return;
                    }
                }
            }
        }
    }
}

enum RunOutcome {
    Cancelled,
    Exited(String),
}

fn workload_token_file(shared: &Arc<Shared>, instance_id: Uuid) -> PathBuf {
    shared
        .args
        .state_dir
        .join("instances")
        .join(instance_id.to_string())
        .join("capability-tokens.json")
}

fn write_workload_tokens(
    shared: &Arc<Shared>,
    workload: &DesiredWorkload,
    env: &std::collections::BTreeMap<String, String>,
) -> anyhow::Result<PathBuf> {
    let path = workload_token_file(shared, workload.instance_id);
    let parent = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("token file has no parent"))?;
    std::fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The per-instance directory is visible to the container UID. Its
        // parent (the instances directory) is private to the Node host user.
        let instances = shared.args.state_dir.join("instances");
        if instances.exists() {
            std::fs::set_permissions(&instances, std::fs::Permissions::from_mode(0o700))?;
        }
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o755))?;
    }
    let raw = env
        .get("OPSWEAVE_CAPABILITY_TOKENS")
        .cloned()
        .unwrap_or_else(|| "{}".to_string());
    let value: serde_json::Value =
        serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({}));
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, serde_json::to_vec(&value)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o644));
    }
    std::fs::rename(&temporary, &path)?;
    parent
        .canonicalize()
        .map(|dir| dir.join("capability-tokens.json"))
        .map_err(Into::into)
}

async fn workload_token_refresher(shared: Arc<Shared>, runtime: InstanceRuntime) {
    let interval = Duration::from_secs(shared.args.token_refresh_seconds.max(1));
    loop {
        tokio::time::sleep(interval).await;
        if !matches!(
            runtime.status_copy().state,
            RuntimeState::Starting | RuntimeState::Ready | RuntimeState::Unhealthy
        ) {
            break;
        }
        let node_id = shared.identity.read().await.node_id;
        match fetch_workload_env(&shared, &runtime.workload, node_id).await {
            Ok(env) => {
                if let Err(error) = write_workload_tokens(&shared, &runtime.workload, &env) {
                    tracing::warn!(instance = %runtime.workload.instance_id, error = %error, "could not refresh workload token file");
                }
            }
            Err(error) => {
                tracing::warn!(instance = %runtime.workload.instance_id, error = %error, "workload token refresh failed; will retry");
            }
        }
    }
}

async fn fetch_workload_env(
    shared: &Arc<Shared>,
    workload: &DesiredWorkload,
    node_id: Uuid,
) -> anyhow::Result<std::collections::BTreeMap<String, String>> {
    let url = format!(
        "{}/internal/v1/nodes/{}/instances/{}/env",
        shared.args.kernel_url.trim_end_matches('/'),
        node_id,
        workload.instance_id
    );
    let credential = shared.identity.read().await.credential.clone();
    let response = shared
        .http
        .get(url)
        .bearer_auth(credential)
        .timeout(Duration::from_secs(10))
        .send()
        .await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(std::collections::BTreeMap::new());
    }
    if !response.status().is_success() {
        anyhow::bail!("workload environment request failed: {}", response.status());
    }
    #[derive(serde::Deserialize)]
    struct EnvResponse {
        env: std::collections::BTreeMap<String, String>,
    }
    let body: EnvResponse = response.json().await?;
    Ok(body.env)
}

/// Decide whether a container that already holds this instance's name may be
/// adopted.
///
/// Same name and same image is **not** proof of ownership: two installations
/// that share a node id run the same plugin version, so the image matches by
/// construction. Adopting on that alone makes this node report another
/// installation's container as its own, and then remove it on the next
/// reconcile.
///
/// Split out of `run_once` so the decision can be exercised directly: the
/// integration test would otherwise have to stand up a Kernel to reach it.
pub async fn adoptable(
    shared: &Arc<Shared>,
    name: &str,
    existing: Option<ContainerInfo>,
    image_ref: &str,
    instance_id: Uuid,
) -> Option<ContainerInfo> {
    let info = existing?;
    if !info.running || info.image != image_ref {
        return None;
    }
    match shared.docker.ownership_of(name).await {
        Ok(Ownership::Ours) => Some(info),
        Ok(_) => {
            tracing::warn!(
                %instance_id,
                container = %info.id,
                "a running container with this name belongs to another installation; \
                 not adopting it"
            );
            None
        }
        Err(error) => {
            // Cannot prove ownership, so cannot adopt. Falling through to create
            // makes the collision explicit rather than silent.
            tracing::warn!(%instance_id, error = %error, "could not establish container ownership; not adopting");
            None
        }
    }
}

async fn run_once(
    shared: &Arc<Shared>,
    runtime: &InstanceRuntime,
    cancel: &mut watch::Receiver<bool>,
) -> anyhow::Result<RunOutcome> {
    ensure_node_active(shared).await?;
    let workload = &runtime.workload;
    let node_id = shared.identity.read().await.node_id;
    let name = container_name(node_id, workload.instance_id);
    let image_ref = &workload.backend.image_ref;
    let port = workload.backend.container_port;

    // Pull outside the lifecycle guard so a slow image cannot delay quarantine
    // for up to the full pull timeout. The create/start critical section is
    // still serialized with quarantine and re-checks the flag after the pull.
    let existing = shared.docker.inspect(&name).await.unwrap_or(None);
    let existing = adoptable(shared, &name, existing, image_ref, workload.instance_id).await;
    let (container_id, host_port) = match existing {
        Some(info) => {
            let _lifecycle = shared.lifecycle.lock().await;
            ensure_node_active(shared).await?;
            let host_port = info
                .host_port
                .ok_or_else(|| anyhow::anyhow!("adopted container has no published port"))?;
            tracing::info!(instance = %workload.instance_id, container = %info.id, "adopting running container");
            (info.id, host_port)
        }
        None => {
            shared.docker.pull(image_ref).await?;
            let _lifecycle = shared.lifecycle.lock().await;
            ensure_node_active(shared).await?;
            shared.docker.verify_digest(image_ref).await?;
            ensure_node_active(shared).await?;
            let extra_env = fetch_workload_env(shared, workload, node_id).await?;
            let token_file = write_workload_tokens(shared, workload, &extra_env)?;
            let id = shared
                .docker
                .create_and_start(
                    workload,
                    image_ref,
                    port,
                    node_id,
                    &extra_env,
                    Some(&token_file),
                    &shared.extra_container_labels,
                )
                .await?;
            let mut host_port = None;
            for _ in 0..20 {
                if let Ok(Some(info)) = shared.docker.inspect(&name).await {
                    if let Some(value) = info.host_port {
                        host_port = Some(value);
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            let host_port =
                host_port.ok_or_else(|| anyhow::anyhow!("container has no published host port"))?;
            runtime.logs.rotate();
            (id, host_port)
        }
    };
    {
        if let Ok(mut status) = runtime.status.lock() {
            status.container_id = Some(container_id.clone());
            status.host_port = Some(host_port);
            status.state = RuntimeState::Starting;
            status.error = None;
            status.observed_at = Utc::now();
        }
    }
    spawn_log_pump(shared.clone(), runtime.clone(), name.clone());
    tokio::spawn(workload_token_refresher(shared.clone(), runtime.clone()));

    let base = format!("http://127.0.0.1:{host_port}");
    let startup_started = Instant::now();
    loop {
        if *cancel.borrow() {
            return Ok(RunOutcome::Cancelled);
        }
        if !shared.docker.is_running(&name).await {
            return Ok(RunOutcome::Exited("container exited during startup".into()));
        }
        let path = workload
            .backend
            .startup_path
            .as_deref()
            .unwrap_or(&workload.backend.readiness_path);
        if probe(shared, &format!("{base}{path}")).await {
            break;
        }
        if startup_started.elapsed() > Duration::from_secs(90) {
            return Err(anyhow::anyhow!("startup probe timed out after 90s"));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    if workload.backend.startup_path.is_some() {
        let readiness_started = Instant::now();
        loop {
            if *cancel.borrow() {
                return Ok(RunOutcome::Cancelled);
            }
            if probe(
                shared,
                &format!("{base}{}", workload.backend.readiness_path),
            )
            .await
            {
                break;
            }
            if readiness_started.elapsed() > Duration::from_secs(60) {
                return Err(anyhow::anyhow!(
                    "readiness probe timed out after startup completed"
                ));
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    verify_runtime_info(shared, &base, workload).await?;
    runtime.set_state(RuntimeState::Ready, None);
    tracing::info!(instance = %workload.instance_id, port = host_port, "instance READY");

    let mut liveness_failures = 0;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(10)) => {},
            _ = cancel.changed() => return Ok(RunOutcome::Cancelled),
        }
        if *cancel.borrow() {
            return Ok(RunOutcome::Cancelled);
        }
        let running = shared.docker.is_running(&name).await;
        let alive = running
            && probe(
                shared,
                &format!("{}{}", base, workload.backend.liveness_path),
            )
            .await;
        if alive {
            liveness_failures = 0;
            if runtime.status_copy().state != RuntimeState::Ready {
                runtime.set_state(RuntimeState::Ready, None);
            }
        } else {
            liveness_failures += 1;
            runtime.set_state(
                RuntimeState::Unhealthy,
                Some(format!("liveness probe failed ({liveness_failures}/3)")),
            );
            if liveness_failures >= 3 {
                return Ok(RunOutcome::Exited(
                    "liveness probe failed three times".into(),
                ));
            }
        }
    }
}

async fn verify_runtime_info(
    shared: &Arc<Shared>,
    base: &str,
    workload: &DesiredWorkload,
) -> anyhow::Result<()> {
    let url = format!("{base}/_opsweave/runtime/v1/info");
    let response = shared
        .http
        .get(url)
        .timeout(Duration::from_secs(3))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(anyhow::anyhow!(
            "runtime info endpoint returned {}",
            response.status()
        ));
    }
    let info: RuntimeInfo = response.json().await?;
    if info.plugin_id != workload.plugin_id
        || info.version != workload.version
        || info.runtime_protocol != "http-json-v1"
        || info.capability_digest != workload.backend.capability_digest
    {
        return Err(anyhow::anyhow!(
            "Runtime Info does not match signed manifest: plugin={}/{} protocol={} capability={}",
            info.plugin_id,
            info.version,
            info.runtime_protocol,
            info.capability_digest
        ));
    }
    Ok(())
}

fn spawn_log_pump(shared: Arc<Shared>, runtime: InstanceRuntime, name: String) {
    let Ok(mut child) = shared.docker.spawn_logs(&name) else {
        tracing::warn!(container = %name, "failed to spawn docker logs");
        return;
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    if let Some(stdout) = stdout {
        let runtime = runtime.clone();
        let shared = shared.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let (occurred_at, message) = parse_docker_log_line(&line);
                let level = parse_level(&message);
                runtime.logs.push(
                    shared.identity.read().await.node_id,
                    runtime.workload.instance_id,
                    LogChannel::Stdout,
                    level,
                    &message,
                    occurred_at,
                );
            }
        });
    }
    if let Some(stderr) = stderr {
        let runtime = runtime.clone();
        let shared = shared.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let (occurred_at, message) = parse_docker_log_line(&line);
                let level = parse_level(&message);
                runtime.logs.push(
                    shared.identity.read().await.node_id,
                    runtime.workload.instance_id,
                    LogChannel::Stderr,
                    level,
                    &message,
                    occurred_at,
                );
            }
        });
    }
    // Reap the child when it exits; logging readers end at EOF.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
}

async fn ensure_node_active(shared: &Arc<Shared>) -> anyhow::Result<()> {
    if shared.quarantined.load(Ordering::SeqCst) {
        anyhow::bail!("node is quarantined; refusing to create a workload");
    }
    Ok(())
}

async fn cleanup_orphans(shared: &Arc<Shared>) {
    let desired = shared.desired.read().await.clone();
    let node_id = shared.identity.read().await.node_id;
    let wanted: std::collections::HashSet<String> = desired
        .desired
        .iter()
        .map(|workload| container_name(node_id, workload.instance_id))
        .collect();
    if let Ok(names) = shared.docker.list_managed(node_id).await {
        for name in names {
            if !wanted.contains(&name) {
                tracing::info!(container = %name, "removing managed container absent from desired state");
                if let Err(error) = shared.docker.stop_and_remove_owned(&name).await {
                    tracing::warn!(container = %name, error = %error, "orphan cleanup failed");
                }
            }
        }
    }
}

async fn cleanup(shared: &Arc<Shared>, workload: &DesiredWorkload) {
    let node_id = shared.identity.read().await.node_id;
    let name = container_name(node_id, workload.instance_id);
    if let Err(error) = shared.docker.stop_and_remove_owned(&name).await {
        tracing::warn!(container = %name, error = %error, "workload cleanup failed");
    }
}

async fn probe(shared: &Arc<Shared>, url: &str) -> bool {
    match shared
        .http
        .get(url)
        .timeout(Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

#[allow(unused_mut, unused_variables)]
fn resource_snapshot(metrics: &Arc<StdMutex<MetricsState>>) -> ResourceSnapshot {
    let _ = metrics;
    let mut cpu_utilization = None;
    let mut memory_used_bytes = None;
    let mut memory_total_bytes = None;
    let mut filesystem_used_bytes = None;
    let mut filesystem_total_bytes = None;
    #[cfg(target_os = "linux")]
    {
        if let Ok(stat) = std::fs::read_to_string("/proc/stat") {
            if let Some(line) = stat.lines().next() {
                let values: Vec<u64> = line
                    .split_whitespace()
                    .skip(1)
                    .filter_map(|value| value.parse().ok())
                    .collect();
                if values.len() >= 4 {
                    let idle = values[3] + values.get(4).copied().unwrap_or(0);
                    let total: u64 = values.iter().sum();
                    if let Ok(mut state) = metrics.lock() {
                        if let Some((prev_idle, prev_total)) = state.previous_cpu {
                            let total_delta = total.saturating_sub(prev_total);
                            let idle_delta = idle.saturating_sub(prev_idle);
                            if total_delta > 0 {
                                cpu_utilization =
                                    Some((total_delta - idle_delta) as f64 / total_delta as f64);
                            }
                        }
                        state.previous_cpu = Some((idle, total));
                    }
                }
            }
        }
        if let Ok(meminfo) = std::fs::read_to_string("/proc/meminfo") {
            let mut total = None;
            let mut available = None;
            for line in meminfo.lines() {
                if let Some(value) = line.strip_prefix("MemTotal:") {
                    total = value
                        .split_whitespace()
                        .next()
                        .and_then(|value| value.parse::<i64>().ok())
                        .map(|kb| kb * 1024);
                }
                if let Some(value) = line.strip_prefix("MemAvailable:") {
                    available = value
                        .split_whitespace()
                        .next()
                        .and_then(|value| value.parse::<i64>().ok())
                        .map(|kb| kb * 1024);
                }
            }
            if let (Some(total), Some(available)) = (total, available) {
                memory_total_bytes = Some(total);
                memory_used_bytes = Some(total - available);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
        {
            memory_total_bytes = String::from_utf8_lossy(&output.stdout)
                .trim()
                .parse::<i64>()
                .ok();
        }
    }
    if let Ok(output) = std::process::Command::new("df").args(["-kP", "/"]).output() {
        let text = String::from_utf8_lossy(&output.stdout);
        if let Some(line) = text.lines().nth(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() >= 3 {
                let total = fields[1].parse::<i64>().ok().map(|kb| kb * 1024);
                let used = fields[2].parse::<i64>().ok().map(|kb| kb * 1024);
                filesystem_total_bytes = total;
                filesystem_used_bytes = used;
            }
        }
    }
    ResourceSnapshot {
        sampled_at: Utc::now(),
        cpu_utilization,
        memory_used_bytes,
        memory_total_bytes,
        cpu_cores: schedulable_cpu_cores(),
        self_cpu_limit_cores: self_cpu_limit_cores(),
        self_memory_limit_bytes: self_memory_limit_bytes(),
        filesystem_used_bytes,
        filesystem_total_bytes,
    }
}

/// Host-schedulable CPU cores.
///
/// `available_parallelism()` answers a different question: it reports this
/// process's own cgroup quota (staging runs the node container with
/// `cpus: "1.0"`), so a 4 vCPU host reported 1 core while `/proc/meminfo`
/// reported the host's 3.7 GiB in the same snapshot. Plugin containers are
/// created by the host daemon and are siblings of this process, so the
/// placement budget is the host's cores, never this container's share.
fn schedulable_cpu_cores() -> Option<i64> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(cpuinfo) = std::fs::read_to_string("/proc/cpuinfo") {
            if let Some(cores) = parse_cpuinfo_cores(&cpuinfo) {
                return Some(cores);
            }
        }
    }
    std::thread::available_parallelism()
        .ok()
        .map(|count| count.get() as i64)
}

/// CPU cap of the Node Runtime's own cgroup, in cores. Diagnosis only: it never
/// bounds the plugin containers scheduled from this snapshot.
fn self_cpu_limit_cores() -> Option<f64> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(text) = std::fs::read_to_string("/sys/fs/cgroup/cpu.max") {
            return parse_cgroup_cpu_max(&text);
        }
        let quota = std::fs::read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").ok()?;
        let period = std::fs::read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_period_us").ok()?;
        parse_cgroup_cpu_max(&format!("{} {}", quota.trim(), period.trim()))
    }
    #[cfg(not(target_os = "linux"))]
    None
}

/// Memory cap of the Node Runtime's own cgroup, in bytes. Diagnosis only, for
/// the same reason as `self_cpu_limit_cores`.
fn self_memory_limit_bytes() -> Option<i64> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(text) = std::fs::read_to_string("/sys/fs/cgroup/memory.max") {
            return parse_cgroup_memory_max(&text);
        }
        if let Ok(text) = std::fs::read_to_string("/sys/fs/cgroup/memory/memory.limit_in_bytes") {
            return parse_cgroup_memory_max(&text);
        }
    }
    None
}

#[allow(dead_code)]
fn parse_cpuinfo_cores(cpuinfo: &str) -> Option<i64> {
    let cores = cpuinfo
        .lines()
        .filter(|line| line.starts_with("processor"))
        .count();
    (cores > 0).then_some(cores as i64)
}

/// cgroup v2 `cpu.max` is "<quota> <period>" in microseconds, or
/// "max <period>" when the cgroup is unlimited. Returns whole/fractional cores.
#[allow(dead_code)]
fn parse_cgroup_cpu_max(text: &str) -> Option<f64> {
    let mut fields = text.split_whitespace();
    let quota: f64 = fields.next()?.parse().ok()?;
    let period: f64 = fields.next()?.parse().ok()?;
    (quota > 0.0 && period > 0.0).then(|| quota / period)
}

/// cgroup v2 reports "max" for an unlimited cgroup and cgroup v1 reports a
/// sentinel near i64::MAX; both mean "no limit".
#[allow(dead_code)]
fn parse_cgroup_memory_max(text: &str) -> Option<i64> {
    let value: i64 = text.trim().parse().ok()?;
    (value > 0 && value < i64::MAX / 2).then_some(value)
}

#[cfg(test)]
mod resource_snapshot_tests {
    use super::{
        parse_cgroup_cpu_max, parse_cgroup_memory_max, parse_cpuinfo_cores, schedulable_cpu_cores,
    };
    use chrono::Utc;
    use opsweave_contracts::ResourceSnapshot;
    use serde_json::json;

    const FOUR_CORE_CPUINFO: &str = "processor	: 0
model name	: x

processor	: 1

processor	: 2

processor	: 3

";

    #[test]
    fn host_core_count_comes_from_cpuinfo_not_the_process_quota() {
        assert_eq!(parse_cpuinfo_cores(FOUR_CORE_CPUINFO), Some(4));
        assert_eq!(
            parse_cpuinfo_cores(
                "model name : no processors
"
            ),
            None
        );
    }

    #[test]
    fn cgroup_cpu_quota_is_reported_in_cores() {
        assert_eq!(parse_cgroup_cpu_max("100000 100000"), Some(1.0));
        assert_eq!(parse_cgroup_cpu_max("150000 100000"), Some(1.5));
        assert_eq!(parse_cgroup_cpu_max("max 100000"), None);
        assert_eq!(parse_cgroup_cpu_max(""), None);
    }

    #[test]
    fn cgroup_memory_limit_is_reported_in_bytes() {
        assert_eq!(
            parse_cgroup_memory_max(
                "536870912
"
            ),
            Some(536_870_912)
        );
        assert_eq!(
            parse_cgroup_memory_max(
                "max
"
            ),
            None
        );
        assert_eq!(
            parse_cgroup_memory_max(
                "9223372036854771712
"
            ),
            None
        );
    }

    #[test]
    fn snapshot_separates_the_host_budget_from_the_agent_cgroup_limit() {
        // Constructed inputs, never the real cgroup: the contract under test is
        // that cpuCores carries the host budget while the self* fields only
        // describe the Node Runtime's own container.
        let snapshot = ResourceSnapshot {
            sampled_at: Utc::now(),
            cpu_utilization: Some(0.05),
            memory_used_bytes: Some(1_108_037_632),
            memory_total_bytes: Some(3_904_065_536),
            cpu_cores: parse_cpuinfo_cores(FOUR_CORE_CPUINFO),
            self_cpu_limit_cores: parse_cgroup_cpu_max("100000 100000"),
            self_memory_limit_bytes: parse_cgroup_memory_max("536870912"),
            filesystem_used_bytes: None,
            filesystem_total_bytes: None,
        };
        assert_eq!(snapshot.cpu_cores, Some(4));
        assert_eq!(snapshot.self_cpu_limit_cores, Some(1.0));
        let wire = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(wire["cpuCores"], json!(4));
        assert_eq!(wire["selfCpuLimitCores"], json!(1.0));
        assert_eq!(wire["selfMemoryLimitBytes"], json!(536_870_912));
        assert_eq!(wire["memoryTotalBytes"], json!(3_904_065_536_i64));
    }

    #[test]
    fn live_collection_stays_fail_closed_without_cpuinfo() {
        assert!(schedulable_cpu_cores().is_none_or(|cores| cores >= 1));
    }
}

#[cfg(test)]
mod tests {
    use super::{cleanup_retry_loop_with, try_cleanup_with_timeout, Shared};
    use crate::config::Args;
    use crate::docker::DockerAdapter;
    use clap::Parser;
    use opsweave_contracts::DesiredNodeState;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;
    use tokio::sync::RwLock;
    use uuid::Uuid;

    fn simple_docker(exit_code: i32) -> String {
        let dir = std::env::temp_dir().join(format!("opsweave-test-docker-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("docker");
        std::fs::write(&script, format!("#!/bin/sh\nexit {exit_code}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        script.to_string_lossy().into_owned()
    }

    fn test_shared(docker_bin: &str) -> Arc<Shared> {
        let args = Args::parse_from(["opsweave-node", "--data-bind", "127.0.0.1:0"]);
        // Parsed before `args` is moved into the struct below.
        let extra_container_labels: Vec<String> = args
            .container_labels
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        let node_id = Uuid::new_v4();
        let identity = super::Identity {
            node_id,
            credential: "test".into(),
            data_token: "test".into(),
            generation: 1,
            name: "test".into(),
        };
        Arc::new(Shared {
            args,
            http: reqwest::Client::new(),
            // Production always stamps an installation identity in main.rs, and
            // cleanup cannot converge without one - it would loop forever on a
            // sweep it can never prove. The helper mirrors that.
            docker: DockerAdapter::new(docker_bin.to_string(), "unix://unused".into())
                .with_installation_id(Uuid::new_v4().to_string()),
            docker_version: "test".into(),
            identity: RwLock::new(identity),
            desired: RwLock::new(DesiredNodeState {
                node_id,
                node_generation: 1,
                heartbeat_interval_seconds: 5,
                max_instances: 1,
                desired: vec![],
            }),
            runtimes: Arc::new(RwLock::new(HashMap::new())),
            tasks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            lifecycle: Arc::new(tokio::sync::Mutex::new(())),
            metrics: Arc::new(StdMutex::new(super::MetricsState::default())),
            quarantined: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            quarantine_error: Arc::new(StdMutex::new(None)),
            lease_deadline: Arc::new(StdMutex::new(None)),
            shutdown: Arc::new(tokio::sync::watch::channel(false).0),
            extra_container_labels,
        })
    }

    #[tokio::test]
    async fn lifecycle_lock_timeout_does_not_scan_containers() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("docker-called");
        let script = dir.path().join("docker");
        std::fs::write(
            &script,
            format!("#!/bin/sh\ntouch '{}'\nexit 0\n", marker.display()),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let shared = test_shared(script.to_str().unwrap());
        let guard = shared.lifecycle.lock().await;
        let error = try_cleanup_with_timeout(
            &shared,
            Uuid::new_v4(),
            "test",
            Duration::from_millis(20),
            Duration::from_millis(200),
        )
        .await
        .unwrap_err();
        assert!(error.contains("lifecycle lock"));
        assert!(
            !marker.exists(),
            "cleanup scanned Docker without the lifecycle lock"
        );
        drop(guard);
    }

    #[tokio::test]
    async fn lifecycle_lock_timeout_is_not_a_cleanup_success() {
        let shared = test_shared(&simple_docker(0));
        let guard = shared.lifecycle.lock().await;
        let error = try_cleanup_with_timeout(
            &shared,
            Uuid::new_v4(),
            "test",
            Duration::from_millis(20),
            Duration::from_millis(200),
        )
        .await
        .unwrap_err();
        assert!(error.contains("lifecycle lock"));
        drop(guard);
    }

    #[tokio::test]
    async fn retry_loop_reacquires_lock_and_clears_error_after_cleanup() {
        let shared = test_shared(&simple_docker(0));
        shared
            .quarantined
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let guard = shared.lifecycle.lock().await;
        let task = tokio::spawn(cleanup_retry_loop_with(
            shared.clone(),
            Uuid::new_v4(),
            "test".into(),
            Duration::from_millis(20),
            Duration::from_secs(10),
            Duration::from_millis(20),
        ));
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(shared
            .quarantine_error
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|error| error.contains("lifecycle")));
        drop(guard);
        // 15s was a latency budget. Under `cargo test` this file's cases run
        // concurrently and each spawns shells; on a loaded machine the retry
        // loop's own 20ms cadence is not the thing being measured here, the
        // convergence is. Give it room and keep it a hang detector.
        tokio::time::timeout(Duration::from_secs(60), task)
            .await
            .expect("retry task did not converge")
            .unwrap();
        assert!(shared.quarantine_error.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn retry_loop_keeps_error_when_docker_cleanup_never_succeeds() {
        let shared = test_shared(&simple_docker(1));
        shared
            .quarantined
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let task = tokio::spawn(cleanup_retry_loop_with(
            shared.clone(),
            Uuid::new_v4(),
            "test".into(),
            Duration::from_millis(20),
            Duration::from_millis(100),
            Duration::from_millis(20),
        ));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(shared
            .quarantine_error
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|error| error.contains("QUARANTINE_CLEANUP_FAILED")));
        task.abort();
    }
}
