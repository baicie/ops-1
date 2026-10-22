use crate::config::Args;
use crate::docker::{container_name, DockerAdapter};
use crate::logs::{parse_docker_log_line, parse_level, LogBuffer};
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
    save_identity(&state_file, &identity)?;
    tracing::info!(node_id = %identity.node_id, "node enrolled");
    Ok(identity)
}

fn state_file(args: &Args) -> PathBuf {
    args.state_dir.join("node-identity.json")
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
    let result = tokio::time::timeout(
        Duration::from_secs(45),
        cleanup_managed(shared, node_id, reason),
    )
    .await;
    let error = match result {
        Ok(Ok(())) => {
            if let Ok(mut slot) = shared.quarantine_error.lock() {
                *slot = None;
            }
            tracing::info!("quarantine cleanup confirmed no managed containers remain");
            return;
        }
        Ok(Err(error)) => error,
        Err(_) => "QUARANTINE_CLEANUP_FAILED: cleanup exceeded the 45s deadline".to_string(),
    };
    tracing::error!(error = %error, "quarantine cleanup could not be verified");
    if let Ok(mut slot) = shared.quarantine_error.lock() {
        *slot = Some(error);
    }
}

async fn cleanup_managed(shared: &Arc<Shared>, node_id: Uuid, reason: &str) -> Result<(), String> {
    let mut failures: Vec<String> = Vec::new();
    // The total cleanup window is bounded by the caller. Give an in-flight
    // create/start a short chance to leave, but never block forever on the
    // lifecycle mutex; if it times out, report a failure even if the sweep
    // later removes the containers.
    let lifecycle_guard =
        match tokio::time::timeout(Duration::from_secs(15), shared.lifecycle.lock()).await {
            Ok(guard) => Some(guard),
            Err(_) => {
                failures.push("lifecycle lock wait exceeded 15s".to_string());
                None
            }
        };
    let lifecycle_ready = lifecycle_guard.is_some();
    let runtimes: Vec<InstanceRuntime> = shared.runtimes.read().await.values().cloned().collect();
    for runtime in runtimes {
        let name = container_name(node_id, runtime.workload.instance_id);
        if let Err(error) = shared.docker.stop_and_remove(&name).await {
            failures.push(format!("{name}: {error}"));
        }
        runtime.set_state(RuntimeState::Stopped, Some(reason.to_string()));
    }
    for attempt in 1..=3 {
        match shared.docker.list_managed(node_id).await {
            Ok(names) => {
                for name in names {
                    if let Err(error) = shared.docker.stop_and_remove(&name).await {
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
            if !lifecycle_ready {
                drop(lifecycle_guard);
                return Err(
                    "QUARANTINE_CLEANUP_FAILED: lifecycle lock deadline expired".to_string()
                );
            }
            drop(lifecycle_guard);
            return Ok(());
        }
        if attempt < 3 {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    drop(lifecycle_guard);
    if failures.is_empty() {
        Err("QUARANTINE_CLEANUP_FAILED: managed containers may remain".to_string())
    } else {
        Err(format!(
            "QUARANTINE_CLEANUP_FAILED: managed containers may remain: {}",
            failures.join("; ")
        ))
    }
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
    let (container_id, host_port) = match existing {
        Some(info) if info.running && info.image == *image_ref => {
            let _lifecycle = shared.lifecycle.lock().await;
            ensure_node_active(shared).await?;
            let host_port = info
                .host_port
                .ok_or_else(|| anyhow::anyhow!("adopted container has no published port"))?;
            tracing::info!(instance = %workload.instance_id, container = %info.id, "adopting running container");
            (info.id, host_port)
        }
        _ => {
            shared.docker.pull(image_ref).await?;
            let _lifecycle = shared.lifecycle.lock().await;
            ensure_node_active(shared).await?;
            shared.docker.verify_digest(image_ref).await?;
            ensure_node_active(shared).await?;
            let id = shared
                .docker
                .create_and_start(workload, image_ref, port, node_id)
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
                if let Err(error) = shared.docker.stop_and_remove(&name).await {
                    tracing::warn!(container = %name, error = %error, "orphan cleanup failed");
                }
            }
        }
    }
}

async fn cleanup(shared: &Arc<Shared>, workload: &DesiredWorkload) {
    let node_id = shared.identity.read().await.node_id;
    let name = container_name(node_id, workload.instance_id);
    if let Err(error) = shared.docker.stop_and_remove(&name).await {
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
        cpu_cores: std::thread::available_parallelism()
            .ok()
            .map(|count| count.get() as i64),
        filesystem_used_bytes,
        filesystem_total_bytes,
    }
}
